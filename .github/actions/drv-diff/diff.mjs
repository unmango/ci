/** @import { Core, Inputs } from "../types.mjs" */

/**
 * One line of nix-eval-jobs output.
 * @typedef {object} Job
 * @property {string} attr
 * @property {string[]} attrPath `[type, system, name]`
 * @property {string} [drvPath]
 * @property {string} [error]
 */

/**
 * @typedef {object} Build One matrix entry.
 * @property {string} system
 * @property {string} runner
 * @property {string[]} packages
 * @property {string[]} checks
 */

/** @typedef {{ attr: string, error: string }} EvalError */

/** @type {Record<string, string>} */
export const RUNNERS = {
  "x86_64-linux": "ubuntu-latest",
  "aarch64-linux": "ubuntu-24.04-arm",
  "aarch64-darwin": "macos-latest",
};

/** @type {(error: string | undefined) => string | undefined} */
const unpinned = (error) => error?.replace(/\/nix\/store\/[0-9a-z]{32}-/g, "/nix/store/");

/**
 * @param {string} text
 * @returns {Job[]}
 */
export function parseJobs(text) {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** @type {(path: string[]) => string} */
export const installable = (path) => ".#" + path.map((s) => (/^[A-Za-z_][\w'-]*$/.test(s) ? s : JSON.stringify(s))).join(".");

/**
 * @param {Job[]} head
 * @param {Job[] | null} base Null builds every head output.
 * @returns {{ matrix: Build[], errors: EvalError[] }}
 */
export function plan(head, base) {
  const before = new Map((base ?? []).map((j) => [j.attr, j]));
  /** @type {Map<string, Build>} */
  const builds = new Map();
  /** @type {EvalError[]} */
  const errors = [];

  for (const job of head) {
    const prev = before.get(job.attr);
    if (job.error !== undefined) {
      // Already broken on base, so not this change's doing. The source's store path changes with any edit.
      if (unpinned(prev?.error) !== unpinned(job.error)) errors.push({ attr: job.attr, error: job.error });
      continue;
    }
    if (prev?.drvPath === job.drvPath) continue;

    const [type, system] = job.attrPath;
    const runner = RUNNERS[system];
    if (!runner) {
      errors.push({ attr: job.attr, error: `no hosted runner for ${system}` });
      continue;
    }
    let build = builds.get(system);
    if (!build) builds.set(system, (build = { system, runner, packages: [], checks: [] }));
    (type === "packages" ? build.packages : build.checks).push(installable(job.attrPath));
  }

  const matrix = [...builds.values()].sort((a, b) => a.system.localeCompare(b.system));
  for (const b of matrix) b.packages.sort(), b.checks.sort();
  return { matrix, errors };
}

/**
 * @param {{ matrix: Build[], errors: EvalError[] }} result
 * @param {boolean} full
 * @returns {string}
 */
export function render({ matrix, errors }, full) {
  const lines = [full ? "## Full build" : "## Changed outputs", ""];
  if (matrix.length === 0) lines.push("Nothing to build.", "");
  for (const b of matrix) {
    lines.push(`### ${b.system}`, "", ...[...b.packages, ...b.checks].map((i) => `- \`${i.slice(2)}\``), "");
  }
  if (errors.length > 0) {
    lines.push("## Evaluation errors", "");
    for (const e of errors) lines.push(`### \`${e.attr}\``, "", "```", e.error.trim(), "```", "");
  }
  return lines.join("\n");
}

/**
 * @param {object} opts
 * @param {Core} opts.core
 * @param {Inputs} opts.inputs `head` and optional `base`: paths to nix-eval-jobs output.
 * @param {(path: string) => Promise<string>} opts.read
 */
export async function run({ core, inputs, read }) {
  const head = parseJobs(await read(inputs.head));
  const base = inputs.base ? parseJobs(await read(inputs.base)) : null;
  const result = plan(head, base);
  core.setOutput("matrix", JSON.stringify(result.matrix));
  await core.summary.addRaw(render(result, base === null)).write();
  if (result.errors.length > 0) core.setFailed(`${result.errors.length} output(s) failed to evaluate`);
}
