import { MARKER, NEEDS_HUMAN, requiredRun } from './health.mjs';
import { run, TITLE } from './run.mjs';

// The GitHub Actions app, which posts every `required` check.
const ACTIONS_APP = 15368;

const env = name => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
};

const issueRepo = env('ISSUE_REPO');
const tokens = { unmango: env('TOKEN_UNMANGO'), unstoppablemango: env('TOKEN_UNSTOPPABLEMANGO') };
const issueToken = env('ISSUE_TOKEN');
const tokenFor = repo => tokens[repo.split('/')[0].toLowerCase()];

async function api(token, path, { method = 'GET', body } = {}) {
	const res = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'x-github-api-version': '2022-11-28',
			...(body && { 'content-type': 'application/json' }),
		},
		body: body && JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
	return res.json();
}

const github = {
	async commits(repo, page) {
		const commits = await api(tokenFor(repo), `/repos/${repo}/commits?sha=main&per_page=100&page=${page}`);
		return commits.map(c => ({ sha: c.sha, date: c.commit.committer.date }));
	},
	async requiredRun(repo, sha) {
		const { check_runs } = await api(
			tokenFor(repo),
			`/repos/${repo}/commits/${sha}/check-runs?filter=latest&app_id=${ACTIONS_APP}&per_page=100`,
		);
		return requiredRun(check_runs);
	},
	async needsHuman(repo) {
		const label = encodeURIComponent(NEEDS_HUMAN);
		const issues = await api(tokenFor(repo), `/repos/${repo}/issues?state=open&labels=${label}&per_page=100`);
		return issues.filter(i => i.pull_request).length;
	},
	async findIssue() {
		const q = encodeURIComponent(`repo:${issueRepo} is:issue is:open in:title "${TITLE}"`);
		const { items } = await api(issueToken, `/search/issues?q=${q}`);
		return items.find(i => i.title === TITLE && i.body?.startsWith(MARKER)) ?? null;
	},
	async createIssue(title, body) {
		const issue = await api(issueToken, `/repos/${issueRepo}/issues`, { method: 'POST', body: { title, body } });
		return { number: issue.number, nodeId: issue.node_id };
	},
	async pinIssue(nodeId) {
		const res = await api(issueToken, '/graphql', {
			method: 'POST',
			body: { query: 'mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { number } } }', variables: { id: nodeId } },
		});
		if (res.errors) throw new Error(res.errors.map(e => e.message).join('; '));
	},
	async updateIssue(number, body) {
		await api(issueToken, `/repos/${issueRepo}/issues/${number}`, { method: 'PATCH', body: { body } });
	},
	async comment(number, body) {
		await api(issueToken, `/repos/${issueRepo}/issues/${number}/comments`, { method: 'POST', body: { body } });
	},
};

const topic = env('NTFY_TOPIC');
const ntfy = {
	async page({ title, body, click }) {
		const res = await fetch(`https://ntfy.sh/${topic}`, {
			method: 'POST',
			headers: { title, priority: 'high', tags: 'rotating_light', click },
			body,
		});
		if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
	},
};

const { failed } = await run(env('REPOS').split(/\s+/).filter(Boolean), {
	github,
	ntfy,
	now: new Date(),
	runUrl: env('RUN_URL'),
	weekly: process.env.WEEKLY === 'true',
});
if (failed) process.exitCode = 1;
