---
name: loop-engineering
description: Design or operate a bounded closed engineering loop with explicit observation, action, verification, decision, memory, budget, and stop conditions.
---

Before acting, define:

1. Measurable goal and scope.
2. Observable starting evidence.
3. Smallest allowed action.
4. Deterministic verification.
5. Retry, completion, and escalation rules.
6. Persistent state location.
7. Iteration or AI-credit budget.

Separate maker and checker roles. Use a branch or worktree when work can collide. Stop for ambiguity, boundary violations, exhausted budgets, or decisions that require a human.

