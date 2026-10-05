import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
	MAX_GIT_FETCH_BYTES,
	MAX_GIT_EXPANDED_FILES,
	sourceControlPublishFailure,
} from '@marimo-hub/core/ports/source-control';
import { GitLabPublisher, parseGitLabRepository } from './index';
import { GitLabTestWorld } from './testing/fixture';

const worlds: GitLabTestWorld[] = [];
async function world() {
	const fixture = await GitLabTestWorld.create();
	worlds.push(fixture);
	return fixture;
}
afterEach(async () => {
	await Promise.all(worlds.splice(0).map((fixture) => fixture.dispose()));
}, 30_000);

describe('GitLab repository and credentials', { timeout: 30_000 }, () => {
	it('accepts nested groups, URL and clone suffix without changing case', () => {
		expect(parseGitLabRepository('Team/group/notebooks.git')).toBe('Team/group/notebooks');
		expect(
			parseGitLabRepository(
				'https://code.example.com/Team/group/notebooks.git',
				'https://code.example.com',
			),
		).toBe('Team/group/notebooks');
	});
	it.each([
		'https://elsewhere.example/team/repo',
		'https://user:secret@gitlab.com/team/repo',
		'https://gitlab.com/team/repo?q=1',
		'https://gitlab.com/team/repo#fragment',
		'team/../repo',
		'/team/repo',
		'team/repo%2fextra',
	])('rejects %s', (repository) => {
		expect(() => parseGitLabRepository(repository)).toThrow();
	});
	it.each([
		'http://gitlab.com',
		'https://gitlab.com/gitlab',
		'https://user:secret@gitlab.com',
		'https://gitlab.com?token=secret',
	])('rejects unsafe base URL %s', (baseUrl) => {
		expect(() => new GitLabPublisher({ token: 'secret', baseUrl })).toThrow();
	});
	it('does not send requests to unsupported repositories', async () => {
		const fixture = await world();
		expect(fixture.publisher.supportsRepository('https://gitlab.com/team/repo')).toBe(false);
		await expect(
			fixture.publisher.getBranchHead('https://gitlab.com/team/repo', 'main'),
		).rejects.toThrow('configured instance');
		expect(fixture.requests).toHaveLength(0);
	});
	it('sanitizes network errors and rejects redirects without following them', async () => {
		const failure = new GitLabPublisher(
			{ token: 'secret' },
			{
				fetcher: async () => {
					throw new Error('secret');
				},
			},
		);
		await expect(failure.getBranchHead('team/repo', 'main')).rejects.toThrow(
			'GitLab request failed',
		);
		const redirected = new GitLabPublisher(
			{ token: 'secret' },
			{
				fetcher: async (_url, init) => {
					expect(init?.redirect).toBe('error');
					return new Response(null, {
						status: 302,
						headers: { location: 'https://elsewhere.example' },
					});
				},
			},
		);
		await expect(redirected.getBranchHead('team/repo', 'main')).rejects.toThrow('redirects');
	});
});

describe('GitLab reader', { timeout: 30_000 }, () => {
	it('downloads archives through Node fetch with GitLab hotlink protection', async () => {
		const fixture = await world();
		const archive = await fixture.fetcher(
			`${fixture.origin}/api/v4/projects/${encodeURIComponent(fixture.path)}/repository/archive.tar.gz?sha=${fixture.baseCommit}`,
		);
		const bytes = Buffer.from(await archive.arrayBuffer());
		const server = createServer((request, response) => {
			if (request.headers['sec-fetch-mode'] !== 'same-origin') {
				response.writeHead(406).end();
				return;
			}
			response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing test server address');
			const publisher = new GitLabPublisher(
				{ token: fixture.token, baseUrl: fixture.origin },
				{ fetcher: (_url, init) => fetch(`http://127.0.0.1:${address.port}/archive`, init) },
			);
			const files = await publisher.fetchWorkspace(fixture.path, fixture.baseCommit, 'apps');
			expect(files.map((file) => file.path)).toEqual(['app.py']);
			expect(new TextDecoder().decode(files[0].bytes)).toBe('print(1)\n');
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
	it('resolves exact commits, scopes archives, and excludes symlinks', async () => {
		const fixture = await world();
		const input = fixture.input();
		expect(await fixture.publisher.getBranchHead(input.repository, 'main')).toEqual({
			commit: fixture.baseCommit,
		});
		const files = await fixture.publisher.fetchWorkspace(
			input.repository,
			fixture.baseCommit,
			'apps',
		);
		expect(files.map((file) => file.path)).toEqual(['app.py']);
		expect(new TextDecoder().decode(files[0].bytes)).toBe('print(1)\n');
		expect(fixture.requests.at(-1)?.url).toContain(`sha=${fixture.baseCommit}`);
		await expect(fixture.publisher.getBranchHead(input.repository, 'absent')).rejects.toThrow(
			'branch not found',
		);
	});
	it('rejects oversized Git responses before consuming the body', async () => {
		const publisher = new GitLabPublisher(
			{ token: 'fake' },
			{
				fetcher: async () =>
					new Response('oversized', {
						headers: { 'content-length': String(MAX_GIT_FETCH_BYTES + 1) },
					}),
			},
		);
		await expect(publisher.fetchGitDirectory('team/repo', 'a'.repeat(40), 'main')).rejects.toThrow(
			'pull-source limit',
		);
	});
	it('rejects repositories exceeding expanded checkout file limits', async () => {
		const fixture = await world();
		const blob = fixture.git(['hash-object', '-w', '--stdin'], 'small');
		const entries = Array.from(
			{ length: MAX_GIT_EXPANDED_FILES },
			(_, i) => `100644 ${blob}\texcess/${i}.txt\n`,
		).join('');
		fixture.git(['update-index', '--index-info'], entries);
		const commit = fixture.git(
			['commit-tree', fixture.git(['write-tree']), '-p', fixture.baseCommit],
			'Large tree',
		);
		fixture.git(['update-ref', 'refs/heads/main', commit]);
		await expect(
			fixture.publisher.fetchGitDirectory(fixture.input().repository, commit, 'main'),
		).rejects.toThrow('file limit');
	});
	it('restores a usable credential-free Git directory at the pinned commit', async () => {
		const fixture = await world();
		const input = fixture.input();
		const files = await fixture.publisher.fetchGitDirectory(
			input.repository,
			fixture.baseCommit,
			'main',
		);
		const restored = await mkdtemp(join(tmpdir(), 'gitlab-restored-'));
		try {
			for (const file of files) {
				const path = join(restored, '.git', file.path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, file.bytes);
				expect(new TextDecoder().decode(file.bytes)).not.toContain(fixture.token);
			}
			expect(
				execFileSync('git', ['rev-parse', 'HEAD'], { cwd: restored, encoding: 'utf8' }).trim(),
			).toBe(fixture.baseCommit);
			expect(await readFile(join(restored, '.git/config'), 'utf8')).toContain(
				`${fixture.origin}/${fixture.path}.git`,
			);
		} finally {
			await rm(restored, { recursive: true, force: true });
		}
		const basic = `Basic ${Buffer.from(`oauth2:${fixture.token}`).toString('base64')}`;
		expect(
			fixture.requests
				.filter((request) => request.url.includes('.git/'))
				.every((request) => request.headers.get('authorization') === basic),
		).toBe(true);
	});
});

describe('GitLab publishing over smart HTTP', { timeout: 30_000 }, () => {
	it('creates a draft MR with binary additions, modifications, deletions and executable modes', async () => {
		const fixture = await world();
		const input = fixture.input([
			{ path: 'apps/app.py', operation: 'modify', content: new TextEncoder().encode('print(2)\n') },
			{ path: 'data/binary.bin', operation: 'add', content: new Uint8Array([0, 255, 128]) },
			{
				path: 'script.sh',
				operation: 'modify',
				content: new TextEncoder().encode('#!/bin/sh\necho ok\n'),
			},
			{ path: 'remove.txt', operation: 'delete' },
		]);
		const result = await fixture.publisher.openChangeRequest(input);
		expect(result.number).toBe(7);
		expect(result.headCommit).toBe(fixture.head(input.headBranch));
		expect(fixture.mergeRequests[0]).toMatchObject({
			title: 'Draft: Update notebook',
			draft: true,
			target_branch: 'main',
		});
		expect(fixture.git(['show', `${result.headCommit}:apps/app.py`])).toBe('print(2)');
		expect(fixture.git(['show', `${result.headCommit}:keep.txt`])).toBe('untouched');
		expect([
			...execFileSync('git', ['show', `${result.headCommit}:data/binary.bin`], {
				cwd: fixture.directory,
			}),
		]).toEqual([0, 255, 128]);
		expect(fixture.git(['ls-tree', result.headCommit, 'script.sh'])).toContain('100755');
		expect(fixture.git(['ls-tree', result.headCommit, 'remove.txt'])).toBe('');
		expect(fixture.git(['show', '-s', '--format=%P%n%B', result.headCommit])).toContain(
			'Co-authored-by: Notebook Editor <editor@example.com>',
		);
		expect(fixture.git(['show', '-s', '--format=%P', result.headCommit])).toBe(fixture.baseCommit);
		expect(fixture.git(['show', '-s', '--format=%cn <%ce>', result.headCommit])).toBe(
			'Integration Bot <bot@example.com>',
		);
		expect(await fixture.publisher.openChangeRequest(input)).toEqual(result);
		expect(fixture.mergeRequests).toHaveLength(1);
	});
	it('recovers a successful push whose response was lost', async () => {
		const fixture = await world();
		fixture.afterReceive = () => {
			throw new Error('lost response');
		};
		const result = await fixture.publisher.openChangeRequest(fixture.input());
		expect(result.headCommit).toBe(fixture.head(result.headBranch));
		expect(fixture.mergeRequests).toHaveLength(1);
	});
	it('retries MR creation without another branch commit', async () => {
		const fixture = await world();
		const input = fixture.input();
		fixture.failCreate = true;
		await expect(fixture.publisher.openChangeRequest(input)).rejects.toThrow('503');
		const head = fixture.head(input.headBranch);
		fixture.failCreate = false;
		expect((await fixture.publisher.openChangeRequest(input)).headCommit).toBe(head);
	});
	it('recovers a created MR whose response was lost', async () => {
		const fixture = await world();
		const input = fixture.input();
		fixture.afterCreate = () => {
			fixture.afterCreate = undefined;
			throw new Error('lost response');
		};
		await expect(fixture.publisher.openChangeRequest(input)).rejects.toThrow('request failed');
		const result = await fixture.publisher.openChangeRequest(input);
		expect(result.number).toBe(7);
		expect(fixture.mergeRequests).toHaveLength(1);
	});
	it('recovers a replacement commit after metadata failure and preserves a ready MR', async () => {
		const fixture = await world();
		const input = fixture.input([
			{ path: 'new.py', operation: 'add', content: new Uint8Array([1]) },
		]);
		const opened = await fixture.publisher.openChangeRequest(input);
		fixture.mergeRequests[0].draft = false;
		const update = {
			...input,
			title: 'Updated notebook',
			changeRequest: opened,
			changes: [{ path: 'new.py', operation: 'add' as const, content: new Uint8Array([2]) }],
		};
		fixture.failMetadata = true;
		await expect(fixture.publisher.updateChangeRequest(update)).rejects.toThrow('503');
		const head = fixture.head(opened.headBranch);
		fixture.failMetadata = false;
		const result = await fixture.publisher.updateChangeRequest(update);
		expect(result.headCommit).toBe(head);
		expect(fixture.mergeRequests[0]).toMatchObject({ title: 'Updated notebook', draft: false });
		expect(fixture.git(['show', '-s', '--format=%P', result.headCommit])).toBe(fixture.baseCommit);
	});
	it.each([401, 403])('marks authentication failures with provider status %s', async (status) => {
		const publisher = new GitLabPublisher(
			{ token: 'fake' },
			{ fetcher: async () => new Response('secret provider body', { status }) },
		);
		const fixture = await world();
		const error = await publisher
			.openChangeRequest({ ...fixture.input(), repository: 'team/repo' })
			.catch((error: unknown) => error);
		expect(sourceControlPublishFailure(error)).toMatchObject({
			provider: 'gitlab',
			stage: 'auth',
			status,
		});
		expect(String(error)).not.toContain('secret provider body');
	});
	it('appends updates and replays metadata failures without duplicate commits', async () => {
		const fixture = await world();
		const input = fixture.input();
		const opened = await fixture.publisher.openChangeRequest(input);
		const update = {
			...input,
			changeRequest: opened,
			changes: [
				{
					path: 'apps/app.py',
					operation: 'modify' as const,
					content: new TextEncoder().encode('print(3)\n'),
				},
			],
		};
		fixture.failMetadata = true;
		await expect(fixture.publisher.updateChangeRequest(update)).rejects.toThrow('503');
		const head = fixture.head(opened.headBranch);
		fixture.failMetadata = false;
		const result = await fixture.publisher.updateChangeRequest(update);
		expect(result.headCommit).toBe(head);
		expect(result.number).toBe(opened.number);
		expect(fixture.git(['show', '-s', '--format=%P', result.headCommit])).toBe(opened.headCommit);
		expect(fixture.git(['show', `${result.headCommit}:apps/app.py`])).toBe('print(3)');
	});
	it('rebuilds from the pinned base when an add already exists in the proposal branch', async () => {
		const fixture = await world();
		const input = fixture.input([
			{ path: 'new.py', operation: 'add', content: new TextEncoder().encode('print(1)') },
		]);
		const opened = await fixture.publisher.openChangeRequest(input);
		const result = await fixture.publisher.updateChangeRequest({
			...input,
			changeRequest: opened,
			changes: [
				{ path: 'new.py', operation: 'add', content: new TextEncoder().encode('print(2)') },
			],
		});
		expect(fixture.git(['show', `${result.headCommit}:new.py`])).toBe('print(2)');
		expect(fixture.git(['show', '-s', '--format=%P', result.headCommit])).toBe(fixture.baseCommit);
	});
	it.each(['beforeAdvertisement', 'beforeReceive'] as const)(
		'rejects a concurrent update at %s and preserves the external commit',
		async (hook) => {
			const fixture = await world();
			const input = fixture.input();
			const opened = await fixture.publisher.openChangeRequest(input);
			let external = '';
			fixture[hook] = () => {
				fixture[hook] = undefined;
				external = fixture.advance(opened.headBranch);
			};
			await expect(
				fixture.publisher.updateChangeRequest({ ...input, changeRequest: opened }),
			).rejects.toThrow(/branch|rejected/);
			expect(fixture.head(opened.headBranch)).toBe(external);
		},
	);
	it('rejects replacement races without overwriting an external commit', async () => {
		const fixture = await world();
		const input = fixture.input([
			{ path: 'new.py', operation: 'add', content: new Uint8Array([1]) },
		]);
		const opened = await fixture.publisher.openChangeRequest(input);
		let external = '';
		fixture.beforeReceive = () => {
			fixture.beforeReceive = undefined;
			external = fixture.advance(opened.headBranch);
		};
		await expect(
			fixture.publisher.updateChangeRequest({
				...input,
				changeRequest: opened,
				changes: [{ path: 'new.py', operation: 'add', content: new Uint8Array([2]) }],
			}),
		).rejects.toThrow();
		expect(fixture.head(opened.headBranch)).toBe(external);
	});
	it('rejects an externally changed branch with branch-stage diagnostics', async () => {
		const fixture = await world();
		const input = fixture.input();
		const opened = await fixture.publisher.openChangeRequest(input);
		fixture.advance(opened.headBranch);
		const error = await fixture.publisher
			.updateChangeRequest({ ...input, changeRequest: opened })
			.catch((error: unknown) => error);
		expect(sourceControlPublishFailure(error)).toMatchObject({
			provider: 'gitlab',
			stage: 'branch',
			condition: 'branch_changed',
		});
	});
	it('rejects an externally replaced branch without fetching its orphaned old head', async () => {
		const fixture = await world();
		const input = fixture.input();
		const opened = await fixture.publisher.openChangeRequest(input);
		const external = fixture.git(
			[
				'commit-tree',
				fixture.git(['rev-parse', `${fixture.baseCommit}^{tree}`]),
				'-p',
				fixture.baseCommit,
			],
			'External replacement\n',
		);
		fixture.git(['update-ref', `refs/heads/${opened.headBranch}`, external, opened.headCommit]);
		const error = await fixture.publisher
			.updateChangeRequest({ ...input, changeRequest: opened })
			.catch((error: unknown) => error);
		expect(sourceControlPublishFailure(error)).toMatchObject({
			provider: 'gitlab',
			stage: 'branch',
			condition: 'branch_changed',
		});
		expect(fixture.head(opened.headBranch)).toBe(external);
	});
	it.each(['closed', 'merged'])('rejects a %s MR and requires a new proposal', async (state) => {
		const fixture = await world();
		const input = fixture.input();
		const opened = await fixture.publisher.openChangeRequest(input);
		fixture.mergeRequests[0].state = state;
		await expect(
			fixture.publisher.updateChangeRequest({ ...input, changeRequest: opened }),
		).rejects.toThrow('closed or no longer matches');
		const created = await fixture.publisher.openChangeRequest({
			...input,
			headBranch: 'marimohub/notebook/new-proposal',
		});
		expect(created.number).not.toBe(opened.number);
		expect(fixture.mergeRequests).toHaveLength(2);
	});
	it('rejects deleted branches and mismatched MR targets', async () => {
		const fixture = await world();
		const input = fixture.input();
		const opened = await fixture.publisher.openChangeRequest(input);
		await expect(
			fixture.publisher.updateChangeRequest({
				...input,
				changeRequest: { ...opened, url: 'https://evil.example/mr/7' },
			}),
		).rejects.toThrow('no longer matches');
		fixture.git(['update-ref', '-d', `refs/heads/${opened.headBranch}`]);
		await expect(
			fixture.publisher.updateChangeRequest({ ...input, changeRequest: opened }),
		).rejects.toThrow('branch was deleted');
	});
});
