# Popcorn documentation

Popcorn makes a coding agent follow a team's development workflow. The workflow is a YAML file of phases. Popcorn enforces it through the agent's own hooks: it refuses tool calls that break the current phase's rules, and it decides, not the model, when a phase is complete.

The [project README](../README.md) is the user guide: install, quick start, the workflow file reference and the security model. These pages explain how popcorn works inside.

| Page | What it covers |
|---|---|
| [Architecture](architecture.md) | Components and their boundaries, the architecture diagram, how one hook event flows through the engine, how a tool call is checked, the run's state machine, and the files popcorn keeps |
| [GitHub flow](github-flow.md) | How the starter workflow makes each run visible on GitHub: branch, pull request, reviews posted on it, and a merge unlocked by the reviewers' approval |
| [Development](development.md) | Building and testing popcorn, the layout of the repository, the rules for changing it, and how to add a platform |

## Concepts in one place

| Term | Meaning |
|---|---|
| **Workflow** | `.popcorn/workflow.yaml`: a policy and an ordered list of phases |
| **Run** | One task going through the workflow, started by the user's prompt `popcorn start <task> <description>`. One run is active at a time |
| **Phase** | A step of the workflow, with a goal, an optional agent, done-conditions and rules |
| **Done-conditions** | What the engine checks when the agent tries to stop: artifacts (files exist), outputs (agents' JSON results match a schema), gates (shell commands exit 0), and an `after` approval |
| **Round** | How many times a phase has been entered. A blocking review sends the run back to Build in a new round |
| **Approval** | Recorded only when the user's own prompt says `popcorn approve`. No tool call can grant one |
| **Guarded** | Shell patterns (`policy.guarded_shell`) and MCP tools (`policy.guarded_mcp`) that are refused except in a phase that unlocks them |
| **Unlock** | A phase unlocks its `allow.guarded` patterns after its `before` approval, and/or once its `unlock_after` phase has passed with every reviewer approving |
| **Adapter** | Translates one platform's hook payloads (Claude Code today) into popcorn's events, and popcorn's decisions back |
