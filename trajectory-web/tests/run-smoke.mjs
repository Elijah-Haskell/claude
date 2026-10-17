// Runs the browser tests end to end: builds the app against the mock API (tests/mock-server.mjs, real tRPC), starts
// the mock and `vite preview`, runs every suite, stops both. Usage:
//   node tests/run-smoke.mjs                 # every tests/smoke*.mjs and tests/account-smoke.mjs
//   node tests/run-smoke.mjs account general # by name (account-smoke.mjs, smoke.mjs = "general", smoke-<name>.mjs)
//   SKIP_BUILD=1 node tests/run-smoke.mjs    # reuse the last builds in the scratch directory
//
// Three builds: "signin" (Google and email sign-in, for smoke-signin.mjs), "free" (VITE_TEST_SIGN_IN=1) and "pro" (also VITE_TEST_PRO=1, the browser's side of the mock's
// MOCK_PRO=1, since a test build has no RevenueCat key to learn Pro from). Each suite gets a freshly started mock
// (its in-memory ledger counts the test student's one free syllabus) with the environment the suite's header asks for.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PREVIEW_PORT = Number(process.env.SMOKE_PREVIEW_PORT ?? 4173);
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT ?? 4174);
const outDir = process.env.SMOKE_OUT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "trajectory-web-smoke-dist");

/** What each suite needs: which build, and the mock's environment. Unlisted suites: the free build, a Pro account. */
const NEEDS = {
  "account-smoke.mjs": { build: "free", mock: { MOCK_PRO: "1" } },
  "smoke.mjs": { build: "free", mock: { MOCK_PRO: "1" } },
  "smoke-syllabus.mjs": { build: "free", mock: { MOCK_PRO: "0" } }, // the second syllabus must hit the free limit
  "smoke-screens.mjs": { build: "free", mock: { MOCK_PRO: "1", MOCK_GCAL: "1" } },
  "smoke-ai.mjs": { build: "pro", mock: { MOCK_PRO: "1" } },
  "smoke-study.mjs": { build: "pro", mock: { MOCK_PRO: "1" } },
  "smoke-wording.mjs": { build: "pro", mock: { MOCK_PRO: "1" } },
  "smoke-signin.mjs": { build: "signin", mock: { MOCK_PRO: "1" } },
};
const needsOf = (suite) => NEEDS[suite] ?? { build: "free", mock: { MOCK_PRO: "1" } };

const wanted = process.argv.slice(2);
const suites = readdirSync(here)
  .filter((name) => name === "account-smoke.mjs" || /^smoke(-[a-z0-9-]+)?\.mjs$/.test(name))
  .filter((name) => wanted.length === 0 || wanted.includes(name === "smoke.mjs" ? "general" : name.replace(/^smoke-|\.mjs$|-smoke/g, "")))
  .sort((a, b) => (a === "account-smoke.mjs" ? -1 : b === "account-smoke.mjs" ? 1 : a.localeCompare(b)));
if (suites.length === 0) {
  console.error("no suites matched", wanted);
  process.exit(2);
}
const builds = [...new Set(suites.map((suite) => needsOf(suite).build))].sort();
const buildDir = (build) => join(outDir, build);

for (const build of builds) {
  if (!process.env.SKIP_BUILD) {
    mkdirSync(buildDir(build), { recursive: true });
    console.log(`building the ${build} app against the mock API into ${buildDir(build)}`);
    const run = spawnSync("npx", ["vite", "build", "--outDir", buildDir(build)], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        VITE_TEST_SIGN_IN: "1",
        ...(build === "pro" ? { VITE_TEST_PRO: "1" } : {}),
        // Google and email sign-in, for smoke-signin.mjs only (Google's real script would load in the other builds).
        ...(build === "signin" ? { VITE_GOOGLE_CLIENT_ID: "mock-google-client", VITE_EMAIL_SIGN_IN: "1" } : {}),
      },
    });
    if (run.status !== 0) process.exit(run.status ?? 1);
  } else if (!existsSync(join(buildDir(build), "index.html"))) {
    console.error(`no ${build} build in ${buildDir(build)}; run without SKIP_BUILD`);
    process.exit(2);
  }
}

function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  child.stdout.on("data", (chunk) => process.env.SMOKE_VERBOSE && process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3000))]);
}
async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not come up`);
}
async function waitForFree(port, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`port ${port} did not free up`);
}

/** Nothing may already answer on the two ports: a stale server would keep another run's accounts and plans. */
async function assertFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
  } catch {
    return;
  }
  console.error(`something is already listening on port ${port}; stop it first (ss -ltnp | grep ${port})`);
  process.exit(2);
}
await assertFree(MOCK_PORT);
await assertFree(PREVIEW_PORT);

let failed = 0;
let preview = null;
let previewBuild = null;
let mock = null;
try {
  for (const suite of suites) {
    const needs = needsOf(suite);
    if (previewBuild !== needs.build) {
      await stop(preview);
      await waitForFree(PREVIEW_PORT);
      preview = start("node", [join(root, "node_modules/vite/bin/vite.js"), "preview", "--outDir", buildDir(needs.build), "--port", String(PREVIEW_PORT), "--strictPort"]);
      previewBuild = needs.build;
      await waitFor(`http://127.0.0.1:${PREVIEW_PORT}/`);
    }
    await stop(mock);
    await waitForFree(MOCK_PORT);
    mock = start("node", [join(here, "mock-server.mjs")], { MOCK_PORT: String(MOCK_PORT), ...needs.mock });
    await waitFor(`http://127.0.0.1:${MOCK_PORT}/api/health`);

    console.log(`\n=== ${suite} (${needs.build} build; mock ${Object.entries(needs.mock).map(([k, v]) => `${k}=${v}`).join(" ")})`);
    const run = spawnSync("node", [join(here, suite)], { cwd: root, stdio: "inherit", env: { ...process.env, SMOKE_URL: `http://127.0.0.1:${PREVIEW_PORT}`, SMOKE_MOCK_URL: `http://127.0.0.1:${MOCK_PORT}` } });
    if (run.status !== 0) failed += 1;
  }
} finally {
  await stop(mock);
  await stop(preview);
}
console.log(failed === 0 ? `\nall ${suites.length} suite${suites.length === 1 ? "" : "s"} passed` : `\n${failed} suite${suites.length === 1 ? "" : "s"} failed`);
process.exit(failed === 0 ? 0 : 1);
