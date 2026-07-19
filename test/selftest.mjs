// Integration self-test for vault-cli. Run with: npm test
// Needs an UNLOCKED session (vault unlock). Creates items prefixed
// "selftest-vaultcli-" and deletes them afterwards; touches nothing else.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT = join(__dirname, "..", "vault.mjs");
const BW_JS = join(__dirname, "..", "node_modules", "@bitwarden", "cli", "build", "bw.js");
const SESSION_DIR = join(os.homedir(), ".vault-cli");
const ITEM = "selftest-vaultcli-item";
const VALUE = "s3lf-test-value-!42";
// space + "&" on purpose: the shape a flag value must survive intact
const FOLDER = "selftest-vaultcli folder & co";
let pass = 0, fail = 0;

function vault(args, { input } = {}) {
  return spawnSync(process.execPath, [VAULT, ...args], { input, encoding: "utf8" });
}
// direct bw call — folders have no vault subcommand that creates them (by design)
function bw(args) {
  const session = (() => {
    try { return readFileSync(join(SESSION_DIR, "session"), "utf8").trim(); } catch { return ""; }
  })();
  return spawnSync(process.execPath, [BW_JS, ...args], {
    encoding: "utf8",
    env: { ...process.env, BW_SESSION: session, BITWARDENCLI_APPDATA_DIR: SESSION_DIR },
  });
}
function folderId(name) {
  const r = bw(["list", "folders", "--raw"]);
  try { return (JSON.parse(r.stdout).find(f => f.name === name) || {}).id || null; }
  catch { return null; }
}
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

console.log("== vault-cli self-test ==");

// 0. must be unlocked
const st = vault(["status"]);
if (!/status: unlocked/.test(st.stdout)) {
  console.log("SKIP: vault is not unlocked — run `vault unlock` first.");
  process.exit(2);
}
check("status reports unlocked", true);

// clean leftovers from a previous crashed run
vault(["rm", ITEM]);

// 1. put — with BOM + CRLF prepended, like a PowerShell pipe would send
let r = vault(["put", ITEM, "--field", "password", "--username", "selftester"],
  { input: "﻿" + VALUE + "\r\n" });
check("put creates item", r.status === 0 && /created/.test(r.stdout), r.stdout + r.stderr);

// 2. list shows the item, never the value
r = vault(["list", ITEM]);
check("list shows item name", r.stdout.includes(ITEM));
check("list hides value", !r.stdout.includes(VALUE));

// 3. get metadata only by default
r = vault(["get", ITEM]);
check("get shows metadata", r.stdout.includes("selftester"));
check("get hides value without --reveal", !r.stdout.includes(VALUE));

// 4. get --reveal returns the EXACT value (BOM/CRLF stripped at put)
r = vault(["get", ITEM, "--field", "password", "--reveal"]);
check("reveal returns exact value", r.stdout === VALUE, JSON.stringify(r.stdout));

// 5. run injects env var into child process
const probe = join(mkdtempSync(join(os.tmpdir(), "vaultcli-")), "probe.mjs");
writeFileSync(probe, `process.stdout.write(process.env.ST_SECRET === ${JSON.stringify(VALUE)} ? "MATCH" : "MISMATCH:" + JSON.stringify(process.env.ST_SECRET));`);
r = vault(["run", `${ITEM}=ST_SECRET`, "--", "node", probe]);
check("run injects exact env var", r.stdout.includes("MATCH"), r.stdout + r.stderr);

// 5b. run passes argv VERBATIM — no shell in between, so `&` in a URL query
// string survives and a quoted argument with spaces stays one argument.
const argvProbe = join(dirname(probe), "argv-probe.mjs");
writeFileSync(argvProbe, `process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
const TRICKY = "https://api.example.com/update?domains=x&token=y&ip=1.2.3.4";
r = vault(["run", `${ITEM}=ST_SECRET`, "--", "node", argvProbe, TRICKY, "two words", "100%"]);
let argvGot = [];
try { argvGot = JSON.parse(r.stdout.trim()); } catch { /* leave empty → fail below */ }
check("run passes argv verbatim (& survives, spaces stay one arg)",
  argvGot[0] === TRICKY && argvGot[1] === "two words" && argvGot[2] === "100%",
  JSON.stringify(r.stdout) + r.stderr);

// 5c. run propagates the child's exit code (callers branch on it)
r = vault(["run", `${ITEM}=ST_SECRET`, "--", "node", "-e", "process.exit(3)"]);
check("run propagates child exit code", r.status === 3, `status=${r.status}`);

// 5d. a command that does not exist fails loudly, not silently
r = vault(["run", `${ITEM}=ST_SECRET`, "--", "definitely-not-a-real-binary-xyz"]);
check("run reports missing command", r.status !== 0 && /command not found/.test(r.stderr),
  `status=${r.status} ${r.stderr}`);

// 6. put updates an existing item (idempotent upsert)
r = vault(["put", ITEM, "--field", "password"], { input: VALUE + "-v2\n" });
check("put updates existing item", r.status === 0 && /updated/.test(r.stdout), r.stdout + r.stderr);
r = vault(["get", ITEM, "--field", "password", "--reveal"]);
check("updated value readable", r.stdout === VALUE + "-v2", JSON.stringify(r.stdout));

// 7. custom field
r = vault(["put", ITEM, "--field", "api-key"], { input: "custom-field-value\n" });
check("put custom field", r.status === 0, r.stdout + r.stderr);
r = vault(["get", ITEM, "--field", "api-key", "--reveal"]);
check("custom field readable", r.stdout === "custom-field-value", JSON.stringify(r.stdout));

// 8. attachment round-trip
const attSrc = join(dirname(probe), "attach-src.txt");
const attOut = join(dirname(probe), "attach-out.txt");
writeFileSync(attSrc, "attachment-payload-123\n");
r = vault(["attach", ITEM, attSrc]);
check("attach uploads file", r.status === 0, r.stdout + r.stderr);
r = vault(["export", ITEM, "attach-src.txt", "-o", attOut]);
const roundtrip = r.status === 0 && readFileSync(attOut, "utf8") === "attachment-payload-123\n";
check("export round-trips attachment", roundtrip, r.stdout + r.stderr);

// 9. ambiguity / missing errors
r = vault(["get", "selftest-vaultcli-does-not-exist"]);
check("missing item errors out", r.status !== 0);

// --- folders -----------------------------------------------------------
// Made with bw directly: `vault` deliberately has no create-folder command, so
// a typo can never invent one.
let fid = folderId(FOLDER);
if (!fid) {
  bw(["create", "folder", Buffer.from(JSON.stringify({ name: FOLDER })).toString("base64")]);
  bw(["sync"]);
  fid = folderId(FOLDER);
}
check("test folder exists", !!fid, "could not create folder via bw");

// 11. put --folder files the item
r = vault(["put", ITEM, "--field", "password", "--folder", FOLDER], { input: VALUE + "\n" });
check("put --folder succeeds", r.status === 0, r.stdout + r.stderr);
r = vault(["get", ITEM]);
check("get shows folder", r.stdout.includes(`folder:      ${FOLDER}`), r.stdout);
r = vault(["list", ITEM]);
check("list shows folder", r.stdout.includes(`folder=${FOLDER}`), r.stdout);

// 12. a later put WITHOUT --folder must not evict the item from its folder
r = vault(["put", ITEM, "--field", "api-key"], { input: "v3\n" });
check("field update keeps folder", r.status === 0 && vault(["get", ITEM]).stdout.includes(FOLDER),
  r.stdout + r.stderr);

// 13. unknown folder = hard error, item untouched, secret not consumed
r = vault(["put", "selftest-vaultcli-ghost", "--folder", "no-such-folder-xyz"], { input: "nope\n" });
check("unknown folder errors out", r.status !== 0 && /No folder named/.test(r.stderr), r.stderr);
check("unknown folder lists real ones", r.stderr.includes(FOLDER), r.stderr);
check("unknown folder creates nothing", vault(["get", "selftest-vaultcli-ghost"]).status !== 0);

// 14. flags before the positional: the item name is the positional, never a
// flag value sitting next to it
const ITEM2 = "selftest-vaultcli-argorder";
vault(["rm", ITEM2]);
r = vault(["put", "--folder", FOLDER, "--field", "password", ITEM2], { input: "v\n" });
check("flag value is not mistaken for the item name",
  r.status === 0 && vault(["get", ITEM2]).stdout.includes(`name:        ${ITEM2}`), r.stdout + r.stderr);
check("folder name did not become an item", vault(["get", FOLDER]).status !== 0);
vault(["rm", ITEM2]);

// 15. unknown flags are rejected rather than silently ignored
r = vault(["put", ITEM, "--flder", FOLDER], { input: "v\n" });
check("unknown flag errors out", r.status !== 0 && /unknown flag/.test(r.stderr), r.stderr);

// 16. folders command lists the folder with a count
r = vault(["folders"]);
check("folders lists the test folder", new RegExp(`${FOLDER.replace(/[&]/g, "\\&")}\\s+\\(\\d+\\)`).test(r.stdout),
  r.stdout);

// 17. cleanup
r = vault(["rm", ITEM]);
check("rm deletes item", r.status === 0 && /deleted/.test(r.stdout), r.stdout + r.stderr);
r = vault(["get", ITEM]);
check("item gone after rm", r.status !== 0);
if (fid) { bw(["delete", "folder", fid]); bw(["sync"]); }
check("test folder removed", folderId(FOLDER) === null);

rmSync(dirname(probe), { recursive: true, force: true });
console.log(`== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
