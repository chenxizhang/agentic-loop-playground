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
    description: Optional GitHub token for external repository reads and future git clone operations.
tools:
  github:
    mode: local
    github-token: ${{ secrets.GH_TOKEN || secrets.GITHUB_TOKEN }}
    toolsets: [repos, issues, pull_requests]
  bash: [cat]
steps:
  - name: Select hot public repositories
    env:
      GH_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
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
  - name: Probe shallow repository clones
    env:
      GH_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/data /tmp/gh-aw/external-repos
      results_jsonl=/tmp/gh-aw/data/clone-results.jsonl
      : > "$results_jsonl"
      failures=0

      jq -c '.repositories[]' /tmp/gh-aw/data/hot-repositories.json | while read -r repository; do
        full_name="$(jq -r '.full_name' <<<"$repository")"
        target="/tmp/gh-aw/external-repos/${full_name//\//__}"
        log="/tmp/gh-aw/data/${full_name//\//__}-clone.log"
        rm -rf "$target"

        if timeout 120 gh repo clone "$full_name" "$target" -- --depth=1 --filter=blob:none --sparse >"$log" 2>&1; then
          head_sha="$(git -C "$target" rev-parse --short HEAD)"
          root_entries="$(find "$target" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')"
          jq -n \
            --arg repo "$full_name" \
            --arg status success \
            --arg target "$target" \
            --arg head_sha "$head_sha" \
            --argjson root_entries "$root_entries" \
            '{repo: $repo, status: $status, target: $target, head_sha: $head_sha, root_entries: $root_entries}' >> "$results_jsonl"
        else
          failures=$((failures + 1))
          message="$(tail -c 2000 "$log")"
          jq -n \
            --arg repo "$full_name" \
            --arg status failed \
            --arg message "$message" \
            '{repo: $repo, status: $status, message: $message}' >> "$results_jsonl"
        fi
      done

      jq -s '{generated_at: (now | todate), clones: .}' "$results_jsonl" > /tmp/gh-aw/data/clone-results.json
      cat /tmp/gh-aw/data/clone-results.json
      if jq -e '.clones[] | select(.status != "success")' /tmp/gh-aw/data/clone-results.json >/dev/null; then
        echo "::error::One or more shallow repository clone probes failed."
        exit 1
      fi
safe-outputs:
  create-issue:
    title-prefix: "[ai-readiness-scout] "
    max: 1
    deduplicate-by-title: true
network:
  allowed:
    - defaults
    - "api.github.com"
    - "github.com"
---

# Hot Repository AI Readiness Scout

## Task

Objective: create one issue in this repository that summarizes the ten hot public GitHub repositories listed in `/tmp/gh-aw/data/hot-repositories.json`, what each repository appears to do, and how mature each one is for AI-assisted development and Loop Engineering.

Read `/tmp/gh-aw/data/hot-repositories.json` first. If the file is missing, empty, malformed, or contains no repositories, call `noop` with a short reason and create no issue.

Analyze each repository with the GitHub MCP Server. The GitHub MCP Server and prefetch step prefer the repository secret `GH_TOKEN` for GitHub repository reads and external `gh` CLI operations, including the shallow clone probe stored in `/tmp/gh-aw/data/clone-results.json`, falling back to the built-in GitHub token when that optional secret is unavailable. Do not use `GH_TOKEN` for Copilot inference or model access; the agent's reasoning uses the workflow `copilot-requests: write` permission through the built-in GitHub token path. Use the precomputed repository list as the only candidate set; do not replace it with live search results. For each candidate, use GitHub MCP repository tools to inspect compact evidence, prioritizing:

- repository metadata from the candidate JSON
- shallow clone probe results from `/tmp/gh-aw/data/clone-results.json`
- root directory listing
- `README.md`, `README`, or equivalent readme files
- `AGENTS.md`
- `.github/copilot-instructions.md`
- `.github/workflows/`
- `.github/ISSUE_TEMPLATE/`
- `CONTRIBUTING.md`
- common manifests such as `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `pom.xml`
- short code-search checks scoped to the repository for `copilot`, `agent`, `agentic`, `AI`, `LLM`, `workflow_dispatch`, `loop`, and `verification`

Keep the analysis bounded. Do not perform additional clones beyond the deterministic shallow clone probe. Do not read large files in full when directory listings, metadata, and concise excerpts are enough. If a file or directory is unavailable, record that as missing evidence instead of failing the run. Treat code search as optional supplementary evidence: if GitHub code search is unavailable, rate-limited, or returns errors, continue from repository metadata, directory listings, and sampled files, and mention the limitation in the issue.

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
