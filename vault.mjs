#!/usr/bin/env node
// vault — agent-safe wrapper around the Bitwarden CLI (bw) for a self-hosted
// Vaultwarden (or bitwarden.com). Point it at your server with VAULTWARDEN_URL.
//
// Design rules (see README.md):
//  - secret VALUES are never printed unless --reveal is passed explicitly
//  - `run` injects secrets as env vars into a child process (transcript-safe)
//  - session: BW_SESSION env > cached session file (created by `unlock`)
//
// Usage: node vault.mjs <command> [...]

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- minimal .env loader (no dep) — lets VAULTWARDEN_URL live in a git-ignored .env ---
function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env — VAULTWARDEN_URL may be set in the environment instead */ }
}
loadEnv();

const BW_JS = join(__dirname, "node_modules", "@bitwarden", "cli", "build", "bw.js");
const SERVER = process.env.VAULTWARDEN_URL || process.env.BW_SERVER || "";
const SESSION_DIR = join(os.homedir(), ".vault-cli");
const SESSION_FILE = join(SESSION_DIR, "session");

function die(msg, code = 1) { console.error(msg); process.exit(code); }

if (!existsSync(BW_JS)) die(`bw not installed — run: npm install  (in ${__dirname})`);

function session() {
  if (process.env.BW_SESSION) return process.env.BW_SESSION;
  if (existsSync(SESSION_FILE)) return readFileSync(SESSION_FILE, "utf8").trim();
  return "";
}

function bw(args, { input, allowFail = false, inherit = false } = {}) {
  const env = { ...process.env, BW_SESSION: session(), BITWARDENCLI_APPDATA_DIR: SESSION_DIR };
  const r = spawnSync(process.execPath, [BW_JS, ...args], {
    input, env, encoding: "utf8", stdio: inherit ? "inherit" : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!inherit && r.status !== 0 && !allowFail)
    die(`bw ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join("\n")}`);
  return r;
}

function bwJson(args) {
  const r = bw([...args, "--raw"]);
  try { return JSON.parse(r.stdout); } catch { die(`bw returned non-JSON: ${r.stdout.slice(0, 200)}`); }
}

function requireUnlocked() {
  const st = bwJson(["status"]);
  if (st.status === "unauthenticated")
    die(`Not logged in. In YOUR terminal run:\n  node "${join(__dirname, "vault.mjs")}" login`);
  if (st.status === "locked")
    die(`Vault locked. In YOUR terminal run:\n  node "${join(__dirname, "vault.mjs")}" unlock`);
}

function findItem(nameOrId) {
  const r = bw(["get", "item", nameOrId, "--raw"], { allowFail: true });
  if (r.status !== 0) {
    const list = bwJson(["list", "items", "--search", nameOrId]);
    if (list.length === 0) die(`No item matches "${nameOrId}".`);
    if (list.length > 1) die(`Ambiguous "${nameOrId}" — matches:\n` + list.map(i => `  ${i.name}  (${i.id})`).join("\n"));
    return list[0];
  }
  try { return JSON.parse(r.stdout); } catch { die("unexpected bw output"); }
}

function fieldValue(item, field) {
  const f = (field || "password").toLowerCase();
  if (f === "password") return item.login?.password;
  if (f === "username") return item.login?.username;
  if (f === "uri") return item.login?.uris?.[0]?.uri;
  if (f === "notes") return item.notes;
  if (f === "totp") { requireUnlocked(); return bw(["get", "totp", item.id, "--raw"]).stdout.trim(); }
  const custom = (item.fields || []).find(x => x.name.toLowerCase() === f);
  return custom?.value;
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith("--")));
const pos = rest.filter(a => !a.startsWith("--"));

switch (cmd) {
  case "status": {
    const st = bwJson(["status"]);
    console.log(`server: ${st.serverUrl}\nstatus: ${st.status}${st.userEmail ? `\nuser:   ${st.userEmail}` : ""}`);
    break;
  }

  case "login": { // interactive — run in YOUR terminal, never by an agent
    if (!SERVER) die("Set VAULTWARDEN_URL to your Vaultwarden/Bitwarden server URL\n(e.g. in vault-cli/.env — see .env.example — or export it in your shell).");
    bw(["logout"], { allowFail: true }); // allow switching the server URL (bw refuses while logged in)
    bw(["config", "server", SERVER], { inherit: true });
    bw(["login"], { inherit: true });
    console.log("\nNow run: vault unlock");
    break;
  }

  case "unlock": { // interactive — caches session (user-only file) for later commands
    mkdirSync(SESSION_DIR, { recursive: true });
    const r = spawnSync(process.execPath, [BW_JS, "unlock", "--raw"], {
      env: { ...process.env, BITWARDENCLI_APPDATA_DIR: SESSION_DIR },
      encoding: "utf8", stdio: ["inherit", "pipe", "inherit"],
    });
    const s = (r.stdout || "").trim();
    if (r.status !== 0 || !s) die("unlock failed");
    writeFileSync(SESSION_FILE, s, { mode: 0o600 });
    console.log(`Session cached at ${SESSION_FILE}\nClear it anytime with: vault lock`);
    break;
  }

  case "lock": {
    rmSync(SESSION_FILE, { force: true });
    bw(["lock"], { allowFail: true });
    console.log("Session cleared.");
    break;
  }

  case "list": {
    requireUnlocked();
    const items = bwJson(pos[0] ? ["list", "items", "--search", pos[0]] : ["list", "items"]);
    for (const i of items) {
      const extras = [];
      if (i.login?.username) extras.push(`user=${i.login.username}`);
      if (i.fields?.length) extras.push(`fields=${i.fields.map(f => f.name).join(",")}`);
      if (i.attachments?.length) extras.push(`attachments=${i.attachments.map(a => a.fileName).join(",")}`);
      console.log(`${i.name}${extras.length ? "  [" + extras.join(" ") + "]" : ""}`);
    }
    if (!items.length) console.log("(no items)");
    break;
  }

  case "get": { // metadata by default; value only with --reveal (user must have asked)
    requireUnlocked();
    const item = findItem(pos[0] ?? die("usage: vault get <item> [--field <f>] [--reveal]"));
    const fieldFlag = rest.find((a, i) => rest[i - 1] === "--field");
    if (flags.has("--reveal")) {
      const v = fieldValue(item, fieldFlag);
      if (v == null) die(`Field "${fieldFlag || "password"}" is empty on "${item.name}".`);
      process.stdout.write(v);
    } else {
      console.log(`name:        ${item.name}`);
      if (item.login?.username) console.log(`username:    ${item.login.username}`);
      if (item.login?.uris?.length) console.log(`uri:         ${item.login.uris[0].uri}`);
      if (item.login?.password) console.log(`password:    (set — use --reveal or 'vault run')`);
      if (item.fields?.length) console.log(`fields:      ${item.fields.map(f => f.name).join(", ")}`);
      if (item.attachments?.length) console.log(`attachments: ${item.attachments.map(a => a.fileName).join(", ")}`);
    }
    break;
  }

  case "run": { // vault run <item>[:field]=ENVVAR ... -- <command...>
    requireUnlocked();
    const sep = rest.indexOf("--");
    if (sep < 0) die("usage: vault run <item>[:field]=ENVVAR ... -- <command...>");
    const specs = rest.slice(0, sep);
    const command = rest.slice(sep + 1);
    if (!specs.length || !command.length) die("usage: vault run <item>[:field]=ENVVAR ... -- <command...>");
    const env = { ...process.env };
    for (const spec of specs) {
      const m = spec.match(/^(.+?)(?::([^=]+))?=([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!m) die(`bad spec "${spec}" — expected <item>[:field]=ENVVAR`);
      const v = fieldValue(findItem(m[1]), m[2]);
      if (v == null) die(`Field "${m[2] || "password"}" is empty on "${m[1]}".`);
      env[m[3]] = v;
    }
    // argv is passed VERBATIM (no shell): joining it into a string would drop
    // quoting, and on Windows cmd.exe would then eat `&` in URLs, `^`, `%VAR%`.
    // Need shell syntax (pipes, redirects)? Ask for it explicitly:
    //   vault run x=T -- bash -c '<script>'
    const [file, ...argv] = command;
    let r = spawnSync(file, argv, { env, stdio: "inherit" });
    if (r.error?.code === "ENOENT" && process.platform === "win32") {
      // Windows can't spawn .cmd/.bat shims (npm, npx, gh) without a shell —
      // but only retry if the command really EXISTS as one, otherwise cmd.exe
      // swallows the failure and prints its own error instead of ours.
      const found = existsSync(file) ||
        spawnSync("where", [file], { encoding: "utf8" }).status === 0;
      if (found) r = spawnSync(file, argv, { env, stdio: "inherit", shell: true });
    }
    if (r.error?.code === "ENOENT") die(`command not found: ${file}`);
    if (r.error) die(`failed to run "${file}": ${r.error.message}`);
    process.exit(r.status ?? 1);
  }

  case "export": { // vault export <item> <attachmentName> -o <path>
    requireUnlocked();
    const oIdx = rest.indexOf("-o");
    const out = oIdx >= 0 ? rest[oIdx + 1] : null;
    if (!pos[0] || !pos[1] || !out) die("usage: vault export <item> <attachmentName> -o <path>");
    const item = findItem(pos[0]);
    bw(["get", "attachment", pos[1], "--itemid", item.id, "--output", out]);
    console.log(`written: ${out}`);
    break;
  }

  case "attach": { // vault attach <item> <file>
    requireUnlocked();
    if (!pos[0] || !pos[1]) die("usage: vault attach <item> <file>");
    const item = findItem(pos[0]);
    bw(["create", "attachment", "--file", pos[1], "--itemid", item.id]);
    console.log(`attached ${pos[1]} to "${item.name}"`);
    break;
  }

  case "put": { // vault put <name> [--field <f>] — VALUE READ FROM STDIN (never argv)
    requireUnlocked();
    const name = pos[0] ?? die("usage: echo <value> | vault put <name> [--field <f>] [--username <u>]");
    const fieldFlag = rest.find((a, i) => rest[i - 1] === "--field") || "password";
    const userFlag = rest.find((a, i) => rest[i - 1] === "--username");
    // strip BOM (PowerShell pipes prepend one) and trailing newline
    const value = readFileSync(0, "utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
    if (!value) die("no value on stdin");
    const found = bw(["get", "item", name, "--raw"], { allowFail: true });
    let item = found.status === 0 ? JSON.parse(found.stdout) : null;
    if (!item) {
      item = JSON.parse(bw(["get", "template", "item", "--raw"]).stdout);
      item.name = name; item.notes = null; item.login = { username: userFlag ?? null, password: null, uris: [] };
      item.fields = [];
    }
    if (["password", "username", "notes"].includes(fieldFlag)) {
      if (fieldFlag === "notes") item.notes = value;
      else { item.login = item.login || {}; item.login[fieldFlag] = value; }
    } else {
      item.fields = item.fields || [];
      const existing = item.fields.find(f => f.name === fieldFlag);
      if (existing) existing.value = value;
      else item.fields.push({ name: fieldFlag, value, type: 1 }); // type 1 = hidden
    }
    const b64 = Buffer.from(JSON.stringify(item)).toString("base64");
    if (item.id) bw(["edit", "item", item.id, b64]);
    else bw(["create", "item", b64]);
    bw(["sync"], { allowFail: true });
    console.log(`${item.id ? "updated" : "created"} "${name}" (${fieldFlag})`);
    break;
  }

  case "rm": { // vault rm <item> — exact/unique match only
    requireUnlocked();
    const item = findItem(pos[0] ?? die("usage: vault rm <item>"));
    bw(["delete", "item", item.id]);
    bw(["sync"], { allowFail: true });
    console.log(`deleted "${item.name}"`);
    break;
  }

  case "sync": { requireUnlocked(); bw(["sync"]); console.log("synced"); break; }

  default:
    console.log(`vault — agent-safe Vaultwarden CLI (server: ${SERVER || "unset — set VAULTWARDEN_URL"})

  status                                    login/lock state
  login                                     interactive (run in YOUR terminal)
  unlock                                    interactive; caches session for agents
  lock                                      clear cached session
  list [search]                             item names + field/attachment names (no values)
  get <item> [--field f] [--reveal]         metadata; value only with --reveal
  run <item>[:field]=ENV ... -- <cmd...>    run cmd with secrets injected as env
  export <item> <attachment> -o <path>      download attachment (kubeconfig, PEM...)
  attach <item> <file>                      upload attachment
  put <name> [--field f] [--username u]     create/update; value from STDIN
  rm <item>                                 delete an item
  sync                                      pull latest vault state

Examples: EXAMPLES.md · Tests: npm test (needs unlocked session)`);
}
