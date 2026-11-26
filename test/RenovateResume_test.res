open Test
open RenovateResume

let equals = (~message=?, a, b) => assertion(~message?, ~operator="equals", (a, b) => a == b, a, b)

let body = "Some text\n\n---\n\n - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n"
let ticked = body->String.replace("[ ] <!-- rebase", "[x] <!-- rebase")

test("tickRebase ticks Renovate's rebase checkbox", () =>
  equals(tickRebase(Value(body)), Some(ticked))
)

test("tickRebase is None without an unticked checkbox", () => {
  equals(tickRebase(Value("no box")), None)
  equals(tickRebase(Value(ticked)), None)
  equals(tickRebase(Null), None)
})

let repo = {Github.owner: "o", repo: "r"}
let opts = {repo, prefix: "renovate/", label: "renovate:needs-human"}

let pr = (~ref=?, ~fullName="o/r", ~labels=[], ~body=body, n): Github.pullRequest => {
  number: n,
  body: Value(body),
  labels: labels->Array.map(name => {Github.name: name}),
  head: {
    ref: ref->Option.getOr(`renovate/thing-${n->Int.toString}`),
    sha: `sha${n->Int.toString}`,
    repo: Value({Github.fullName: fullName}),
  },
}

test("isCandidate takes Renovate branches in the repo", () =>
  equals(isCandidate(pr(1), opts), true)
)

test("isCandidate skips other branches, forks, and the needs-human label", () => {
  equals(isCandidate(pr(~ref="feature", 1), opts), false)
  equals(isCandidate(pr(~fullName="fork/r", 1), opts), false)
  equals(isCandidate(pr(~labels=["renovate:needs-human"], 1), opts), false)
  equals(isCandidate({...pr(1), head: {...pr(1).head, repo: Null}}, opts), false)
})

let run = (id, status, conclusion, started): Github.checkRun => {
  id,
  status,
  conclusion: conclusion->Nullable.fromOption,
  startedAt: started,
}
let ids = run => run->Option.map(r => r.Github.id)

test("latestRun picks the most recently started run", () => {
  let runs = [
    run(1, "completed", Some("failure"), "2026-01-01T00:00:00Z"),
    run(2, "completed", Some("success"), "2026-01-02T00:00:00Z"),
  ]
  let busy = [...runs, run(3, "in_progress", None, "2026-01-03T00:00:00Z")]
  equals(latestRun(runs)->ids, Some(2))
  equals(latestRun(~completed=true, runs)->ids, Some(2))
  equals(latestRun(busy)->ids, Some(3))
  equals(latestRun(~completed=true, busy)->ids, Some(2))
  equals(latestRun([])->ids, None)
})

test("latestRun breaks a tie on start time by id", () => {
  let runs = [
    run(1, "completed", Some("failure"), "2026-01-01T00:00:00Z"),
    run(2, "completed", Some("success"), "2026-01-01T00:00:00Z"),
  ]
  equals(latestRun(runs)->ids, Some(2))
})

let red = [run(1, "completed", Some("failure"), "2026-01-01T00:00:00Z")]
let green = [run(1, "completed", Some("success"), "2026-01-01T00:00:00Z")]
let busy = [run(1, "in_progress", None, "2026-01-01T00:00:00Z")]

test("commitVerdict reads a commit's last finished run", () => {
  equals(commitVerdict(red), Some(true))
  equals(commitVerdict(green), Some(false))
  equals(commitVerdict(busy), None)
  equals(commitVerdict([]), None)
})

test("a timed-out run counts as failed; cancelled and skipped runs are passed over", () => {
  let after = conclusion => [...red, run(2, "completed", Some(conclusion), "2026-01-02T00:00:00Z")]
  equals(
    commitVerdict([run(1, "completed", Some("timed_out"), "2026-01-01T00:00:00Z")]),
    Some(true),
  )
  equals(commitVerdict(after("cancelled")), Some(true))
  equals(commitVerdict(after("skipped")), Some(true))
  equals(commitVerdict([run(1, "completed", Some("skipped"), "2026-01-02T00:00:00Z")]), None)
})

test("hasHistory is false for a new branch or an empty before", () => {
  equals(hasHistory("b"), true)
  equals(hasHistory(String.repeat("0", 40)), false)
  equals(hasHistory(""), false)
})

test("decide ticks a failing candidate", () => equals(decide(pr(1), red), Tick(ticked)))

test("decide leaves passing, running, and unchecked PRs alone", () => {
  equals(decide(pr(3), green), Ignore)
  equals(decide(pr(4), busy), Ignore)
  equals(decide(pr(6), []), Ignore)
})

test("decide reads only a PR's latest run", () =>
  equals(
    decide(pr(6), [...green, run(2, "completed", Some("failure"), "2026-02-01T00:00:00Z")]),
    Tick(ticked),
  )
)

test("decide reports a failing PR whose checkbox is already ticked", () =>
  equals(decide(pr(~body=ticked, 1), red), NoCheckbox)
)
