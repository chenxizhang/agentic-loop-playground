# Playground Agent Instructions

This repository is a hands-on Loop Engineering lab.

Before editing, define the goal, observable evidence, smallest action, deterministic verification, persistent state, budget, and stop condition. Use a branch or worktree for isolated work and separate maker and checker roles.

## Commands

- Run workspace validation with `npm run validate`.
- Run the intentionally failing scenario with `npm run test:practice`.
- Reset the scenario with `npm run scenario:reset`.
- Create GitHub lab issues and labels with `npm run github:setup`.

## Boundaries

- Do not weaken tests to produce a passing result.
- Do not fabricate GitHub evidence.
- Do not automatically merge the capstone pull request.
- Stop for ambiguous product behavior, credentials, external integrations, security policy, destructive Git operations, or exhausted budgets.

