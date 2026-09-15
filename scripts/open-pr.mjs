#!/usr/bin/env node
// Open a GitHub pull request using a token supplied as an ENV VAR.
//
// Meant to be run through bedros so the token never reaches argv, the shell
// history or the transcript:
//
//   node vault.mjs run github-pat=GITHUB_TOKEN -- \
//     node scripts/open-pr.mjs --repo owner/name --head <branch> --base main \
//     --title "..." --body-file <path>
//
// Exists because `gh` is not installed everywhere, and installing it is not
// always the user's call. Uses only the standard library.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is not set. Run this through: vault run github-pat=GITHUB_TOKEN -- node scripts/open-pr.mjs ...');
  process.exit(2);
}

const repo = flag('repo');
const head = flag('head');
const base = flag('base') || 'main';
const title = flag('title');
const bodyFile = flag('body-file');
const update = flag('update');
const merge = flag('merge');
if (!repo || (!update && !merge && (!head || !title))) {
  console.error('Usage: open-pr.mjs --repo <owner/name> --head <branch> [--base <branch>] --title "<t>" [--body-file <path>] [--draft]');
  console.error('       open-pr.mjs --repo <owner/name> --update <pr-number> [--title "<t>"] [--body-file <path>]');
  console.error('       open-pr.mjs --repo <owner/name> --merge  <pr-number> [--method merge|squash|rebase]');
  process.exit(2);
}

const body = bodyFile ? (await import('node:fs')).readFileSync(bodyFile, 'utf8') : '';

const api = async (method, path, payload) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bedros-open-pr',
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the raw text for the error */ }
  return { status: res.status, json, text };
};

// Merging. Read the PR first: GitHub will refuse a merge it cannot do, but the
// refusal is a bare 405, so check mergeable_state up front and say WHY in terms a
// caller can act on — dirty means conflicts, blocked means a required review or a
// failing check, behind means the base moved.
if (merge) {
  const method = flag('method') || 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) {
    console.error(`--method must be merge, squash or rebase (got "${method}").`);
    process.exit(2);
  }
  const pr = await api('GET', `/repos/${repo}/pulls/${merge}`);
  if (pr.status !== 200) {
    console.error(`Could not read PR #${merge}: HTTP ${pr.status} ${(pr.json && pr.json.message) || ''}`);
    process.exit(1);
  }
  if (pr.json.merged) {
    console.log(`PR #${merge} is already merged: ${pr.json.html_url}`);
    process.exit(0);
  }
  if (pr.json.state !== 'open') {
    console.error(`PR #${merge} is ${pr.json.state}, not open. Nothing was merged.`);
    process.exit(1);
  }
  console.error(`PR #${merge}: ${pr.json.title}`);
  console.error(`  ${pr.json.head.ref} -> ${pr.json.base.ref}   ${pr.json.commits} commit(s), `
    + `+${pr.json.additions}/-${pr.json.deletions} across ${pr.json.changed_files} file(s)`);
  console.error(`  mergeable=${pr.json.mergeable}  state=${pr.json.mergeable_state}`);
  if (pr.json.mergeable === false) {
    console.error(`Refusing to merge: GitHub reports the branch is not mergeable `
      + `(${pr.json.mergeable_state}). Resolve that first — nothing was merged.`);
    process.exit(1);
  }

  const res = await api('PUT', `/repos/${repo}/pulls/${merge}/merge`, { merge_method: method });
  if (res.status === 200 && res.json.merged) {
    console.log(`PR #${merge} merged (${method}) into ${pr.json.base.ref}: ${res.json.sha}`);
    console.log(`  ${pr.json.html_url}`);
    process.exit(0);
  }
  console.error(`Merge failed: HTTP ${res.status} ${(res.json && res.json.message) || res.text.slice(0, 200)}`);
  process.exit(1);
}

// Editing an existing PR's title/body — the usual reason is that the branch grew
// after the PR was opened and the description no longer describes it.
if (update) {
  const payload = {};
  if (title) payload.title = title;
  if (bodyFile) payload.body = body;
  if (!Object.keys(payload).length) {
    console.error('--update needs --title and/or --body-file.');
    process.exit(2);
  }
  const res = await api('PATCH', `/repos/${repo}/pulls/${update}`, payload);
  if (res.status === 200) {
    console.log(`PR #${res.json.number} updated: ${res.json.html_url}`);
    process.exit(0);
  }
  console.error(`GitHub returned HTTP ${res.status}: ${(res.json && res.json.message) || res.text.slice(0, 200)}`);
  process.exit(1);
}

// An existing PR for the same head is not an error — report it and stop, rather
// than failing in a way that invites a retry that would open a duplicate.
const existing = await api('GET', `/repos/${repo}/pulls?head=${encodeURIComponent(repo.split('/')[0] + ':' + head)}&state=open`);
if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length) {
  console.log(`A pull request is already open for ${head}:`);
  for (const pr of existing.json) console.log(`  #${pr.number}  ${pr.html_url}`);
  process.exit(0);
}

const created = await api('POST', `/repos/${repo}/pulls`, {
  title, head, base, body, draft: args.includes('--draft'),
});

if (created.status === 201) {
  console.log(`PR #${created.json.number} opened: ${created.json.html_url}`);
  process.exit(0);
}

console.error(`GitHub returned HTTP ${created.status}`);
const errors = created.json && created.json.errors;
if (created.json && created.json.message) console.error(`  ${created.json.message}`);
if (Array.isArray(errors)) for (const e of errors) console.error(`  ${e.message || JSON.stringify(e)}`);
if (!created.json) console.error(created.text.slice(0, 400));
process.exit(1);
