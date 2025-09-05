#!/usr/bin/env node
// Shim: map GitHub Action inputs (exposed as INPUT_*) to expected environment variable names
// This allows the same script to operate both as a standalone CLI (explicit env vars)
// and as a GitHub Action using 'with:' inputs without adding @actions/core dependency.
// GitHub converts input names to uppercase and replaces spaces with underscores, prefixed by INPUT_.
function mapInput(name, targetEnv) {
  const key = `INPUT_${name.toUpperCase()}`;
  if (process.env[key] && !process.env[targetEnv]) {
    process.env[targetEnv] = process.env[key];
  }
}
mapInput('github_token', 'GITHUB_TOKEN');
mapInput('owner', 'OWNER');
mapInput('repos', 'REPOS');
mapInput('review_hours', 'REVIEW_HOURS');
mapInput('max_closed_lookback_days', 'MAX_CLOSED_LOOKBACK_DAYS');
mapInput('dry_run', 'DRY_RUN');
mapInput('include_forks', 'INCLUDE_FORKS');
mapInput('include_archived', 'INCLUDE_ARCHIVED');

const { Octokit } = require('@octokit/rest');

if (!process.env.GITHUB_TOKEN) {
  console.error('Missing GITHUB_TOKEN env var. Exiting.');
  process.exit(1);
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Configuration via environment variables (can be wired through action inputs)
// Either supply REPOS (comma-separated). Each item may be `owner/repo` or just `repo`.
// If owner omitted in REPOS, you MUST supply OWNER (or legacy ORG).
// If REPOS not provided, OWNER is required and repositories will be auto-discovered.
const OWNER = process.env.OWNER || process.env.ORG || ''; // legacy ORG fallback
const REPOS_RAW = (process.env.REPOS || '')
  .split(',')
  .map(r => r.trim())
  .filter(Boolean);
const REVIEW_HOURS = parseFloat(process.env.REVIEW_HOURS || '12');
const MAX_CLOSED_LOOKBACK_DAYS = parseInt(process.env.MAX_CLOSED_LOOKBACK_DAYS || '14', 10);
const DRY_RUN = /^true$/i.test(process.env.DRY_RUN || 'false');
const INCLUDE_FORKS = /^true$/i.test(process.env.INCLUDE_FORKS || 'false');
const INCLUDE_ARCHIVED = /^true$/i.test(process.env.INCLUDE_ARCHIVED || 'false');

function log(...args) { console.log(new Date().toISOString(), ...args); }

function parseExplicitRepos() {
  if (!REPOS_RAW.length) return [];
  const parsed = [];
  for (const entry of REPOS_RAW) {
    if (!entry) continue;
    const parts = entry.split('/');
    if (parts.length === 1) {
      if (!OWNER) {
        throw new Error(`Repository '${entry}' missing owner. Provide OWNER env var or use 'owner/repo' form.`);
      }
      parsed.push({ owner: OWNER, name: parts[0] });
    } else if (parts.length === 2) {
      parsed.push({ owner: parts[0], name: parts[1] });
    } else {
      throw new Error(`Invalid repo spec: '${entry}'. Use 'owner/repo' or 'repo'.`);
    }
  }
  return parsed;
}

async function autoDiscoverRepos() {
  if (!OWNER) {
    throw new Error('OWNER env var required when REPOS not provided.');
  }
  log('Auto-discovering repositories for owner', OWNER);
  const repos = [];
  let page = 1;
  let isOrg = true;
  while (true) {
    let data;
    try {
      // Try as organization first
      ({ data } = await octokit.repos.listForOrg({ org: OWNER, per_page: 100, page }));
    } catch (err) {
      if (err.status === 404) {
        isOrg = false;
      } else {
        throw err;
      }
    }
    if (!isOrg) {
      // Fallback to user listing
      const { data: userData } = await octokit.repos.listForUser({ username: OWNER, per_page: 100, page });
      data = userData;
    }
    if (!data || !data.length) break;
    repos.push(
      ...data
        .filter(r => (INCLUDE_ARCHIVED || !r.archived) && (INCLUDE_FORKS || !r.fork))
        .map(r => ({ owner: r.owner.login, name: r.name }))
    );
    page++;
  }
  return repos;
}

async function listRepos() {
  const explicit = parseExplicitRepos();
  if (explicit.length) return explicit;
  return autoDiscoverRepos();
}

async function notifyInactiveReviewers(owner, repo) {
  log(`[${owner}/${repo}] Checking open PRs for inactive reviewers (> ${REVIEW_HOURS}h)`);
  let page = 1;
  while (true) {
    const { data: prs } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 50, page });
    if (!prs.length) break;
    for (const pr of prs) {
      if (!pr.requested_reviewers || !pr.requested_reviewers.length) continue;
      const { data: reviews } = await octokit.pulls.listReviews({ owner, repo, pull_number: pr.number });
      for (const reviewer of pr.requested_reviewers) {
        const reviewByUser = reviews.find(r => r.user && r.user.login === reviewer.login);
        const assignedTime = new Date(pr.created_at); // simplification
        const hoursSinceRequested = (Date.now() - assignedTime) / 36e5;
        if (!reviewByUser && hoursSinceRequested > REVIEW_HOURS) {
          const body = `@${reviewer.login} You were requested for review ${hoursSinceRequested.toFixed(1)} hours ago (threshold ${REVIEW_HOURS}h). Please review this PR.`;
          if (DRY_RUN) {
            log(`[DRY_RUN] Would comment on PR #${pr.number}: ${body}`);
          } else {
            await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body });
            log(`Commented reminder on PR #${pr.number} for @${reviewer.login}`);
          }
        }
      }
    }
    page++;
  }
}

async function notifyUndeletedBranches(owner, repo) {
  log(`[${owner}/${repo}] Checking merged PRs for undeleted branches (lookback ${MAX_CLOSED_LOOKBACK_DAYS}d)`);
  const since = Date.now() - MAX_CLOSED_LOOKBACK_DAYS * 864e5;
  let page = 1;
  while (true) {
    const { data: prs } = await octokit.pulls.list({ owner, repo, state: 'closed', per_page: 50, page, sort: 'updated', direction: 'desc' });
    if (!prs.length) break;
    let anyWithinWindow = false;
    for (const pr of prs) {
      const updated = new Date(pr.updated_at).getTime();
      if (updated < since) continue; // skip old
      anyWithinWindow = true;
      if (pr.merged_at) {
        const branchName = pr.head.ref;
        try {
          await octokit.git.getRef({ owner, repo, ref: `heads/${branchName}` });
      const body = `@${pr.user.login} The PR was merged but the branch \`${branchName}\` still exists. Please delete it if it's no longer needed.`;
          if (DRY_RUN) {
            log(`[DRY_RUN] Would comment on PR #${pr.number}: ${body}`);
          } else {
            await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body });
            log(`Commented branch reminder on PR #${pr.number}`);
          }
        } catch (error) {
          if (error.status === 404) {
            // branch already deleted; ignore
          } else {
            log('Error checking ref', branchName, error.status || error.message);
          }
        }
      }
    }
    if (!anyWithinWindow) break; // further pages will be older
    page++;
  }
}

async function main() {
  const repos = await listRepos();
  log('Target repositories:', repos.map(r => `${r.owner}/${r.name}`).join(', '));
  for (const { owner, name } of repos) {
    try {
    await notifyInactiveReviewers(owner, name);
    await notifyUndeletedBranches(owner, name);
    } catch (e) {
    log(`Error processing repo ${owner}/${name}:`, e.status || e.message);
    }
  }
  log('Completed run');
}

main().catch(err => { console.error(err); process.exit(1); });
