/** @import { Context, Core, Exec, Inputs } from "../types.mjs" */

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

/**
 * The trace quotes source lines, which any nearby edit changes.
 * @type {(error: string | undefined) => string | undefined}
 */
const cause = (error) => {
  const plain = error?.replace(/\x1b\[[0-9;]*m/g, "");
  return plain
    ?.slice(Math.max(plain.lastIndexOf("error:"), 0))
    .trim()
    .replace(/\/nix\/store\/[0-9a-z]{32}-/g, "/nix/store/");
};

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
      if (cause(prev?.error) !== cause(job.error)) errors.push({ attr: job.attr, error: job.error });
      continue;
    }
    if (prev?.drvPath === job.drvPath) continue;

    const [type, system] = job.attrPath;
    const runner = RUNNERS[system];
    if (!runner) {
      errors.push({ attr: job.attr, error: `no hosted runner for ${system}` });
      continue;
    }
    const build = builds.get(system) ?? { system, runner, packages: [], checks: [] };
    builds.set(system, build);
    (type === "packages" ? build.packages : build.checks).push(installable(job.attrPath));
  }

  const matrix = [...builds.values()].sort((a, b) => a.system.localeCompare(b.system));
  for (const b of matrix) {
    b.packages.sort();
    b.checks.sort();
  }
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
 * The commit to diff against, or "" to build everything.
 * @param {Context} context
 * @param {boolean} full
 * @returns {string}
 */
export function baseSha({ eventName, payload }, full) {
  if (full || eventName === "schedule" || eventName === "workflow_dispatch") return "";
  if (eventName === "pull_request") return payload.pull_request.base.sha;
  if (eventName === "push" && !payload.created) return payload.before;
  return "";
}

/**
 * nix-eval-jobs from this repo's lock, so base and head agree on it.
 * @param {object} opts
 * @param {string} opts.actionPath
 * @param {string} opts.flake
 * @param {string} opts.systems
 * @param {boolean} opts.full
 * @returns {string[]} Arguments to `nix`.
 */
export const evalArgs = ({ actionPath, flake, systems, full }) => [
  "run",
  "--inputs-from",
  `path:${actionPath}/../../..`,
  "nixpkgs#nix-eval-jobs",
  "--",
  "--impure",
  "--force-recurse",
  "--no-instantiate",
  "--workers",
  "4",
  "--max-memory-size",
  "3072",
  "--argstr",
  "flake",
  flake,
  "--argstr",
  "systems",
  systems,
  "--arg",
  "full",
  String(full),
  `${actionPath}/jobs.nix`,
];

/**
 * @param {object} opts
 * @param {Exec} opts.exec
 * @param {Core} opts.core
 * @param {Context} opts.context
 * @param {Inputs} opts.inputs `head` is the checkout; `token` fetches the base into it.
 */
export async function run({ exec, core, context, inputs }) {
  const sha = baseSha(context, inputs.full === "true");
  const full = sha === "";
  /** @type {(cmd: string, args: string[]) => Promise<string>} */
  const output = async (cmd, args) => {
    const { exitCode, stdout, stderr } = await exec.getExecOutput(cmd, args, { silent: true, ignoreReturnCode: true });
    if (exitCode !== 0) throw new Error(`${cmd} ${args[0]} failed:\n${stderr}`);
    return stdout;
  };
  /** @type {(flake: string) => Promise<Job[]>} */
  const evaluate = async (flake) => {
    const args = evalArgs({ actionPath: inputs["action-path"], flake, systems: inputs.systems, full });
    const stdout = await output("nix", args);
    return parseJobs(stdout);
  };

  const head = await evaluate(`git+file://${inputs.head}`);
  let base = null;
  if (sha) {
    try {
      const auth = btoa(`x-access-token:${inputs.token}`);
      await output("git", ["-C", inputs.head, "-c", `http.extraheader=AUTHORIZATION: basic ${auth}`, "fetch", "--depth", "1", "origin", sha]);
      base = await evaluate(`git+file://${inputs.head}?rev=${sha}&shallow=1`);
    } catch (/** @type {any} */ e) {
      // A force-push can leave the base commit gone.
      core.warning(`${e.message}\nBuilding every output.`);
    }
  }
  const result = plan(head, base);
  core.setOutput("matrix", JSON.stringify(result.matrix));
  await core.summary.addRaw(render(result, base === null)).write();
  if (result.errors.length > 0) core.setFailed(`${result.errors.length} output(s) failed to evaluate`);
}
