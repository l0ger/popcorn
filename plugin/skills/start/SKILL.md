---
name: start
description: Start a popcorn workflow run for a task, e.g. /popcorn:start p1-user-login "Users can log in with email".
argument-hint: <task-name> [what to build]
disable-model-invocation: true
---
popcorn start $ARGUMENTS

If the context above already shows "[popcorn] Run ..." for this task, the run has started: follow that phase brief.
Otherwise start it yourself by running `popcorn start $ARGUMENTS` with the Bash tool, then follow the brief it prints.
