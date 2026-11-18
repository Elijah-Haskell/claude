// Create an administrator from the command line (instead of the first-run screen), or
// get back in when the only administrator is locked out.
//
//   npm run create-admin -- --email pat@firm.com --name "Pat Smith"
//   npm run create-admin -- --email pat@firm.com --reset     new password for an existing account,
//                                                            made an administrator, two-factor off
//
// The password is asked for on the terminal (not echoed), or read from
// LAWDESK_ADMIN_PASSWORD for scripted set-ups.

import { createInterface } from "node:readline";
import { openDatabase } from "../server.ts";
import { Engine } from "../engine.ts";
import { adminSetPassword, createAccount, getAccount, updateAccount } from "./accounts.ts";
import { passwordProblem } from "./passwords.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as any;
    const write = out._writeToOutput?.bind(out);
    out._writeToOutput = (s: string) => (s.startsWith(question) ? write?.(s) : write?.(""));
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const email = arg("email");
const name = arg("name");
const reset = process.argv.includes("--reset");
if (!email) {
  console.error('Usage: npm run create-admin -- --email you@firm.com --name "Your Name"   (or --reset for an existing account)');
  process.exit(2);
}
const dbPath = process.env.LAWDESK_DB ?? "lawdesk.db";
const db = openDatabase(dbPath);
const engine = new Engine(db);

let password = process.env.LAWDESK_ADMIN_PASSWORD ?? "";
if (!password) {
  password = await askHidden("Password (at least 12 characters): ");
  const again = await askHidden("Same password again: ");
  if (again !== password) {
    console.error("The two passwords don't match. Nothing was changed.");
    process.exit(1);
  }
}
const problem = passwordProblem(password, email);
if (problem) {
  console.error(problem + ". Nothing was changed.");
  process.exit(1);
}

try {
  const existing = db.prepare("SELECT user_id FROM auth_accounts WHERE email = ?").get(email) as { user_id: number } | undefined;
  if (existing) {
    if (!reset) {
      console.error(`${email} already has an account. Add --reset to give it a new password and administrator access.`);
      process.exit(1);
    }
    // A temporary password from the command line: they choose their own at next sign-in.
    await adminSetPassword(db, engine, null, existing.user_id, password, { turnOffTwoFactor: true });
    updateAccount(db, engine, null, existing.user_id, { role: "admin", disabled: false });
    console.log(`Reset ${email}: administrator, two-factor off, signed out everywhere. They will be asked to choose a new password.`);
  } else {
    if (!name) {
      console.error('Give the person\'s name too: --name "Pat Smith"');
      process.exit(2);
    }
    const user = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE ORDER BY id LIMIT 1").get(email) as { id: number } | undefined;
    const userId = user ? user.id : engine.addUser(name, "attorney", email);
    const a = await createAccount(db, engine, { userId, email, role: "admin", password });
    console.log(`Created administrator ${getAccount(db, a.user_id)!.name} <${email}> in ${dbPath}.`);
  }
} catch (err: any) {
  console.error(err.message ?? err);
  process.exit(1);
}
