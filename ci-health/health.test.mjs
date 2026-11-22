import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	digest,
	issueBody,
	olderCommitsMatter,
	pageMessage,
	percentile,
	requiredGate,
	summarize,
	shouldPage,
} from './health.mjs';

const now = new Date('2026-11-22T12:00:00Z');
const hoursAgo = h => new Date(now.getTime() - h * 3600_000).toISOString();

// A commit whose `required` run took `minutes` and finished `h` hours ago.
const commit = (h, conclusion, minutes = 3) => ({
	date: hoursAgo(h + minutes / 60),
	run: {
		status: 'completed',
		conclusion,
		startedAt: hoursAgo(h + minutes / 60),
		completedAt: hoursAgo(h),
	},
});

test('percentile is nearest-rank', () => {
	assert.equal(percentile([], 50), null);
	assert.equal(percentile([7], 90), 7);
	assert.equal(percentile([4, 1, 3, 2], 50), 2);
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
});

test('a green head is green', () => {
	const s = summarize([commit(1, 'success'), commit(30, 'failure')], now);
	assert.equal(s.state, 'green');
	assert.equal(s.redSince, null);
});

test('red since the oldest failure of the current streak', () => {
	const s = summarize([commit(1, 'failure'), commit(5, 'timed_out'), commit(30, 'success')], now);
	assert.equal(s.state, 'red');
	assert.equal(s.redSince, hoursAgo(5));
});

test('commits without a counted run neither break nor extend a streak', () => {
	const pending = { date: hoursAgo(0), run: { status: 'in_progress', conclusion: null } };
	const cancelled = commit(2, 'cancelled');
	const none = { date: hoursAgo(3), run: null };
	const s = summarize([pending, commit(1, 'failure'), cancelled, none, commit(26, 'failure'), commit(40, 'success')], now);
	assert.equal(s.state, 'red');
	assert.equal(s.redSince, hoursAgo(26));
});

test('a streak running off the end is red since its oldest failure', () => {
	const s = summarize([commit(1, 'failure'), commit(200, 'failure')], now);
	assert.equal(s.redSince, hoursAgo(200));
});

test('no counted run at all is none', () => {
	assert.equal(summarize([], now).state, 'none');
	assert.equal(summarize([{ date: hoursAgo(1), run: null }], now).state, 'none');
});

test('durations come from the last 7 days of completed, counted runs', () => {
	const s = summarize(
		[commit(1, 'success', 2), commit(2, 'failure', 4), commit(3, 'cancelled', 60), commit(24 * 8, 'success', 90)],
		now,
	);
	assert.equal(s.samples, 2);
	assert.equal(s.p50, 2 * 60);
	assert.equal(s.p90, 4 * 60);
});

test('shouldPage after more than 24 hours red', () => {
	assert.equal(shouldPage({ state: 'red', redSince: hoursAgo(23) }, now), false);
	assert.equal(shouldPage({ state: 'red', redSince: hoursAgo(25) }, now), true);
	assert.equal(shouldPage({ state: 'green', redSince: null }, now), false);
});

test('olderCommitsMatter until the window is covered and the streak is resolved', () => {
	assert.equal(olderCommitsMatter([], now), true);
	assert.equal(olderCommitsMatter([commit(1, 'success')], now), true);
	assert.equal(olderCommitsMatter([commit(1, 'success'), commit(24 * 8, 'success')], now), false);
	assert.equal(olderCommitsMatter([commit(1, 'failure'), commit(24 * 8, 'failure')], now), true);
	assert.equal(olderCommitsMatter([commit(1, 'failure'), commit(24 * 8, 'failure'), commit(24 * 9, 'success')], now), false);
});

const report = (repo, overrides = {}) => ({
	repo,
	state: 'green',
	redSince: null,
	p50: 120,
	p90: 200,
	samples: 5,
	needsHuman: 0,
	error: null,
	...overrides,
});

test('issueBody holds a row per repo and flags a slow p50', () => {
	const body = issueBody(
		[
			report('unmango/pkgs', { p50: 301, p90: 13443, needsHuman: 2 }),
			report('UnstoppableMango/tdl', { state: 'red', redSince: hoursAgo(30) }),
			report('UnstoppableMango/vcs', { state: 'none', p50: null, p90: null, samples: 0 }),
			report('unmango/scm', { error: 'HTTP 404' }),
		],
		now,
		'https://example.test/run',
	);
	assert.match(body, /\| \[unmango\/pkgs\]\(https:\/\/github\.com\/unmango\/pkgs\) \| ✅ green \|/);
	assert.match(body, /⚠️ 5m 1s \| 3h 44m \|/);
	assert.match(body, /\[2\]\(https:\/\/github\.com\/unmango\/pkgs\/pulls\?q=is%3Apr\+is%3Aopen\+label%3Arenovate%3Aneeds-human\)/);
	assert.match(body, /❌ red for 1d 6h/);
	assert.match(body, /no `required` check/);
	assert.match(body, /HTTP 404/);
	assert.match(body, /example\.test\/run/);
	assert.doesNotMatch(body, /\/pull\/\d/, 'linking a PR would add to its timeline every run');
});

test('digest lists everything but pages', () => {
	const text = digest(
		[
			report('unmango/pkgs', { p50: 400 }),
			report('unmango/kubepkgs', { needsHuman: 1 }),
			report('UnstoppableMango/tdl', { state: 'red', redSince: hoursAgo(30) }),
			report('UnstoppableMango/nix', { state: 'red', redSince: hoursAgo(2) }),
			report('UnstoppableMango/vcs', { state: 'none', p50: null, p90: null, samples: 0 }),
			report('unmango/scm', { error: 'HTTP 404' }),
			report('unmango/charts'),
		],
		now,
	);
	assert.match(text, /unmango\/pkgs.*p50 6m 40s/);
	assert.match(text, /unmango\/kubepkgs.*1 PR labelled `renovate:needs-human`/);
	assert.match(text, /UnstoppableMango\/nix.*red for 2h/);
	assert.match(text, /UnstoppableMango\/vcs.*no `required` check/);
	assert.match(text, /unmango\/scm.*HTTP 404/);
	assert.doesNotMatch(text, /UnstoppableMango\/tdl/);
	assert.doesNotMatch(text, /unmango\/charts/);
});

test('an empty digest says so', () => {
	assert.match(digest([report('unmango/charts')], now), /Nothing to report/);
});

test('pageMessage names the repo and how long', () => {
	const msg = pageMessage(report('UnstoppableMango/tdl', { state: 'red', redSince: hoursAgo(49) }), now);
	assert.equal(msg.title, 'UnstoppableMango/tdl main is red');
	assert.match(msg.body, /red for 2d 1h/);
	assert.match(msg.click, /^https:\/\/github\.com\/UnstoppableMango\/tdl\/actions/);
});

test('requiredGate finds the gate and its workflow run', () => {
	const gate = (name, url) => ({
		name,
		status: 'completed',
		conclusion: 'failure',
		started_at: '2026-11-22T10:04:10Z',
		completed_at: '2026-11-22T10:04:12Z',
		details_url: url,
	});
	const build = gate('build', 'https://github.com/o/r/actions/runs/1/job/2');
	assert.deepEqual(requiredGate([build, gate('required', 'https://github.com/o/r/actions/runs/123/job/456')]), {
		status: 'completed',
		conclusion: 'failure',
		completedAt: '2026-11-22T10:04:12Z',
		workflowRun: 123,
	});
	assert.equal(requiredGate([gate('ci / required', 'https://github.com/o/r/actions/runs/7/job/8')]).workflowRun, 7);
	assert.equal(requiredGate([build]), null);
	assert.equal(requiredGate([gate('not-required', null)]), null);
});
