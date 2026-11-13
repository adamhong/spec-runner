# spec-runner

A Claude Code plugin that takes a folder of written specs and turns each one into a pull request,
without you in the loop for each step.

First it **checks every spec is buildable**: a read-only pass looks for requirements an agent
would have to guess at, contradictions, and specs with no way to verify them. Specs that fail
are left out, with the problems listed, so the author can fix them and rerun. Then, for each
spec that's ready, it:

1. **Claims** it: creates a branch, moves the spec to `in-progress`, and breaks it into
   commit-sized tasks if it doesn't have them yet.
2. **Builds** it one task at a time, each with a fresh agent. Each task makes one commit with a
   `Spec-Task: <spec>.<task>` trailer and ticks its box in the spec. Task agents only check that
   their code compiles; tests run once, at the gate. A reviewer then reads that one commit
   against its task and gets one fix if something's off, so a wrong turn is caught where it
   happened instead of at the end.
3. **Gates** it with an independent agent that wrote none of the code. The gate checks that every
   task has its commit, runs the spec's verification, and walks the acceptance criteria. If
   something fails, a fix agent gets up to four rounds; the later rounds move to a stronger
   model.
4. **Checks failures against the base branch.** If a failing command fails on the base branch too,
   it isn't this spec's problem. The spec still lands, and the PR says what was already broken,
   instead of quietly "fixing" unrelated code under the spec's name.
5. **Opens the PR** (or a draft PR marked `[BLOCKED]` with a write-up if the gate never passes),
   then runs an independent `/code-review` on it.

Specs that already have an **open PR** are left alone, and so are the specs that depend on
them: until that PR merges, the base branch still lists the spec as ready, and rebuilding it
would only redo finished work. A spec parked as a draft `[BLOCKED]` PR is retried when you
name its id (`/spec-runner:run-specs 0230`).

The run builds in **its own git worktree**, starting from `origin/<base>`, so you can keep
working in your checkout while it runs. Specs run one after another. Progress lives in git and
in the spec's checkboxes, so an interrupted run picks up where it stopped.

## Install

```
/plugin marketplace add adamhong/spec-runner
/plugin install spec-runner@spec-runner
```

To have it offered automatically to everyone who works in a repo, add this to the repo's
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "spec-runner": { "source": { "source": "github", "repo": "adamhong/spec-runner" } }
  },
  "enabledPlugins": { "spec-runner@spec-runner": true }
}
```

## Use

From anywhere in the repo, on any branch:

```
/spec-runner:run-specs                   # every spec in the ready folder
/spec-runner:run-specs 0230 0231         # just these
/spec-runner:run-specs --no-review       # skip the code-review pass
/spec-runner:run-specs --skip-readiness  # build specs even if the readiness check would hold them
/spec-runner:run-specs --max 2           # at most two specs this run
/spec-runner:run-specs --here            # build in this checkout instead of a worktree
```

**The worktree.** The run builds at `.git/spec-runner/worktree`, inside your repo's `.git`
folder, so it never shows up as untracked files. It starts from `origin/<base>`, which means
**specs must be pushed** to be picked up; the command warns you if your local base is ahead.
A fresh worktree has no installed dependencies and none of your gitignored files, so tell the
runner what to copy in and what to run (`worktree.copy`, `worktree.setup` below). The worktree
is kept between runs, dependencies and all, so only the first run pays for setup.
`git worktree remove .git/spec-runner/worktree` deletes it.

`--here` builds in your current checkout instead: it must be on the base branch with a clean
tree, and you can't use the checkout while the run goes.

## Setting up a repo

The runner reads `.claude/spec-runner.json` at the repository root. Everything is optional except
what your repo does differently from the defaults.

```json
{
  "baseBranch": "main",
  "processDoc": "tasks/README.md",
  "template": "tasks/specs/_template.md",
  "specs": {
    "ready": "tasks/specs/ready",
    "inProgress": "tasks/specs/in-progress",
    "done": "tasks/specs/done",
    "folders": true,
    "match": "NNNN-title.md files and NNNN-title/ folders containing spec.md",
    "id": "the 4-digit prefix, e.g. \"0230\""
  },
  "branch": "spec/{filename}",
  "prTitle": "spec/{id}: {title}",
  "prLabels": [],
  "stacking": "dependencies",
  "model": { "default": "sonnet", "from": "the `> **Model**:` frontmatter line", "map": {} },
  "dependenciesFrom": "the \"## Dependencies\" section",
  "decomposeFrom": "Detailed Design + Tests — every file in Detailed Design and every test in Tests must be covered by some task",
  "conventions": "every rule in CLAUDE.md and AGENTS.md",
  "taskRules": [],
  "compileCheck": "`pnpm exec eslint <your files> && pnpm typecheck`",
  "verification": "every command in the spec's \"## Verification\" section, in order, from the directories it states",
  "acceptance": "each criterion in the spec's \"## Acceptance Criteria\" section",
  "gateSetup": "",
  "prBody": "",
  "review": true,
  "readinessCheck": true,
  "taskReview": true,
  "fixRounds": 4,
  "fixEscalation": { "fromRound": 3, "model": "opus" },
  "worktree": {
    "enabled": true,
    "copy": [".env"],
    "setup": ["pnpm install --frozen-lockfile"]
  },
  "prompts": {}
}
```

| Key | What it does |
|---|---|
| `baseBranch` | The branch PRs target and new branches start from. Unset: whatever branch you're on. With `--here`, the run refuses to start on any other branch. |
| `processDoc` | Your written process. Every agent is told to follow it, so repo-specific rules for claiming, committing and completing a spec belong here. |
| `template` | Where the spec template (and its Tasks format) lives. |
| `specs.ready` / `inProgress` / `done` | The lifecycle folders. Specs move between them with `git mv`. |
| `specs.folders` | `true` if a spec can be a folder (`NNNN-title/spec.md` plus `design/`, `screenshots/`). Folders move whole. |
| `specs.match`, `specs.id` | Plain-language description of what counts as a spec and what its id is. |
| `branch` | Branch name. Placeholders: `{id}`, `{filename}`, `{slug}`. |
| `prTitle` | PR title. Placeholders: `{id}`, `{filename}`, `{slug}`, `{title}`. |
| `prLabels` | Labels added when the PR is created. |
| `stacking` | `"dependencies"`: a spec branches off the base unless it depends on another spec in the same run, in which case it stacks on that spec's branch, and a failure only skips its dependents. `"chain"`: each spec stacks on the previous one, and the first failure stops the run. |
| `model.from` | Where a spec names the model to build it with. |
| `model.map` | Your own vocabulary for that value, e.g. `{"high": "opus"}` for a complexity field. Values containing opus, sonnet or haiku work without a map. |
| `model.default` | Model when the spec names none. |
| `dependenciesFrom` | Where a spec lists the specs it depends on. |
| `decomposeFrom` | What to break into tasks when a spec has none yet. |
| `conventions` | What task agents must follow. |
| `taskRules` | Extra rules for every task agent, one per item, e.g. "never log PHI". |
| `compileCheck` | What a task agent runs instead of tests. |
| `verification` | What the gate runs. Can name checklists as well as commands. |
| `acceptance` | What the gate walks and ticks off. |
| `gateSetup` | Anything the gate must do first, e.g. "start the database with `docker compose up -d` if verification needs it". |
| `prBody` | Extra instructions for the PR description. |
| `review` | Run `/code-review high --comment` on each PR. |
| `readinessCheck` | Check each spec is buildable before claiming any. `false` to skip. |
| `taskReview` | Review each task's commit against its task, with one fix if needed. `false` to skip, if per-task time matters more than catching problems early. |
| `fixRounds` | Fix attempts after a failed gate, before the spec is marked blocked. |
| `fixEscalation` | From which fix round to switch models, and to which. |
| `worktree.enabled` | `false` to always build in place, as if `--here` were given. |
| `worktree.copy` | Gitignored files to copy from your checkout into the worktree before each run, e.g. `.env` files. |
| `worktree.setup` | Commands to run in the worktree before each run, e.g. installing dependencies or generating a database client. Each may `cd` into a subdirectory. |
| `prompts` | Repo-specific steps, each a path to a Markdown file (below). |

### Repo-specific steps

Anything that only makes sense in your repo goes in a Markdown file that `prompts` points to. The
runner reads it and slots it into the right agent's instructions.

| Prompt | When it runs |
|---|---|
| `capture` | After the gate passes: take screenshots or walkthroughs. Without it, there is no capture step. The agent reports `committed`, `count`, `galleryPath`, and optionally `walkthroughs`, `mediaDir` and `note` for the after-PR step. |
| `afterClaim` | Once the spec is claimed, e.g. comment "in progress" on its issue. |
| `afterPr` | Once the PR exists, e.g. publish walkthrough media or link the issue. |
| `afterBlocked` | When a spec is blocked, e.g. note it on the issue. |
| `afterReview` | Once review findings are posted, e.g. set a review-state label. |

All of these are advisory: a failure is noted and never blocks the spec or its PR.

Placeholders filled in prompt files: `{id}`, `{filename}`, `{slug}`, `{title}`, `{branch}`,
`{base}`, `{specPath}`, `{ready}`, `{inProgress}`, `{done}`. In `afterPr` also `{gallery}`,
`{count}`, `{walkthroughs}`, `{mediaDir}`, `{note}`; in `afterReview`, `{pr}`. Any other braces,
including shell `${...}`, are left alone.

## Develop

```
node tests/run-specs.test.mjs
```

The tests run the workflow with every agent stubbed, so they check its decisions (who gets fixed,
what's excused, what stacks on what) without spending tokens or touching git.

## License

MIT
