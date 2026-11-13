---
description: Implement the specs in this repo's ready folder, one task per commit, each spec gated by an independent audit before it gets a PR
argument-hint: "[spec ids...] [--here] [--no-review] [--skip-readiness] [--max N] [--fix-rounds N]"
---

Run the spec runner on this repository. Arguments: `$ARGUMENTS`

## 1. Load the config

Read `.claude/spec-runner.json` at the repository root (`git rev-parse --show-toplevel`).
If it does not exist, stop and say so: this repo has not been set up for the spec runner.
Point to the "Setting up a repo" section of `${CLAUDE_PLUGIN_ROOT}/README.md`.

Every value under `prompts` is a path to a Markdown file, relative to the repo root. Read each
file and replace the path with the file's full text. If a listed file is missing, stop and
name it — never run with a prompt silently dropped.

## 2. Parse the arguments

- Bare words are spec ids → `ids` (e.g. `0230 0231`, or `87` for `TASK-087`).
- `--here` → run in this checkout instead of a worktree (section 3b).
- `--no-review` → `review: false`
- `--skip-readiness` → `readiness: false`
- `--max N` → `maxSpecs: N`
- `--fix-rounds N` → `fixRounds: N`

## 3a. Prepare the worktree (default)

The run builds in its own git worktree so the user can keep working in theirs. Use this
unless `--here` was given or the config has `"worktree": {"enabled": false}`.

The **base** is the config's `baseBranch`; if unset, the current branch of this checkout.

1. `gh auth status` must succeed. The run pushes branches and opens PRs.
2. `git fetch origin <base>`. The run starts from `origin/<base>`, so it sees specs as they
   are on the remote. If `git rev-list --count origin/<base>..<base>` is above zero, the local
   base has commits the run will not see (perhaps specs that were never pushed). Tell the user
   how many and ask whether to continue before going further.
3. The worktree lives at `<git common dir>/spec-runner/worktree`, where the git common dir is
   `git rev-parse --path-format=absolute --git-common-dir`. Being inside `.git/`, it never
   shows up as untracked files in the user's checkout.
   - If it does not exist: `git worktree add --detach <path> origin/<base>`.
   - If it exists: `git -C <path> status --porcelain` must be empty. If it is not, a previous
     run left work there. Stop and show the user what is there; never discard it. If it is
     clean, `git -C <path> checkout --detach origin/<base>`.
4. Copy each path in the config's `worktree.copy` (gitignored files such as `.env`) from this
   checkout to the same relative path in the worktree, creating directories as needed. Skip
   paths that don't exist here, and say which.
5. Run each command in `worktree.setup`, in order, from the worktree root (they may `cd`
   into subdirectories). If one fails, stop and show its output; the run would fail anyway.
   A reused worktree keeps its installed dependencies, so later runs are faster.

Pass `worktree: <absolute path>`, `base: <base>` and `baseRef: "origin/<base>"`.

## 3b. In place (`--here`)

All of these must hold. If one fails, stop, say which, and change nothing:

- `git status --porcelain` is empty. The run commits on its own and its baseline step needs a
  clean tree.
- The current branch is the config's `baseBranch` (when set).
- `gh auth status` succeeds.

Pass no `worktree`, `base` or `baseRef`.

## 4. Run the workflow

This command authorizes the Workflow tool. Call it by name; if the tool does not know the
name, pass `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/run-specs.js"` instead:

```
Workflow({
  name: "spec-runner:run-specs",
  args: { config: <the config, prompts inlined>, worktree, base, baseRef, ids, review, readiness, maxSpecs, fixRounds }
})
```

Pass `args` as a JSON object, not a string. Leave out any option that doesn't apply.

## 5. Report

When the workflow finishes, give a short table: each spec, its outcome (landed with PR
number, blocked, not ready, skipped and why), and the base it targeted. Then:

- For each spec under `notReady`: its problems, so the author can fix the spec and rerun.
- Anything under `inherited`: verification commands already failing on the base branch and
  left alone. Those are worth their own fixes.
- In worktree mode, where the worktree is. It is left in place for the next run; `git worktree
  remove <path>` deletes it.
