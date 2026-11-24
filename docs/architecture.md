# Architecture

popcorn is one small Node.js program, bundled into `plugin/dist/popcorn.mjs`. The coding agent runs it on each hook event. It reads the workflow and the run's state from disk, decides, and prints the answer in the platform's format. It keeps no process running between events.

## Architecture diagram

```mermaid
flowchart LR
    user([User])

    subgraph agent["Coding agent (Claude Code)"]
        session["Main session"]
        subagents["Subagents<br/>implementer, reviewers, ..."]
        hooks["Hooks<br/>SessionStart, UserPromptSubmit,<br/>PreToolUse, Stop"]
    end

    subgraph plugin["popcorn plugin (plugin/)"]
        hooksjson["hooks/hooks.json"]
        skills["skills/<br/>/popcorn:start, approve, ..."]
        agentsdir["agents/<br/>7 generic agents"]
        template["templates/workflow.yaml"]
        bin["bin/popcorn"]
    end

    subgraph bundle["plugin/dist/popcorn.mjs"]
        cli["CLI<br/>src/cli"]
        registry["Adapter registry<br/>src/adapters/registry.ts"]
        claude["Claude Code adapter<br/>src/adapters/claude"]
        subgraph core["Engine: src/core (platform-neutral)"]
            engine["Engine<br/>engine.ts"]
            policy["Policy<br/>policy.ts"]
            workflow["Workflow parser<br/>workflow.ts"]
            state["State store<br/>state.ts"]
            env["Env interface<br/>node-env.ts"]
        end
    end

    subgraph project["The user's project"]
        wfyaml[".popcorn/workflow.yaml"]
        runs[".popcorn/runs/&lt;task&gt;/state.json<br/>.popcorn/active"]
        outputs[".popcorn/outputs/&lt;task&gt;/&lt;phase&gt;-r&lt;n&gt;/*.json"]
        mcpjson[".mcp.json"]
        code["Source, tests, git"]
    end

    github[("GitHub<br/>branch, pull request,<br/>reviews, merge")]

    user -- prompts --> session
    session <--> subagents
    session -. every event .-> hooks
    subagents -. tool calls .-> hooks
    hooks --> hooksjson
    hooksjson -- "node popcorn.mjs hook claude" --> cli
    bin --> cli
    cli --> registry --> claude
    claude -- NormalizedEvent --> engine
    engine -- Decision --> claude
    engine --> policy
    engine --> workflow
    engine --> state
    engine --> env
    env --> wfyaml
    env --> runs
    env --> outputs
    env -- gate commands --> code
    session -- MCP tools --> mcpjson
    mcpjson --> github
    session -- git push --> github
```

The dashed arrows are hook events: Claude Code calls popcorn before it acts. popcorn never calls the agent; it only answers.

## Components

| Component | Where | Responsibility |
|---|---|---|
| Plugin | `plugin/` | What Claude Code installs: the hook wiring, slash-command skills, the generic agents, the starter workflow, the CLI wrapper and the committed bundle |
| CLI | `src/cli/` | `popcorn hook <adapter>`, `init`, `validate`, `start`, `status`. Has no approve command, on purpose |
| Adapter registry | `src/adapters/registry.ts` | Maps a platform name to its adapter. A new platform is one new entry |
| Claude Code adapter | `src/adapters/claude/` | Hook payload → `NormalizedEvent`; `Decision` → hook output JSON; resolves agent names (`.claude/agents/<name>.md` first, else `popcorn:<name>`); renders crashes as refusals |
| Engine | `src/core/engine.ts` | Routes events: starts runs, applies the user's commands, checks tool calls, and on Stop checks done-conditions and moves the run on |
| Policy | `src/core/policy.ts` | Pure function `checkTool`: allow a tool call, or return the reason to refuse it |
| Workflow | `src/core/workflow.ts` | Parses the YAML, validates it against a JSON Schema plus cross-references, validates agent outputs against the workflow's schemas |
| State store | `src/core/state.ts` | Reads and writes the run state and the active-run pointer |
| Env | `src/core/types.ts`, `node-env.ts` | Every side effect the engine needs (files, shell, clock). Injected, so tests use an in-memory `Env` |

### Boundaries

- **`src/core` knows no platform.** It imports nothing from `src/adapters` and names no agent product. Adapters translate; they hold no workflow logic.
- **All I/O goes through `Env`.** `checkTool` is pure: same workflow, state and call give the same answer.
- **The bundle is the product.** Claude Code runs `plugin/dist/popcorn.mjs` directly, so it is committed and rebuilt by `npm run check`.

## One hook event

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant CLI as popcorn hook claude
    participant AD as Claude adapter
    participant EN as Engine
    participant FS as .popcorn/ (via Env)

    CC->>CLI: hook payload on stdin
    CLI->>AD: parse(payload)
    AD-->>CLI: NormalizedEvent (or null: ignore)
    CLI->>EN: handle(event)
    EN->>FS: active run? load workflow + state
    alt no active run
        EN-->>CLI: pass (silent), unless the prompt is "popcorn start"
    else active run
        EN->>EN: session_start / prompt / before_tool / stop
        EN->>FS: save state (if it changed)
        EN-->>CLI: Decision: pass, context, deny, continue or halt
    end
    CLI->>AD: render(event, decision)
    AD-->>CC: stdout JSON, exit 0
```

| Event | What the engine does | Typical decision |
|---|---|---|
| `session_start` | Re-briefs the agent on the active phase | `context` |
| `prompt` | Applies `popcorn start/approve/reject/retry/abort/status`; otherwise re-briefs | `context` |
| `before_tool` | `checkTool` on the normalized call | `pass` or `deny` |
| `stop` | Checks done-conditions; moves to the next phase or back to `on_fail` | `continue` (keep working, with the next brief) or `halt` (let the agent stop and tell the user) |

**Fail safe.** The hook always exits 0, because Claude Code treats a failing hook as "allow". If the engine throws while a run is active, tool calls are refused with the error and the agent is allowed to stop. Without a `.popcorn/` directory, popcorn does nothing.

## How a tool call is checked

```mermaid
flowchart TD
    call["Tool call"] --> kind{kind}

    kind -- edit --> e1{"path outside project?"}
    e1 -- yes --> deny([refuse])
    e1 -- no --> e2{".popcorn/runs, workflow.yaml,<br/>.popcorn/active or protect_paths?"}
    e2 -- yes --> deny
    e2 -- no --> e3{"under .popcorn/?"}
    e3 -- yes --> e4{"this phase's output file,<br/>written by that agent?"}
    e4 -- yes --> allow([allow])
    e4 -- no --> deny
    e3 -- no --> w1{"waiting for approval?"}
    w1 -- yes --> deny
    w1 -- no --> e5{"deny.edit, or outside allow.edit?"}
    e5 -- yes --> deny
    e5 -- no --> allow

    kind -- shell --> s1{"mentions .popcorn<br/>or popcorn init?"}
    s1 -- yes --> deny
    s1 -- no --> w2{"waiting for approval?"}
    w2 -- yes --> deny
    w2 -- no --> s2["split into segments<br/>(; && || | newlines, bash -c, git global options)"]
    s2 --> s3{"any segment in deny_shell<br/>or phase deny.shell?"}
    s3 -- yes --> deny
    s3 -- no --> s4{"guarded_shell match?"}
    s4 -- "yes, and not unlocked here" --> deny
    s4 -- "no, or unlocked" --> s5{"phase has allow.shell and<br/>a segment is outside it?"}
    s5 -- yes --> deny
    s5 -- no --> allow

    kind -- mcp --> w3{"waiting for approval?"}
    w3 -- yes --> deny
    w3 -- no --> m1{"server:tool matches guarded_mcp?"}
    m1 -- "yes, and not unlocked here" --> deny
    m1 -- "no, or unlocked" --> m2{"phase has allow.mcp<br/>without this server?"}
    m2 -- yes --> deny
    m2 -- no --> allow

    kind -- other --> allow
```

**Unlocked** means: the phase lists the pattern in `allow.guarded`, the run isn't waiting, the phase's `before` approval was granted this round (if it has `approval: before`), and its `unlock_after` phase passed in that phase's current round with every output saying `"verdict": "approve"` (if it names one).

Shell matching is best effort. A determined agent can disguise a command, which is why popcorn's state is also protected from the edit tools, and why branch protection and CI should stay in place.

## The run's state machine

```mermaid
stateDiagram-v2
    [*] --> running: popcorn start (first phase has no before-approval)
    [*] --> awaiting_approval: popcorn start (first phase has approval: before)

    running --> running: Stop, phase incomplete → keep working (attempt n of max)
    running --> running: Stop, phase complete → next phase
    running --> running: Stop, blocking finding or verdict → back to on_fail, new round
    running --> awaiting_approval: Stop, phase complete and approval: after
    running --> awaiting_approval: next phase has approval: before
    running --> escalated: attempts exceed max_attempts_per_phase
    running --> done: last phase complete

    awaiting_approval --> running: popcorn approve / reject (after)
    awaiting_approval --> awaiting_approval: popcorn reject (before)
    escalated --> running: popcorn retry [hint]

    running --> aborted: popcorn abort
    awaiting_approval --> aborted: popcorn abort
    escalated --> aborted: popcorn abort

    done --> [*]
    aborted --> [*]
```

Only the user's prompt moves a run out of `awaiting_approval` or `escalated`. The agent's only way forward is to finish the phase's work and end its turn.

## Files popcorn keeps

| Path | Written by | Purpose |
|---|---|---|
| `.popcorn/workflow.yaml` | The team (`popcorn init` copies the starter) | The workflow. Can't be edited during a run |
| `.popcorn/active` | Engine | The active run's task name, or empty |
| `.popcorn/runs/<task>/state.json` | Engine | Phase, status, rounds, attempts, approvals, passed phases, gate cache, history. Never writable by the agent |
| `.popcorn/outputs/<task>/<phase>-r<round>/<agent>.json` | Each required agent, for its own file only | Agent results, such as review verdicts, validated against the workflow's schema |

The state records:

- `rounds`: entries into each phase.
- `attempts`: stop attempts in the current round.
- `approvals`: keyed `<phase>#<round>#<before|after>`.
- `passed`: phases that completed with every output approving, and the round they passed in. `unlock_after` reads this.
- `gateCache`: the last result of each gate. A pass is reused while the working tree (HEAD, uncommitted changes and untracked files, minus `.popcorn/`) is unchanged; a failure is always rerun.
- `history`: every start, enter, complete, fail, approve, reject, retry, escalate and abort.
