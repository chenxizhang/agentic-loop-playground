# Promotion Plan

This plan promotes Agentic Loop Playground as a practical workshop for engineers and teams who want to learn safe, measurable agentic coding with GitHub Copilot CLI.

## Positioning

**One-line pitch:** Learn Loop Engineering by operating a real GitHub-native agentic coding loop, not by reading slides.

**Core promise:** In 60-90 minutes, a learner experiences the complete cycle from goal definition to issue queue, agent execution, independent verification, pull request evidence, and safe stop conditions.

**Primary audiences**

| Audience | Trigger | Message |
|---|---|---|
| Individual developers | "I want to use AI agents without losing control." | Practice the exact control loop on a local repository before applying it at work. |
| Engineering leads | "How do I govern AI coding work?" | Turn agent work into auditable evidence: issues, branches, checks, reviews, and PR decisions. |
| DevRel and trainers | "I need a Copilot CLI workshop." | Run an executable lab with deterministic checkpoints instead of a static presentation. |
| Enterprise enablement teams | "We have restricted environments." | Use release tarballs and offline npm install paths while preserving GitHub-native workflows. |

## Domestic channels

| Channel | Format | Hook | Call to action |
|---|---|---|---|
| 微信公众号 | 1200-1800 字技术文章 | "AI Agent 不是自动驾驶，而是一个可验证的工程闭环" | 运行 `npx -y agentic-loop-playground`，完成 Lab 00-01 |
| 掘金 / CSDN / 博客园 | 实操教程 + 截图 | "用 GitHub Copilot CLI 做一次真正可审计的 Agentic Coding 训练" | Star repo，按 README 启动 |
| 知乎 | 问答式长文 | "团队怎样避免 AI Agent 乱改代码？" | 引导到学习路径与平台闭环文档 |
| Bilibili | 8-12 分钟演示视频 | 从 issue 到 PR 的闭环演示 | 评论区置顶安装命令和仓库链接 |
| 小红书 | 6-8 张卡片 | "AI 编程从提示词进化到工程闭环" | 收藏清单，进入 GitHub 仓库 |
| 技术社群 | 30 分钟 live demo | 现场跑通 Lab 00、Lab 01、一次 checkpoint | 招募第一批试学反馈 |

## International channels

| Channel | Format | Hook | Call to action |
|---|---|---|---|
| GitHub README / topics | Searchable repo metadata | "Loop Engineering workshop for GitHub Copilot CLI" | Star, fork, run with npx |
| X / LinkedIn | Short demo thread | "Agentic coding needs a control loop, not just a bigger prompt." | Link to README quick start |
| Dev.to / Hashnode | Tutorial article | "Build a safe agentic coding loop with GitHub Copilot CLI" | Complete the first two labs |
| Reddit / Hacker News | Show HN style post | "A hands-on repo for practicing safe AI-agent coding loops" | Invite critique and workshop trials |
| GitHub Discussions / Issues | Feedback prompts | "Which loop evidence is missing for your team?" | Convert feedback into labeled issues |
| Conference CFPs / meetups | 30-45 minute workshop | "From prompt to governed loop" | Use the repo as workshop material |

## Four-week launch loop

| Week | Goal | Actions | Evidence |
|---|---|---|---|
| 1 | Prepare discoverability | Update README, npm metadata, GitHub description/topics, and first demo script. | Repo metadata complete, validation green, demo command works. |
| 2 | Seed domestic attention | Publish one Chinese article, one short video, and share to 3-5 trusted engineering groups. | Views, stars, comments, first learner issues. |
| 3 | Seed international attention | Publish an English tutorial, X/LinkedIn thread, and submit a Show HN or relevant community post. | Referral traffic, stars/forks, discussion comments. |
| 4 | Convert feedback into product proof | Triage comments into GitHub issues, fix top onboarding friction, publish a short "what we learned" update. | Closed issues, updated docs, repeatable workshop outline. |

## Content angles

1. **From prompt engineering to loop engineering:** show why observation, verification, and stop conditions matter more than a clever prompt.
2. **A safe Copilot CLI workshop:** emphasize approvals, local Git state, deterministic checkpoints, and independent review.
3. **AI coding governance for teams:** map labs to issues, worktrees, Actions, pull requests, and durable evidence.
4. **Offline-friendly enablement:** highlight release tarballs and restricted-environment installation paths.

## Reusable copy

**Chinese short post**

> 我做了一个 Agentic Loop Playground：不是教你写更长的提示词，而是用 GitHub Copilot CLI 练习一个完整的工程闭环。你会在真实仓库里经历目标定义、Issue 队列、隔离分支、Agent 执行、测试验证、独立复核和 PR 证据。适合想把 AI Agent 引入团队但又不想失控的开发者。运行：`npx -y agentic-loop-playground`

**English short post**

> I built Agentic Loop Playground, a hands-on workshop for practicing safe agentic coding with GitHub Copilot CLI. It teaches the operating loop around agents: goal, evidence, isolated action, deterministic checks, independent review, persistent decisions, and stop conditions. Try it with `npx -y agentic-loop-playground`.

## Measurement

| Metric | Target signal | Follow-up decision |
|---|---|---|
| Stars and forks | Repo-level interest | If stars grow but forks do not, improve contribution/workshop guidance. |
| npx installs and release downloads | Trial intent | If downloads are low, shorten the quick-start and add a GIF/video. |
| Issues and discussions | Learning friction | Convert repeated friction into labeled improvement issues. |
| Article/video engagement | Message fit | Double down on the top two content angles by save/comment ratio. |
| Completed checkpoint reports | Workshop effectiveness | Improve labs where learners fail before understanding the loop concept. |

## Operating cadence

Run promotion as the same loop taught by the repo:

1. Observe traffic, comments, stars, installs, and learner failures.
2. Pick one audience and one channel per iteration.
3. Publish the smallest useful artifact.
4. Verify by concrete engagement and learner evidence.
5. Persist findings in GitHub Issues or documentation.
6. Stop or pivot when the channel produces no qualified engagement after two iterations.
