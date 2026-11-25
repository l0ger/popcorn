---
name: init
description: Set up popcorn in this project. Copies the starter seven-phase workflow to .popcorn/workflow.yaml and explains how to customise it. Use when the user asks to set up, install or configure popcorn workflows.
---
1. Run `popcorn init` with the Bash tool. If `.popcorn/workflow.yaml` already exists, tell the user and stop; don't overwrite it unless they ask (then `popcorn init --force`).
2. Read `.popcorn/workflow.yaml` and look at the project: find its real test, lint and build commands (package.json scripts, Makefile, pyproject.toml, CI config). Suggest replacing the placeholder `npm test` gates with them, and show the exact edit. Make it only when the user agrees.
3. Run `popcorn validate` and show the result.
4. Explain in a few lines:
   - Start a run with `/popcorn:start <task-name> <what to build>`.
   - Phases with an approval wait for `/popcorn:approve` or `/popcorn:reject <feedback>`; only the user can approve.
   - Override any agent by creating `.claude/agents/<name>.md` with the same name (e.g. `code-reviewer`).
   - MCP servers come from the project's normal `.mcp.json`; a phase can limit them with `allow.mcp`.
   - Publish, Review and Deploy work on a GitHub pull request through a GitHub MCP server in `.mcp.json` (or the `gh` CLI). If the project has neither, point the user to the README's "GitHub pull requests" section. Deploy merges once every reviewer agent approves, without the user; to require the user too, add `approval: before` to Deploy.
   - Add `.popcorn/runs/` and `.popcorn/outputs/` to `.gitignore` if run state shouldn't be committed.
