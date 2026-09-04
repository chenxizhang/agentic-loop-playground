# Repository Agent Instructions

This repository is an interactive Loop Engineering workshop for GitHub Copilot CLI.

## Operating loop

Always work from an explicit goal and acceptance criteria. Observe the current state before editing, make the smallest bounded change, run deterministic validation, request independent review for behavioral changes, and persist decisions in the relevant issue or pull request.

## Commands

- Run platform tests with `npm test`.
- Run all platform validation with `npm run validate`.
- Run the intentionally failing learner scenario with `npm run test:practice`.
- Reset that scenario with `npm run scenario:reset`.
- Inspect a checkpoint with `node src/cli.js check <ID>`.

## Boundaries

- Do not make the intentionally broken practice scenario pass unless Lab 06 or a task explicitly requests that repair.
- Do not weaken validators to make a lab pass.
- Do not claim GitHub evidence exists without querying GitHub.
- Do not merge a capstone pull request automatically.
- Stop for ambiguous domain rules, credentials, external services, security policy, or destructive Git operations.

