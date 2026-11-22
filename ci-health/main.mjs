import { MARKER, NEEDS_HUMAN, requiredGate, TITLE } from './health.mjs';
import { run } from './run.mjs';

// GitHub Actions' app ID.
const ACTIONS_APP = 15368;

const env = name => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
};

const repos = env('REPOS').split(/\s+/).filter(Boolean);
const issueRepo = env('ISSUE_REPO');
const tokens = { unmango: env('TOKEN_UNMANGO'), unstoppablemango: env('TOKEN_UNSTOPPABLEMANGO') };
const issueToken = env('ISSUE_TOKEN');
const topic = env('NTFY_TOPIC');
const runUrl = env('RUN_URL');
const weekly = process.env.WEEKLY === 'true';

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

async function graphql(query, variables) {
	const res = await api(issueToken, '/graphql', { method: 'POST', body: { query, variables } });
	if (res.errors) throw new Error(res.errors.map(e => e.message).join('; '));
	return res.data;
}

const isHealthIssue = i => i.title === TITLE && i.body?.startsWith(MARKER);

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
		const gate = requiredGate(check_runs);
		if (!gate?.workflowRun) return null;
		// The gate only aggregates. Timing from the latest attempt's start leaves out the gap before a rerun.
		const { run_started_at } = await api(tokenFor(repo), `/repos/${repo}/actions/runs/${gate.workflowRun}`);
		return { ...gate, startedAt: run_started_at };
	},
	async needsHuman(repo) {
		const label = encodeURIComponent(NEEDS_HUMAN);
		const issues = await api(tokenFor(repo), `/repos/${repo}/issues?state=open&labels=${label}&per_page=100`);
		return issues.filter(i => i.pull_request).length;
	},
	async findIssue() {
		const [owner, name] = issueRepo.split('/');
		const { repository } = await graphql(
			'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pinnedIssues(first: 3) { nodes { issue { number id title body } } } } }',
			{ owner, name },
		);
		const pinned = repository.pinnedIssues.nodes.map(n => n.issue).find(isHealthIssue);
		if (pinned) return { number: pinned.number, nodeId: pinned.id, pinned: true };
		for (let page = 1; ; page++) {
			const issues = await api(issueToken, `/repos/${issueRepo}/issues?state=open&per_page=100&page=${page}`);
			const found = issues.find(isHealthIssue);
			if (found) return { number: found.number, nodeId: found.node_id, pinned: false };
			if (issues.length < 100) return null;
		}
	},
	async createIssue(title, body) {
		const issue = await api(issueToken, `/repos/${issueRepo}/issues`, { method: 'POST', body: { title, body } });
		return { number: issue.number, nodeId: issue.node_id, pinned: false };
	},
	async pinIssue(nodeId) {
		await graphql('mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { number } } }', { id: nodeId });
	},
	async updateIssue(number, body) {
		await api(issueToken, `/repos/${issueRepo}/issues/${number}`, { method: 'PATCH', body: { body } });
	},
	async comment(number, body) {
		await api(issueToken, `/repos/${issueRepo}/issues/${number}/comments`, { method: 'POST', body: { body } });
	},
};

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

const { failed } = await run(repos, { github, ntfy, now: new Date(), runUrl, weekly });
if (failed) process.exitCode = 1;
