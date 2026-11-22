import { digest, issueBody, olderCommitsMatter, pageMessage, shouldPage, summarize, TITLE } from './health.mjs';

const MAX_PAGES = 5;

async function report(repo, { github, now }) {
	try {
		const commits = [];
		for (let page = 1; page <= MAX_PAGES && olderCommitsMatter(commits, now); page++) {
			const batch = await github.commits(repo, page);
			if (batch.length === 0) break;
			for (const { sha, date } of batch) {
				if (!olderCommitsMatter(commits, now)) break;
				commits.push({ date, run: await github.requiredRun(repo, sha) });
			}
		}
		const summary = { repo, ...summarize(commits, now), needsHuman: 0, error: null };
		try {
			summary.needsHuman = await github.needsHuman(repo);
		} catch (err) {
			summary.error = err.message;
		}
		return summary;
	} catch (err) {
		return { repo, ...summarize([], now), needsHuman: 0, error: err.message };
	}
}

export async function run(repos, { github, ntfy, now, runUrl, weekly }) {
	const reports = [];
	for (const repo of repos) reports.push(await report(repo, { github, now }));
	let failed = false;
	const fail = (what, err) => {
		console.error(`${what}: ${err.message ?? err}`);
		failed = true;
	};
	for (const r of reports) if (r.error) fail(r.repo, r.error);

	for (const r of reports.filter(r => shouldPage(r, now))) {
		await ntfy.page(pageMessage(r, now)).catch(err => fail(`paging for ${r.repo}`, err));
	}

	const body = issueBody(reports, now, runUrl);
	let issue = await github.findIssue();
	if (issue) await github.updateIssue(issue.number, body);
	else issue = await github.createIssue(TITLE, body);
	if (!issue.pinned) await github.pinIssue(issue.nodeId).catch(err => fail(`pinning #${issue.number}`, err));
	if (weekly) await github.comment(issue.number, digest(reports, now));

	return { failed, reports };
}
