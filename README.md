# spec-runner

A Claude Code plugin that takes a folder of written specs and turns each one into a pull request,
without you in the loop for each step.

For every spec in your `ready` folder it:

1. **Claims** it: creates a branch, moves the spec to `in-progress`, and breaks it into
   commit-sized tasks if it doesn't have them yet.
2. **Builds** it one task at a time, each with a fresh agent. Each task makes one commit with a
   `Spec-Task: <spec>.<task>` trailer and ticks its box in the spec. Task agents only check that
   their code compiles; tests run once, at the gate.
3. **Gates** it with an independent agent that wrote none of the code. The gate checks that every
   task has its commit, runs the spec's verification, and walks the acceptance criteria. If
   something fails, a fix agent gets a bounded number of rounds.
4. **Checks failures against the base branch.** If a failing command fails on the base branch too,
   it isn't this spec's problem. The spec still lands, and the PR says what was already broken,
   instead of quietly "fixing" unrelated code under the spec's name.
5. **Opens the PR** (or a draft PR marked `[BLOCKED]` with a write-up if the gate never passes),
   then runs an independent `/code-review` on it.

Specs run one after another in the same checkout. Progress lives in git and in the spec's
checkboxes, so an interrupted run picks up where it stopped.

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

From the base branch, with a clean working tree:

```
/spec-runner:run-specs                 # every spec in the ready folder
/spec-runner:run-specs 0230 0231       # just these
/spec-runner:run-specs --no-review     # skip the code-review pass
/spec-runner:run-specs --max 2         # at most two specs this run
```

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
  "fixRounds": 2,
  "prompts": {}
}
```

| Key | What it does |
|---|---|
| `baseBranch` | The run refuses to start anywhere else. Unset: whatever branch you're on. |
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
| `fixRounds` | Fix attempts after a failed gate, before the spec is marked blocked. |
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
