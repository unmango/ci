# ci

Reusable GitHub Actions workflows for Nix repositories.
The design is the [Nix CI spec](https://github.com/UnstoppableMango/nixos/blob/main/docs/nix-ci.md).

## `nix-ci.yml`

The hosted jobs and the gate behind a repo's `required` check.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  nix:
    uses: unmango/ci/.github/workflows/nix-ci.yml@<sha> # <version>
    permissions:
      checks: read
      contents: read
      pull-requests: write
      statuses: read
    with:
      darwin: true
    secrets:
      CACHIX_AUTH_TOKEN: ${{ secrets.CACHIX_AUTH_TOKEN }}

  required:
    needs: [nix]
    if: always()
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - env:
          NEEDS: ${{ toJSON(needs) }}
        run: jq -e 'all(.[]; .result == "success" or .result == "skipped")' <<<"$NEEDS"
```

The `required` job stays in the caller: GitHub names a called workflow's checks `<caller job> / <job>`, so only a caller job can hold the `required` context the ruleset asks for.
Add any other job that should block a merge to its `needs`.
The calling job grants every permission a job in the workflow asks for, or the run fails to start.

| Input | Default | |
| --- | --- | --- |
| `darwin` | `false` | `nix flake check` on `macos-latest` |
| `aarch64-linux` | `false` | `nix flake check` on `ubuntu-24.04-arm` |
| `linux` | `false` | `nix flake check` on a hosted x86_64 runner instead of waiting for Hercules; for private repos and repos Hercules doesn't build |
| `cachix-push` | `true` | Push hosted builds to `unstoppablemango`, on pushes to `main` only |
| `hercules-timeout-minutes` | `345` | How long `gate` waits for Hercules; under 360, where the hosted job stops |

Every hosted job reads Cachix; only a push to `main` gets the token.

`gate` needs every hosted job, then:

- on a branch PR or `main`, waits for `ci/hercules/onPush/default` on the head commit and passes only on a green status created by the Hercules app (24794), ignoring the same context from anyone else;
- on a fork PR, or with `linux: true`, the hosted `linux` job builds instead and nothing waits for Hercules.

`renovate-resume` runs on a push to `main` once `gate` passes, and its failure never fails the call.
When the previous finished `required` run on `main`, skipping cancelled and skipped runs, failed or timed out, it ticks the rebase checkbox on every open `renovate/` PR whose latest `required` run failed and that isn't labelled `renovate:needs-human`.

## `collection-ci.yml`

For the package collections, unmango/pkgs, unmango/pulumipkgs and unmango/kubepkgs, on hosted runners only.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "41 7 * * 1"

permissions:
  contents: read

jobs:
  collection:
    uses: unmango/ci/.github/workflows/collection-ci.yml@<sha> # <version>
    permissions:
      checks: read
      contents: read
      pull-requests: write
    secrets:
      CACHIX_AUTH_TOKEN: ${{ secrets.CACHIX_AUTH_TOKEN }}

  required:
    needs: [collection]
    if: always() && github.event_name != 'schedule'
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - env:
          NEEDS: ${{ toJSON(needs) }}
        run: jq -e 'all(.[]; .result == "success" or .result == "skipped")' <<<"$NEEDS"
```

| Input | Default | |
| --- | --- | --- |
| `systems` | `x86_64-linux aarch64-linux aarch64-darwin` | Systems to build, on `ubuntu-latest`, `ubuntu-24.04-arm` and `macos-latest` |
| `full` | `false` | Build everything, as a scheduled or manual run does |

`plan` evaluates `checks` and `packages` for each system with `nix-eval-jobs`, at the head and at the base: the PR's base, or the commit `main` pointed at before the push.
`build` runs once per system with an output whose `.drv` path differs, so a `flake.lock` bump rebuilds everything and a docs edit builds nothing, and `required` passes.
A check whose source is the whole tree, such as treefmt's, is the exception: any edit rebuilds it.
An aggregate like a `linkFarm` of every package changes with any package, so building it realises the whole set; put it on the exclude list.
A head output that fails to evaluate fails `plan` unless it failed the same way on the base; what did evaluate still builds.
When the base can't be fetched or evaluated, everything builds.

A scheduled or manual run has no base and builds every output, which keeps the cache warm and catches what the diff misses.
`required` skips a scheduled run, so it gates nothing and `renovate-resume` never reads it; `ci-health.yml` reports the run's result instead.

Every job reads Cachix `unstoppablemango`; on `main`, outside PRs, what a package build makes is pushed to it, and checks never are.

Where the repo imports `flakeModules.ci` from [UnstoppableMango/nix](https://github.com/UnstoppableMango/nix), its exclude lists are never built and its nightly lists only in a full build.
They are read back from `herculesCI`, against the first of its `ciSystems`.

`renovate-resume` runs on a push to `main` once every build passed, as in `nix-ci.yml`.

## `renovate-fixup.yml`

Refreshes what a Renovate update leaves stale and pushes it back to the Renovate branch, for repos that import `flakeModules.ci` from [UnstoppableMango/nix](https://github.com/UnstoppableMango/nix).
Call it from its own workflow on pushes to Renovate's branches:

```yaml
name: Renovate fixup

on:
  push:
    branches: ["renovate/**"]

permissions: {}

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  fixup:
    uses: unmango/ci/.github/workflows/renovate-fixup.yml@<sha> # <version>
    permissions:
      checks: read
      contents: read
      pull-requests: write
    with:
      client-id: ${{ vars.RENOVATE_FIXUP_APP_CLIENT_ID }}
    secrets:
      RENOVATE_FIXUP_APP_PRIVATE_KEY: ${{ secrets.RENOVATE_FIXUP_APP_PRIVATE_KEY }}
```

- `fixup` runs `nix run .#renovate-fixup`, the steps the repo lists in `perSystem.ci.fixup.steps`, with a read-only token, and uploads what changed as a patch.
- `push` runs only when the patch isn't empty and runs nothing from the branch.
  It applies the patch, then mints a token for the `renovate-fixup` App, limited to `contents: write` on this repo, and commits the staged blobs through `createCommitOnBranch`, so the commit is signed.
  It refuses symlinks, submodules and anything under `.github/workflows/`, since a symlink's read would leave the tree and the App can't write workflows.
  GitHub refuses the commit if the branch moved since the fixup ran; Renovate's newer push starts a new run.
- `label` adds `renovate:needs-human` to the branch's PR with `GITHUB_TOKEN` when `nix run .#renovate-fixup` failed or `push` refused the patch, unless the last finished `required` run on the default branch failed.
  Then `renovate-resume` brings the PR back once `main` is green.
  A failure before the fixup step, such as installing Nix, labels nothing, since a labelled PR never retries.

Pushes by the App itself, `unmango-renovate-fixup[bot]` unless `app-slug` says otherwise, are skipped, so a fixup never triggers another.
Its push does trigger the repo's other workflows, which a `GITHUB_TOKEN` push wouldn't.
`createCommitOnBranch` takes no file mode, so a fixup can't make a file executable.
`fixup` gets the read-only `GITHUB_TOKEN`, for fetching flake inputs from GitHub.

## `package-updates.yml`

Bumps a package collection's packages to their latest upstream releases, one branch and PR per package, for unmango/pkgs, unmango/pulumipkgs and unmango/kubepkgs.
The repo supplies two commands:

- `list` prints one package name per line. If it fails, the run fails.
- `bump` is run once per name, with the name appended, from a clean checkout of the default branch.
  It edits the tree and builds the result, skipping a release younger than `MIN_RELEASE_AGE_DAYS` where it can read the upstream date.
  Exit 0 with no change means the package is current; exit 0 with a change is a bump, whose last line of output is the commit and PR title, such as `foo: 1.2.0 -> 1.3.0`; exit 3 with a change is a bump that doesn't build; anything else is a failure.

```yaml
name: Package updates

on:
  schedule:
    # 00:17 UTC Saturday: after 6 PM Friday in Chicago, under CDT or CST.
    - cron: "17 0 * * 6"
  workflow_dispatch:

permissions: {}

concurrency:
  group: ${{ github.workflow }}

jobs:
  updates:
    uses: unmango/ci/.github/workflows/package-updates.yml@<sha> # <version>
    permissions:
      contents: read
      issues: write
      pull-requests: read
    with:
      list: nix develop -c ./scripts/update.sh --list
      bump: nix develop -c ./scripts/update.sh --bump
      client-id: ${{ vars.PACKAGE_UPDATES_APP_CLIENT_ID }}
    secrets:
      PACKAGE_UPDATES_APP_PRIVATE_KEY: ${{ secrets.PACKAGE_UPDATES_APP_PRIVATE_KEY }}
```

- `bump` runs the commands with the read-only `GITHUB_TOKEN`, which nix-update also reads, and without the runner's Actions tokens, then uploads each bump's staged diff.
  A package whose bump runs past `package-timeout-minutes`, 60 by default, counts as a failure.
- `publish` runs nothing from the bumps.
  It mints one `package-updates` App token, and for each bump commits the staged blobs through `createCommitOnBranch`, so the commit is signed, and points `update/<name>` at it, force-pushing over an older version.
  It opens the PR with platform auto-merge on, or retitles the open one, and leaves a PR that already has the version alone.
  A bump that doesn't build gets `renovate:needs-human`, which a later bump that builds takes off; it isn't listed as a failure.
  Symlinks, submodules and workflow changes are refused, as in `renovate-fixup.yml`.
- `report` rewrites the pinned "Package update failures" issue with this run's failures, opening it on the first one, with `GITHUB_TOKEN`.
  A package failure never fails the run.

`dry-run: true` bumps everything and then only logs what it would push, with no App token; `ci.yml` runs one over two fake packages.

## `ci-health.yml`

Keeps one pinned "CI health" issue, labelled `ci-health`, in the calling repo, for the aggregator in [UnstoppableMango/nix](https://github.com/UnstoppableMango/nix) to read.
Call it from its own workflow, which runs once `CI` finishes on `main` and once a day, so `ci.yml` needs no change:

```yaml
name: CI health

on:
  schedule:
    - cron: "23 6 * * *"
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]

permissions: {}

jobs:
  ci-health:
    if: github.event_name == 'schedule' || github.event.workflow_run.event == 'push'
    uses: unmango/ci/.github/workflows/ci-health.yml@<sha> # <version>
    permissions:
      actions: read
      issues: write
      pull-requests: read
```

The `if` keeps out a fork PR whose branch is also named `main`, which `branches` alone would let through.
The `workflow` input names the file holding `required`, `ci.yml` by default.

Each run reads the caller's workflow runs on pushes to the default branch and the `required` job in each:

- the latest `required` result, green or red;
- p50 and p90 over the last 7 days, timed from the run's start to `required` finishing, flagging a p50 over 5 minutes;
- open PRs labelled `renovate:needs-human`;
- the latest scheduled run, such as `collection-ci.yml`'s full build, if the workflow has one; it never changes the state.

On a `workflow_run` or a schedule it rewrites the issue's body, creating and pinning the issue if there is none, with the caller's `GITHUB_TOKEN`.
On a PR it only writes the report to the job summary.
While `main` is red the issue carries `ci-health:red`, which comes off once it is green.
The body's first line is machine-readable, with `red_since` the creation time of the first run in the red streak:

```html
<!-- ci-health {"state":"red","red_since":"2026-11-20T09:00:00Z","p50":270,"p90":420} -->
```

`state` is `green`, `red`, or `unknown`; `p50` and `p90` are seconds, or `null` with no runs in the window.
Cancelled runs count toward neither the state nor the percentiles, and `unknown` leaves the label as it was.

## Development

Each composite action under `.github/actions/` runs the module beside it through `actions/github-script`, which supplies the Octokit client and `core`.
The workflows use the actions through `$/`, so they come from the same commit.
`drv-diff` runs `nix-eval-jobs` over its `jobs.nix`, pinned by this repo's `flake.lock`, `nix-build` runs `nix build`, and `renovate-fixup` reads staged blobs and `package-updates` runs the repo's commands and reads staged blobs, all through github-script's `exec`; `test/jobs.nix` tests `jobs.nix` as `checks.jobs`.
The modules are typed with JSDoc and checked by `tsc -p jsconfig.json`.
`nix flake check` runs the type check and the tests; `node --test 'test/*.test.mjs'` runs the tests alone.
`ci.yml` calls `nix-ci.yml` both ways and holds the gate to ignoring a spoofed status.
It also calls `collection-ci.yml`, with this repo's checks standing in for packages, and runs its weekly full build.
`health.yml` calls `ci-health.yml` for this repo's own issue, and also on PRs, where it writes only the job summary.

## `unmango-ci`

The actions are moving into one ReScript CLI, `unmango-ci`, one subcommand per action (#20, [ADR 0001](docs/adr/0001-rescript-cli.md)).
Until an action is ported it still runs through github-script as described above.

A ported action's only step runs the bundle with its subcommand, passing each input as the `INPUT_<NAME>` variable `@actions/core` reads, since a composite action sets none.
`src/Github.res` binds the Octokit endpoints and `@actions/core` calls the subcommands use, and nothing else.
A subcommand's decisions are a pure core its tests cover; its `run` only fetches, calls the core, and writes.

`src/` is the ReScript source and `test/*.res` its `rescript-test` suites.
rolldown bundles the compiled output into `dist/unmango-ci.mjs` and its source map, which are committed so an action needs only `node`.
After changing `src/`, run `npm run build` and commit `dist/`: `checks.bundle` builds the package and fails when the committed bundle differs.

```console
npm ci
npm run build
npm test
node --enable-source-maps dist/unmango-ci.mjs --help
nix run github:unmango/ci -- --help
```
