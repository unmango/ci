import { digest, issueBody, needsOlder, pageMessage, shouldPage, summarize } from './health.mjs';

export const TITLE = 'CI health';
const MAX_PAGES = 5;

async function report(repo, { github, now }) {
	try {
		const commits = [];
		for (let page = 1; page <= MAX_PAGES && needsOlder(commits, now); page++) {
			const batch = await github.commits(repo, page);
			if (batch.length === 0) break;
			for (const { sha, date } of batch) {
				if (!needsOlder(commits, now)) break;
				commits.push({ date, run: await github.requiredRun(repo, sha) });
			}
		}
		return { repo, ...summarize(commits, now), needsHuman: await github.needsHuman(repo), error: null };
	} catch (err) {
		return { repo, state: 'none', redSince: null, p50: null, p90: null, samples: 0, needsHuman: 0, error: err.message };
	}
}

export async function run(repos, { github, ntfy, now, runUrl, weekly }) {
	const reports = [];
	for (const repo of repos) reports.push(await report(repo, { github, now }));
	let failed = reports.some(r => r.error);
	for (const r of reports) if (r.error) console.error(`${r.repo}: ${r.error}`);

	for (const r of reports.filter(r => shouldPage(r, now))) {
		try {
			await ntfy.page(pageMessage(r, now));
		} catch (err) {
			console.error(`paging for ${r.repo}: ${err.message}`);
			failed = true;
		}
	}

	const body = issueBody(reports, now, runUrl);
	let issue = await github.findIssue();
	if (issue) {
		await github.updateIssue(issue.number, body);
	} else {
		issue = await github.createIssue(TITLE, body);
		try {
			await github.pinIssue(issue.nodeId);
		} catch (err) {
			console.warn(`pinning #${issue.number}: ${err.message}`);
		}
	}
	if (weekly) await github.comment(issue.number, digest(reports, now));

	return { failed, reports };
}
