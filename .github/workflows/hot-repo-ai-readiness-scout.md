---
emoji: "🔎"
description: Manually scout ten hot public GitHub repositories and report their AI readiness.
intent: Identify ten currently hot public repositories, explain what they do, and create one issue summarizing their AI readiness and Loop Engineering maturity.
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
secrets:
  GH_TOKEN:
    value: ${{ secrets.GH_TOKEN }}
    description: GitHub token for external repository reads and future git clone operations.
tools:
  github:
    mode: local
    github-token: ${{ secrets.GH_TOKEN }}
    toolsets: [repos, issues, pull_requests]
  bash: [cat]
steps:
  - name: Select hot public repositories
    env:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/data
      since="$(date -u -d '7 days ago' +%F)"
      gh api -X GET /search/repositories \
        -f q="stars:>100 pushed:>=$since archived:false fork:false" \
        -f sort=stars \
        -f order=desc \
        -F per_page=10 \
        | jq --arg since "$since" '{
            generated_at: (now | todate),
            selection: {
              description: "Top ten public, non-archived, non-fork repositories with more than 100 stars and a push in the last seven days, sorted by stars.",
              since: $since,
              sort: "stars desc",
              limit: 10
            },
            repositories: [
              .items[] | {
                full_name,
                owner: .owner.login,
                name,
                html_url,
                description,
                language,
                stargazers_count,
                forks_count,
                open_issues_count,
                pushed_at,
                default_branch,
                has_issues,
                topics
              }
            ]
          }' > /tmp/gh-aw/data/hot-repositories.json
safe-outputs:
  create-issue:
    title-prefix: "[ai-readiness-scout] "
    max: 1
    deduplicate-by-title: true
network:
  allowed:
    - defaults
    - "api.github.com"
---

# Hot Repository AI Readiness Scout

## Task

Objective: create one issue in this repository that summarizes the ten hot public GitHub repositories listed in `/tmp/gh-aw/data/hot-repositories.json`, what each repository appears to do, and how mature each one is for AI-assisted development and Loop Engineering.

Read `/tmp/gh-aw/data/hot-repositories.json` first. If the file is missing, empty, malformed, or contains no repositories, call `noop` with a short reason and create no issue.

Analyze each repository with the GitHub MCP Server. The GitHub MCP Server is configured with the repository secret `GH_TOKEN`; use that token only for GitHub repository reads and any future external `gh` CLI or `git clone` operations. Do not use `GH_TOKEN` for Copilot inference or model access; the agent's reasoning uses the workflow `copilot-requests: write` permission through the built-in GitHub token path. Use the precomputed repository list as the only candidate set; do not replace it with live search results. For each candidate, use GitHub MCP repository tools to inspect compact evidence, prioritizing:

- repository metadata from the candidate JSON
- root directory listing
- `README.md`, `README`, or equivalent readme files
- `AGENTS.md`
- `.github/copilot-instructions.md`
- `.github/workflows/`
- `.github/ISSUE_TEMPLATE/`
- `CONTRIBUTING.md`
- common manifests such as `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `pom.xml`
- short code-search checks scoped to the repository for `copilot`, `agent`, `agentic`, `AI`, `LLM`, `workflow_dispatch`, `loop`, and `verification`

Keep the analysis bounded. Do not clone repositories. Do not read large files in full when directory listings, metadata, and concise excerpts are enough. If a file or directory is unavailable, record that as missing evidence instead of failing the run. Treat code search as optional supplementary evidence: if GitHub code search is unavailable, rate-limited, or returns errors, continue from repository metadata, directory listings, and sampled files, and mention the limitation in the issue.

## Scoring rubric

Assign two scores for every repository:

- AI readiness: 0-5, based on explicit AI coding guidance, Copilot instructions, agent instructions, AI-related automation, clear setup instructions, and machine-actionable contributor guidance.
- Loop Engineering maturity: 0-5, based on explicit observe-act-verify loops, deterministic validation commands, CI, issue/PR templates, recurring maintenance automation, agentic workflows, and clear stop or escalation criteria.

Use evidence-based scores only. A repository can be excellent software while still scoring low if it lacks explicit AI-readiness or Loop Engineering signals.

## Required issue

Create exactly one issue in the current repository with:

- title: `Hot repository AI readiness report - YYYY-MM-DD`
- body containing:
  - the selection criteria and generation timestamp from `/tmp/gh-aw/data/hot-repositories.json`
  - a summary table with columns: `Repo`, `Purpose`, `Stars`, `Language`, `AI readiness`, `Loop maturity`, `Key evidence`, `Suggested follow-up`
  - one short detail section per repository with evidence paths inspected, missing signals, and the reasoning behind both scores
  - a final section named `Outreach caution` that says this run did not create issues in external repositories and that any outreach should be human-reviewed before posting

Call `noop` instead of creating an issue only when fewer than one repository can be analyzed from metadata plus root/file evidence, or when GitHub MCP repository content access is unavailable for the full run. Do not call `noop` solely because code-search checks are unavailable or rate-limited.

## Safe Outputs

Use `create_issue` for the report issue. Do not create issues, comments, pull requests, labels, or other visible outputs in any external repository.
