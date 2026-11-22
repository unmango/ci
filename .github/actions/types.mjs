// Types only: the parts of github-script's injected client, core and exec that the actions use.

/**
 * @typedef {object} Octokit
 * @property {(route: string, params?: Record<string, unknown>) => Promise<{ data: any }>} request
 * @property {(route: string, params?: Record<string, unknown>) => Promise<any[]>} paginate
 * @property {(query: string, variables?: Record<string, unknown>) => Promise<any>} graphql
 */

/**
 * @typedef {object} Core
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warning
 * @property {(name: string, value: unknown) => void} setOutput
 * @property {(message: string) => void} setFailed
 * @property {{ addRaw: (text: string) => { write: () => Promise<unknown> } }} summary
 */

/**
 * @typedef {object} Exec
 * @property {(cmd: string, args?: string[], opts?: { ignoreReturnCode?: boolean }) => Promise<number>} exec
 * @property {(cmd: string, args?: string[], opts?: { ignoreReturnCode?: boolean, silent?: boolean }) => Promise<{ exitCode: number, stdout: string, stderr: string }>} getExecOutput
 */

/** @typedef {{ owner: string, repo: string }} Repo */

/** @typedef {Record<string, string>} Inputs */

export {};
