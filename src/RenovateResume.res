type options = {repo: Github.repo, prefix: string, label: string}

type decision =
  | Tick(string)
  | NoCheckbox
  | Ignore

let unticked = /- \[ \] <!-- rebase-check -->/

let tickRebase = body =>
  switch body->Nullable.toOption {
  | Some(b) if unticked->RegExp.test(b) =>
    Some(b->String.replaceRegExp(unticked, "- [x] <!-- rebase-check -->"))
  | _ => None
  }

let isCandidate = (pr: Github.pullRequest, {repo, prefix, label}) =>
  pr.head.ref->String.startsWith(prefix) &&
  pr.head.repo->Nullable.mapOr(false, r => r.fullName == `${repo.owner}/${repo.repo}`) &&
  !(pr.labels->Array.some(l => l.name == label))

let failed = (run: Github.checkRun) =>
  switch run.conclusion->Nullable.toOption {
  | Some("failure" | "timed_out") => true
  | _ => false
  }

let startTime = (run: Github.checkRun) =>
  run.startedAt->Nullable.mapOr(Float.Constants.nan, s => Date.fromString(s)->Date.getTime)

let latestRun = (~completed=false, runs: array<Github.checkRun>) =>
  runs
  ->Array.filter(r => !completed || r.status == "completed")
  ->Array.toSorted((a, b) =>
    switch startTime(b) -. startTime(a) {
    | d if d != 0. && !Float.isNaN(d) => d
    | _ => b.id -. a.id
    }
  )
  ->Array.get(0)

// Drops a scheduled run's skipped required and a cancelled run.
let commitVerdict = runs =>
  runs
  ->Array.filter(r => r.Github.conclusion == Value("success") || failed(r))
  ->latestRun(~completed=true)
  ->Option.map(failed)

let hasHistory = before => before != "" && !(/^0+$/->RegExp.test(before))

let decide = (pr: Github.pullRequest, runs) =>
  switch latestRun(runs) {
  | Some(r) if r.status == "completed" && failed(r) =>
    switch tickRebase(pr.body) {
    | Some(body) => Tick(body)
    | None => NoCheckbox
    }
  | _ => Ignore
  }

type plan =
  | NothingToResume
  | Decided(array<(Github.pullRequest, decision)>)

type sources = {
  commits: string => promise<array<string>>,
  runsFor: string => promise<array<Github.checkRun>>,
  pulls: unit => promise<array<Github.pullRequest>>,
}

let previousFailed = async (~before, {commits, runsFor}) =>
  if !hasHistory(before) {
    false
  } else {
    let shas = await commits(before)
    let rec walk = async i =>
      switch shas[i] {
      | None => false
      | Some(sha) =>
        let runs = await runsFor(sha)
        switch commitVerdict(runs) {
        | Some(verdict) => verdict
        | None => await walk(i + 1)
        }
      }
    await walk(0)
  }

let plan = async (~before, sources, opts) => {
  let failed = await previousFailed(~before, sources)
  if !failed {
    NothingToResume
  } else {
    let prs = await sources.pulls()
    let candidates = prs->Array.filter(pr => isCandidate(pr, opts))
    let decided = []
    for i in 0 to candidates->Array.length - 1 {
      let pr = candidates->Array.getUnsafe(i)
      let runs = await sources.runsFor(pr.head.sha)
      decided->Array.push((pr, decide(pr, runs)))
    }
    Decided(decided)
  }
}

let run = async _args => {
  let input = name => Github.Core.input(name, {required: false})
  let toInt = name => input(name)->Int.fromString->Option.getOrThrow
  let octokit = Github.make(input("token"))
  let repository = Cli.parseRepo(input("repository"))
  let {owner, repo} = repository
  let checkName = input("check-name")
  let appId = toInt("app-id")
  let depth = toInt("depth")
  let opts = {repo: repository, prefix: input("branch-prefix"), label: input("label")}
  let sources = {
    commits: async sha => {
      let {data} = await octokit.rest.repos.listCommits({owner, repo, sha, perPage: depth})
      data->Array.map(c => c.sha)
    },
    runsFor: async ref => {
      let {data} = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        checkName,
        appId,
        filter: "all",
        perPage: 100,
      })
      data.checkRuns
    },
    pulls: () =>
      octokit->Github.paginate(octokit.rest.pulls.list, {owner, repo, state: "open", perPage: 100}),
  }

  let ticked = []
  switch await plan(~before=input("before"), sources, opts) {
  | NothingToResume => Github.Core.info("previous main run did not fail; nothing to resume")
  | Decided(decided) =>
    for i in 0 to decided->Array.length - 1 {
      let (pr, decision) = decided->Array.getUnsafe(i)
      let number = pr.number->Int.toString
      switch decision {
      | Tick(body) =>
        let _ = await octokit.rest.pulls.update({owner, repo, pullNumber: pr.number, body})
        Github.Core.info(`#${number}: ticked the rebase checkbox`)
        ticked->Array.push(pr.number)
      | NoCheckbox => Github.Core.info(`#${number}: no unticked rebase checkbox`)
      | Ignore => ()
      }
    }
  }
  Github.Core.setOutput("ticked", ticked->JSON.stringifyAny->Option.getOr("[]"))
}

let subcommand: Cli.subcommand = {
  name: "renovate-resume",
  summary: "Tick the rebase box on Renovate PRs that failed while main was red",
  run,
}
