import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MARKER } from './health.mjs';
import { run } from './run.mjs';

const now = new Date('2026-11-22T12:00:00Z');
const hoursAgo = h => new Date(now.getTime() - h * 3600_000).toISOString();
const completed = (h, conclusion) => ({
	status: 'completed',
	conclusion,
	startedAt: hoursAgo(h + 0.05),
	completedAt: hoursAgo(h),
});

// `repos` maps a repo to its `main`, newest first: [hoursAgo, conclusion | null].
function fakeGitHub(repos, { issue = null, needsHuman = {} } = {}) {
	const calls = [];
	const runs = new Map();
	const commitsOf = new Map();
	for (const [repo, history] of Object.entries(repos)) {
		if (history instanceof Error) continue;
		commitsOf.set(
			repo,
			history.map(([h, conclusion], i) => {
				const sha = `${repo}-${i}`;
				runs.set(sha, conclusion ? completed(h, conclusion) : null);
				return { sha, date: hoursAgo(h + 0.05) };
			}),
		);
	}
	return {
		calls,
		async commits(repo, page) {
			if (repos[repo] instanceof Error) throw repos[repo];
			calls.push(['commits', repo, page]);
			return (commitsOf.get(repo) ?? []).slice((page - 1) * 2, page * 2);
		},
		async requiredRun(repo, sha) {
			calls.push(['requiredRun', sha]);
			return runs.get(sha);
		},
		async needsHuman(repo) {
			return needsHuman[repo] ?? 0;
		},
		async findIssue() {
			return issue;
		},
		async createIssue(title, body) {
			calls.push(['createIssue', title, body]);
			return { number: 9, nodeId: 'I_9' };
		},
		async pinIssue(nodeId) {
			calls.push(['pinIssue', nodeId]);
		},
		async updateIssue(number, body) {
			calls.push(['updateIssue', number, body]);
		},
		async comment(number, body) {
			calls.push(['comment', number, body]);
		},
	};
}

function fakeNtfy() {
	const pages = [];
	return { pages, page: async msg => pages.push(msg) };
}

const opts = (github, ntfy, extra = {}) => ({ github, ntfy, now, runUrl: 'https://example.test/run', weekly: false, ...extra });

test('creates and pins the issue when none exists', async () => {
	const github = fakeGitHub({ 'unmango/pkgs': [[1, 'success'], [24 * 8, 'success']] });
	const result = await run(['unmango/pkgs'], opts(github, fakeNtfy()));
	assert.equal(result.failed, false);
	const created = github.calls.find(c => c[0] === 'createIssue');
	assert.equal(created[1], 'CI health');
	assert.ok(created[2].startsWith(MARKER));
	assert.deepEqual(github.calls.find(c => c[0] === 'pinIssue'), ['pinIssue', 'I_9']);
});

test('rewrites the existing issue', async () => {
	const github = fakeGitHub({ 'unmango/pkgs': [[1, 'success'], [24 * 8, 'success']] }, { issue: { number: 3 } });
	await run(['unmango/pkgs'], opts(github, fakeNtfy()));
	assert.equal(github.calls.find(c => c[0] === 'createIssue'), undefined);
	const updated = github.calls.find(c => c[0] === 'updateIssue');
	assert.equal(updated[1], 3);
	assert.match(updated[2], /unmango\/pkgs/);
});

test('stops fetching once older commits cannot change the result', async () => {
	const github = fakeGitHub({
		'unmango/pkgs': [[1, 'success'], [24 * 8, 'success'], [24 * 9, 'success'], [24 * 10, 'success']],
	});
	await run(['unmango/pkgs'], opts(github, fakeNtfy()));
	assert.equal(github.calls.filter(c => c[0] === 'requiredRun').length, 2);
	assert.equal(github.calls.filter(c => c[0] === 'commits').length, 1);
});

test('follows a red streak onto the next page', async () => {
	const github = fakeGitHub({
		'UnstoppableMango/tdl': [[1, 'failure'], [24 * 8, 'failure'], [24 * 9, 'success']],
	});
	const ntfy = fakeNtfy();
	await run(['UnstoppableMango/tdl'], opts(github, ntfy));
	assert.equal(github.calls.filter(c => c[0] === 'commits').length, 2);
	assert.equal(ntfy.pages.length, 1);
	assert.match(ntfy.pages[0].body, /red for 8d/);
});

test('pages only for main red more than 24 hours', async () => {
	const github = fakeGitHub({
		'UnstoppableMango/tdl': [[30, 'failure'], [24 * 8, 'success']],
		'UnstoppableMango/nix': [[2, 'failure'], [24 * 8, 'success']],
	});
	const ntfy = fakeNtfy();
	await run(['UnstoppableMango/tdl', 'UnstoppableMango/nix'], opts(github, ntfy));
	assert.deepEqual(
		ntfy.pages.map(p => p.title),
		['UnstoppableMango/tdl main is red'],
	);
});

test('a repo that cannot be read is reported and fails the run', async () => {
	const github = fakeGitHub({
		'unmango/scm': new Error('HTTP 404'),
		'unmango/pkgs': [[1, 'success'], [24 * 8, 'success']],
	});
	const result = await run(['unmango/scm', 'unmango/pkgs'], opts(github, fakeNtfy()));
	assert.equal(result.failed, true);
	const body = github.calls.find(c => c[0] === 'createIssue')[2];
	assert.match(body, /unmango\/scm.*HTTP 404/);
	assert.match(body, /unmango\/pkgs.*green/);
});

test('a failed page fails the run but still writes the issue', async () => {
	const github = fakeGitHub({ 'UnstoppableMango/tdl': [[30, 'failure'], [24 * 8, 'success']] });
	const ntfy = { page: async () => { throw new Error('ntfy down'); } };
	const result = await run(['UnstoppableMango/tdl'], opts(github, ntfy));
	assert.equal(result.failed, true);
	assert.ok(github.calls.find(c => c[0] === 'createIssue'));
});

test('weekly runs add the digest as a comment', async () => {
	const github = fakeGitHub({ 'unmango/pkgs': [[1, 'success'], [24 * 8, 'success']] }, { issue: { number: 3 }, needsHuman: { 'unmango/pkgs': 2 } });
	await run(['unmango/pkgs'], opts(github, fakeNtfy(), { weekly: true }));
	const comment = github.calls.find(c => c[0] === 'comment');
	assert.equal(comment[1], 3);
	assert.match(comment[2], /2 PRs labelled/);
});

test('daily runs add no comment', async () => {
	const github = fakeGitHub({ 'unmango/pkgs': [[1, 'success'], [24 * 8, 'success']] }, { issue: { number: 3 } });
	await run(['unmango/pkgs'], opts(github, fakeNtfy()));
	assert.equal(github.calls.find(c => c[0] === 'comment'), undefined);
});
