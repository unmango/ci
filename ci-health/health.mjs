const HOUR = 3600_000;
const WINDOW = 7 * 24 * HOUR;
const PAGE_AFTER = 24 * HOUR;
const SLOW_P50 = 5 * 60;
const UNCOUNTED_LIMIT = 30;

const RED = new Set(['failure', 'timed_out', 'startup_failure']);
const GREEN = new Set(['success', 'neutral']);

export const NEEDS_HUMAN = 'renovate:needs-human';
export const MARKER = '<!-- ci-health -->';
export const TITLE = 'CI health';

export function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// Cancelled, skipped and unfinished runs say nothing about whether `main` builds.
function counted(run) {
	return run?.status === 'completed' && (RED.has(run.conclusion) || GREEN.has(run.conclusion));
}

function streak(commits) {
	let state = 'none';
	let redSince = null;
	for (const { run } of commits) {
		if (!counted(run)) continue;
		const red = RED.has(run.conclusion);
		if (state === 'none') state = red ? 'red' : 'green';
		if (!red) return { state, redSince, resolved: true };
		redSince = run.completedAt;
	}
	return { state, redSince, resolved: state === 'none' ? false : state === 'green' };
}

// `commits` is `main`, newest first, each with its latest `required` run or null.
export function summarize(commits, now) {
	const { state, redSince } = streak(commits);
	const durations = commits
		.map(c => c.run)
		.filter(r => counted(r) && now - new Date(r.completedAt) <= WINDOW)
		.map(r => (new Date(r.completedAt) - new Date(r.startedAt)) / 1000);
	return {
		state,
		redSince,
		p50: percentile(durations, 50),
		p90: percentile(durations, 90),
		samples: durations.length,
	};
}

export function olderCommitsMatter(commits, now) {
	const oldest = commits.at(-1);
	if (!oldest || now - new Date(oldest.date) <= WINDOW) return true;
	const { state, resolved } = streak(commits);
	if (state === 'none') return commits.filter(c => now - new Date(c.date) > WINDOW).length < UNCOUNTED_LIMIT;
	return state === 'red' && !resolved;
}

export function shouldPage(summary, now) {
	return summary.state === 'red' && now - new Date(summary.redSince) > PAGE_AFTER;
}

function duration(seconds) {
	if (seconds == null) return '–';
	const s = Math.round(seconds);
	if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function age(since, now) {
	const hours = Math.floor((now - new Date(since)) / HOUR);
	return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
}

const repoUrl = repo => `https://github.com/${repo}`;
const actionsUrl = repo => `${repoUrl(repo)}/actions?query=branch%3Amain`;
// A search link rather than PR links: a reference from this issue would add to every PR's timeline on each run.
const needsHumanUrl = repo =>
	`${repoUrl(repo)}/pulls?q=${encodeURIComponent(`is:pr is:open label:${NEEDS_HUMAN}`).replaceAll('%20', '+')}`;

function mainCell(r, now) {
	const state = {
		red: () => `❌ red for ${age(r.redSince, now)}`,
		green: () => '✅ green',
		none: () => (r.error ? '' : 'no `required` check'),
	}[r.state]();
	return r.error ? `${state} ⚠️ ${r.error}`.trim() : state;
}

const slow = r => r.p50 != null && r.p50 > SLOW_P50;

export function issueBody(reports, now, runUrl) {
	const rows = reports.map(r =>
		[
			`[${r.repo}](${repoUrl(r.repo)})`,
			mainCell(r, now),
			r.error ? '–' : r.needsHuman ? `[${r.needsHuman}](${needsHumanUrl(r.repo)})` : '0',
			slow(r) ? `⚠️ ${duration(r.p50)}` : duration(r.p50),
			duration(r.p90),
			String(r.samples),
		].join(' | ')
	);
	return [
		MARKER,
		`The \`required\` job on each Nix repo's \`main\`, refreshed daily by [ci-health](${runUrl}) at ${now.toISOString()}.`,
		'Durations cover the last 7 days; ⚠️ marks a p50 over 5 minutes.',
		'A `main` red for more than 24 hours pages.',
		'',
		`| Repo | \`main\` | \`${NEEDS_HUMAN}\` | p50 | p90 | Runs |`,
		'| --- | --- | --- | --- | --- | --- |',
		...rows.map(row => `| ${row} |`),
		'',
	].join('\n');
}

export function digest(reports, now) {
	const lines = [];
	for (const r of reports) {
		const link = `[${r.repo}](${repoUrl(r.repo)})`;
		if (r.error) {
			lines.push(`- ${link}: ${r.error}`);
			continue;
		}
		if (r.state === 'none') lines.push(`- ${link}: no \`required\` check on \`main\``);
		if (r.state === 'red' && !shouldPage(r, now)) lines.push(`- ${link}: \`main\` red for ${age(r.redSince, now)}`);
		if (slow(r)) lines.push(`- ${link}: p50 ${duration(r.p50)}, p90 ${duration(r.p90)}`);
		if (r.needsHuman) {
			const prs = r.needsHuman === 1 ? '1 PR' : `${r.needsHuman} PRs`;
			lines.push(`- ${link}: [${prs} labelled \`${NEEDS_HUMAN}\`](${needsHumanUrl(r.repo)})`);
		}
	}
	return [`Weekly digest, ${now.toISOString().slice(0, 10)}`, '', ...(lines.length ? lines : ['Nothing to report.']), ''].join(
		'\n',
	);
}

export function pageMessage(r, now) {
	return {
		title: `${r.repo} main is red`,
		body: `The required check on ${r.repo} main has been red for ${age(r.redSince, now)}.`,
		click: actionsUrl(r.repo),
	};
}

// A gate called from a reusable workflow is named `<caller job> / required`.
export function requiredGate(checkRuns) {
	const gate = checkRuns.find(r => r.name === 'required' || r.name.endsWith(' / required'));
	if (!gate) return null;
	return {
		status: gate.status,
		conclusion: gate.conclusion,
		completedAt: gate.completed_at,
		workflowRun: Number(gate.details_url?.match(/\/actions\/runs\/(\d+)/)?.[1]) || null,
	};
}
