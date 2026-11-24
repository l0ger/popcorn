<p align="center"><img src="assets/logo-256.png" width="160" alt="popcorn logo: a striped popcorn bucket with a green check mark"></p>

# popcorn: deterministic AI development workflows for coding agents

**popcorn makes your AI coding agent follow your team's development workflow: every phase, every quality gate, every human approval, in order.** You describe the workflow once in a YAML file (for example Plan → Design → Build → Test → Publish → Review → Deploy), and popcorn enforces it through the agent's own hooks. It runs as a **Claude Code plugin** today, and **GitHub Copilot** support is on the roadmap: one workflow file, whichever agent your team uses. The agent can't skip the tests, can't merge without a code review, can't push to `main` before you approve, and can't quietly edit its own rules. It ships with ready-made agents (product manager, architect, implementer, test engineer, and code, quality and security reviewers) that you can override one by one, and it uses your project's normal MCP servers.

Spec-driven development, TDD and multi-agent code review, as a workflow you can't accidentally skip.

---

## Why popcorn?

AI coding agents are fast, and they cut corners when you're not watching. They "finish" without running the tests, review their own work, push before anyone looked, and forget the process you explained three prompts ago. Prompts and `CLAUDE.md` rules are suggestions. popcorn turns them into **guarantees**:

| Without popcorn | With popcorn |
|---|---|
| "Please run the tests before you finish" | The agent **can't end its turn** until the phase's gate commands pass |
| "Don't push until I've looked" | `git push` is **refused** until you type `popcorn approve` |
| "Get the code reviewed" | Review **isn't complete** until each reviewer agent has filed a valid JSON verdict; a HIGH finding **sends the run back to Build** |
| "Only touch the docs while planning" | Edits outside the phase's paths are **refused** |
| Process lives in a long prompt | Process lives in `.popcorn/workflow.yaml`, versioned with your code |

## Features

- **YAML-defined workflows.** Phases, agents, artifacts, gate commands, approvals, allowed paths, commands and MCP servers. Change the YAML and the workflow changes. No code.
- **Enforced phase order.** The agent works on one phase at a time and can't move on until that phase is done.
- **Quality gates.** Any shell command (`npm test`, `pytest`, `make lint`, `cargo clippy`) must pass before a phase is complete. Passing results are cached per working-tree state, so an unchanged tree doesn't rerun a suite that passed. Failures are always rerun, since a gate can depend on more than the tree (for example what was pushed).
- **Human-in-the-loop approvals.** `approval: before` or `approval: after` on any phase. Only **you** can approve, by typing `popcorn approve` as a prompt. The agent has no command that approves.
- **Guardrails.** Commands that are always denied, guarded commands and MCP tools (push, merge) that unlock only after your approval or once the reviewer agents approve, per-phase editable paths, and per-phase MCP allowlists. popcorn's own state is out of the agent's reach.
- **Visible on GitHub.** The starter workflow pushes the branch and opens a pull request, posts each reviewer's findings on it as a review, and merges it once every reviewer agent approves (see [GitHub pull requests](#github-pull-requests)).
- **Structured multi-agent review.** Reviewer agents write JSON verdicts validated against a JSON Schema in your workflow. Blocking severities loop the run back to Build, with the findings.
- **Ready-made agents, overridable.** Seven agents ship with the plugin. Put a `.claude/agents/code-reviewer.md` in your project and popcorn uses yours instead.
- **Your MCP servers.** popcorn reads nothing special: it uses your project's `.mcp.json`. Phases can restrict which servers are allowed.
- **Fail-safe.** No run → popcorn is invisible. Broken workflow mid-run → tool calls are refused, not silently allowed.
- **Agent-neutral engine.** The workflow engine knows nothing about any one agent. Claude Code is supported today, GitHub Copilot is next, and other agents plug in through an adapter (see [Platforms](#platforms)).

## Quick start

1. **Install the plugin** in Claude Code (replace `OWNER` with the GitHub account that hosts this repository):
   ```
   /plugin marketplace add OWNER/popcorn
   /plugin install popcorn@popcorn
   ```
   To share it with your team, add the marketplace and the plugin to your project's `.claude/settings.json` (`extraKnownMarketplaces` and `enabledPlugins`).

2. **Set it up in your project:**
   ```
   /popcorn:init
   ```
   This copies the starter workflow to `.popcorn/workflow.yaml` and helps you replace the placeholder `npm test` gates with your real commands. Requires Node.js 20 or later.

3. **Start a run:**
   ```
   /popcorn:start p1-user-login Users can sign in with email and password
   ```
   Claude gets a brief for phase 1 and goes to work. When a phase needs you, popcorn stops and says so:
   ```
   popcorn approve                      # accept and continue
   popcorn reject cover password reset  # send it back with feedback
   popcorn status                       # where is the run?
   popcorn retry [hint]                 # a phase ran out of attempts
   popcorn abort                        # end the run
   ```
   (`/popcorn:approve`, `/popcorn:reject`, … work too.)

## How it works

```
 you ──"popcorn start"──▶ UserPromptSubmit hook ──▶ run created, phase 1 brief
                                                         │
 Claude works ──every tool call──▶ PreToolUse hook ──▶ allowed / refused (phase rules, guardrails)
                                                         │
 Claude tries to finish ──▶ Stop hook ──▶ artifacts? agent outputs? gates pass?
                                │                ├─ no  → "keep going: <what's missing>"
                                │                ├─ blocking review finding → back to Build
                                │                └─ yes → next phase brief, or wait for your approval
 you ──"popcorn approve"──▶ approval recorded (only from your prompt)
```

popcorn's engine is one small Node.js program bundled in the plugin. Each hook passes the event to it. The engine reads `.popcorn/workflow.yaml` and the run's state in `.popcorn/runs/<task>/state.json`, and answers allow, deny, continue or stop. The engine, not the model, decides when a phase is complete.

## The workflow file

```yaml
version: 1
name: my-team
policy:
  deny_shell: ["git push --force*", "git reset --hard*"]   # never allowed
  guarded_shell: ["git push*", "git merge*"]               # only in a phase that unlocks them
  guarded_mcp: ["*:merge_pull_request"]                    # MCP tools, as "<server>:<tool>"
  max_attempts_per_phase: 3
  blocking_severities: [BLOCKER, CRITICAL, HIGH]
  blocking_verdicts: [changes_requested]                   # a reviewer that doesn't approve sends the run back
phases:
  - id: plan
    agent: product-manager
    goal: Turn the request into a user story with acceptance criteria.
    artifacts: ["docs/plans/{task}.md"]
    approval: after
    allow: { edit: ["docs/**"] }
  - id: build
    agent: implementer
    goal: Implement it test-first.
    gates: ["npm test"]
  - id: review
    goal: Get it reviewed.
    outputs: { schema: review, required: [code-reviewer, security-reviewer] }
    on_fail: build
  - id: deploy
    goal: Merge and push.
    approval: before
    allow: { guarded: ["git push*", "git merge*"] }
schemas:
  review: { type: object, required: [verdict, findings] }
```

| Phase key | Meaning |
|---|---|
| `id`, `title`, `goal`, `instructions` | What the phase is for. `{task}` is replaced with the run's name. |
| `agent` | Subagent that does the work (plugin agent, or your project's override) |
| `artifacts` | Files that must exist before the phase is complete |
| `outputs` | JSON results each listed agent must write to `.popcorn/outputs/<task>/<phase>-r<round>/<agent>.json`, validated against `schemas.<schema>` |
| `on_fail` | Where to go when an output has a blocking finding |
| `gates` | Shell commands that must exit 0 |
| `approval` | `before` (you approve the start) or `after` (you approve the result) |
| `allow.edit` / `deny.edit` | Globs of editable paths in this phase |
| `allow.shell` / `deny.shell` | Shell command patterns for this phase |
| `allow.mcp` | MCP servers this phase may use |
| `allow.guarded` | Guarded commands (`policy.guarded_shell`) and MCP tools (`policy.guarded_mcp`) this phase unlocks after its `before` approval and/or its `unlock_after` phase's pass |
| `unlock_after` | An earlier phase that must have passed, in its current round, before `allow.guarded` unlocks. If that phase has `outputs`, every output must say `"verdict": "approve"`: the reviewer agents' approval stands in for yours |
| `next` | Jump to a phase other than the next one in the list |

Check your file at any time with `popcorn validate`. It reports every problem, not just the first.

## GitHub pull requests

The starter workflow makes every change visible on GitHub:

```
Build ─ commits on popcorn/<task>
Test ─ gates pass
Publish ─ pushes popcorn/<task> and opens a pull request into main; done when the remote branch is at HEAD
Review ─ three reviewer agents file JSON verdicts; each is posted on the PR as a COMMENT review
          └─ any reviewer not approving, or a blocking finding → back to Build, then Publish again
Deploy ─ unlocked only because every reviewer approved: merges the PR (no approval from you);
          done when the branch is in origin/main
```

Publish refuses `git push … main`, but that check is best effort (a bare `git push` while on `main` isn't caught), so protect `main` on GitHub too.

Publish, Review and Deploy use a GitHub MCP server from your project's `.mcp.json` (or the `gh` CLI if you have none). For GitHub's own server:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" }
    }
  }
}
```

Export `GITHUB_PERSONAL_ACCESS_TOKEN` before starting Claude Code, with a token that can push to the repository and write pull requests (contents, pull requests: read and write). Never commit the token. If you use `gh`, `export GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token)` works.

**Merging is guarded.** A GitHub MCP server can merge or write straight to a branch, so `policy.guarded_mcp` locks those tools (`merge_pull_request`, `push_files`, `create_or_update_file`, `delete_file`, `create_branch`, `update_pull_request_branch`) in every phase except one that unlocks them. `gh pr merge` and `gh api` are guarded too. If your server names its tools differently, add them to `guarded_mcp`.

**Reviews come from your account.** The server acts with your token, so the reviewers' reviews appear under your name, and GitHub doesn't let a PR's author approve their own PR. That's why reviews are posted as comments: the JSON verdicts in `.popcorn/outputs/` are what popcorn checks. Turn on branch protection for `main` as well.

## Agents

| Agent | Phase in the starter workflow | Role |
|---|---|---|
| `product-manager` | Plan | User story, acceptance criteria, scope |
| `architect` | Design | Approach, invariants → tests, ordered build steps |
| `implementer` | Build | Test-first implementation, one commit per step; fixes review findings |
| `test-engineer` | Test | Edge cases, error paths, checks that every new test can fail |
| `code-reviewer` | Review | Correctness, design, contracts, test quality |
| `quality-reviewer` | Review | Performance at scale, error handling, structure |
| `security-reviewer` | Review | Authorization, injection, secrets, data exposure, dependencies |

**Add or override agents.** Any agent name in the workflow resolves to your project's `.claude/agents/<name>.md` if it exists, and otherwise to the plugin's `popcorn:<name>`. To use your own reviewer, add `.claude/agents/code-reviewer.md`. To add a new one, create it and reference it in the YAML.

## Security model and limits

Read this before you rely on popcorn:

- **What's enforced:** phase order, done-conditions, approvals, editable paths, MCP allowlists, and the protection of popcorn's own state and workflow file during a run. While a run waits for your approval, edits, shell commands and MCP calls are all refused.
- **Shell rules are best effort.** popcorn splits chained commands and looks inside `bash -c '…'`, but a determined agent can disguise a command from any pattern matcher. Keep real protections (branch protection, CI, least-privilege credentials) in place. popcorn makes the right path the easy path. It doesn't replace your repository's security.
- **Approvals come only from your prompt.** The engine records an approval only when the user's own prompt says `popcorn approve`. No tool call can grant one.
- **The reviewers are only as independent as their brief.** The starter workflow stops the agent from editing `.claude/agents/`, `.claude/settings*.json` and `.mcp.json` during a run, so it can't swap in a reviewer that always approves. But the main session still writes each reviewer's prompt and could steer it. If that matters to you, keep `approval: before` on Deploy.
- **Or from the reviewers, where the workflow says so.** A phase with `unlock_after: review` unlocks its guarded commands once every reviewer filed `"verdict": "approve"`, with no prompt from you. Only the reviewer subagents can write those verdicts (see below). If you want to look before anything merges, add `approval: before` to that phase too: then both are needed.
- **Verdicts come only from the reviewer.** A reviewer's output file can be written only by a tool call that Claude Code attributes to that subagent (`agent_type`). The main session and other agents are refused, and shell commands can't touch `.popcorn/` at all.
- **Claude Code limits consecutive stop-hook continuations** (8 by default). Long stretches without an approval may hit it. Raise it with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, or add approvals to split the run.
- **Hooks run on every tool call** while the plugin is enabled. Without `.popcorn/` in the project, popcorn exits immediately and changes nothing.
- Don't run Claude Code in `--bare` mode: it skips plugin hooks.

## Platforms

popcorn's engine (`src/core`) knows nothing about Claude Code. Each platform is an **adapter** (`src/adapters/<name>`) that translates the platform's hook payloads into popcorn's normalized events (`session_start`, `prompt`, `before_tool`, `stop`) and renders the engine's decision back.

| Platform | Status |
|---|---|
| Claude Code (CLI, VS Code, JetBrains) | ✅ supported |
| GitHub Copilot | 🗺️ on the roadmap: the next adapter |
| Other coding agents with hooks | adapter interface ready (`src/adapters/types.ts`), contributions welcome |

The workflow file, the gates and the run state are shared across platforms, so a team can move between agents without rewriting its process.

A new adapter implements `parse`, `render`, `renderCrash` and `agentRef`, is registered in `src/adapters/registry.ts`, and must pass the shared contract suite in `tests/unit/adapter-contract.ts`.

## Development

```bash
npm install
npm run check      # typecheck, build the bundle, run unit and end-to-end tests
npm run build      # rebuild plugin/dist/popcorn.mjs (committed: the plugin runs it directly)
```

Layout:
```
.claude-plugin/marketplace.json   marketplace entry (this repo is its own marketplace)
plugin/                           the Claude Code plugin
  .claude-plugin/plugin.json      manifest
  hooks/hooks.json                SessionStart, UserPromptSubmit, PreToolUse, Stop → popcorn hook claude
  agents/                         the seven default agents
  skills/                         /popcorn:start, approve, reject, retry, abort, status, init
  templates/workflow.yaml         starter six-phase workflow
  bin/popcorn                     CLI on the Bash tool's PATH
  dist/popcorn.mjs                bundled engine (generated)
src/core/                         platform-neutral engine: workflow, policy, state, engine
src/adapters/                     adapter interface, registry, Claude Code adapter
src/cli/                          popcorn command line
tests/unit/                       engine, policy, workflow, adapter contract, CLI
tests/e2e/                        the bundled hook fed real payloads in a temporary git repo
```

## FAQ

**Is this a replacement for Spec Kit, BMAD or similar prompt packs?** It's complementary. Those give an agent a method. popcorn makes the method binding. You can put their prompts into popcorn's agents and phases.

**Does it work without subagents?** Yes. A phase without `agent` is done by the main session, and the same gates and rules apply.

**Can a workflow branch or loop?** Yes. `on_fail` loops back, for example from Review to Build, and `next` jumps.

**Where's the run state?** In `.popcorn/runs/<task>/state.json` and `.popcorn/outputs/`. `popcorn init` writes a `.popcorn/.gitignore` that keeps both out of commits; commit `.popcorn/workflow.yaml` itself.

## License

[MIT](LICENSE). The bundled engine includes third-party packages under MIT, ISC and BSD-3-Clause licenses; see [`plugin/dist/THIRD_PARTY_NOTICES.md`](plugin/dist/THIRD_PARTY_NOTICES.md).

---

*Keywords: Claude Code plugin, GitHub Copilot workflow, AI coding workflow, deterministic agent workflow, SDLC automation, YAML workflow engine, Claude Code hooks, AI guardrails, quality gates, human-in-the-loop approval, test-driven development with AI, multi-agent code review, spec-driven development, agentic software engineering.*
