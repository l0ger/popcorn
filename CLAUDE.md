# popcorn: notes for coding agents

- `src/core` is platform-neutral: no imports from `src/adapters`, no platform names. Side effects go through `Env`.
- A platform is an adapter in `src/adapters/<name>`, registered in `src/adapters/registry.ts`, and it must pass `tests/unit/adapter-contract.ts`.
- Fail safe: with an active run, any engine error must refuse tool calls (never exit non-zero from a hook; Claude Code treats that as "allow").
- Only the user's prompt may approve, reject, retry or abort. Never add a CLI or tool path for those.
- After changing `src/`, run `npm run check`; it rebuilds `plugin/dist/popcorn.mjs`, which is committed because the plugin runs it directly.
- Keep agents in `plugin/agents/` generic: no project-specific rules.
