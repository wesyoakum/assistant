#!/usr/bin/env node
// Idempotent first-time deploy helper for the whyapp Worker.
// Cross-platform: runs under PowerShell, cmd, or any POSIX shell.
// Calls wrangler directly via node (no pnpm wrapper) to avoid pnpm's
// pre-run deps verification on Windows.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const require = createRequire(import.meta.url);
const WRANGLER = require.resolve("wrangler/bin/wrangler.js");

const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const step = (m) => console.log(`\n${BOLD}${BLUE}==> ${m}${RESET}`);
const ok = (m) => console.log(`    ${GREEN}✓${RESET} ${m}`);
const note = (m) => console.log(`    ${m}`);

function wrangler(args, { input, capture = false } = {}) {
  const stdio = capture
    ? ["pipe", "pipe", "pipe"]
    : input != null
      ? ["pipe", "inherit", "inherit"]
      : "inherit";
  return spawnSync(process.execPath, [WRANGLER, ...args], {
    stdio,
    input,
    encoding: "utf8",
  });
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

step("Cloudflare login");
{
  const r = wrangler(["whoami"], { capture: true });
  if (r.status === 0) ok("already logged in");
  else {
    note("opening browser...");
    const l = wrangler(["login"]);
    if (l.status !== 0) die("wrangler login failed", l.status ?? 1);
  }
}

step("R2 bucket: whyapp-files");
{
  const r = wrangler(["r2", "bucket", "create", "whyapp-files"], { capture: true });
  if (r.status === 0) ok("created");
  else if (/already/i.test(`${r.stdout}${r.stderr}`)) ok("exists");
  else die(r.stderr || r.stdout, r.status ?? 1);
}

step("Queue: whyapp-tasks");
{
  const r = wrangler(["queues", "create", "whyapp-tasks"], { capture: true });
  if (r.status === 0) ok("created");
  else if (/already/i.test(`${r.stdout}${r.stderr}`)) ok("exists");
  else die(r.stderr || r.stdout, r.status ?? 1);
}

step("D1 migrations (whyapp-db, remote)");
{
  const r = wrangler(["d1", "migrations", "apply", "whyapp-db", "--remote"]);
  if (r.status !== 0) die("migrations apply failed", r.status ?? 1);
}

step("Secrets");
let existing = [];
{
  const r = wrangler(["secret", "list"], { capture: true });
  if (r.status === 0) {
    try {
      existing = JSON.parse(r.stdout).map((s) => s.name);
    } catch {
      existing = [...r.stdout.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    }
  }
}

function putSecret(name, generator) {
  if (existing.includes(name)) {
    ok(`${name} already set`);
    return;
  }
  if (generator) {
    note(`auto-generating ${name}`);
    const r = wrangler(["secret", "put", name], { input: generator() });
    if (r.status !== 0) die(`secret put ${name} failed`, r.status ?? 1);
  } else {
    note(`paste value for ${name} (input hidden):`);
    const r = wrangler(["secret", "put", name]);
    if (r.status !== 0) die(`secret put ${name} failed`, r.status ?? 1);
  }
}

const b64 = (n) => randomBytes(n).toString("base64");
putSecret("OAUTH_ENCRYPTION_KEY", () => b64(32));
putSecret("SESSION_JWT_SECRET", () => b64(48));
putSecret("GOOGLE_CLIENT_SECRET", null);
putSecret("ANTHROPIC_API_KEY", null);

step("Deploy");
{
  const r = wrangler(["deploy"]);
  if (r.status !== 0) die("deploy failed", r.status ?? 1);
}

step("Done");
note("verify: curl https://api.whyapp.us/health");
