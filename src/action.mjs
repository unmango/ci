import { appendFileSync } from "node:fs";

export function input(name, { env = process.env, fallback } = {}) {
  const value = (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`input ${name} is required`);
}

export function setOutput(name, value, { env = process.env } = {}) {
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function main(fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`::error::${err.message.replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
