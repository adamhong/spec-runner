// Control-flow tests for workflows/run-specs.js.
//
//   node tests/run-specs.test.mjs
//
// The workflow decides whether a spec gets a PR, so its branching is worth
// testing — but it only runs inside the Workflow tool, and every step is an
// LLM call. So the script body is evaluated here with `agent()` stubbed:
// canned verdicts in, control flow out. Nothing spawns, nothing touches git.
//
// The baseline cases exist because of a real failure: verification commands
// that were already red on the base branch made the gate return
// complete=false, and two fix rounds went into repairing unrelated breakage
// that then shipped wearing `Spec-Task:` trailers claiming it was the spec's.

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, "..", "workflows", "run-specs.js")

// Strip the `export const meta = {…}` header only the Workflow runtime
// understands; keep the body.
function scriptBody() {
  const lines = fs.readFileSync(SCRIPT, "utf8").split("\n")
  const end = lines.findIndex((l, i) => i > 3 && l.startsWith("}"))
  assert.ok(end > 0, "could not find the end of the meta block")
  return lines.slice(end + 1).join("\n")
}

const BODY = scriptBody()

const CONFIG = {
  baseBranch: "develop",
  specs: {ready: "tasks/specs/ready", inProgress: "tasks/specs/in-progress", done: "tasks/specs/done", folders: true},
  branch: "spec/{filename}",
  prTitle: "spec/{id}: {title}",
  prLabels: ["needs-review"],
  compileCheck: "`make check`",
  taskRules: ["Never log secrets."],
  prompts: {
    capture: "Capture into {inProgress}/{filename}/screenshots/. Do NOT publish anything here.",
    afterPr: "Media dir: `{mediaDir}` ({walkthroughs} built). If it is empty, write this note instead: {note}. Leave ${shell} and {unknown} alone.",
    afterReview: "Label PR #{pr} as reviewed.",
  },
}

/** A gate verdict with every field present — override only what the case is about. */
const verdict = (over = {}) => ({
  complete: false, uncheckedTasks: [], missingCommits: [], failedVerification: [],
  suspectedPreExisting: [], uncheckedCriteria: [], notes: "", ...over,
})

const spec = (id, over = {}) => ({id, filename: `${id}-f`, slug: "f", path: "p", model: "", deps: [], ...over})

const READY = {ready: true, problems: [], warnings: []}
const REVIEW_OK = {ok: true, problems: []}

async function run({
  gate = () => verdict({complete: true}), baseline = null, capture, config = CONFIG, specs = [spec("0317")],
  baseBranch = "develop", args = {}, ready = () => READY, taskReview = () => REVIEW_OK,
} = {}) {
  const logs = []
  const calls = []
  const prompts = {}
  const opts = {}
  const byLabel = {}

  const agent = async (prompt, o = {}) => {
    const label = o.label || ""
    calls.push(label)
    const key = label.split(":")[0]
    prompts[key] = prompt
    opts[key] = o
    byLabel[label] = {prompt, o}

    const id = label.split(":")[1]
    if (key === "plan") return {baseBranch, specs}
    if (key === "ready") return ready(id)
    if (key === "claim") {
      return {branch: `spec/${id}-f`, specPath: "sp", title: "A title", resumed: false, tasks: [{id: "T1", title: "t", verify: "", done: false}]}
    }
    if (key === "task") return {committed: true, sha: "abcdef1234", summary: ""}
    if (key === "taskreview") return taskReview(id)
    if (key === "gate") return gate(calls.filter((c) => c.startsWith("gate")).length, label)
    if (key === "baseline") return baseline
    if (key === "capture") return capture || {attempted: false, committed: false, count: 0, galleryPath: "", summary: ""}
    if (key === "complete") return {prNumber: 1, pushed: true, summary: ""}
    return ""
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))

  const fn = new Function("args", "agent", "log", "phase", "parallel", "pipeline", `return (async () => { ${BODY} })()`)
  const result = await fn({config, review: false, ...args}, agent, (m) => logs.push(m), () => {}, parallel, () => {})
  const count = (p) => calls.filter((c) => c.split(":")[0] === p).length
  return {result, logs, calls, prompts, opts, byLabel, count}
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ── Gate and baseline ─────────────────────────────────────────

test("a spec whose only failures predate the branch passes, and says so", async () => {
  const o = await run({
    gate: () => verdict({failedVerification: ["make lint", "make test"]}),
    baseline: {ran: true, alreadyFailing: ["make lint", "make test"], newlyFailing: [], notes: "advisory; two stale specs"},
  })
  assert.equal(o.count("fix"), 0, "nothing to fix — the repo was already red")
  assert.equal(o.count("gate"), 1, "no second gate: the first verdict stands once baselined")
  assert.equal(o.count("baseline"), 1, "baseline runs once, lazily")
  assert.equal(o.result.landed, 1)
  assert.deepEqual(o.result.inherited, ["make lint", "make test"])
  assert.match(o.prompts.complete, /Inherited red/)
  assert.match(o.prompts.complete, /already failing on develop/)
})

test("a genuinely broken command still gets a fix round", async () => {
  const o = await run({
    gate: (n) => (n === 1 ? verdict({failedVerification: ["make test ours"]}) : verdict({complete: true})),
    baseline: {ran: true, alreadyFailing: [], newlyFailing: ["make test ours"], notes: ""},
  })
  assert.equal(o.count("fix"), 1)
  assert.match(o.prompts.fix, /make test ours/)
  assert.equal(o.result.landed, 1)
  assert.deepEqual(o.result.inherited, [])
})

test("mixed failures: the fix agent is handed ours and warned off the rest", async () => {
  const o = await run({
    gate: (n) => (n === 1 ? verdict({failedVerification: ["make lint", "make test ours"], uncheckedCriteria: ["a criterion"]}) : verdict({complete: true})),
    baseline: {ran: true, alreadyFailing: ["make lint"], newlyFailing: ["make test ours"], notes: ""},
  })
  const worklist = o.prompts.fix.match(/Failing verification commands: .*/)[0]
  assert.match(worklist, /make test ours/)
  assert.doesNotMatch(worklist, /make lint/, "pre-existing breakage is not work")
  assert.match(o.prompts.fix, /NOT YOURS TO FIX[\s\S]*make lint/)
  assert.match(o.prompts.fix, /a criterion/, "an unmet criterion is still ours regardless")
})

test("an unmeasurable baseline fails closed — every failure is assumed ours", async () => {
  const o = await run({
    gate: (n) => (n === 1 ? verdict({failedVerification: ["make lint"]}) : verdict({complete: true})),
    baseline: {ran: false, alreadyFailing: [], newlyFailing: [], notes: "working tree dirty"},
  })
  assert.equal(o.count("fix"), 1)
  assert.match(o.prompts.fix.match(/Failing verification commands: .*/)[0], /make lint/)
  assert.deepEqual(o.result.inherited, [])
})

test("unchecked tasks are never excused by a baseline", async () => {
  const o = await run({
    gate: (n) => (n === 1 ? verdict({uncheckedTasks: ["T3"], failedVerification: ["make lint"]}) : verdict({complete: true})),
    baseline: {ran: true, alreadyFailing: ["make lint"], newlyFailing: [], notes: ""},
  })
  assert.equal(o.count("fix"), 1)
  assert.match(o.prompts.fix, /Unfinished tasks: T3/)
})

test("a gate that never returns a verdict leaves the spec blocked, without fix rounds", async () => {
  const o = await run({gate: () => null})
  assert.equal(o.count("gate"), 3, "retried GATE_ATTEMPTS times")
  assert.equal(o.count("fix"), 0, "an outage is not a code failure")
  assert.equal(o.count("blocked"), 1)
  assert.equal(o.result.landed, 0)
})

// ── Config ────────────────────────────────────────────────────

test("no config: refuses to run instead of guessing", async () => {
  const o = await run({config: null})
  assert.equal(o.calls.length, 0)
  assert.match(o.result.error, /missing args.config/)
})

test("wrong base branch: stops after planning, changes nothing", async () => {
  const o = await run({baseBranch: "feature/x"})
  assert.deepEqual(o.calls, ["plan:discover"])
  assert.match(o.result.error, /wrong base branch/)
})

test("tasks get the repo's compile check and rules, and are told not to run tests", async () => {
  const o = await run()
  assert.match(o.prompts.task, /Do NOT run tests/)
  assert.match(o.prompts.task, /`make check`/)
  assert.match(o.prompts.task, /Never log secrets\./)
  assert.match(o.prompts.task, /Spec-Task: 0317\.T1/)
})

test("placeholders are filled; unknown braces and shell syntax survive", async () => {
  const o = await run()
  assert.match(o.prompts.capture, /tasks\/specs\/in-progress\/0317-f\/screenshots\//)
  assert.match(o.prompts.complete, /\$\{shell\} and \{unknown\} alone/)
})

test("branch, PR title and labels come from config", async () => {
  const o = await run({config: {...CONFIG, branch: "task/{id}-{slug}", prTitle: "[{id}] {title}"}})
  assert.equal(o.result.processed[0].branch, "task/0317-f")
  assert.match(o.prompts.complete, /title "\[0317\] A title"/)
  assert.match(o.prompts.complete, /--label needs-review/)
})

test("model frontmatter is routed through model.map", async () => {
  const o = await run({config: {...CONFIG, model: {map: {high: "opus"}}}, specs: [spec("0317", {model: "complexity: High"})]})
  assert.equal(o.opts.task.model, "opus")
})

test("folder specs move whole; flat-only repos get one git mv", async () => {
  const folders = await run()
  assert.match(folders.prompts.claim, /git mv tasks\/specs\/ready\/0317-f tasks\/specs\/in-progress\//)
  const flat = await run({config: {...CONFIG, specs: {...CONFIG.specs, folders: false}}})
  assert.doesNotMatch(flat.prompts.claim, /folder/)
  assert.match(flat.prompts.claim, /git mv tasks\/specs\/ready\/0317-f\.md tasks\/specs\/in-progress\/0317-f\.md/)
})

// ── Capture and after-PR steps ────────────────────────────────

test("no capture prompt: the Capture phase is skipped entirely", async () => {
  const {capture, ...prompts} = CONFIG.prompts
  const o = await run({config: {...CONFIG, prompts}})
  assert.equal(o.count("capture"), 0)
  assert.equal(o.result.landed, 1)
})

test("built media is handed to the after-PR step, after the PR exists", async () => {
  const mediaDir = "out/walkthroughs/build/"
  const o = await run({capture: {attempted: true, committed: true, count: 2, galleryPath: "g/SCREENSHOTS.md", walkthroughs: 1, mediaDir, note: "", summary: ""}})
  assert.match(o.prompts.capture, /Do NOT publish/)
  assert.ok(o.prompts.complete.includes(`Media dir: \`${mediaDir}\` (1 built)`))
  assert.match(o.prompts.complete, /## Screenshots/)
  assert.match(o.prompts.complete, /NEVER changes pushed or prNumber/)
})

test("no media: the capture note reaches the after-PR step, quote-safe", async () => {
  const o = await run({capture: {attempted: true, committed: false, count: 0, galleryPath: "", walkthroughs: 0, mediaDir: "", note: 'capture failed (no "ffmpeg")', summary: ""}})
  assert.match(o.prompts.complete, /Media dir: `` \(0 built\)/)
  assert.match(o.prompts.complete, /capture failed \(no 'ffmpeg'\)/)
  assert.doesNotMatch(o.prompts.complete, /## Screenshots/)
})

test("review runs only when enabled, with the repo's after-review step", async () => {
  const o = await run({args: {review: true}})
  assert.match(o.prompts.review, /\/code-review high --comment 1/)
  assert.match(o.prompts.review, /Label PR #1 as reviewed\./)
  assert.equal((await run()).count("review"), 0)
})

// ── Stacking ──────────────────────────────────────────────────

test("dependency stacking: a dependent stacks on its parent; unrelated specs branch off base", async () => {
  const o = await run({specs: [spec("0001"), spec("0002", {deps: ["0001"]}), spec("0003")]})
  const [a, b, c] = o.result.processed
  assert.equal(a.base, "develop")
  assert.equal(b.base, "spec/0001-f")
  assert.equal(c.base, "develop")
})

test("dependency stacking: a blocked parent skips its dependents, not unrelated specs", async () => {
  const o = await run({
    gate: (n, label) => (label.startsWith("gate:0001") ? verdict({uncheckedTasks: ["T1"]}) : verdict({complete: true})),
    specs: [spec("0001"), spec("0002", {deps: ["0001"]}), spec("0003")],
    config: {...CONFIG, fixRounds: 0},
  })
  const [a, b, c] = o.result.processed
  assert.equal(a.blocked, true)
  assert.equal(b.skipped, true)
  assert.equal(c.pushed, true)
})

test("chain stacking: each spec builds on the last, and the first failure stops the run", async () => {
  const landed = await run({config: {...CONFIG, stacking: "chain"}, specs: [spec("0001"), spec("0002")]})
  assert.equal(landed.result.processed[1].base, "spec/0001-f")

  const stopped = await run({
    config: {...CONFIG, stacking: "chain", fixRounds: 0},
    gate: (n, label) => (label.startsWith("gate:0001") ? verdict({uncheckedTasks: ["T1"]}) : verdict({complete: true})),
    specs: [spec("0001"), spec("0002"), spec("0003")],
  })
  const [a, b, c] = stopped.result.processed
  assert.equal(a.blocked, true)
  assert.equal(b.skipped, true)
  assert.equal(c.skipped, true)
  assert.equal(stopped.count("claim"), 1)
})

// ── Readiness ─────────────────────────────────────────────────

test("an unready spec is not built, its dependents skip, unrelated specs still build", async () => {
  const o = await run({
    ready: (id) => (id === "0001" ? {ready: false, problems: ["T3 says TBD"], warnings: []} : READY),
    specs: [spec("0001"), spec("0002", {deps: ["0001"]}), spec("0003")],
  })
  assert.equal(o.count("ready"), 3, "every spec is checked, up front")
  assert.ok(!o.calls.includes("claim:0001"), "an unready spec is never claimed")
  const [a, b, c] = o.result.processed
  assert.deepEqual(a.notReady, ["T3 says TBD"])
  assert.equal(b.skipped, true)
  assert.equal(c.pushed, true)
  assert.deepEqual(o.result.notReady, [{id: "0001", problems: ["T3 says TBD"]}])
})

test("readiness can be turned off, and a check that errors doesn't hold a spec back", async () => {
  const off = await run({config: {...CONFIG, readinessCheck: false}})
  assert.equal(off.count("ready"), 0)
  const errored = await run({ready: () => { throw new Error("529") }})
  assert.equal(errored.result.landed, 1)
})

// ── Per-task review ───────────────────────────────────────────

test("a task review that finds problems gets one fix, as a new commit on the same trailer", async () => {
  const o = await run({taskReview: () => ({ok: false, problems: ["calls Foo.bar/2, which doesn't exist"]})})
  assert.equal(o.count("taskreview"), 1)
  assert.equal(o.count("taskfix"), 1)
  assert.match(o.prompts.taskfix, /Foo\.bar\/2/)
  assert.match(o.prompts.taskfix, /do not amend/)
  assert.match(o.prompts.taskfix, /Spec-Task: 0317\.T1/)
  assert.match(o.prompts.taskreview, /Do NOT run tests/)
  assert.equal(o.result.landed, 1, "the gate is still the judge")
})

test("a clean task review costs no fix; taskReview:false skips reviews", async () => {
  const clean = await run()
  assert.equal(clean.count("taskreview"), 1)
  assert.equal(clean.count("taskfix"), 0)
  const off = await run({config: {...CONFIG, taskReview: false}})
  assert.equal(off.count("taskreview"), 0)
})

// ── Escalating fixes ──────────────────────────────────────────

test("fix rounds default to 4, and escalate to a stronger model from round 3", async () => {
  const o = await run({gate: () => verdict({uncheckedTasks: ["T1"]})})
  assert.equal(o.count("fix"), 4)
  assert.equal(o.byLabel["fix:0317:r1"].o.model, "sonnet")
  assert.equal(o.byLabel["fix:0317:r2"].o.model, "sonnet")
  assert.equal(o.byLabel["fix:0317:r3"].o.model, "opus")
  assert.equal(o.byLabel["fix:0317:r4"].o.model, "opus")
  assert.match(o.byLabel["fix:0317:r3"].prompt, /do not repeat an approach that already failed/)
  assert.equal(o.count("blocked"), 1)
})

test("escalation is configurable", async () => {
  const o = await run({
    config: {...CONFIG, fixRounds: 2, fixEscalation: {fromRound: 2, model: "sonnet-max"}},
    gate: () => verdict({uncheckedTasks: ["T1"]}),
  })
  assert.equal(o.byLabel["fix:0317:r1"].o.model, "sonnet")
  assert.equal(o.byLabel["fix:0317:r2"].o.model, "sonnet-max")
})

// ── Worktree ──────────────────────────────────────────────────

const WT = {worktree: "/repo/.git/spec-runner/worktree", base: "develop", baseRef: "origin/develop"}

test("worktree: every agent is told where to work, and nothing checks the user's branch", async () => {
  const o = await run({args: WT, baseBranch: "HEAD"})
  assert.equal(o.result.landed, 1, "a detached worktree isn't 'the wrong branch'")
  for (const label of o.calls) assert.match(o.byLabel[label].prompt, /^WORKING DIRECTORY: .*\/repo\/\.git\/spec-runner\/worktree/, label)
})

test("worktree: branches start from origin/<base>, PRs target <base>", async () => {
  const o = await run({
    args: WT, baseBranch: "HEAD",
    gate: () => verdict({failedVerification: ["make lint"]}),
    baseline: {ran: true, alreadyFailing: ["make lint"], newlyFailing: [], notes: ""},
  })
  assert.match(o.prompts.claim, /git checkout -b spec\/0317-f origin\/develop/)
  assert.doesNotMatch(o.prompts.claim, /git checkout develop/, "can't check out a branch the main checkout holds")
  assert.match(o.prompts.baseline, /git checkout --detach origin\/develop/)
  assert.match(o.prompts.complete, /gh pr create --base develop /)
  assert.match(o.prompts.complete, /already failing on develop/)
})

test("worktree: a dependent spec stacks on its parent's local branch", async () => {
  const o = await run({args: WT, baseBranch: "HEAD", specs: [spec("0001"), spec("0002", {deps: ["0001"]})]})
  assert.match(o.byLabel["claim:0002"].prompt, /git checkout -b spec\/0002-f spec\/0001-f/)
  assert.equal(o.result.processed[1].base, "spec/0001-f")
})

test("in place: no working-directory note", async () => {
  const o = await run()
  assert.doesNotMatch(o.prompts.claim, /WORKING DIRECTORY/)
  assert.match(o.prompts.claim, /git checkout -b spec\/0317-f develop/)
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}\n     ${e.message.split("\n").slice(0, 6).join("\n     ")}`)
  }
}
console.log(failed ? `\n${failed}/${tests.length} failed` : `\n${tests.length} passed`)
process.exit(failed ? 1 : 0)
