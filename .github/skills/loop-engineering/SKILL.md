---
name: loop-engineering
description: Design or operate a bounded closed engineering loop with explicit observation, action, verification, decision, memory, budget, and stop conditions. Use for recurring maintenance, autonomous execution, or issue-to-PR workflows.
---

# Loop Engineering

Before acting, write down:

1. The measurable goal and scope.
2. The current observable evidence.
3. The smallest allowed action.
4. The deterministic verification that can disprove success.
5. The retry, completion, and escalation decision rule.
6. The persistent state location.
7. The iteration or AI-credit budget.

Separate maker and checker roles for behavioral changes. Use a branch or worktree when work can collide. Prefer GitHub Issues as the discovery queue and pull requests as the review and decision record.

Stop when acceptance criteria pass, the budget is exhausted, evidence becomes ambiguous, permissions or credentials are missing, or a human product, security, or merge decision is required.

