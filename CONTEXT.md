# Context

**Subcommand**: one behaviour of `unmango-ci`, named after the action that runs it (`unmango-ci renovate-resume`).
Avoid: command, task, script.

**Action wrapper**: a composite action under `.github/actions/` whose only job is to run the bundle with one subcommand, mapping its inputs through.
Callers use it; they never call the CLI directly.

**Bundle**: `dist/unmango-ci.mjs` and its source map, the minified build of `src/` that is committed and run with `node`.
It is generated: edit `src/` and rebuild.
