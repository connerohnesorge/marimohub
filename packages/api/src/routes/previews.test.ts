import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createServices,
	paths,
	PreviewCreateSchema,
	sessionPersistsEdits,
	NotebookMetaSchema,
	readStored,
	ValidationError,
	ProxyExposure,
} from '@marimo-hub/core';
import type {
	SourceControlReader,
	NotebookId,
	ProjectId,
	Session,
	AuthorizationAction,
} from '@marimo-hub/core';
import {
	ACTOR,
	uid,
	makeFakeCompute,
	makeFakeSandbox,
	fakeComputeFrom,
} from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	stubSourceControl,
} from '../testing';
import { sweepPreviews } from '../previews';

let api: ReturnType<typeof createTestApi>;
let pid: ProjectId;
let nid: NotebookId;
let base: string;
let head: string;
let reader: SourceControlReader;
const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const body = { name: 'Prototype', source: { type: 'branch' as const, branch: 'prototype' } };

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

beforeEach(async () => {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	pid = (await services.projects.createProject({ name: 'Previews', description: '' }, ACTOR)).id;
	nid = (
		await services.notebooks.synced.create(
			pid,
			{
				title: 'Notebook',
				description: '',
				repo: 'owner/repo',
				branch: 'main',
				root_path: '',
				entry_notebook: 'notebook.py',
				sync_mode: 'push',
			},
			ACTOR,
		)
	).meta.id;
	head = SHA;
	reader = {
		provider: 'github',
		previews: true,
		supportsRepository: () => true,
		getBranchHead: vi.fn(async () => ({ commit: head })),
		resolveCommit: vi.fn(async (_repo, commit) => ({ commit })),
		fetchWorkspace: vi.fn(async () => [
			{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo\napp = marimo.App()') },
		]),
		listBranches: vi.fn(async () => [{ value: 'prototype', commit: head, label: 'prototype' }]),
		listCommits: vi.fn(async () => [{ value: head, commit: head, label: 'Prototype' }]),
		getPullRequest: vi.fn(async () => ({
			number: 1,
			state: 'open' as const,
			branch: 'prototype',
			commit: head,
			sameRepository: true,
		})),
	};
	api = createTestApi({
		bucket,
		compute: makeFakeCompute(),
		deps: { sourceControl: stubSourceControl({ reader }) },
	});
	base = `/projects/${pid}/notebooks/${nid}/previews`;
});
async function create(input = body) {
	const result = await expectOk<{ id: string }>(await api.request('POST', base, input));
	return api.deps.services.previews.get(pid, nid, result.id);
}
async function userApi(role: 'app-user' | 'viewer' | 'editor' | 'manager', name = role) {
	await api.deps.services.projects.addMember(pid, { user_id: uid(name) }, role, ACTOR);
	return createTestApi({
		bucket: api.bucket,
		userId: uid(name),
		compute: api.deps.compute,
		deps: { sourceControl: api.deps.sourceControl, policy: { viewerMode: 'ephemeral-sandbox' } },
	});
}

describe('Notebook previews', () => {
	it.each(['https://hub.example.com/marimohub', 'https://hub.example.com/marimohub/'])(
		'preserves the configured public prefix in links and launches: %s',
		async (appBaseUrl) => {
			const { instance, calls } = makeFakeSandbox();
			api = createTestApi({
				bucket: api.bucket,
				compute: fakeComputeFrom(instance),
				deps: {
					sourceControl: api.deps.sourceControl,
					sandbox: {
						...api.deps.sandbox,
						appBaseUrl,
						exposure: new ProxyExposure('preview-test-secret'),
					},
				},
			});
			const record = await expectOk<{ id: string; url: string }>(
				await api.request('POST', base, body),
			);
			const url = `https://hub.example.com/marimohub/projects/${pid}/notebooks/${nid}/previews/${record.id}`;
			expect(record.url).toBe(url);
			expect(await expectOk(await api.request('GET', `${base}/${record.id}`))).toMatchObject({
				url,
			});
			expect(await expectOk(await api.request('GET', base))).toEqual([
				expect.objectContaining({ url }),
			]);
			const session = await expectOk<Session>(
				await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			);
			expect(session.sandbox_url).toMatch(/^https:\/\/hub\.example\.com\/marimohub\/proxy\//);
			expect(calls.startProcess.some(({ cmd }) => cmd.includes('/marimohub/proxy/'))).toBe(true);
		},
	);

	it('returns the launched revision to app-users without exposing editor session fields', async () => {
		const record = await create();
		const appUser = await userApi('app-user');
		const launch = () => appUser.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' });
		const first = await expectOk<Session & { preview_version_id: string }>(await launch());
		expect(first.preview_version_id).toBe(record.current!.version_id);
		for (const field of ['source_version_id', 'user_id', 'integrations', 'compute_profile'])
			expect(first).not.toHaveProperty(field);

		head = NEXT;
		const latest = await api.deps.services.previews.reconcile(record, api.deps.sourceControl, true);
		const publicPreview = await expectOk<{ version_id: string }>(
			await appUser.request('GET', `${base}/${record.id}`),
		);
		expect(publicPreview.version_id).toBe(latest.current!.version_id);
		expect(publicPreview.version_id).not.toBe(first.preview_version_id);
		const running = await api.deps.services.sessions.getSession(pid, first.session_id);
		expect(running.source_version_id).toBe(first.preview_version_id);
		const second = await expectOk<{ preview_version_id: string }>(await launch());
		expect(second.preview_version_id).toBe(latest.current!.version_id);
	});

	it('isolates prepared source from the parent and never catalogs runtime identities', async () => {
		const original = await api.deps.services.notebooks.getNotebookSource(pid, nid);
		const record = await create();
		expect(record.preparation).toBe('ready');
		expect(record.current?.commit).toBe(SHA);
		expect(record.current?.notebook_id).not.toBe(nid);
		expect(await api.deps.services.notebooks.getNotebookSource(pid, nid)).toEqual(original);
		expect((await api.deps.services.notebooks.listNotebooks(pid)).map((item) => item.id)).toEqual([
			nid,
		]);
		const child = record.current!.notebook_id;
		for (const [method, suffix, input] of [
			['GET', '', undefined],
			['PATCH', '', { title: 'changed' }],
			['POST', '/sessions', { mode: 'edit' }],
			['POST', '/deep-links', { slug: 'unsafe' }],
			['POST', '/jobs', { name: 'unsafe' }],
		] as const) {
			const response = await api.request(
				method,
				`/projects/${pid}/notebooks/${child}${suffix}`,
				input,
			);
			expect(response.status).toBeGreaterThanOrEqual(400);
		}
		await expect(
			api.deps.services.notebooks.commitSession(pid, child, { code: 'changed' }, ACTOR),
		).rejects.toThrow('cannot persist');
	});

	it.each(['app-user', 'viewer', 'editor'] as const)(
		'denies management and source discovery to %s',
		async (role) => {
			const record = await create();
			const other = await userApi(role);
			await expectError(await other.request('POST', base, body), 403);
			await expectError(await other.request('DELETE', `${base}/${record.id}`), 403);
			await expectError(
				await other.request('GET', `/projects/${pid}/notebooks/${nid}/source/refs?type=branch`),
				403,
			);
			const publicRecord = await expectOk<Record<string, unknown>>(
				await other.request('GET', `${base}/${record.id}`),
			);
			expect(publicRecord).not.toHaveProperty('source');
			expect(publicRecord).not.toHaveProperty('repository');
			expect(publicRecord).not.toHaveProperty('runtime_ids');
		},
	);

	it('keeps editors personal and discard-only, while app-users only start apps', async () => {
		const record = await create();
		const first = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		expect(first.ephemeral).toBe(true);
		expect(first.editor_sandbox_sharing).toBe('exclusive');
		expect(sessionPersistsEdits(first)).toBe(false);
		expect(await api.deps.services.sessions.getEditorClaim(pid, nid)).toBeUndefined();
		const editor = await userApi('editor');
		const second = await expectOk<Session>(
			await editor.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		expect(first.session_id).not.toBe(second.session_id);
		const appUser = await userApi('app-user');
		await expectError(
			await appUser.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
			403,
		);
		const app = await expectOk<Session>(
			await appUser.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		expect(app.ephemeral).toBeUndefined();
		expect(app.session_id).not.toBe(first.session_id);
		const other = await create();
		const otherApp = await expectOk<Session>(
			await appUser.request('POST', `${base}/${other.id}/sessions`, { mode: 'app' }),
		);
		expect(otherApp.notebook_id).not.toBe(app.notebook_id);
		await expectError(
			await appUser.request('POST', `${base}/${record.id}/sessions`, {
				mode: 'app',
				ref: 'secret',
			}),
			422,
		);
	});

	it('tracks branches including force pushes and leaves pinned previews unchanged', async () => {
		const moving = await create();
		const pinned = await api.deps.services.previews.create(
			pid,
			nid,
			{ name: 'Pinned', source: { type: 'commit', commit: SHA } },
			ACTOR,
			api.deps.sourceControl,
		);
		head = NEXT;
		const updated = await api.deps.services.previews.reconcile(
			moving,
			api.deps.sourceControl,
			true,
		);
		expect(updated.id).toBe(moving.id);
		expect(updated.current?.commit).toBe(NEXT);
		expect(updated.current?.notebook_id).not.toBe(moving.current?.notebook_id);
		const unchanged = await api.deps.services.previews.reconcile(
			pinned,
			api.deps.sourceControl,
			true,
		);
		expect(unchanged.current).toEqual(pinned.current);
		expect(reader.resolveCommit).toHaveBeenCalledTimes(1);
		head = SHA;
		expect(
			(await api.deps.services.previews.reconcile(updated, api.deps.sourceControl, true)).current
				?.commit,
		).toBe(SHA);
		expect(
			PreviewCreateSchema.safeParse({ ...body, source: { type: 'branch', branch: SHA } }).success,
		).toBe(true);
		expect(
			PreviewCreateSchema.safeParse({
				...body,
				source: { type: 'commit', branch: 'main', commit: SHA },
			}).success,
		).toBe(false);
	});

	it('concurrent idempotent creates share one identity and a delete cannot be replayed', async () => {
		const service = api.deps.services.previews;
		const [a, b] = await Promise.all([
			service.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'one'),
			service.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'one'),
		]);
		expect(a.id).toBe(b.id);
		expect(await service.list(pid, nid)).toHaveLength(1);
		expect(reader.fetchWorkspace).toHaveBeenCalledTimes(1);
		await expect(
			service.create(
				pid,
				nid,
				{ ...body, name: 'Different' },
				ACTOR,
				api.deps.sourceControl,
				'one',
			),
		).rejects.toThrow('Idempotency');
		await service.retire(a);
		await expect(
			service.create(pid, nid, body, ACTOR, api.deps.sourceControl, 'one'),
		).rejects.toThrow('deleted');
	});

	it('fences deletion during preparation and cleans late artifacts', async () => {
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		reader.fetchWorkspace = async () => {
			started.resolve();
			await proceed.promise;
			return [{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo') }];
		};
		const creating = api.deps.services.previews.create(
			pid,
			nid,
			body,
			ACTOR,
			api.deps.sourceControl,
		);
		await started.promise;
		const record = (await api.deps.services.previews.list(pid, nid))[0];
		await api.deps.services.previews.retire(record);
		proceed.resolve();
		expect((await creating).state).toBe('deleting');
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
		for (const child of record.runtime_ids)
			expect(await api.bucket.get(paths.project(pid).notebook(child).meta)).toBeNull();
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			404,
		);
	});

	it('keeps the last revision when an update fails and retires on PR close', async () => {
		const record = await api.deps.services.previews.create(
			pid,
			nid,
			{ ...body, pull_request: 1 },
			ACTOR,
			api.deps.sourceControl,
		);
		head = NEXT;
		reader.fetchWorkspace = async () => {
			throw new Error('provider failure');
		};
		const failed = await api.deps.services.previews.reconcile(record, api.deps.sourceControl, true);
		expect(failed.preparation).toBe('failed');
		expect(failed.current).toEqual(record.current);
		reader.getPullRequest = async () => ({
			number: 1,
			state: 'closed',
			branch: 'prototype',
			commit: head,
			sameRepository: true,
		});
		expect(
			(await api.deps.services.previews.reconcile(failed, api.deps.sourceControl, true)).state,
		).toBe('deleting');
	});

	it('inherits live parent labels and rejects sessions after parent deletion', async () => {
		const record = await create();
		const child = record.current!.notebook_id;
		const key = paths.project(pid).notebook(nid).meta;
		const object = (await api.bucket.get(key))!;
		const meta = await readStored(NotebookMetaSchema, object, key);
		await api.bucket.put(
			key,
			JSON.stringify({
				...meta,
				security_labels: { classification: 'restricted', compartments: ['review'] },
			}),
		);
		expect(await api.deps.services.notebooks.getSecurityLabels(pid, child)).toEqual({
			classification: 'restricted',
			compartments: ['review'],
		});
		await api.bucket.put(key, JSON.stringify({ ...meta, status: 'deleted' }));
		await expect(api.deps.services.notebooks.getSecurityLabels(pid, child)).rejects.toThrow();
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
	});
	it('enforces token actions before resolving refs or starting preview code', async () => {
		const record = await create();
		const tokenApi = (actions: AuthorizationAction[], projects: ProjectId[] = [pid]) =>
			createTestApi({
				bucket: api.bucket,
				compute: api.deps.compute,
				deps: {
					sourceControl: api.deps.sourceControl,
					authenticator: {
						authenticate: async () => ({
							id: ACTOR,
							email: 'actor@example.com',
							credential: { kind: 'personal-access-token', grant: { actions, projects } },
						}),
					},
				},
			});
		const readerOnly = tokenApi(['project.read']);
		await expectOk(await readerOnly.request('GET', `${base}/${record.id}`));
		await expectError(await readerOnly.request('POST', base, body), 403);
		await expectError(
			await readerOnly.request('GET', `/projects/${pid}/notebooks/${nid}/source/refs?type=branch`),
			403,
		);
		vi.mocked(reader.getBranchHead).mockClear();
		await expectError(
			await readerOnly.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			403,
		);
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		await expectOk(await tokenApi(['preview.manage']).request('POST', base, body));
		await expectError(
			await tokenApi(['project.read', 'preview.manage'], []).request('POST', base, body),
			404,
		);
	});

	it('uses preview compute defaults for viewers and never mounts a personal home', async () => {
		const record = await create();
		const baseViewer = await userApi('viewer');
		const compute = makeFakeCompute();
		const resolve = vi.fn(() => ({ path: '/home/me', key: 'personal' }));
		const sandbox = {
			...baseViewer.deps.sandbox,
			computeProfiles: [
				{ name: 'normal', resources: { cpu: 4 } },
				{ name: 'preview', resources: { cpu: 1 } },
			],
			previewComputeProfile: 'preview',
			userHome: { resolve },
		};
		const viewer = createTestApi({
			bucket: api.bucket,
			userId: uid('viewer'),
			compute,
			deps: { sourceControl: api.deps.sourceControl, policy: baseViewer.deps.policy, sandbox },
		});
		const session = await expectOk<Session>(
			await viewer.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		expect(session.compute_profile).toBe('preview');
		expect(compute.lastCreateOptions?.resources?.cpu).toBe(1);
		expect(compute.lastCreateOptions?.userHome).toBeUndefined();
		expect(resolve).not.toHaveBeenCalled();
		const stored = await viewer.deps.services.sessions.getSession(pid, session.session_id);
		expect(stored.idle_timeout_ms).toBe(300_000);
		expect(stored.authorization_expires_at).toBe(record.expires_at);
	});

	it('keeps deleting state during startup and retries a late failed destruction', async () => {
		const record = await create();
		const { instance, calls } = makeFakeSandbox();
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const startProcess = instance.startProcess;
		instance.startProcess = async (...args) => {
			const process = await startProcess(...args);
			started.resolve();
			await proceed.promise;
			return process;
		};
		const destroy = instance.destroy;
		instance.destroy = vi.fn(async () => {
			throw new Error('Provider unavailable');
		});
		api = createTestApi({
			bucket: api.bucket,
			compute: fakeComputeFrom(instance),
			deps: { sourceControl: api.deps.sourceControl },
		});
		const starting = api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' });
		await started.promise;
		await expectOk(await api.request('DELETE', `${base}/${record.id}`));
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleting');
		expect(calls.destroy).toBe(0);
		proceed.resolve();
		expect((await starting).status).toBeGreaterThanOrEqual(400);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleting');
		instance.destroy = destroy;
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
		expect(calls.destroy).toBeGreaterThan(0);
	});

	it('prunes unused old revisions and drops deleted maintenance markers after the grace period', async () => {
		const original = await create();
		head = NEXT;
		const updated = await api.deps.services.previews.reconcile(
			original,
			api.deps.sourceControl,
			true,
		);
		await sweepPreviews(api.deps);
		const pruned = await api.deps.services.previews.get(pid, nid, original.id);
		expect(pruned.runtime_ids).toEqual([updated.current!.notebook_id]);
		expect(
			await api.bucket.get(paths.project(pid).notebook(original.current!.notebook_id).meta),
		).toBeNull();
		await api.deps.services.previews.retire(pruned);
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 901_000);
			await sweepPreviews(api.deps);
			expect(await api.deps.services.previews.all()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
		expect((await api.deps.services.previews.get(pid, nid, original.id)).state).toBe('deleted');
	});
});

describe('Preview failure recovery and boundaries', () => {
	it.each([
		{ viewerMode: 'static', mode: 'app' },
		{ viewerMode: 'static', mode: 'edit' },
		{ viewerMode: 'applications', mode: 'edit' },
	] as const)(
		'denies $mode in viewer mode $viewerMode before checking GitHub',
		async ({ viewerMode, mode }) => {
			const record = await create();
			await userApi('viewer');
			const viewer = createTestApi({
				bucket: api.bucket,
				userId: uid('viewer'),
				compute: api.deps.compute,
				deps: { sourceControl: api.deps.sourceControl, policy: { viewerMode } },
			});
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(Date.now() + 61_000);
			vi.mocked(reader.getBranchHead).mockClear();
			const shown = await expectOk<{ can: { app: boolean; edit: boolean } }>(
				await viewer.request('GET', `${base}/${record.id}`),
			);
			expect(shown.can[mode]).toBe(false);
			await expectError(
				await viewer.request('POST', `${base}/${record.id}/sessions`, { mode }),
				403,
			);
			expect(reader.getBranchHead).not.toHaveBeenCalled();
			expect(await api.deps.services.sessions.listActiveByProject(pid)).toEqual([]);
		},
	);

	it('retires preview compute when its parent project is deleted', async () => {
		const record = await create();
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		expect((await api.request('DELETE', `/projects/${pid}`)).status).toBe(200);
		await expectError(await api.request('GET', `${base}/${record.id}`), 404);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).state).toBe('deleted');
		expect(
			(await api.deps.services.sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at,
		).toBeDefined();
		expect(
			await api.bucket.get(paths.project(pid).notebook(session.notebook_id).source),
		).toBeNull();
	});

	it.each([
		{ name: 'empty name', input: { ...body, name: '  ' } },
		{ name: 'empty branch', input: { ...body, source: { type: 'branch', branch: '' } } },
		{ name: 'short SHA', input: { ...body, source: { type: 'commit', commit: 'abcdef' } } },
		{
			name: 'mixed selectors',
			input: { ...body, source: { type: 'commit', commit: SHA, branch: 'main' } },
		},
		{ name: 'repository override', input: { ...body, repository: 'other/repository' } },
		{ name: 'invalid PR number', input: { ...body, pull_request: 0 } },
		{ name: 'invalid expiry', input: { ...body, expires_at: 'tomorrow' } },
	])('rejects $name before publishing or fetching source', async ({ input }) => {
		await expectError(await api.request('POST', base, input), 422);
		expect(await api.deps.services.previews.list(pid, nid)).toEqual([]);
		expect(await api.deps.services.previews.all()).toEqual([]);
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
	});

	it.each([-1, 0, 30 * 24 * 60 * 60_000 + 1])(
		'rejects expiry offset %i without leaving a maintenance marker',
		async (offset) => {
			vi.useFakeTimers({ toFake: ['Date'] });
			await expectError(
				await api.request('POST', base, {
					...body,
					expires_at: new Date(Date.now() + offset).toISOString(),
				}),
				400,
			);
			expect(await api.deps.services.previews.all()).toEqual([]);
			expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		},
	);

	it.each(['disabled', 'no commit resolver', 'repository denied'] as const)(
		'rejects a GitHub connection with %s before creating records',
		async (condition) => {
			const unavailable = { ...reader };
			if (condition === 'disabled') unavailable.previews = false;
			if (condition === 'no commit resolver') unavailable.resolveCommit = undefined;
			if (condition === 'repository denied') unavailable.supportsRepository = () => false;
			const denied = createTestApi({
				bucket: api.bucket,
				deps: { sourceControl: stubSourceControl({ reader: unavailable }) },
			});
			await expectError(await denied.request('POST', base, body), 400);
			expect(await api.deps.services.previews.all()).toEqual([]);
			expect(reader.fetchWorkspace).not.toHaveBeenCalled();
		},
	);

	it('blocks launches after initial preparation fails and recovers on a later retry', async () => {
		const fetchWorkspace = vi.mocked(reader.fetchWorkspace);
		fetchWorkspace.mockRejectedValueOnce(new Error('provider credential: must-not-leak'));
		const record = await create();
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		expect(record.lease).toBeUndefined();
		const shown = await expectOk(await api.request('GET', `${base}/${record.id}`));
		expect(JSON.stringify(shown)).not.toContain('must-not-leak');
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
			409,
		);
		expect(await api.deps.services.sessions.listActiveByProject(pid)).toEqual([]);
		const recovered = await api.deps.services.previews.reconcile(
			record,
			api.deps.sourceControl,
			true,
		);
		expect(recovered.id).toBe(record.id);
		expect(recovered.preparation).toBe('ready');
		expect(recovered.error).toBeUndefined();
		await expectOk(await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }));
	});

	it('keeps serving the last prepared revision when a branch disappears', async () => {
		const record = await create();
		vi.mocked(reader.getBranchHead).mockRejectedValue(
			new ValidationError('Branch no longer exists'),
		);
		const failed = await api.deps.services.previews.reconcile(record, api.deps.sourceControl, true);
		expect(failed.state).toBe('active');
		expect(failed.preparation).toBe('failed');
		expect(failed.current).toEqual(record.current);
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'app' }),
		);
		expect(session.source_version_id).toBe(record.current!.version_id);
	});

	it('does not publish an archive missing the configured entry notebook', async () => {
		vi.mocked(reader.fetchWorkspace).mockResolvedValue([
			{ path: 'other.py', bytes: new TextEncoder().encode('unrelated') },
		]);
		const record = await create();
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		await expectError(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
			409,
		);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).runtime_ids).toEqual([]);
	});

	it.each([
		{ name: 'fork', sameRepository: false, branch: 'prototype' },
		{ name: 'different head branch', sameRepository: true, branch: 'other' },
	])('never fetches code for a PR with a $name', async ({ sameRepository, branch }) => {
		vi.mocked(reader.getPullRequest!).mockResolvedValue({
			number: 1,
			state: 'open',
			commit: SHA,
			sameRepository,
			branch,
		});
		const record = await api.deps.services.previews.create(
			pid,
			nid,
			{ ...body, pull_request: 1 },
			ACTOR,
			api.deps.sourceControl,
		);
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		expect(record.runtime_ids).toEqual([]);
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(reader.fetchWorkspace).not.toHaveBeenCalled();
	});

	it('accepts the maximum lifetime but denies access at the exact expiry before cleanup runs', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const expires = Date.now() + 30 * 24 * 60 * 60_000;
		const created = await expectOk<{ id: string }>(
			await api.request('POST', base, { ...body, expires_at: new Date(expires).toISOString() }),
		);
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${created.id}/sessions`, { mode: 'edit' }),
		);
		vi.setSystemTime(expires);
		await expectError(await api.request('GET', `${base}/${created.id}`), 404);
		await expectError(
			await api.request('POST', `${base}/${created.id}/sessions`, { mode: 'app' }),
			404,
		);
		await expectError(
			await api.request(
				'POST',
				`/projects/${pid}/notebooks/${session.notebook_id}/sessions/${session.session_id}/heartbeat`,
			),
			404,
		);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, created.id)).state).toBe('deleted');
		expect(
			(await api.deps.services.sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at,
		).toBeDefined();
	});

	it('revokes preview and live session access when project membership is removed', async () => {
		const record = await create();
		const member = await userApi('editor');
		const session = await expectOk<Session>(
			await member.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		await api.deps.services.projects.removeMember(pid, uid('editor'), ACTOR);
		await expectError(await member.request('GET', `${base}/${record.id}`), 404);
		await expectError(
			await member.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
			404,
		);
		await expectError(
			await member.request(
				'POST',
				`/projects/${pid}/notebooks/${session.notebook_id}/sessions/${session.session_id}/heartbeat`,
			),
			404,
		);
		await expectOk(await api.request('GET', `${base}/${record.id}`));
	});

	it('does not let an expired update lease overwrite a newer prepared revision', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const record = await create();
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		vi.mocked(reader.fetchWorkspace).mockImplementationOnce(async () => {
			started.resolve();
			await proceed.promise;
			return [{ path: 'notebook.py', bytes: new TextEncoder().encode('stale') }];
		});
		head = NEXT;
		const stale = api.deps.services.previews.reconcile(record, api.deps.sourceControl, true);
		await started.promise;
		try {
			vi.setSystemTime(Date.now() + 600_001);
			head = 'c'.repeat(40);
			const winner = await api.deps.services.previews.reconcile(
				record,
				api.deps.sourceControl,
				true,
			);
			expect(winner.current?.commit).toBe(head);
			proceed.resolve();
			expect((await stale).current).toEqual(winner.current);
			await sweepPreviews(api.deps);
			expect((await api.deps.services.previews.get(pid, nid, record.id)).runtime_ids).toEqual([
				winner.current!.notebook_id,
			]);
		} finally {
			proceed.resolve();
			await stale;
		}
	});

	it('recovers from a partial workspace write without publishing or retaining incomplete artifacts', async () => {
		const put = api.bucket.put.bind(api.bucket);
		const writes = vi.spyOn(api.bucket, 'put').mockImplementation((key, value, options) => {
			if (key.endsWith('/workspace/notebook.py'))
				return Promise.reject(new Error('Storage unavailable'));
			return put(key, value, options);
		});
		const record = await create();
		expect(record.preparation).toBe('failed');
		expect(record.current).toBeUndefined();
		const failedRuntime = record.runtime_ids[0];
		expect(await api.bucket.get(paths.project(pid).notebook(failedRuntime).meta)).not.toBeNull();
		writes.mockRestore();
		const recovered = await api.deps.services.previews.reconcile(
			record,
			api.deps.sourceControl,
			true,
		);
		expect(recovered.preparation).toBe('ready');
		expect(recovered.current?.notebook_id).not.toBe(failedRuntime);
		await sweepPreviews(api.deps);
		expect(
			(await api.bucket.list({ prefix: paths.project(pid).notebook(failedRuntime).base })).objects,
		).toEqual([]);
	});

	it('retains an old revision until its running editor is stopped and reclaimed', async () => {
		const record = await create();
		const session = await expectOk<Session>(
			await api.request('POST', `${base}/${record.id}/sessions`, { mode: 'edit' }),
		);
		head = NEXT;
		const updated = await api.deps.services.previews.reconcile(
			record,
			api.deps.sourceControl,
			true,
		);
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).runtime_ids).toContain(
			session.notebook_id,
		);
		const sessionPath = `/projects/${pid}/notebooks/${session.notebook_id}/sessions/${session.session_id}`;
		const stillRunning = await expectOk<Session>(
			await api.request('POST', `${sessionPath}/heartbeat`),
		);
		expect(stillRunning.status).toBe('running');
		expect(stillRunning.source_version_id).toBe(record.current!.version_id);
		await expectOk(await api.request('DELETE', sessionPath));
		await sweepPreviews(api.deps);
		expect((await api.deps.services.previews.get(pid, nid, record.id)).runtime_ids).toEqual([
			updated.current!.notebook_id,
		]);
		expect(await api.bucket.get(paths.project(pid).notebook(session.notebook_id).meta)).toBeNull();
	});
});
