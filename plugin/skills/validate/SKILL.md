---
name: validate
description: Check .popcorn/workflow.yaml (or another workflow file) for errors. Use after editing a popcorn workflow.
argument-hint: "[file]"
---
Run `node "${CLAUDE_PLUGIN_ROOT}/dist/popcorn.mjs" validate $ARGUMENTS` with the Bash tool and show the result. If it lists problems, explain each one and suggest the fix in the workflow file.
