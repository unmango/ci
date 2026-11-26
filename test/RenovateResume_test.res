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
  id: Int.toFloat(id),
  status,
  conclusion: conclusion->Nullable.fromOption,
  startedAt: Value(started),
}
let red = [run(1, "completed", Some("failure"), "2026-01-01T00:00:00Z")]
let green = [run(1, "completed", Some("success"), "2026-01-01T00:00:00Z")]
let busy = [run(1, "in_progress", None, "2026-01-01T00:00:00Z")]
let ids = run => run->Option.map(r => r.Github.id->Float.toString)

test("latestRun picks the most recently started run", () => {
  let runs = [
    run(1, "completed", Some("failure"), "2026-01-01T00:00:00Z"),
    run(2, "completed", Some("success"), "2026-01-02T00:00:00Z"),
  ]
  let busy = [...runs, run(3, "in_progress", None, "2026-01-03T00:00:00Z")]
  equals(latestRun(runs)->ids, Some("2"))
  equals(latestRun(~completed=true, runs)->ids, Some("2"))
  equals(latestRun(busy)->ids, Some("3"))
  equals(latestRun(~completed=true, busy)->ids, Some("2"))
  equals(latestRun([])->ids, None)
})

test("latestRun breaks a tie by id, past 2^31 too, and orders an unstarted run by id", () => {
  let tie = [...red, run(2, "completed", Some("success"), "2026-01-01T00:00:00Z")]
  equals(latestRun(tie)->ids, Some("2"))
  equals(
    latestRun([...tie, {...run(1, "queued", None, ""), id: 3000000001.}])->ids,
    Some("3000000001"),
  )
  let unstarted = [...red, {...run(2, "queued", None, ""), startedAt: Null}]
  equals(latestRun(unstarted)->ids, Some("2"))
  equals(decide(pr(1), unstarted), Ignore)
})

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

test("decide reads only a PR's latest run", () =>
  equals(
    decide(pr(6), [...green, run(2, "completed", Some("failure"), "2026-02-01T00:00:00Z")]),
    Tick(ticked),
  )
)

// Data the API would return, keyed by sha; no client.
let sources = (~commits=[], ~runs=dict{}, ~prs=[]) => {
  commits: async _ => commits,
  runsFor: async sha => runs->Dict.get(sha)->Option.getOr([]),
  pulls: async () => prs,
}
let testPromise = (name, body) =>
  testAsync(name, done => body()->Promise.thenResolve(() => done())->ignore)

let skipped = [run(1, "completed", Some("skipped"), "2026-01-02T00:00:00Z")]

testPromise("previousFailed walks past commits with no finished run", async () => {
  let got = await previousFailed(
    ~before="b",
    sources(~commits=["b", "c", "d"], ~runs=dict{"b": busy, "c": skipped, "d": red}),
  )
  equals(got, true)
  let got = await previousFailed(
    ~before="b",
    sources(~commits=["b", "c"], ~runs=dict{"b": skipped, "c": green}),
  )
  equals(got, false)
})

testPromise("previousFailed is false for a new branch or no history", async () => {
  let got = await previousFailed(
    ~before=String.repeat("0", 40),
    sources(~commits=["b"], ~runs=dict{"b": red}),
  )
  equals(got, false)
  let got = await previousFailed(~before="b", sources())
  equals(got, false)
  let got = await previousFailed(~before="b", sources(~commits=["b"]))
  equals(got, false)
})

let numbers = plan =>
  switch plan {
  | NothingToResume => None
  | Decided(decided) => Some(decided->Array.map(((pr, d)) => (pr.Github.number, d)))
  }

testPromise("plan does nothing after a green main", async () => {
  let got = await plan(
    ~before="b",
    sources(~commits=["b"], ~runs=dict{"b": green, "sha1": red}, ~prs=[pr(1)]),
    opts,
  )
  equals(got->numbers, None)
})

testPromise("plan decides only candidates, in order, after a red main", async () => {
  let prs = [
    pr(1),
    pr(~labels=["renovate:needs-human"], 2),
    pr(3),
    pr(~ref="feature/x", 5),
    pr(~body=ticked, 7),
  ]
  let runs = dict{"b": red, "sha1": red, "sha2": red, "sha3": green, "sha5": red, "sha7": red}
  let got = await plan(~before="b", sources(~commits=["b"], ~runs, ~prs), opts)
  equals(got->numbers, Some([(1, Tick(ticked)), (3, Ignore), (7, NoCheckbox)]))
})
