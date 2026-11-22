/** @import { Core, Exec, Inputs } from "../types.mjs" */

/**
 * @param {object} opts
 * @param {string[]} opts.packages
 * @param {string[]} opts.checks
 * @param {boolean} opts.push Push what the package build makes.
 * @param {string} opts.cache
 * @returns {[string, string[]][]}
 */
export function commands({ packages, checks, push, cache }) {
  /** @type {(installables: string[]) => string[]} */
  const build = (installables) => ["build", "--keep-going", "--no-link", ...installables];
  /** @type {[string, string[]][]} */
  const out = [];
  if (packages.length > 0) {
    out.push(push ? ["cachix", ["watch-exec", cache, "--", "nix", ...build(packages)]] : ["nix", build(packages)]);
  }
  if (checks.length > 0) out.push(["nix", build(checks)]);
  return out;
}

/**
 * @param {object} opts
 * @param {Exec} opts.exec
 * @param {Pick<Core, "setFailed">} opts.core
 * @param {Inputs} opts.inputs `packages` and `checks` as JSON arrays.
 * @param {boolean} opts.push
 */
export async function run({ exec, core, inputs, push }) {
  const cmds = commands({
    packages: JSON.parse(inputs.packages),
    checks: JSON.parse(inputs.checks),
    push,
    cache: inputs.cache,
  });
  let failed = 0;
  for (const [cmd, args] of cmds) {
    if ((await exec.exec(cmd, args, { ignoreReturnCode: true })) !== 0) failed++;
  }
  if (failed > 0) core.setFailed(`${failed} of ${cmds.length} builds failed`);
}
