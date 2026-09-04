# Agentic Loop Playground Instructions

Treat every task as a bounded engineering loop: establish the goal, inspect current evidence, propose the smallest action, validate against deterministic checks, independently review meaningful changes, record durable state, and stop when acceptance criteria pass or a human decision is required.

This is a dependency-light Node.js 20+ project using ECMAScript modules and the built-in `node:test` runner. The interactive CLI is in `src/`, GitHub setup automation is in `scripts/`, lesson scenarios are in `scenarios/`, and the learner's mutable exercise is in `practice/`.

Always run `npm run validate` after platform changes. Run `npm run test:practice` only when working on the practice scenario; it intentionally fails in the starter state. Keep curriculum instructions in `src/curriculum.js` synchronized with validators in `src/validators.js`.

Never weaken a test or validator merely to produce a passing result. Never auto-merge pull requests. Escalate ambiguous domain behavior, credentials, external integrations, security policy, destructive Git operations, and exhausted iteration or AI-credit budgets.
