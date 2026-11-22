import { setTimeout as sleep } from "node:timers/promises";
import { input, main, setOutput } from "../../../src/action.mjs";
import { resolveAppLogin, waitFor } from "../../../src/gate.mjs";
import { client } from "../../../src/github.mjs";

await main(async () => {
  const api = client({ token: input("token"), baseUrl: process.env.GITHUB_API_URL });
  const context = input("context");
  const login = await resolveAppLogin(api, input("app-slug"), Number(input("app-id")));
  const sha = input("sha");
  console.log(`waiting for ${context} from ${login} on ${sha}`);

  const result = await waitFor({
    api,
    repo: input("repository"),
    sha,
    context,
    login,
    timeoutMs: Number(input("timeout-minutes")) * 60_000,
    intervalMs: Number(input("interval-seconds")) * 1000,
    log: (msg) => console.log(`::warning::${msg}`),
    sleep,
  });

  setOutput("verdict", result.verdict);
  setOutput("ignored", result.ignored.length);
  const link = result.status?.target_url ? ` (${result.status.target_url})` : "";
  if (result.verdict === "pass") console.log(`${context} passed${link}`);
  else if (result.verdict === "fail") throw new Error(`${context} is ${result.status.state}${link}`);
  else throw new Error(`no final ${context} from ${login} within ${input("timeout-minutes")} minutes`);
});
