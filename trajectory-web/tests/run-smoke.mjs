// Runs the browser tests end to end: builds the app against the mock API (tests/mock-server.mjs, real tRPC), starts
// the mock and `vite preview`, runs every suite, stops both. Usage:
//   node tests/run-smoke.mjs                 # every tests/smoke*.mjs and tests/account-smoke.mjs
//   node tests/run-smoke.mjs account general # by name (account-smoke.mjs, smoke.mjs = "general", smoke-<name>.mjs)
//   SKIP_BUILD=1 node tests/run-smoke.mjs    # reuse the last build in the scratch directory
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PREVIEW_PORT = Number(process.env.SMOKE_PREVIEW_PORT ?? 4173);
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT ?? 4174);
const outDir = process.env.SMOKE_OUT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "trajectory-web-smoke-dist");

const wanted = process.argv.slice(2);
const suites = readdirSync(here)
  .filter((name) => name === "account-smoke.mjs" || /^smoke(-[a-z0-9-]+)?\.mjs$/.test(name))
  .filter((name) => wanted.length === 0 || wanted.includes(name === "smoke.mjs" ? "general" : name.replace(/^smoke-|\.mjs$|-smoke/g, "")))
  .sort((a, b) => (a === "account-smoke.mjs" ? -1 : b === "account-smoke.mjs" ? 1 : a.localeCompare(b)));
if (suites.length === 0) {
  console.error("no suites matched", wanted);
  process.exit(2);
}

if (!process.env.SKIP_BUILD) {
  mkdirSync(outDir, { recursive: true });
  console.log(`building against the mock API into ${outDir}`);
  const build = spawnSync("npx", ["vite", "build", "--outDir", outDir], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, VITE_TEST_SIGN_IN: "1" },
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
} else if (!existsSync(join(outDir, "index.html"))) {
  console.error(`no build in ${outDir}; run without SKIP_BUILD`);
  process.exit(2);
}

const children = [];
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  child.stdout.on("data", (chunk) => process.env.SMOKE_VERBOSE && process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
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
try {
  start("node", [join(here, "mock-server.mjs")], { MOCK_PORT: String(MOCK_PORT), MOCK_PRO: process.env.MOCK_PRO ?? "1" });
  start("node", [join(root, "node_modules/vite/bin/vite.js"), "preview", "--outDir", outDir, "--port", String(PREVIEW_PORT), "--strictPort"]);
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/api/health`);
  await waitFor(`http://127.0.0.1:${PREVIEW_PORT}/`);
  for (const suite of suites) {
    console.log(`\n=== ${suite}`);
    const run = spawnSync("node", [join(here, suite)], { cwd: root, stdio: "inherit", env: { ...process.env, SMOKE_URL: `http://127.0.0.1:${PREVIEW_PORT}` } });
    if (run.status !== 0) failed += 1;
  }
} finally {
  for (const child of children) child.kill();
}
console.log(failed === 0 ? `\nall ${suites.length} suite${suites.length === 1 ? "" : "s"} passed` : `\n${failed} suite${failed === 1 ? "" : "s"} failed`);
process.exit(failed === 0 ? 0 : 1);
