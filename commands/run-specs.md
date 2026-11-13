---
description: Implement the specs in this repo's ready folder, one task per commit, each spec gated by an independent audit before it gets a PR
argument-hint: "[spec ids...] [--no-review] [--max N] [--fix-rounds N]"
---

Run the spec runner on this repository. Arguments: `$ARGUMENTS`

## 1. Load the config

Read `.claude/spec-runner.json` at the repository root (`git rev-parse --show-toplevel`).
If it does not exist, stop and say so: this repo has not been set up for the spec runner.
Point to the "Setting up a repo" section of `${CLAUDE_PLUGIN_ROOT}/README.md`.

Every value under `prompts` is a path to a Markdown file, relative to the repo root. Read each
file and replace the path with the file's full text. If a listed file is missing, stop and
name it — never run with a prompt silently dropped.

## 2. Preflight

All of these must hold. If one fails, stop, say which, and change nothing:

- `git status --porcelain` is empty. The run commits on its own and its baseline step needs a
  clean tree.
- The current branch is the config's `baseBranch` (when set).
- `gh auth status` succeeds. The run pushes branches and opens PRs.

## 3. Parse the arguments

- Bare words are spec ids → `ids` (e.g. `0230 0231`, or `87` for `TASK-087`).
- `--no-review` → `review: false`
- `--max N` → `maxSpecs: N`
- `--fix-rounds N` → `fixRounds: N`

## 4. Run the workflow

This command authorizes the Workflow tool. Call it by name; if the tool does not know the
name, pass `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/run-specs.js"` instead:

```
Workflow({
  name: "spec-runner:run-specs",
  args: { config: <the config, prompts inlined>, ids: [...], review: ..., maxSpecs: ..., fixRounds: ... }
})
```

Pass `args` as a JSON object, not a string. Leave out any option the user did not give.

## 5. Report

When the workflow finishes, give a short table: each spec, its outcome (landed with PR
number, blocked, skipped and why), and the base it targeted. Then list anything under
`inherited`: verification commands that were already failing on the base branch and were
left alone. Those are worth their own fixes.
