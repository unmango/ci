open Test
open RenovateFixup

let equals = (a, b) => assertion(~operator="equals", (a, b) => a == b, a, b)

let testPromise = (name, body) =>
  testAsync(name, done => body()->Promise.thenResolve(() => done())->ignore)

let run = (conclusion): Github.checkRun => {
  id: 1.,
  status: "completed",
  conclusion: Value(conclusion),
  startedAt: Value("2026-01-01T00:00:00Z"),
}

let pr = (n, sha): Github.pullRequest => {
  number: n,
  body: Null,
  labels: [],
  head: {ref: "renovate/x", sha, repo: Null},
}

let sources = (~main=?, prs): RenovateResume.sources => {
  commits: async sha => {
    equals(sha, "main")
    ["m1"]
  },
  runsFor: async _ => main->Option.mapOr([], c => [run(c)]),
  pulls: async () => prs,
}

let label = sources => labelPlan(~defaultBranch="main", ~sha="h1", sources)

testPromise("labelPlan labels the PR while main is green", async () => {
  let got = await label(sources(~main="success", [pr(7, "h1")]))
  equals(got, Label(7))
})

testPromise("labelPlan labels when main has no finished required run", async () => {
  let got = await label(sources([pr(7, "h1")]))
  equals(got, Label(7))
})

testPromise("labelPlan leaves the label off while main is red", async () => {
  let got = await label(sources(~main="failure", [pr(7, "h1")]))
  equals(got, MainRed)
})

testPromise("labelPlan does nothing without a PR", async () => {
  let got = await label(sources(~main="success", []))
  equals(got, NoPullRequest)
})

testPromise("labelPlan leaves a PR alone once Renovate has moved its branch", async () => {
  let got = await label(sources(~main="success", [pr(7, "h2")]))
  equals(got, Moved(7))
})
