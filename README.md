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
When the previous completed `required` run on `main` failed or timed out, it ticks the rebase checkbox on every open `renovate/` PR whose latest `required` run failed and that isn't labelled `renovate:needs-human`.

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
    if: always()
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
A head output that fails to evaluate fails `plan` unless it failed the same way on the base; what did evaluate still builds.

A scheduled or manual run has no base and builds every output, which keeps the cache warm and catches what the diff misses.
`ci-health.yml` reports its result; it fails the run's `required`, but the health state only reads pushes.

Every job reads Cachix `unstoppablemango`; on `main`, outside PRs, the packages a build makes are pushed to it, and checks never are.

Where the repo imports `flakeModules.ci` from [UnstoppableMango/nix](https://github.com/UnstoppableMango/nix), its exclude lists are never built and its nightly lists only in a full build.
They are read back from `herculesCI`, against the first of its `ciSystems`.

`renovate-resume` runs on a push to `main` once every build passed, as in `nix-ci.yml`.

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
`drv-diff` also runs `nix-eval-jobs` over its `jobs.nix`, pinned by this repo's `flake.lock`; `test/jobs.nix` tests it as `checks.jobs`.
The modules are typed with JSDoc and checked by `tsc -p jsconfig.json`.
`nix flake check` runs the type check and the tests; `node --test 'test/*.test.mjs'` runs the tests alone.
`ci.yml` calls `nix-ci.yml` both ways and holds the gate to ignoring a spoofed status.
It also calls `collection-ci.yml`, with this repo's checks standing in for packages, and runs its weekly full build.
`health.yml` calls `ci-health.yml` for this repo's own issue, and also on PRs, where it writes only the job summary.
