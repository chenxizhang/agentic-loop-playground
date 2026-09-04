# Agentic Loop Playground

**Agentic Loop Playground** is an interactive, repository-native workshop for learning Loop Engineering by building and operating real loops with GitHub Copilot and GitHub.

## Run with npx

After the package is published, start it from any directory:

```shell
npx -y agentic-loop-playground
```

Without a path, the command creates an isolated `agentic-loop-playground` repository under the current directory. Pass one positional path to choose an empty directory or an existing playground:

```shell
npx -y agentic-loop-playground .
npx -y agentic-loop-playground ./my-loop-lab
```

The path is resolved from the directory where `npx` runs. A non-empty directory that is not already a playground is rejected to prevent accidental changes to an existing project. `AGENTIC_LOOP_PLAYGROUND_WORKSPACE` is available as an environment-variable alternative; an explicit positional path takes precedence.

The launcher initializes local Git history, starts a loopback-only Node.js server, and opens the browser.

## Install without public npm registry access

Each GitHub Release provides platform-specific, self-contained npm tarballs for Windows x64, Linux x64, and macOS arm64. Download the asset that matches the target computer, transfer it through your approved internal channel if necessary, and install it without registry access:

```powershell
npm install --global --offline .\agentic-loop-playground-<version>-win32-x64.tgz
agentic-loop-playground
```

Linux and macOS assets use the same naming pattern with `linux-x64` or `darwin-arm64`. The tarball bundles the Copilot SDK, Copilot runtime, and platform-specific native dependencies, so npm does not need to resolve packages from the public registry during installation. Other architectures require an asset built on that architecture or an approved internal npm proxy.

If company policy also blocks GitHub Releases, place the downloaded asset in an approved internal artifact repository or shared software distribution location. An internal npm proxy such as Azure Artifacts, GitHub Packages, Artifactory, or Verdaccio is preferable for organization-wide distribution because it provides access control, retention, auditing, and repeatable installs.

It does not teach Loop Engineering as a collection of definitions. Every lesson asks the learner to change the repository through the embedded Copilot workspace pane, use GitHub collaboration primitives, and pass an automated checkpoint.

The browser pane is backed by the official GitHub Copilot SDK and is scoped to the generated playground repository. Workspace reads are allowed automatically. File writes, shell commands, URL access, MCP operations, and other elevated actions require explicit one-time approval in the browser.

## What learners build

During the workshop, learners progressively create a closed engineering loop:

```text
GitHub Issue -> discovery -> specialized agent -> isolated change
             -> tests and review -> pull request -> recorded state
             -> next issue or stop condition
```

The course maps the core Loop Engineering components to concrete GitHub tools:

| Loop component | GitHub Copilot CLI implementation |
|---|---|
| Automation | `/loop`, `/every`, programmatic `copilot -p`, GitHub Actions |
| Isolation | Git branches and `git worktree` |
| Skills | `.github/skills/*/SKILL.md` |
| Connectors | Built-in GitHub MCP server and GitHub CLI |
| Sub-agents | Custom agents, `/agent`, `/fleet`, review agents |
| Memory | GitHub Issues, pull requests, commits, evidence files, session resume |
| Verification | Tests, hooks, Actions, `/review`, independent verifier agent |

## Start the workshop

Prerequisites:

- Node.js 20.19 or newer, or Node.js 22.12 or newer
- Git
- A GitHub account with Copilot access
- GitHub CLI authenticated with `gh auth login` for the embedded Copilot pane and private repository analysis

The package includes the Copilot runtime used by the SDK. A separate GitHub Copilot CLI installation is not required. The launcher creates the practice Git repository automatically.

Lab 07 uses the experimental `/loop` alias for `/every`. Enable it in that session with `/experimental on`, or start Copilot CLI with `copilot --experimental`.

Run the browser platform:

```shell
npm run web:open
```

Or start only the server and open `http://127.0.0.1:4173` yourself:

```shell
npm run web
```

The terminal dashboard remains available as a secondary interface:

```shell
npm start
```

Useful source-repository commands for maintainers:

```shell
npm run doctor
node src/cli.js lesson 01
node src/cli.js check 01
npm run status
npm run grade
```

Initialize the GitHub-side exercises after pushing the repository:

```shell
npm run github:setup
```

Reset the intentionally broken CI repair scenario:

```shell
npm run scenario:reset
npm run test:practice
```

The second command is expected to fail before the learner completes Lab 06. The platform's own `npm test` command deliberately runs only tests under `test/`, keeping teaching failures separate from platform health.

## Recommended Copilot CLI session

Start Copilot from the repository root:

```shell
copilot
```

Then inspect the learning support included in the repository:

```text
/skills list
/agent
```

Use `@` file mentions when a lesson references a file. Do not enable `--allow-all` until you have reviewed the repository instructions, skills, hooks, and scripts.

## Curriculum

| Lab | Outcome |
|---|---|
| 00 | Verify the local and GitHub environment |
| 01 | Design a measurable closed loop |
| 02 | Encode durable knowledge with instructions and a skill |
| 03 | Use GitHub Issues as the loop's discovery queue and memory |
| 04 | Isolate parallel work with worktrees and specialized agents |
| 05 | Separate maker and checker responsibilities |
| 06 | Repair a failing implementation through a test-driven loop |
| 07 | Automate recurrence and define safe stop conditions |
| 08 | Run the capstone loop through a pull request |

See [docs/LEARNING-PATH.md](docs/LEARNING-PATH.md) for the teaching model and [docs/PLATFORM-LOOP.md](docs/PLATFORM-LOOP.md) for how this platform applies Loop Engineering to itself.

## Safety

The workshop deliberately creates branches, worktrees, issues, and pull requests. Read commands before approving them. Scheduled CLI prompts run only while their Copilot CLI session is open; GitHub Actions are the persistent automation mechanism used by this repository.
