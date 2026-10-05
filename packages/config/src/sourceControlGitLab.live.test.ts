import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { NotebookId, paths, ProjectId } from '@marimo-hub/core';
import type {
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	SourceControlReader,
	SourceControlPublisher,
} from '@marimo-hub/core/ports/source-control';
import { gitLabBaseUrl } from '@marimo-hub/source-control-gitlab';
import { createFromEnv } from './index';
import { makeSourceControl } from './sourceControl';

const token = process.env.MARIMOHUB_TEST_GITLAB_TOKEN;
const repository = process.env.MARIMOHUB_TEST_GITLAB_REPOSITORY;
const baseUrl = gitLabBaseUrl(process.env.MARIMOHUB_TEST_GITLAB_BASE_URL);
const configured = token !== undefined || repository !== undefined;

describe.runIf(configured)('GitLab live source-control workflow', { concurrent: false }, () => {
	const run = randomUUID();
	const rootPath = `apps/${run}`;
	const endpoint = `${baseUrl}/api/v4/projects/${encodeURIComponent(repository ?? '')}`;
	let deps: ReturnType<typeof createFromEnv>;
	let app: ReturnType<typeof createApi>;
	let projectId: ProjectId;
	let reader: SourceControlReader;
	let publisher: SourceControlPublisher;
	let baseCommit: string;
	let input: OpenChangeRequestInput;
	let published: OpenChangeRequestResult;
	const encode = (value: string) => new TextEncoder().encode(value);

	async function gitlab(path: string, method = 'GET', body?: unknown): Promise<Response> {
		const response = await fetch(`${endpoint}${path}`, {
			method,
			redirect: 'error',
			headers: { 'PRIVATE-TOKEN': token!, 'Content-Type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`Live GitLab ${method} ${path}: ${response.status}`);
		return response;
	}

	async function json<T>(response: Promise<Response>): Promise<T> {
		return (await (await response).json()) as T;
	}

	async function request<T>(method: string, path: string, body?: unknown, status = 200) {
		const response = await app.request(`/api/v1${path}`, {
			method,
			...(body === undefined
				? {}
				: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
		});
		const result = (await response.json()) as { success: boolean; data: T; error?: unknown };
		if (response.status !== status || !result.success)
			throw new Error(`Hub ${method} ${path}: ${response.status} ${JSON.stringify(result.error)}`);
		return result.data;
	}

	beforeAll(async () => {
		if (!token || !repository) throw new Error('Set both GitLab live-test environment variables');
		const project = await json<{ path: string; visibility: string; default_branch: string }>(
			gitlab(''),
		);
		if (
			!project.path.startsWith('marimohub-gitlab-integration-test-') ||
			project.visibility !== 'private'
		)
			throw new Error(
				'Live tests require a private, disposable marimohub-gitlab-integration-test-* project',
			);
		expect(project.default_branch).toBe('main');
		const seed = await json<{ id: string }>(
			gitlab('/repository/commits', 'POST', {
				branch: 'main',
				commit_message: `Seed marimohub live test ${run}`,
				actions: [
					{ action: 'create', file_path: `${rootPath}/app.py`, content: 'print(1)\n' },
					{ action: 'create', file_path: `${rootPath}/remove.txt`, content: 'remove me\n' },
					{ action: 'create', file_path: `${rootPath}/keep.txt`, content: 'untouched\n' },
					{
						action: 'create',
						file_path: `${rootPath}/script.sh`,
						content: '#!/bin/sh\necho live\n',
						execute_filemode: true,
					},
				],
			}),
		);
		baseCommit = seed.id;
		deps = createFromEnv({
			MARIMOHUB_STORAGE_BACKEND: 'memory',
			MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
			MARIMOHUB_COMPUTE_BACKEND: 'none',
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_AUTH_DEV_USER_ID: 'gitlab-live-smoke',
			MARIMOHUB_AUTH_DEV_EMAIL: 'gitlab-live-smoke@example.com',
			MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN: token,
			MARIMOHUB_SOURCE_CONTROL_GITLAB_BASE_URL: baseUrl,
			MARIMOHUB_SOURCE_CONTROL_GITLAB_ALLOWED_REPOSITORIES: JSON.stringify([
				{ resource: repository, projects: '*' },
			]),
		});
		app = createApi(deps);
		const created = await request<{ id: string }>(
			'POST',
			'/projects',
			{ name: 'GitLab live smoke', description: '' },
			201,
		);
		projectId = ProjectId.parse(created.id);
		reader = deps.sourceControl!.getReader('gitlab', projectId)!;
		publisher = deps.sourceControl!.getPublisher('gitlab', projectId)!;
		input = {
			repository: `${baseUrl}/${repository}.git`,
			baseBranch: 'main',
			baseCommit,
			headBranch: `marimohub/live-${run}`,
			title: 'Marimohub live integration test',
			body: 'Disposable integration test; no production notebook or deployment.',
			draft: true,
			coAuthor: { name: 'Notebook Editor', email: 'editor@example.com' },
			changes: [
				{ path: `${rootPath}/app.py`, operation: 'modify', content: encode('print(2)\n') },
				{
					path: `${rootPath}/binary.bin`,
					operation: 'add',
					content: new Uint8Array([0, 255, 128]),
				},
				{ path: `${rootPath}/remove.txt`, operation: 'delete' },
			],
		};
		console.info(JSON.stringify({ event: 'gitlab_live_seed', repository, baseCommit, run }));
	}, 120_000);

	it('pulls through the configured Hub API, restores Git, detects drift and syncs again', async () => {
		const created = await request<{
			notebook: { id: string; status: string };
			sync_token?: string;
			sync_error?: unknown;
		}>(
			'POST',
			`/projects/${projectId}/notebooks/git`,
			{
				title: 'GitLab live notebook',
				description: '',
				provider: 'gitlab',
				repo: `${baseUrl}/${repository}`,
				branch: 'main',
				root_path: rootPath,
				entry_notebook: 'app.py',
				sync_mode: 'pull',
			},
			201,
		);
		expect(created.sync_error).toBeUndefined();
		expect(created.sync_token).toBeUndefined();
		expect(created.notebook.status).toBe('active');
		const notebookId = NotebookId.parse(created.notebook.id);
		const notebookPaths = paths.project(projectId).notebook(notebookId);
		async function currentApp() {
			const { source } = await deps.services.notebooks.getNotebook(projectId, notebookId);
			if (source.type !== 'git' || !source.current_version_id)
				throw new Error('Live notebook has no synced version');
			const file = await deps.bucket.get(
				notebookPaths.version(source.current_version_id).workspaceFile('app.py'),
			);
			return file?.text();
		}
		expect(await deps.bucket.get(notebookPaths.integrationSyncToken)).toBeNull();
		expect(await currentApp()).toBe('print(1)\n');
		const metadata = await reader.fetchGitDirectory!(input.repository, baseCommit, 'main');
		const restored = await mkdtemp(join(tmpdir(), 'gitlab-live-restored-'));
		try {
			for (const file of metadata) {
				expect(Buffer.from(file.bytes).includes(token!)).toBe(false);
				const target = join(restored, '.git', file.path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, file.bytes);
			}
			expect(
				execFileSync('git', ['rev-parse', 'HEAD'], { cwd: restored, encoding: 'utf8' }).trim(),
			).toBe(baseCommit);
			expect(
				execFileSync('git', ['remote', 'get-url', 'origin'], {
					cwd: restored,
					encoding: 'utf8',
				}).trim(),
			).toBe(`${baseUrl}/${repository}.git`);
			expect(
				execFileSync('git', ['show', `HEAD:${rootPath}/app.py`], {
					cwd: restored,
					encoding: 'utf8',
				}),
			).toBe('print(1)\n');
		} finally {
			await rm(restored, { recursive: true, force: true });
		}
		const source = `/projects/${projectId}/notebooks/${notebookId}/source`;
		expect(await request('POST', `${source}/sync`)).toMatchObject({
			synced: false,
			commit: baseCommit,
		});
		const advanced = await json<{ id: string }>(
			gitlab('/repository/commits', 'POST', {
				branch: 'main',
				commit_message: 'Advance source for live Sync now test',
				actions: [{ action: 'update', file_path: `${rootPath}/app.py`, content: 'print(10)\n' }],
			}),
		);
		expect(await request('GET', `${source}/drift`)).toMatchObject({
			in_sync: false,
			remote_commit: advanced.id,
		});
		expect(await request('POST', `${source}/sync`)).toMatchObject({
			synced: true,
			commit: advanced.id,
		});
		expect(await request('GET', `${source}/drift`)).toMatchObject({ in_sync: true });
		expect(await currentApp()).toBe('print(10)\n');
		const pinned = await reader.fetchWorkspace(input.repository, baseCommit, rootPath);
		expect(new TextDecoder().decode(pinned.find((file) => file.path === 'app.py')!.bytes)).toBe(
			'print(1)\n',
		);
		const scoped = makeSourceControl({
			MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN: token,
			MARIMOHUB_SOURCE_CONTROL_GITLAB_BASE_URL: baseUrl,
			MARIMOHUB_SOURCE_CONTROL_GITLAB_ALLOWED_REPOSITORIES: JSON.stringify([
				{ resource: repository, projects: [projectId] },
			]),
		}).sourceControl!;
		await expect(
			scoped.getReader('gitlab')!.getBranchHead(input.repository, 'main'),
		).rejects.toThrow('not allowed');
		expect(
			await scoped.getReader('gitlab', projectId)!.getBranchHead(input.repository, 'main'),
		).toEqual({ commit: advanced.id });
		console.info(
			JSON.stringify({
				event: 'gitlab_live_pull_sync_pass',
				repository,
				baseCommit,
				syncedCommit: advanced.id,
			}),
		);
	}, 180_000);

	it('publishes a draft MR at the captured commit and reuses it on retry', async () => {
		published = await publisher.openChangeRequest(input);
		expect(await publisher.openChangeRequest(input)).toEqual(published);
		const mr = await json<{
			iid: number;
			draft: boolean;
			sha: string;
			source_branch: string;
			target_branch: string;
		}>(gitlab(`/merge_requests/${published.number}`));
		expect(mr).toMatchObject({
			iid: published.number,
			draft: true,
			source_branch: input.headBranch,
			target_branch: 'main',
		});
		const commit = await json<{ parent_ids: string[]; message: string }>(
			gitlab(`/repository/commits/${published.headCommit}`),
		);
		expect(commit.parent_ids).toEqual([baseCommit]);
		expect(commit.message).toContain('Co-authored-by: Notebook Editor <editor@example.com>');
		const raw = (file: string) =>
			gitlab(
				`/repository/files/${encodeURIComponent(`${rootPath}/${file}`)}/raw?ref=${published.headCommit}`,
			);
		expect(await (await raw('app.py')).text()).toBe('print(2)\n');
		expect(await (await raw('keep.txt')).text()).toBe('untouched\n');
		expect([...new Uint8Array(await (await raw('binary.bin')).arrayBuffer())]).toEqual([
			0, 255, 128,
		]);
		const tree = await json<{ name: string; mode: string }[]>(
			gitlab(`/repository/tree?path=${encodeURIComponent(rootPath)}&ref=${published.headCommit}`),
		);
		expect(tree.find((file) => file.name === 'script.sh')?.mode).toBe('100755');
		expect(tree.some((file) => file.name === 'remove.txt')).toBe(false);
		console.info(JSON.stringify({ event: 'gitlab_live_draft_mr_pass', ...published }));
	}, 180_000);

	it('appends and replaces MR commits, recovers retries and preserves ready state', async () => {
		const append = {
			...input,
			changeRequest: published,
			title: 'Append live notebook edit',
			changes: [
				{ path: `${rootPath}/app.py`, operation: 'modify' as const, content: encode('print(3)\n') },
			],
		};
		const appended = await publisher.updateChangeRequest!(append);
		expect(appended.number).toBe(published.number);
		expect(await publisher.updateChangeRequest!(append)).toEqual(appended);
		expect(
			(await json<{ parent_ids: string[] }>(gitlab(`/repository/commits/${appended.headCommit}`)))
				.parent_ids,
		).toEqual([published.headCommit]);
		await gitlab(`/merge_requests/${published.number}`, 'PUT', {
			title: 'Ready live notebook edit',
		});
		const replace = {
			...input,
			changeRequest: appended,
			title: 'Replace live notebook proposal',
			changes: [
				{ path: `${rootPath}/app.py`, operation: 'modify' as const, content: encode('print(4)\n') },
				{
					path: `${rootPath}/binary.bin`,
					operation: 'add' as const,
					content: new Uint8Array([1, 0, 254]),
				},
				{ path: `${rootPath}/remove.txt`, operation: 'delete' as const },
			],
		};
		const replaced = await publisher.updateChangeRequest!(replace);
		expect(await publisher.updateChangeRequest!(replace)).toEqual(replaced);
		expect(
			(await json<{ parent_ids: string[] }>(gitlab(`/repository/commits/${replaced.headCommit}`)))
				.parent_ids,
		).toEqual([baseCommit]);
		expect(await json(gitlab(`/merge_requests/${published.number}`))).toMatchObject({
			draft: false,
			title: replace.title,
			state: 'opened',
		});
		published = replaced;
		console.info(
			JSON.stringify({
				event: 'gitlab_live_mr_updates_pass',
				appendedCommit: appended.headCommit,
				...replaced,
			}),
		);
	}, 180_000);

	it('rejects external edits and closed MRs without overwriting the branch', async () => {
		const external = await json<{ id: string }>(
			gitlab('/repository/commits', 'POST', {
				branch: published.headBranch,
				commit_message: 'External editor changed proposal branch',
				actions: [{ action: 'update', file_path: `${rootPath}/app.py`, content: 'print(99)\n' }],
			}),
		);
		const update = {
			...input,
			changeRequest: published,
			title: 'Conflicting live edit',
			changes: [
				{ path: `${rootPath}/app.py`, operation: 'modify' as const, content: encode('print(5)\n') },
			],
		};
		await expect(publisher.updateChangeRequest!(update)).rejects.toThrow('changed outside');
		expect(await reader.getBranchHead(input.repository, published.headBranch)).toEqual({
			commit: external.id,
		});
		await gitlab(`/merge_requests/${published.number}`, 'PUT', { state_event: 'close' });
		await expect(publisher.updateChangeRequest!(update)).rejects.toThrow(
			'closed or no longer matches',
		);
		expect(await reader.getBranchHead(input.repository, published.headBranch)).toEqual({
			commit: external.id,
		});
		console.info(
			JSON.stringify({
				event: 'gitlab_live_conflicts_pass',
				mergeRequest: published.url,
				preservedCommit: external.id,
			}),
		);
	}, 120_000);
});
