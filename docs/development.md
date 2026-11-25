# Development

## Setup

Requires Node.js 20 or later.

```
npm install
npm run check      # typecheck, rebuild plugin/dist/popcorn.mjs, run all tests
```

| Script | Does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Bundles `src/cli/main.ts` with esbuild into `plugin/dist/popcorn.mjs`, and regenerates `plugin/dist/THIRD_PARTY_NOTICES.md` |
| `npm test` | Unit and e2e tests (e2e needs a current bundle) |
| `npm run test:e2e` | Builds, then runs the e2e tests only |
| `npm run check` | All of the above. Run it after every change to `src/` |

**The bundle is committed.** Claude Code runs `plugin/dist/popcorn.mjs` straight from the plugin, so commit it together with the source change that produced it.

## Repository layout

```
.claude-plugin/marketplace.json   the marketplace entry for /plugin marketplace add
plugin/                           what Claude Code installs
  .claude-plugin/plugin.json      plugin manifest
  agents/                         the 7 generic agents (no project-specific rules)
  skills/                         /popcorn:start, approve, reject, retry, abort, status, init, validate
  hooks/hooks.json                SessionStart, UserPromptSubmit, PreToolUse and Stop → the bundle
  templates/workflow.yaml         the starter workflow
  dist/popcorn.mjs                the bundled engine (committed)
src/
  core/                           platform-neutral engine
    engine.ts                     event routing, commands, stop checks, briefs
    policy.ts                     checkTool: the pure allow/refuse decision
    workflow.ts                   YAML parsing and validation
    state.ts                      run state store
    types.ts                      workflow, state, event, decision and Env types
    node-env.ts                   the real Env (fs, child_process, clock)
  adapters/
    types.ts                      the Adapter interface
    registry.ts                   name → adapter
    claude/index.ts               Claude Code adapter
  cli/                            main.ts (process I/O) and run.ts (commands)
tests/
  unit/                           engine, policy, workflow, CLI, Claude adapter, adapter contract
  e2e/bundle.test.ts              the built bundle, fed real hook payloads, in a temporary git repository
scripts/third-party-notices.mjs   license notices for bundled dependencies
docs/                             these pages
```

## Rules for changing popcorn

These come from the project's `CLAUDE.md`:

- `src/core` is platform-neutral: no imports from `src/adapters` and no platform names. Side effects go through `Env`.
- With an active run, any engine error must refuse tool calls. A hook never exits non-zero, because Claude Code treats that as "allow".
- Only the user's prompt may approve, reject, retry or abort. Never add a CLI command or tool path for those.
- Keep the agents in `plugin/agents/` generic.

## Tests

| Layer | File | Uses |
|---|---|---|
| Policy | `tests/unit/policy.test.ts` | `checkTool` directly: edits, shell splitting, guarded shell and MCP, `unlock_after`, the approval hold |
| Workflow | `tests/unit/workflow.test.ts` | Parsing and every validation rule, including the starter template |
| Engine | `tests/unit/engine.test.ts` | The engine with an in-memory `Env` (`tests/helpers.ts`): phase moves, outputs, gates and their cache, approvals, fail safe |
| CLI | `tests/unit/cli.test.ts` | `run()` with fake I/O |
| Adapter | `tests/unit/claude-adapter.test.ts`, `adapter-contract.ts` | Payload parsing and rendering; the contract every adapter must pass |
| End to end | `tests/e2e/bundle.test.ts` | The real bundle in a temporary git repository, with the starter workflow, including a bare remote for the Publish gate |

## Adding a platform

1. Create `src/adapters/<name>/index.ts` that implements `Adapter` (`src/adapters/types.ts`):
   - `parse`: platform payload → `NormalizedEvent`.
   - `render`: `Decision` → the platform's output.
   - `renderCrash`: refuse tool calls when the engine itself fails.
   - `agentRef`: how a workflow agent name maps to the platform's agent.
2. Register it in `src/adapters/registry.ts`.
3. Run it through `tests/unit/adapter-contract.ts` and add its own unit tests.
4. Wire the platform's hooks to `popcorn hook <name>`.

Nothing in `src/core` changes.

## Working on popcorn with popcorn

You can run the GitHub flow on this repository. Install popcorn from the marketplace (`/plugin marketplace add l0ger/popcorn`) instead of loading `./plugin` from the working tree. Otherwise, during Build, the agent can edit the very bundle, hooks and reviewer agents that are checking it. An installed copy only changes after a merge and a plugin update.
