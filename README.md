# Repo Guardian

Remind inactive pull request reviewers and gently nudge authors to delete merged branches. Works across either:

* An entire organization (auto-discovers repositories)
* A personal user account
* An explicit list of repositories (`owner/repo` or just `repo` when combined with a single `owner`)

Usable as a **GitHub Action** or a small **CLI** (Node 18+).

---
## Features

* Detects open PRs with requested reviewers who haven't left a review within a threshold (default 12h) and comments reminders.
* Detects merged PRs whose source branches still exist and comments asking for cleanup.
* Auto-discovers repositories for an org or user (with optional inclusion of forks / archived repos).
* Dry-run mode for safe trial runs.

---
## GitHub Action Usage

Create a workflow, e.g. `.github/workflows/repo-guardian.yml`:

```yaml
name: Repo Guardian
on:
  schedule:
    - cron: '0 * * * *' # hourly
  workflow_dispatch: {}

jobs:
  remind:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - name: Run Repo Guardian (org-wide auto discovery)
        uses: MCKanpolat/RepoGuardian@v0.2.0
        with:
          owner: your-org-or-username
          review_hours: 12
          max_closed_lookback_days: 14
          dry_run: false
```

### Limiting to specific repositories
```yaml
    steps:
      - name: Specific repositories
        uses: MCKanpolat/RepoGuardian@v0.2.0
        with:
          repos: your-org/repo-one,your-org/repo-two
          review_hours: 6
```

### Mixed form (implicit owner)
```yaml
    steps:
      - name: Implicit owner
        uses: MCKanpolat/RepoGuardian@v0.2.0
        with:
          owner: your-org
          repos: repo-one,repo-two
```

### Include forks or archived repositories
```yaml
        with:
          owner: your-org
          include_forks: true
          include_archived: true
```

### Dry run (no comments posted)
```yaml
        with:
          owner: your-org
          dry_run: true
```

### Permissions
The default `GITHUB_TOKEN` needs `pull-requests: write` and `issues: write` to create reminder comments.

If you need to use a PAT instead (e.g., cross-repo or org-level constraints):
```yaml
    steps:
      - name: Repo Guardian with PAT
        uses: MCKanpolat/RepoGuardian@v0.2.0
        with:
          owner: your-org
          github_token: ${{ secrets.MY_PAT }}
```
Ensure the PAT has at least `repo` scope (private repos) or `public_repo` (public-only).

---
## Inputs
| Input | Description | Default |
|-------|-------------|---------|
| `github_token` | Custom token (defaults to `${{ github.token }}`) | (auto) |
| `owner` | Org or username (required if `repos` not set) |  |
| `repos` | Comma list of `owner/repo` or `repo` (needs `owner`) |  |
| `review_hours` | Hours before reminding reviewers | 12 |
| `max_closed_lookback_days` | Days window to scan merged PRs | 14 |
| `dry_run` | Log only, no comments | false |
| `include_forks` | Include forks on auto-discovery | false |
| `include_archived` | Include archived repos | false |

---
## CLI Usage
Install globally (optional):
```bash
npm install -g repo-guardian
```
Run with environment variables:
```bash
GITHUB_TOKEN=ghp_yourToken OWNER=your-org node remind-reviewers.js
```
Or via the installed binary:
```bash
GITHUB_TOKEN=ghp_yourToken OWNER=your-org repo-guardian
```
Limit to explicit repositories:
```bash
GITHUB_TOKEN=token REPOS=owner1/repoA,owner2/repoB repo-guardian
```
Implicit owner form:
```bash
GITHUB_TOKEN=token OWNER=your-org REPOS=repoA,repoB repo-guardian
```
Dry run:
```bash
GITHUB_TOKEN=token OWNER=your-org DRY_RUN=true repo-guardian
```
Additional toggles:
```bash
INCLUDE_FORKS=true INCLUDE_ARCHIVED=true ...
```

---
## Exit Codes
* `0` success
* `1` configuration or runtime error

---
## Development
Install deps:
```bash
npm install
```
Run locally (dry run):
```bash
GITHUB_TOKEN=token OWNER=your-org DRY_RUN=true node remind-reviewers.js
```

---
## Notes & Limitations
* Reviewer inactivity is approximated using PR creation time vs. first review; it does not currently track the exact time each reviewer was requested individually.
* Branch cleanup comments only appear for merged PRs whose head branch still exists.
* Pagination stops early for merged PR scanning when older than the lookback window.

---
## Roadmap Ideas
* Per-reviewer request timestamp tracking
* Slack / Teams notification bridge
* Config file support (YAML) for advanced rules

---
## License
MIT
