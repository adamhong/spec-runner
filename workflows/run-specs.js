export const meta = {
  name: 'run-specs',
  description: 'Implement ready specs one commit-sized task at a time; each spec gets a PR only after an independent completeness gate passes',
  whenToUse: 'Invoked by /spec-runner:run-specs, which reads the repo\'s .claude/spec-runner.json, prepares the worktree, and passes everything as args. Requires args {config, base?, baseRef?, worktree?, ids?, review?, maxSpecs?, fixRounds?, defaultModel?, readiness?}.',
  phases: [
    { title: 'Plan', detail: 'discover ready specs, read model + dependency frontmatter' },
    { title: 'Ready', detail: 'read-only check of each spec — gaps, contradictions, missing verification; unready specs are skipped with reasons' },
    { title: 'Claim', detail: 'branch off the base (or the parent spec\'s branch), move spec to in-progress, decompose into tasks if missing, detect resume' },
    { title: 'Tasks', detail: 'one fresh agent per task — implement, compile-check (no tests), commit with Spec-Task trailer — then a light review of that commit against its task' },
    { title: 'Gate', detail: 'independent agent audits task commits + verification + acceptance criteria; failures baselined against the base branch; escalating fix rounds' },
    { title: 'Capture', detail: 'repo-defined screenshots / walkthroughs — advisory, skipped when the repo defines none' },
    { title: 'Complete', detail: 'move spec to done, push, open PR — only after the gate passes' },
    { title: 'Review', detail: 'fresh agent runs /code-review high --comment on each PR (advisory)' },
  ],
}

// ── Config ───────────────────────────────────────────────────
// args.config is the repo's .claude/spec-runner.json, with every `prompts.*`
// path already replaced by that file's text (the command does this — workflow
// scripts cannot read files). See README.md for the full reference.
//
// args.worktree: absolute path of the checkout this run works in (the command
// creates it). Absent = work in the current checkout ("--here").
// args.base: the branch PRs target. args.baseRef: the git ref new branches
// start from and failures are compared against (e.g. origin/develop).
// `args` may arrive as a JSON string depending on the caller; accept both.
const ARGS = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch (e) { return {} } })() : (args || {})
const opts = Array.isArray(ARGS) ? { ids: ARGS } : ARGS
const C = opts.config
if (!C || typeof C !== 'object') {
  log('No config — start this through /spec-runner:run-specs, which reads .claude/spec-runner.json and passes it in.')
  return { error: 'missing args.config' }
}

const S = {
  ready: 'tasks/specs/ready',
  inProgress: 'tasks/specs/in-progress',
  done: 'tasks/specs/done',
  folders: false,
  match: 'every .md file (ignore .gitkeep and README files)',
  id: 'the leading number of the filename, e.g. "0230" from 0230-some-title.md',
  ...(C.specs || {}),
}
const PROCESS = C.processDoc || 'tasks/README.md'
const TEMPLATE = C.template || 'the spec template'
const BRANCH = C.branch || 'spec/{filename}'
const PR_TITLE = C.prTitle || 'spec/{id}: {title}'
const PR_LABELS = C.prLabels || []
const STACKING = C.stacking === 'chain' ? 'chain' : 'dependencies'
const CONVENTIONS = C.conventions || 'every rule in CLAUDE.md and any AGENTS.md files'
const TASK_RULES = C.taskRules || []
const COMPILE_CHECK = C.compileCheck || "the project's type-check and lint for the files you touched"
const DECOMPOSE_FROM = C.decomposeFrom || 'the spec\'s design and test sections — every file and every test the spec names must be covered by some task'
const DEPS_FROM = C.dependenciesFrom || 'the "## Dependencies" section'
const VERIFICATION = C.verification || 'every command in the spec\'s "## Verification" section, in order, from the directories it states'
const ACCEPTANCE = C.acceptance || 'each criterion in the spec\'s "## Acceptance Criteria" section'
const GATE_SETUP = C.gateSetup || ''
const P = C.prompts || {}
const MODEL = C.model || {}
const ESCALATE = { fromRound: 3, model: 'opus', ...(C.fixEscalation || {}) }

const ID_FILTER = opts.ids && opts.ids.length ? opts.ids : null
const RUN_REVIEW = opts.review ?? (C.review !== false)
const RUN_READINESS = opts.readiness ?? (C.readinessCheck !== false)
const RUN_TASK_REVIEW = opts.taskReview ?? (C.taskReview !== false)
const DEFAULT_MODEL = opts.defaultModel || MODEL.default || 'sonnet'
const MAX_SPECS = opts.maxSpecs || 0
const FIX_ROUNDS = opts.fixRounds ?? C.fixRounds ?? 4
const GATE_ATTEMPTS = opts.gateAttempts ?? 3
const WORKTREE = opts.worktree || ''

// Every agent works in the run's worktree when there is one. Prepended to
// every prompt, because each agent starts fresh and knows nothing else.
const WHERE = WORKTREE
  ? `WORKING DIRECTORY: this run builds in its own git worktree at ${WORKTREE}. cd there before your first command and run every command from there; read and edit files only under that path. Never touch the user's main checkout — they may be working in it right now.\n\n`
  : ''
const ask = (prompt, o) => agent(WHERE + prompt, o)

// Replace {name} placeholders whose name is a known variable; leave every
// other brace alone, so shell snippets in repo prompts survive untouched.
function fill(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m))
}

// Map a spec's model frontmatter value to a model alias. `model.map` lets a
// repo route its own vocabulary, e.g. {"high": "opus"} for a complexity field.
function normalizeModel(m) {
  if (!m) return DEFAULT_MODEL
  const s = String(m).toLowerCase()
  for (const [k, v] of Object.entries(MODEL.map || {})) if (s.includes(k.toLowerCase())) return v
  if (s.includes('opus')) return 'opus'
  if (s.includes('haiku')) return 'haiku'
  if (s.includes('sonnet')) return 'sonnet'
  return DEFAULT_MODEL
}

// Shell steps that move a spec between lifecycle folders. A folder spec
// carries design/ and screenshots/ next to spec.md, so it moves whole.
function moveSteps(from, to, spec) {
  const flat = `git mv ${from}/${spec.filename}.md ${to}/${spec.filename}.md`
  if (!S.folders) return `   ${flat}`
  return `   - flat   (${from}/${spec.filename}.md):        ${flat}
   - folder (${from}/${spec.filename}/spec.md):  git mv ${from}/${spec.filename} ${to}/
   Move the WHOLE spec, never just its markdown — moving spec.md alone orphans its design/ and screenshots/.`
}

const numbered = (lines, start) => lines.map((l, i) => `${start + i}. ${l}`).join('\n')

// ── Phase 1: Plan ────────────────────────────────────────────
phase('Plan')

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseBranch: { type: 'string', description: 'output of `git rev-parse --abbrev-ref HEAD`' },
    specs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'the spec id' },
          filename: { type: 'string', description: 'basename without .md (for a folder spec, the folder name — never "spec")' },
          slug: { type: 'string', description: 'kebab-case, 3-5 words from the title, a-z0-9 and hyphens only' },
          path: { type: 'string', description: 'path to the spec markdown' },
          model: { type: 'string', description: 'raw model value from the spec, or empty string' },
          deps: { type: 'array', items: { type: 'string' }, description: 'ids of specs that must be done first; empty if none' },
        },
        required: ['id', 'filename', 'slug', 'path', 'model', 'deps'],
      },
    },
  },
  required: ['baseBranch', 'specs'],
}

const idClause = ID_FILTER
  ? `Only include specs whose id is one of: ${ID_FILTER.join(', ')} (match loosely — "87" means the spec whose id is 87 in whatever padding the repo uses). If a requested id has no file, still return the rest.`
  : 'Include every spec there.'

const plan = await ask(
  `You are preparing a batch spec run. Do NOT modify anything — read only.
1. Run: git rev-parse --abbrev-ref HEAD  → this is baseBranch.
2. List the specs in ${S.ready}/. What counts as a spec: ${S.match}.${S.folders ? ` A spec is EITHER ${S.ready}/<name>.md OR a folder ${S.ready}/<name>/spec.md — globbing only *.md silently skips folder specs. For a folder spec, \`path\` is its spec.md and \`filename\` is the folder name.` : ''} The id of each spec is ${S.id}. ${idClause}
3. Sort the specs ascending by filename.
4. For each spec, read ${MODEL.from || 'the first frontmatter line matching ^>\\s*\\*\\*Model\\*\\*:'} and return its value (strip backticks/whitespace), or an empty string if absent.
5. For each spec, read ${DEPS_FROM}. Put the id of every SPEC it lists as a prerequisite into \`deps\`. Ignore external services and packages — only spec ids count. Empty array if none.
6. Derive a slug from each spec's title.
Return the structured result.`,
  { phase: 'Plan', label: 'plan:discover', schema: PLAN_SCHEMA },
)

// In a worktree the command decides the base (the worktree sits on a detached
// origin/<base>). In place, the current branch is the base and must match.
if (!WORKTREE && C.baseBranch && plan.baseBranch !== C.baseBranch) {
  log(`Run from ${C.baseBranch} — the working tree is on ${plan.baseBranch}. Nothing was changed.`)
  return { error: `wrong base branch: on ${plan.baseBranch}, config says ${C.baseBranch}` }
}
const startBase = opts.base || C.baseBranch || plan.baseBranch
const startRef = opts.baseRef || startBase

let specs = plan.specs || []
if (MAX_SPECS > 0 && specs.length > MAX_SPECS) {
  log(`maxSpecs=${MAX_SPECS}: leaving ${specs.length - MAX_SPECS} spec(s) for a later run: ${specs.slice(MAX_SPECS).map(s => s.id).join(', ')}`)
  specs = specs.slice(0, MAX_SPECS)
}

if (specs.length === 0) {
  log(`No specs found in ${S.ready}/ — nothing to do.`)
  return { baseBranch: startBase, processed: [], note: 'no specs' }
}

log(`Planning ${specs.length} spec(s) off ${startRef}${WORKTREE ? ` in worktree ${WORKTREE}` : ''} (${STACKING} stacking): ${specs.map(s => s.id).join(', ')}`)

// ── Phase 2: Ready — is each spec buildable as written? ──────
// A thin or contradictory spec is the most expensive failure there is: it
// spends every task and a gate before anyone finds out. These checks are
// read-only, so they run in parallel; a barrier is right here because the
// run needs the full verdict list before it decides what to claim.
const READY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ready: { type: 'boolean', description: 'false only for a problem that would make the work ambiguous or the gate impossible to pass' },
    problems: { type: 'array', items: { type: 'string' }, description: 'each blocking problem, concrete enough for the author to fix in one edit' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'worth fixing, but the spec can still be built' },
  },
  required: ['ready', 'problems', 'warnings'],
}

const notReady = {} // spec id → problems
if (RUN_READINESS) {
  phase('Ready')
  const verdicts = await parallel(specs.map(spec => () => ask(
    `Check whether spec ${spec.id} (${spec.path}) is ready to be built by agents with no one to ask. Read it, ${TEMPLATE}, and ${PROCESS}. Do NOT modify anything — read only.

It is NOT ready (ready=false) only if one of these holds — list each as a problem, concrete enough to fix in one edit:
- An agent would have to guess: a requirement has two reasonable readings that lead to different code, or says TBD / TODO / "decide later" / an open question about behavior.
- The spec contradicts itself, or contradicts code it says already exists (check the files it names).
- There is no way to verify it: nothing in ${VERIFICATION.replace(/^every command in /, '')} could be run, and ${ACCEPTANCE.replace(/^each criterion in /, '')} is missing or untestable.
- It has a "## Tasks" section that leaves out work the spec describes, or a task depends on a later one.

Anything else — style, wording, a missing nice-to-have, a criterion that needs a manual check — is a warning, not a problem. Do not hold a spec back for polish.`,
    { phase: 'Ready', label: `ready:${spec.id}`, schema: READY_SCHEMA },
  )))
  specs.forEach((spec, idx) => {
    const v = verdicts[idx]
    if (!v) {
      log(`[${spec.id}] readiness check errored — building it anyway; the gate still applies`)
      return
    }
    if (!v.ready) {
      notReady[spec.id] = v.problems
      log(`[${spec.id}] NOT READY — ${v.problems.join(' | ')}`)
    } else if (v.warnings.length) {
      log(`[${spec.id}] ready, with warnings: ${v.warnings.join(' | ')}`)
    }
  })
}

// ── Schemas for the per-spec stages ──────────────────────────
const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branch: { type: 'string' },
    specPath: { type: 'string', description: 'current path of the spec markdown (now under in-progress)' },
    title: { type: 'string', description: 'the spec\'s title' },
    resumed: { type: 'boolean', description: 'true if the branch already existed with prior task commits' },
    tasks: {
      type: 'array',
      description: 'ALL tasks from the Tasks section, in order, including already-done ones',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'task id, e.g. "T1" or "T4a"' },
          title: { type: 'string' },
          verify: { type: 'string', description: 'the task Verify: command, empty string if none' },
          done: { type: 'boolean', description: 'true if already checked off AND a Spec-Task commit exists for it' },
        },
        required: ['id', 'title', 'verify', 'done'],
      },
    },
  },
  required: ['branch', 'specPath', 'title', 'resumed', 'tasks'],
}

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    committed: { type: 'boolean', description: 'true only if the task commit exists on the branch' },
    sha: { type: 'string', description: 'commit sha, empty if not committed' },
    summary: { type: 'string', description: 'one or two sentences on what was done, or what failed' },
  },
  required: ['committed', 'sha', 'summary'],
}

const TASK_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true if the commit does what the task asks, within its scope' },
    problems: { type: 'array', items: { type: 'string' }, description: 'each concrete problem: what is wrong, where (file:line), what the task needed instead' },
  },
  required: ['ok', 'problems'],
}

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    complete: { type: 'boolean' },
    uncheckedTasks: { type: 'array', items: { type: 'string' }, description: 'task ids still [ ] in the spec' },
    missingCommits: { type: 'array', items: { type: 'string' }, description: 'checked task ids with NO matching Spec-Task commit' },
    failedVerification: { type: 'array', items: { type: 'string' }, description: 'verification commands (or checklist items) that failed' },
    suspectedPreExisting: {
      type: 'array',
      items: { type: 'string' },
      description: 'Subset of failedVerification the gate believes was ALREADY broken on the base branch. Report it here AND in failedVerification; a baseline run decides it, not you.',
    },
    uncheckedCriteria: { type: 'array', items: { type: 'string' }, description: 'acceptance criteria that are not satisfied' },
    notes: { type: 'string' },
  },
  required: ['complete', 'uncheckedTasks', 'missingCommits', 'failedVerification', 'suspectedPreExisting', 'uncheckedCriteria', 'notes'],
}

// A gate failure is only this spec's problem if the command *newly* fails.
// Without this, fix rounds get spent repairing a dependency advisory or a test
// that was already red on the base branch — and the repair ships wearing a
// `Spec-Task:` trailer that claims it belongs to the spec. So when the gate
// reports failing commands, re-run *those commands only* on the base branch.
// Lazy on purpose: a clean run never pays for it.
const BASELINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ran: { type: 'boolean', description: 'false if the baseline could not be established (dirty tree, checkout failed) — then nothing is assumed pre-existing' },
    alreadyFailing: { type: 'array', items: { type: 'string' }, description: 'commands that fail on the base branch too, verbatim as given' },
    newlyFailing: { type: 'array', items: { type: 'string' }, description: 'commands that pass on base and therefore broke here' },
    notes: { type: 'string' },
  },
  required: ['ran', 'alreadyFailing', 'newlyFailing', 'notes'],
}

const CAPTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attempted: { type: 'boolean', description: 'true if the spec has UI to capture and capture was attempted' },
    committed: { type: 'boolean', description: 'true only if a screenshots commit exists on the branch' },
    count: { type: 'integer', description: 'number of screenshots committed' },
    galleryPath: { type: 'string', description: 'path to the committed gallery, or empty string' },
    walkthroughs: { type: 'integer', description: 'number of walkthrough media files built (0 if none)' },
    mediaDir: { type: 'string', description: 'directory holding built walkthrough media, or empty string' },
    note: { type: 'string', description: 'one-line note for the PR when nothing was built (e.g. "no UI changes", "capture failed (<reason>)"), else empty' },
    summary: { type: 'string' },
  },
  required: ['attempted', 'committed', 'count', 'galleryPath', 'summary'],
}

const COMPLETE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prNumber: { type: 'integer', description: 'PR number, or 0 if creation failed' },
    pushed: { type: 'boolean', description: 'true only if the branch is confirmed on origin' },
    summary: { type: 'string' },
  },
  required: ['prNumber', 'pushed', 'summary'],
}

// ── Per spec, one at a time ──────────────────────────────────
// SEQUENTIAL ON PURPOSE: every agent mutates the same working tree and
// touches git, so this must NOT be parallel()/pipeline().
//
// stacking "dependencies": a spec with no dependency *in this run* branches
// off (and targets) the base branch, so its PR merges on its own. A spec that
// depends on another spec in this run branches off that parent's branch. A
// spec whose in-run dependency failed is SKIPPED; unrelated specs continue.
//
// stacking "chain": every spec branches off the previous one, and the first
// failure stops the run (nothing is stacked on an incomplete base).
const processed = []
const runIds = new Set(specs.map(s => s.id))
const orderOf = new Map(specs.map((s, idx) => [s.id, idx]))
const branchById = {} // spec id → branch, set only once a spec lands clean
let chain = { base: startBase, ref: startRef }
let chainBroken = false

for (let i = 0; i < specs.length; i++) {
  const spec = specs[i]
  const branch = fill(BRANCH, { id: spec.id, filename: spec.filename, slug: spec.slug })
  const model = normalizeModel(spec.model)
  const record = { id: spec.id, branch, base: null, tasks: [], gate: null, pushed: false, prNumber: 0 }
  processed.push(record)
  const stop = () => { if (STACKING === 'chain') chainBroken = true }

  if (notReady[spec.id]) {
    record.skipped = true
    record.notReady = notReady[spec.id]
    record.skipReason = 'spec not ready'
    stop()
    continue
  }

  // ── Resolve the base ───────────────────────────────────────
  // base = the branch the PR targets; baseRef = the git ref to branch from
  // and compare against. They differ only for the start base in a worktree
  // (develop vs origin/develop); a parent spec's branch is local either way.
  let base
  let baseRef
  let parentDep = null
  if (STACKING === 'chain') {
    if (chainBroken) {
      record.skipped = true
      record.skipReason = 'an earlier spec in the chain did not land'
      log(`[${spec.id}] skipped — the chain stopped at an earlier spec`)
      continue
    }
    base = chain.base
    baseRef = chain.ref
  } else {
    // Only deps that are part of THIS run matter: a dep already done is
    // merged into the base branch.
    const inRunDeps = (spec.deps || []).filter(d => runIds.has(d) && d !== spec.id)
    const unmetDeps = inRunDeps.filter(d => !branchById[d])
    if (unmetDeps.length) {
      log(`[${spec.id}] skipped — in-run dependency not available (not ready, blocked, failed, or ordered later): ${unmetDeps.join(', ')}`)
      record.skipped = true
      record.skipReason = `unmet in-run dependencies: ${unmetDeps.join(', ')}`
      continue
    }
    // Parent = the in-run dependency latest in run order; its branch already
    // contains any earlier chained deps.
    parentDep = inRunDeps.length ? inRunDeps.reduce((a, b) => (orderOf.get(b) > orderOf.get(a) ? b : a)) : null
    base = parentDep ? branchById[parentDep] : startBase
    baseRef = parentDep ? branchById[parentDep] : startRef
  }
  record.base = base
  const vars = {
    id: spec.id, filename: spec.filename, slug: spec.slug, branch, base: baseRef, prBase: base,
    ready: S.ready, inProgress: S.inProgress, done: S.done,
  }

  // ── Claim + Decompose ──────────────────────────────────────
  log(`[${spec.id}] claiming on ${branch} (base: ${baseRef}${parentDep ? ` ← dep ${parentDep}` : ''}) — ${i + 1}/${specs.length}`)
  let claim
  try {
    claim = await ask(
      `You are claiming spec ${spec.id} for implementation. Follow ${PROCESS} for starting a spec.

If branch ${branch} does NOT exist yet:
1. git checkout -b ${branch} ${baseRef}
2. Move the spec to in-progress:
${moveSteps(S.ready, S.inProgress, spec)}
   Report the spec markdown's new path in specPath.
3. Commit: chore: start spec ${spec.id} — [title from the spec]

If branch ${branch} DOES exist (a previous run was interrupted): check it out, do NOT recreate it, and treat this as a resume. The spec should already be under ${S.inProgress}/.

Then ensure the spec has a "## Tasks" section (format defined in ${TEMPLATE}):
- If it is missing, decompose ${DECOMPOSE_FROM} into commit-sized tasks, ordered so earlier tasks unblock later ones. Each task gets an id, a title, a Files: hint and a Verify: command. Add the section and commit it ALONE: chore: decompose spec ${spec.id} into tasks
- Write NO implementation code.
${P.afterClaim ? `\nThen, advisory (a failure here never fails the claim — note it in your summary and move on):\n${fill(P.afterClaim, vars)}\n` : ''}
Finally, report every task in order. A task counts as done=true ONLY if its checkbox is [x] AND \`git log --grep '^Spec-Task: ${spec.id}\\.<taskId>$'\` finds a commit on this branch. A checked box without a commit is done=false (it will be redone).`,
      { phase: 'Claim', label: `claim:${spec.id}`, schema: CLAIM_SCHEMA },
    )
  } catch (e) {
    claim = null
    log(`[${spec.id}] claim errored: ${e?.message || e}`)
  }
  if (!claim) {
    log(`[${spec.id}] claim failed — skipping this spec${STACKING === 'chain' ? ' and stopping the chain' : ''}.`)
    record.error = 'claim failed'
    stop()
    continue
  }
  vars.specPath = claim.specPath
  vars.title = claim.title

  const todo = claim.tasks.filter(t => !t.done)
  const doneAlready = claim.tasks.length - todo.length
  if (claim.resumed) log(`[${spec.id}] resuming — ${doneAlready}/${claim.tasks.length} tasks already committed`)
  else log(`[${spec.id}] decomposed into ${claim.tasks.length} task(s)`)

  // ── Execute tasks: one FRESH agent per task ────────────────
  // Fresh context per commit-sized task: small scope, no context exhaustion,
  // and progress survives any single failure because it lives in git
  // (Spec-Task trailers) + spec checkboxes.
  const taskSteps = [
    `Read the spec for context, but implement ONLY this task. Do not start later tasks; do not refactor beyond the task.`,
    `Follow ${CONVENTIONS}.`,
    ...TASK_RULES,
    `Do NOT run tests — the completeness gate runs the spec's verification once at the end, and per-task test runs cost too much time. Instead make sure what you touched compiles cleanly: ${COMPILE_CHECK}. Still write the task's tests if it calls for them.`,
  ]
  let taskFailed = null
  for (const task of todo) {
    let result = null
    for (let attempt = 1; attempt <= 2 && !result?.committed; attempt++) {
      try {
        result = await ask(
          `You are implementing exactly ONE task of spec ${spec.id}. The spec file is at ${claim.specPath} on branch ${branch} (verify with git rev-parse --abbrev-ref HEAD; check it out if needed).

Your task: **${task.id} — ${task.title}**

Follow ${PROCESS} for executing a task:
${numbered(taskSteps, 1)}
${taskSteps.length + 1}. Edit ${claim.specPath}: change the ${task.id} checkbox from [ ] to [x].
${taskSteps.length + 2}. Commit the implementation AND the checkbox change as ONE commit whose message ends with the trailer line:

Spec-Task: ${spec.id}.${task.id}

(For reference, the task's verify command is: ${task.verify || 'none listed'} — leave it for the gate.)
${attempt > 1 ? 'NOTE: a previous attempt failed — check git status for leftover uncommitted changes from it; reset or build on them as appropriate.\n' : ''}Report committed=true only if the commit actually exists (confirm the sha with git log -1). Never report success you cannot confirm.`,
          { phase: 'Tasks', label: `task:${spec.id}.${task.id}${attempt > 1 ? ':retry' : ''}`, model, schema: TASK_SCHEMA },
        )
      } catch (e) {
        result = null
        log(`[${spec.id}] ${task.id} attempt ${attempt} errored: ${e?.message || e}`)
      }
    }
    const taskRecord = { id: task.id, ...(result || { committed: false, sha: '', summary: 'agent error' }) }
    record.tasks.push(taskRecord)
    if (!result?.committed) {
      taskFailed = task.id
      log(`[${spec.id}] ${task.id} failed twice — sending spec to the gate/blocked path`)
      break
    }
    log(`[${spec.id}] ${task.id} committed (${String(result.sha).slice(0, 8)})`)

    // ── Light review of this one commit ──────────────────────
    // Catches a wrong turn at the task that took it, not at the gate after
    // the last task. No tests — reading only. One fix attempt; the gate is
    // still the judge, so a review that can't be satisfied doesn't block.
    if (RUN_TASK_REVIEW) {
      let review = null
      try {
        review = await ask(
          `Review ONE commit against the task it claims to implement. You did not write it. Do NOT run tests, do NOT modify anything — read only.

Spec ${spec.id}, file ${claim.specPath}, branch ${branch}. Task: **${task.id} — ${task.title}**. Commit: ${result.sha} (\`git show ${result.sha}\`).

Check only:
- Does the commit do what the task asks, as the spec describes it? Anything missing or wrong?
- Did it stay in scope: no work from later tasks, no unrelated edits?
- Anything that plainly won't work: a call to something that doesn't exist, a wrong field or route name, an obviously broken condition.

ok=false only for problems a fix should address now. Do not flag style, naming taste or things a later task will clearly cover.`,
          { phase: 'Tasks', label: `taskreview:${spec.id}.${task.id}`, schema: TASK_REVIEW_SCHEMA },
        )
      } catch (e) {
        log(`[${spec.id}] ${task.id} review errored — continuing. ${e?.message || e}`)
      }
      taskRecord.review = review
      if (review && !review.ok && review.problems.length) {
        log(`[${spec.id}] ${task.id} review found ${review.problems.length} problem(s) — one fix attempt`)
        try {
          await ask(
            `A reviewer found problems in task ${task.id} of spec ${spec.id} (commit ${result.sha}, branch ${branch}, spec file ${claim.specPath}). Fix exactly these and nothing else:

${review.problems.map(p => `- ${p}`).join('\n')}

If a problem is wrong (the code is actually fine), leave it and say why in your final message. Do NOT run tests; check that what you touched compiles cleanly: ${COMPILE_CHECK}. Commit the fix as a new commit (do not amend or rewrite history) whose message ends with the trailer line:

Spec-Task: ${spec.id}.${task.id}`,
            { phase: 'Tasks', label: `taskfix:${spec.id}.${task.id}`, model },
          )
        } catch (e) {
          log(`[${spec.id}] ${task.id} review fix errored — the gate will catch what's left. ${e?.message || e}`)
        }
      }
    }
  }

  // ── Completeness gate + escalating fix rounds ──────────────
  // A FRESH agent with no implementation context. It judges evidence
  // (commits, checkboxes, passing commands), not intentions.
  let gate = null
  let round = 0
  const preExisting = [] // commands proven red on the base branch
  let baselineRan = false
  while (round <= FIX_ROUNDS) {
    // An infrastructure failure is NOT a verdict: agent() returns null on a
    // terminal API error, so retry the gate rather than burning a fix round.
    gate = null
    for (let attempt = 1; attempt <= GATE_ATTEMPTS && !gate; attempt++) {
      try {
        gate = await ask(
          `You are the completeness gate for spec ${spec.id}. You did not write this code — audit it skeptically on branch ${branch}. The spec file is at ${claim.specPath}.
${GATE_SETUP ? `\nSetup first: ${GATE_SETUP}\n` : ''}
1. Tasks: list every task in the "## Tasks" section. Report any still [ ] as uncheckedTasks. For each [x] task, confirm a commit exists: git log --grep '^Spec-Task: ${spec.id}\\.<id>$' — report checked tasks with no commit as missingCommits.
2. Verification: run ${VERIFICATION}. Report anything that fails in failedVerification (include the failing output's gist in notes).
${preExisting.length ? `   ALREADY PROVEN RED ON ${baseRef} — do NOT re-run these, and do NOT report them in failedVerification. A baseline run has confirmed they are someone else's problem:\n${preExisting.map(c => `     - ${c}`).join('\n')}\n` : ''}   For anything that does fail, ask whether this branch could plausibly have caused it: does the failing test live in a file \`git diff --name-only ${baseRef}...HEAD\` lists? Is it a dependency advisory, a missing service, an environment problem? If it looks like it was already broken, still report it in failedVerification but ALSO list it in suspectedPreExisting. Do not fix it — a baseline run decides it, not you.
3. Acceptance criteria: walk ${ACCEPTANCE}. Mark satisfied ones [x] in the spec file (append "(manually verified)" where programmatic verification is impossible but you confirmed it by inspection). Leave unsatisfied ones [ ] and report them in uncheckedCriteria. If you changed the spec file, commit: chore: mark acceptance criteria for spec ${spec.id}

complete=true ONLY if all three checks pass clean. Do not give the benefit of the doubt — an unverifiable claim is a failed check.`,
          { phase: 'Gate', label: `gate:${spec.id}${round > 0 ? `:r${round}` : ''}${attempt > 1 ? `:a${attempt}` : ''}`, schema: GATE_SCHEMA },
        )
      } catch (e) {
        log(`[${spec.id}] gate attempt ${attempt}/${GATE_ATTEMPTS} threw: ${e?.message || e}`)
      }
      if (!gate && attempt < GATE_ATTEMPTS) log(`[${spec.id}] gate attempt ${attempt}/${GATE_ATTEMPTS} returned no verdict — retrying`)
    }
    if (!gate) {
      gate = { complete: false, uncheckedTasks: [], missingCommits: [], failedVerification: [], suspectedPreExisting: [], uncheckedCriteria: [], notes: `gate produced no verdict after ${GATE_ATTEMPTS} attempts (agent error, not a code failure) — spec left for manual review` }
      record.gate = gate
      log(`[${spec.id}] gate unavailable after ${GATE_ATTEMPTS} attempts — leaving spec in-progress, no PR`)
      break
    }
    record.gate = gate
    if (gate.complete) break

    // ── Baseline: this spec's fault, or already red? ──────────
    // Once per spec, only when a command fails, only for the failing commands.
    // Unchecked tasks, missing commits and unmet criteria are always ours.
    const failed = gate.failedVerification.filter(c => !preExisting.includes(c))
    if (failed.length && !baselineRan) {
      baselineRan = true
      log(`[${spec.id}] ${failed.length} command(s) failing — checking whether ${baseRef} was already red`)
      try {
        const baseline = await ask(
          `Spec ${spec.id}'s completeness gate reported failing verification on branch ${branch}. Before anyone "fixes" it, find out whether it was ALREADY failing on ${baseRef}. Do NOT fix anything and do NOT commit anything — this is a measurement.

Commands to test, verbatim (run each the way the spec's verification says to — the spec is at ${claim.specPath}):
${failed.map(c => `  - ${c}`).join('\n')}

Procedure:
1. \`git status --porcelain\` MUST be empty. If it is not, stop: report ran=false with the reason, put nothing in alreadyFailing. Never stash or discard someone's work to take a measurement.
2. \`git checkout --detach ${baseRef}\`.
3. Run each command above and record its exit code. Build artifacts may need rebuilding on the way in and back out; that is expected.
4. \`git checkout ${branch}\` — even if a command blew up — and confirm with \`git rev-parse --abbrev-ref HEAD\`. Leaving the tree on the wrong branch corrupts every later phase.
5. A command that fails on ${baseRef} too goes in alreadyFailing, verbatim as given above. One that passes on ${baseRef} goes in newlyFailing.

In notes, say briefly what each failure actually was, so a human reading the PR knows what is already broken on ${base}.`,
          { phase: 'Gate', label: `baseline:${spec.id}`, schema: BASELINE_SCHEMA },
        )
        if (baseline?.ran) {
          for (const c of baseline.alreadyFailing || []) if (!preExisting.includes(c)) preExisting.push(c)
          record.preExistingFailures = [...preExisting]
          record.baselineNotes = baseline.notes || ''
          if (preExisting.length) log(`[${spec.id}] already red on ${baseRef} — not this spec's to fix: ${preExisting.join(' | ')}`)
        } else {
          log(`[${spec.id}] baseline could not run (${baseline?.notes || 'agent error'}) — treating every failure as ours`)
        }
      } catch (e) {
        log(`[${spec.id}] baseline errored — treating every failure as ours. ${e?.message || e}`)
      }
    }

    // A spec whose only problem is that the repo was already broken is DONE:
    // it gets a PR, and the inherited failures are reported, not repaired.
    const ourFailures = gate.failedVerification.filter(c => !preExisting.includes(c))
    const clean = !gate.uncheckedTasks.length && !gate.missingCommits.length && !gate.uncheckedCriteria.length && !ourFailures.length
    if (clean) {
      gate.complete = true
      gate.failedVerification = ourFailures
      record.gate = gate
      log(`[${spec.id}] gate passes — the only failures predate this branch (${preExisting.length} command(s))`)
      break
    }

    if (round === FIX_ROUNDS) break

    round++
    // Later rounds go to a stronger model: if the first fixer couldn't
    // crack it twice, a third try on the same model rarely does.
    const fixModel = round >= ESCALATE.fromRound ? ESCALATE.model : model
    const problems = [
      gate.uncheckedTasks.length ? `Unfinished tasks: ${gate.uncheckedTasks.join(', ')}` : '',
      gate.missingCommits.length ? `Checked tasks with NO Spec-Task commit (redo them): ${gate.missingCommits.join(', ')}` : '',
      ourFailures.length ? `Failing verification commands: ${ourFailures.join(' | ')}` : '',
      gate.uncheckedCriteria.length ? `Unmet acceptance criteria: ${gate.uncheckedCriteria.join(' | ')}` : '',
      gate.notes ? `Gate notes: ${gate.notes}` : '',
    ].filter(Boolean).join('\n')
    log(`[${spec.id}] gate failed (round ${round}/${FIX_ROUNDS}) — dispatching fix agent${fixModel !== model ? ` on ${fixModel}` : ''}`)
    try {
      await ask(
        `Spec ${spec.id} on branch ${branch} failed its completeness gate. The spec file is at ${claim.specPath}. Fix ONLY the reported problems, following ${PROCESS} — one commit per task with its Spec-Task: ${spec.id}.<taskId> trailer (use the trailer of the task each fix belongs to).
${round > 1 ? `\nThis is fix round ${round} of ${FIX_ROUNDS}: earlier rounds did not get the gate to pass. Read \`git log ${baseRef}..HEAD\` to see what they tried, and do not repeat an approach that already failed.\n` : ''}
${problems}
${preExisting.length ? `
ALREADY RED ON ${baseRef}, CONFIRMED BY A BASELINE RUN — NOT YOURS TO FIX:
${preExisting.map(c => `  - ${c}`).join('\n')}
Leave them alone. They are deliberately excluded from the list above.
` : ''}
**Scope.** Every commit you make wears a \`Spec-Task: ${spec.id}.*\` trailer, which claims the change belongs to this spec. So it has to. Before you touch a file, ask whether the problem was introduced by this branch — \`git log ${baseRef}..HEAD -- <path>\` and \`git diff --name-only ${baseRef}...HEAD\` answer it. If the cause predates the branch (a red test in a file nobody here touched, a dependency advisory, a stale fixture, a missing service), DO NOT fix it: say so in your final message and move on. That fix belongs in its own branch.

Re-run the relevant verify commands before committing. Do not touch anything outside the reported problems.`,
        { phase: 'Gate', label: `fix:${spec.id}:r${round}`, model: fixModel },
      )
    } catch (e) {
      log(`[${spec.id}] fix round ${round} errored: ${e?.message || e}`)
    }
  }

  // ── Blocked path: gate never passed (or a task died) ───────
  if (!gate?.complete) {
    log(`[${spec.id}] BLOCKED${taskFailed ? ` (task ${taskFailed})` : ''} — draft PR; ${STACKING === 'chain' ? 'stopping the chain' : 'dependents will skip, unrelated specs continue'}`)
    try {
      await ask(
        `Spec ${spec.id} on branch ${branch} is blocked (spec file: ${claim.specPath}). Follow the failure protocol in ${PROCESS} if it has one; otherwise:
1. Add a "## Blocked" section to the spec file listing: what was attempted, the exact errors, which tasks are unchecked (${(gate?.uncheckedTasks || []).concat(gate?.missingCommits || []).join(', ') || taskFailed || 'see gate notes'}), failing verification (${(gate?.failedVerification || []).join(' | ') || 'none'}), and unmet criteria (${(gate?.uncheckedCriteria || []).join(' | ') || 'none'}). Gate notes: ${gate?.notes || 'n/a'}${record.preExistingFailures?.length ? `\n   Note separately, under a "Not caused by this spec" heading, that these were confirmed already failing on ${base} and were deliberately left alone: ${record.preExistingFailures.join(' | ')}` : ''}
2. Commit it. Leave the spec in ${S.inProgress}/ — do NOT move it to done.
3. Commit any leftover uncommitted changes (chore: WIP for blocked spec ${spec.id}).
4. git push origin ${branch}
5. Create a DRAFT pull request targeting '${base}' titled "[BLOCKED] ${fill(PR_TITLE, { ...vars, title: claim.title })}" summarizing the blockage.${P.afterBlocked ? `\n6. Advisory (a failure here is noted and ignored):\n${fill(P.afterBlocked, vars)}` : ''}`,
        { phase: 'Gate', label: `blocked:${spec.id}` },
      )
    } catch (e) {
      log(`[${spec.id}] blocked-protocol agent errored: ${e?.message || e}`)
    }
    record.blocked = true
    stop()
    continue
  }

  // ── Capture — advisory, repo-defined ───────────────────────
  // Only runs when the repo supplies prompts.capture. Any failure is logged
  // and never blocks Complete.
  if (P.capture) {
    try {
      const capture = await ask(
        `Spec ${spec.id} on branch ${branch} has passed its completeness gate (spec file: ${claim.specPath}). Capture visuals of what it changed — advisory, do NOT change any implementation code.

${fill(P.capture, vars)}

Report committed=true only if the screenshots commit exists (confirm with git log -1), with galleryPath set to the committed gallery's real path. If nothing was captured, say why in note. Never fabricate success — a failed capture is committed=false, and that is fine.`,
        { phase: 'Capture', label: `capture:${spec.id}`, model, schema: CAPTURE_SCHEMA },
      )
      record.screenshots = {
        committed: !!capture?.committed,
        count: capture?.count || 0,
        galleryPath: capture?.galleryPath || '',
        walkthroughs: capture?.walkthroughs || 0,
        mediaDir: capture?.mediaDir || '',
        note: capture?.note || '',
      }
      if (capture?.committed) log(`[${spec.id}] captured ${capture.count} screenshot(s) → ${capture.galleryPath}`)
      else if (capture?.attempted) log(`[${spec.id}] capture produced no committed screenshots — continuing. ${capture?.summary || ''}`)
    } catch (e) {
      log(`[${spec.id}] capture step failed — continuing. ${e?.message || e}`)
    }
  }

  // ── Complete: move to done, push, PR ───────────────────────
  const shots = record.screenshots || {}
  const gallery = shots.committed ? shots.galleryPath : ''
  const doneVars = {
    ...vars,
    gallery,
    count: shots.count || 0,
    walkthroughs: shots.walkthroughs || 0,
    mediaDir: shots.mediaDir || '',
    note: (shots.note || '').replace(/[`"$\\]/g, "'"),
  }
  const labels = PR_LABELS.map(l => ` --label ${l}`).join('')
  let fin
  try {
    fin = await ask(
      `Spec ${spec.id} on branch ${branch} passed its completeness gate. Follow ${PROCESS} for completing a spec:
1. Move the spec to done — the whole spec, exactly as at claim time:
${moveSteps(S.inProgress, S.done, spec)}
   Verify nothing was left behind: \`ls ${S.inProgress}/ | grep '${spec.filename}'\` must come back empty.
2. Commit any leftover uncommitted changes first if present, then commit: chore: complete spec ${spec.id} — ${claim.title}
3. git push origin ${branch}
4. Create a PR with \`gh pr create --base ${base}${labels}\`, title "${fill(PR_TITLE, { ...vars, title: claim.title })}", body containing the spec's acceptance criteria (with checkmarks), its Tasks section, and a summary${gallery ? `, and a "## Screenshots" section linking the committed gallery at ${gallery} (${shots.count} shot(s); it moved to ${S.done}/ in step 1 — link the new path)` : ''}.${record.preExistingFailures?.length ? `\n   Also add a "## Inherited red" section, stated plainly so a reviewer doesn't mistake it for this spec's doing: these verification commands were confirmed by a baseline run to be **already failing on ${base}**, and were deliberately left alone rather than repaired under this spec's trailers — ${record.preExistingFailures.join(' | ')}.${record.baselineNotes ? ` What they actually were: ${record.baselineNotes}` : ''} They are worth their own branch.` : ''}${C.prBody ? `\n   ${fill(C.prBody, doneVars)}` : ''}
5. Verify the push: git ls-remote --exit-code origin ${branch}${P.afterPr ? `
6. After the PR exists (advisory: a failure here is logged and NEVER changes pushed or prNumber, and never stops the PR):
${fill(P.afterPr, doneVars)}` : ''}

Report pushed=true only if step 5 succeeds. Never fabricate success.`,
      { phase: 'Complete', label: `complete:${spec.id}`, schema: COMPLETE_SCHEMA },
    )
  } catch (e) {
    fin = null
    log(`[${spec.id}] completion step errored: ${e?.message || e}`)
  }
  if (!fin) {
    record.error = 'complete failed'
    stop()
    continue
  }

  record.pushed = fin.pushed
  record.prNumber = fin.prNumber
  record.summary = fin.summary

  if (!fin.pushed) {
    log(`[${spec.id}] branch not confirmed on origin — ${STACKING === 'chain' ? 'stopping the chain' : 'dependents will skip, unrelated specs continue'}.`)
    stop()
    continue
  }

  // Complete and on origin: usable as a base from here on.
  branchById[spec.id] = branch
  chain = { base: branch, ref: branch }

  // ── Independent review — advisory, never aborts ────────────
  if (RUN_REVIEW && fin.prNumber > 0) {
    try {
      record.review = await ask(
        `Run a code review of PR #${fin.prNumber} and post findings as inline comments. Execute the slash command: /code-review high --comment ${fin.prNumber}
You have no implementation context on purpose — review independently.${P.afterReview ? `\nOnce the findings are posted:\n${fill(P.afterReview, { ...vars, pr: fin.prNumber })}` : ''}
Return a one-line note of how many findings you posted.`,
        { phase: 'Review', label: `review:${spec.id}` },
      )
    } catch (e) {
      log(`[${spec.id}] review step failed — continuing. ${e?.message || e}`)
    }
  }

  log(`[${spec.id}] done (${i + 1}/${specs.length}) — PR #${fin.prNumber} → ${base}, ${record.tasks.length} task commit(s)`)
}

const ok = processed.filter(p => p.pushed).length
const skipped = processed.filter(p => p.skipped).length
const blocked = processed.filter(p => p.blocked).length
const unready = processed.filter(p => p.notReady)
log(`Finished: ${ok}/${specs.length} spec(s) landed${blocked ? `, ${blocked} blocked` : ''}${skipped ? `, ${skipped} skipped` : ''}.`)

// Surface what needs a human, once, at the end.
for (const p of unready) log(`[${p.id}] not built — fix the spec first: ${p.notReady.join(' | ')}`)
const inherited = [...new Set(processed.flatMap(p => p.preExistingFailures || []))]
if (inherited.length) log(`Already red before this run, left alone on purpose (worth their own branch): ${inherited.join(' | ')}`)

return { startBase, startRef, worktree: WORKTREE || null, landed: ok, notReady: unready.map(p => ({ id: p.id, problems: p.notReady })), inherited, processed }
