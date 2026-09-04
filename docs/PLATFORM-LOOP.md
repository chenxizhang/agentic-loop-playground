# How the Platform Applies Loop Engineering to Itself

**Agentic Loop Playground** is built and maintained as a loop rather than as a static tutorial.

## Goal

Keep the workshop executable, current with GitHub Copilot CLI, and resistant to false-positive completion.

## Observe

- Unit test results for curriculum and validators
- GitHub Actions results
- Open issues labeled `loop:ready`, `loop:blocked`, and `loop:verify`
- Learner checkpoint failures
- Independent code review findings

## Act

- Select one ready issue
- Assign a narrow implementation owner
- Work on an isolated branch or worktree
- Make the smallest change that satisfies explicit acceptance criteria
- Update curriculum and validators together when behavior changes

## Verify

- Run `npm run validate`
- Run the affected lesson checkpoint
- Use an independent verifier or `/review`
- Require the pull request Loop Evidence checklist

## Decide

- Merge only when deterministic checks pass and a human approves
- Retry only when new evidence identifies a bounded correction
- Escalate ambiguous product, security, cost, or policy decisions

## Stop conditions

- Acceptance criteria and validation pass
- No unresolved high-confidence review finding remains
- The iteration or AI-credit budget is exhausted
- A requested action crosses the documented trust boundary
- Human judgment is required

## Persistent memory

GitHub issues contain the queue and claims. Pull requests contain implementation evidence and human decisions. Repository instructions and skills contain durable operating knowledge. `.workshop/progress.json` contains local learner state and is intentionally not committed.
