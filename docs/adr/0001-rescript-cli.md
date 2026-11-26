# 1. One ReScript CLI in place of github-script modules

Date: 2026-11-25

## Status

Accepted

## Context

Each action carried its own `actions/github-script` module, about 1,300 lines across eight actions, plus a copy of one in UnstoppableMango/nix and `update.sh` scripts in the package collections.
Each reimplemented GitHub calls, exec, and types, and nothing gave the growth a shape.
They were dependency-free Node with JSDoc types, a rule set when there were two of them.

## Decision

- Every behaviour is a subcommand of one CLI, `unmango-ci`, in this repository beside the workflows that use it.
- It is written in ReScript, for a sound type system with direct JS interop, so ports can go one module at a time.
- npm dependencies are allowed, at run time too.
  GitHub goes through Octokit and `@actions/core` rather than a client of our own, so API changes are the libraries' to track.
  Their bindings live in one module, which a later library could be extracted from.
- rolldown bundles and minifies it into one committed file plus a source map.
  Actions run it with `node --enable-source-maps`, so jobs without Nix install nothing.
  `checks.bundle` fails when the committed bundle differs from a fresh build, and runs it.
- The flake's `unmango-ci` package builds the same bundle, so `nix run` runs what CI runs.
- Actions stay as thin wrappers, so callers see no change when one is ported.
- Tests use `rescript-test` against each subcommand's pure core; the I/O around it has no unit tests and holds no decisions.

## Consequences

- Every existing module is to be ported (#21 to #30); until then github-script and the CLI run side by side.
- A change to `src/` must rebuild and commit `dist/`, or `checks.bundle` fails.
- ReScript emits no source maps, so a stack trace names a line of the compiled `.res.mjs`, which sits beside its `.res` once built, not the `.res` itself.
- `rescript-test` pulls a `glob` with moderate advisories into development only; nothing of it reaches the bundle.
