# Bedros — agent-safe Vaultwarden CLI

Wrapper around the official Bitwarden CLI (`bw`, bundled as a local npm
dependency) for a self-hosted **Vaultwarden** — or **bitwarden.com** itself.

```
node vault.mjs <command>
```

## Requirements

- **Node.js 18+**
- `npm install` in this directory once (bundles the Bitwarden `bw` CLI — no separate install).

## Setup

1. Point vault at your server: copy `.env.example` to `.env` and set
   `VAULTWARDEN_URL` (or export it in your shell). Works for a self-hosted
   Vaultwarden or `https://bitwarden.com`.
2. `vault login` then `vault unlock` **in your own terminal** (email + master
   password + TOTP — never typed by an agent).

## Design rules (for agents)

1. **Never print secret values.** `list`/`get` show names and metadata only.
   `--reveal` exists but may be used ONLY when the user explicitly asked to see
   the value in this conversation.
2. **Use values without seeing them:**
   - `vault run <item>=TOKEN -- <cmd>` injects the secret as an env var into
     the child process; nothing enters the transcript.
   - `vault export <item> <attachment> -o <path>` writes SSH keys / kubeconfigs
     straight to disk.
3. **Writes** (`put`, `attach`) read the value from STDIN, never from argv
   (argv leaks into process listings and shell history).
4. `login`/`unlock` are interactive and belong to the human. If a command says
   the vault is locked, ask the user to run `vault unlock` — do not attempt it.

## Session model

`unlock` caches the session token at `~/.vault-cli/session` (user-only file),
so later commands — including from agent shells — work non-interactively.
`vault lock` deletes it. `BW_SESSION` env, when set, takes precedence.
The cache means "unlocked while I'm logged into this machine" — same trade-off
as an SSH agent. Lock before walking away if that bothers you.

## Commands

| Command | What |
|---|---|
| `status` | server, login/lock state |
| `login` / `unlock` / `lock` | session management (interactive, human-only) |
| `list [search]` | item names + folder/field/attachment NAMES, never values |
| `folders` | folder names + how many items each holds |
| `get <item> [--field f] [--reveal]` | metadata by default; raw value only with `--reveal` |
| `run <item>[:field]=ENV ... -- <cmd...>` | run command with secrets as env vars (argv passed **verbatim, no shell** — `&`/spaces/`%` are safe; for pipes or `$VAR` use `-- bash -c '...'`) |
| `export <item> <attachment> -o <path>` | download attachment |
| `attach <item> <file>` | upload attachment |
| `put <name> [--field f] [--username u] [--folder F]` | create/update item, value from STDIN |
| `rm <item>` | delete an item (unique match required) |
| `sync` | pull latest vault state |

`<item>` is a name or id; unique-prefix search is applied, ambiguity errors out.
`--field` accepts `password` (default), `username`, `uri`, `notes`, `totp`, or
any custom field name.

### Folders

`--folder` takes an **existing** folder name, matched case-insensitively but
otherwise exactly. An unknown name is a hard error that prints the folders you
do have — a typo can never invent a folder or quietly drop the item into
"No Folder". Creating folders is deliberately left to the web UI.

Passing `--folder` on an existing item **moves** it. Omitting it leaves the item
where it is, so routine field updates never disturb your organisation.

## Examples

```bash
# agent uses a PAT without ever seeing it
vault run github-pat=GITHUB_TOKEN -- gh api user

# restore kubeconfig on a new machine
vault export kubeconfig kubeconfig-merged.yaml -o ~/.kube/config

# store a rotated key (value via stdin)
echo "$NEW_KEY" | vault put openai-api --field password
```

Many more in [EXAMPLES.md](EXAMPLES.md).

## Tests

`npm test` runs `test/selftest.mjs` — an integration suite against your
configured server (needs `VAULTWARDEN_URL` set and an unlocked session). It
creates items prefixed `selftest-vaultcli-` plus one throwaway folder, exercises
put/list/get/reveal/run/attach/export/folders/rm (including the PowerShell
BOM+CRLF case and flag-order parsing), and cleans up after itself.

## License

MIT — see [LICENSE](LICENSE).
