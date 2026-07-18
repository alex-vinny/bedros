# vault-cli — examples

`vault` below means `node vault.mjs` (add a shell alias/function if you like).

## Daily: use a credential without seeing it

```sh
# GitHub PAT for gh / git
vault run github-pat=GITHUB_TOKEN -- gh api user
vault run github-pat=GITHUB_TOKEN -- git push origin main

# API key into any script (child process env)
vault run openai-api=OPENAI_API_KEY -- node my-script.mjs

# two secrets at once, custom fields
vault run "my-db:uri=DATABASE_URL" "my-db:api-key=API_KEY" -- node worker.mjs
```

`run` passes the command's argv **verbatim — no shell**. So `&`, spaces, `%`
and quotes survive untouched, on Windows and Linux alike. If you want shell
syntax (pipes, redirects, `$VAR` expansion), ask for a shell explicitly:

```sh
# a URL whose `&` is safe because no shell ever sees the argv
vault run some-token=TOKEN -- bash -c 'curl -s "https://api.example.com/update?a=1&token=$TOKEN"'
```

⚠ On Windows, prefer `bash -c '<script>'` over a bare `cmd` one-liner: `cmd.exe`
treats `&` as a command separator, so a URL pasted straight into it gets
silently truncated at the first `&`. Inside `bash -c '...'` it is just a
character. (`run` passes argv verbatim precisely so this cannot happen; there is
a regression test for it in `test/selftest.mjs`.)

## Bootstrap a machine (SSH keys, kubeconfig)

```sh
vault export kubeconfig kubeconfig-merged.yaml -o ~/.kube/config
vault export my-server-ssh id_ed25519 -o ~/.ssh/my-server_key
chmod 600 ~/.ssh/my-server_key
```

## Store / rotate a secret (value via STDIN, never argv)

```sh
# new PAT (bash/zsh) — read without echoing to history
read -rs TOKEN && printf %s "$TOKEN" | vault put github-pat --field password --username me

# rotate an API key on an existing item, from a file
cat ./token.txt | vault put openai-api --field password

# attach a key file (kubeconfig, PEM)
vault attach kubeconfig ~/.kube/config
```

```powershell
# PowerShell equivalents
Read-Host "PAT" | vault put github-pat --field password --username me
Get-Clipboard   | vault put openai-api --field password
```

## Feed a Kubernetes Secret without the value touching the transcript

```sh
# expansion happens inside the child shell, not in the agent command
vault run my-db=PGPASS -- bash -c \
  'kubectl -n my-namespace create secret generic my-db-secret --from-literal=password="$PGPASS"'
```

## Inspect (safe — no values)

```sh
vault list                 # everything: names, field names, attachment names
vault list github          # filtered
vault get github-pat       # metadata: username, uri, which fields exist
vault status               # server + lock state
```

## Reveal (only when the human asked)

```sh
vault get github-pat --field password --reveal   # prints the raw value
vault get some-site --field totp --reveal        # current TOTP code
```

## Session

```sh
vault login    # once per machine (email + master password + TOTP)
vault unlock   # once per "work session" — caches token in ~/.vault-cli/session
vault lock     # clear the cached session (do this before lending the machine)
```
