import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServices, ForbiddenError } from '@marimo-hub/core';
import type {
	EndUserPrincipal,
	MarimoLaunchSpec,
	NotebookId,
	ProjectId,
	SandboxInstance,
	SandboxProvider,
	Session,
	SessionId,
} from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFakeSandbox, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import type { ApiDeps } from '../context';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const PERSONAL = 'personal';
const STRANGER = uid('user_stranger');

/**
 * A routing provider over two fakes: `personal` is a managed-environment
 * kernel, the default is a regular sandbox backend.
 */
function routedCompute(select: (owner: EndUserPrincipal) => Promise<string | undefined>) {
	const regular = makeFakeSandbox();
	const regularProvider = fakeComputeFrom(regular.instance, {
		capabilities: { multiPort: true },
	});
	const managed = makeFakeSandbox();
	const launches: MarimoLaunchSpec[] = [];
	const personalInstance: SandboxInstance = {
		...managed.instance,
		supportsBucketMount: false,
		ready: async () => {},
		exec: vi.fn(async () => {
			throw new Error('exec must not run in a managed kernel');
		}),
		launchMarimo: async (spec) => {
			launches.push(spec);
		},
		ensureDirectories: async () => {},
		destroy: vi.fn(async () => {
			managed.calls.destroy++;
		}),
	};
	const personalProvider = fakeComputeFrom(personalInstance, {
		capabilities: { multiPort: false, managedEnvironment: true, exclusiveEditors: true },
	});
	const regularCreate = vi.spyOn(regularProvider, 'create');
	const personalCreate = vi.spyOn(personalProvider, 'create');
	const selectEditBackend = vi.fn(select);
	const compute: SandboxProvider = {
		capabilities: regularProvider.capabilities,
		create: (id, options) => regularProvider.create(id, options),
		proxy: async () => null,
		routing: {
			selectEditBackend,
			backend: (name) => {
				if (name === undefined) return regularProvider;
				if (name === PERSONAL) return personalProvider;
				throw new Error(`unknown backend ${name}`);
			},
		},
	};
	return {
		compute,
		selectEditBackend,
		regular: { calls: regular.calls, create: regularCreate },
		personal: {
			calls: managed.calls,
			create: personalCreate,
			launches,
			instance: personalInstance,
		},
	};
}

describe('Session start on a routing compute provider', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;
	});

	async function storedSession(id: string): Promise<Session> {
		return createServices(bucket).sessions.getSession(pid, id as SessionId);
	}

	it('runs an edit session on the backend chosen for the caller and records it', async () => {
		const routed = routedCompute(async () => PERSONAL);
		const { request } = createTestApi({ bucket, userId: ACTOR, compute: routed.compute });

		const data = await expectOk<Session>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);

		expect(data.status).toBe('running');
		expect(routed.selectEditBackend).toHaveBeenCalledWith({
			userId: ACTOR,
			email: `${ACTOR}@example.com`,
		});
		expect((await storedSession(data.session_id)).compute_backend).toBe(PERSONAL);
		expect(routed.personal.launches).toHaveLength(1);
		expect(routed.regular.create).not.toHaveBeenCalled();

		await expectOk(
			await request('DELETE', `/projects/${pid}/notebooks/${nid}/sessions/${data.session_id}`),
		);
		expect(routed.personal.calls.destroy).toBe(1);
		expect(routed.regular.create).not.toHaveBeenCalled();
	});

	it('runs the session on the default backend when no backend is chosen', async () => {
		const routed = routedCompute(async () => {});
		const { request } = createTestApi({ bucket, userId: ACTOR, compute: routed.compute });

		const data = await expectOk<Session>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);

		expect(data.status).toBe('running');
		expect((await storedSession(data.session_id)).compute_backend).toBeUndefined();
		expect(routed.regular.calls.startProcess).toHaveLength(1);
		expect(routed.personal.create).not.toHaveBeenCalled();
	});

	it('fails the start without provisioning anywhere when the choice fails', async () => {
		const routed = routedCompute(async () => {
			throw new ForbiddenError('owner_mismatch');
		});
		const { request } = createTestApi({ bucket, userId: ACTOR, compute: routed.compute });

		const res = await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`);

		expect(res.status).toBe(403);
		expect(routed.regular.create).not.toHaveBeenCalled();
		expect(routed.personal.create).not.toHaveBeenCalled();
		expect(await createServices(bucket).sessions.listActiveByProject(pid)).toEqual([]);
	});

	it('never starts a surface in a routed kernel that cannot expose one', async () => {
		const routed = routedCompute(async () => PERSONAL);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const { request } = createTestApi({
				bucket,
				userId: ACTOR,
				compute: routed.compute,
				deps: {
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						surfaces: {
							vscode: {
								flavor: 'code-server',
								start: 'eager',
								port: 8443,
								settings: {},
								extensionGallery: 'openvsx',
								embed: 'tab',
							},
						},
					},
				},
			});

			const data = await expectOk<Session>(
				await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`, {
					surfaces: ['vscode'],
				}),
			);

			expect(data.status).toBe('running');
			expect(data.surfaces?.vscode).toBeUndefined();
			const started = await request(
				'POST',
				`/projects/${pid}/notebooks/${nid}/sessions/${data.session_id}/surfaces/vscode`,
			);
			expect(started.status).toBe(409);
			expect(((await started.json()) as { error: { code: string } }).error.code).toBe(
				'SURFACE_UNSUPPORTED_PROVIDER',
			);
			expect(routed.personal.calls.startProcess).toEqual([]);
			expect(routed.regular.create).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
});

describe("Another user's session in a personal kernel", () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;
	});

	function apis() {
		const routed = routedCompute(async () => PERSONAL);
		const deps: Partial<ApiDeps> = {
			// Exclusive editors: only a manager or above, here a super admin, may stop another's.
			policy: { editorSandboxSharing: 'exclusive', defaultRole: 'editor', superAdmins: [STRANGER] },
		};
		const owner = createTestApi({ bucket, userId: ACTOR, compute: routed.compute, deps });
		const other = createTestApi({ bucket, userId: STRANGER, compute: routed.compute, deps });
		return { routed, owner: owner.request, other: other.request };
	}

	const sessionsPath = (suffix = '') => `/projects/${pid}/notebooks/${nid}/sessions${suffix}`;

	it("stops it through the provider alone and keeps the saved workspace for the owner's capture", async () => {
		const { routed, owner, other } = apis();
		const started = await expectOk<Session>(await owner('POST', sessionsPath()));
		routed.personal.calls.readFile.length = 0;

		await expectOk(await other('DELETE', sessionsPath(`/${started.session_id}`)));

		expect(routed.personal.instance.destroy).toHaveBeenCalledOnce();
		expect(routed.personal.calls.readFile).toEqual([]);
		const services = createServices(bucket);
		const stored = await services.sessions.getSession(pid, started.session_id as SessionId);
		expect(stored.status).toBe('terminated');
		expect(stored.admin_stopped_at).toBeDefined();
		// Not reclaimed: the claim holds the notebook until the workspace is captured.
		expect(stored.sandbox_reclaimed_at).toBeUndefined();
		expect((await services.sessions.getEditorClaim(pid, nid))?.session_id).toBe(started.session_id);
	});

	it("captures the stopped workspace with the owner's own request before a new start", async () => {
		const { routed, owner, other } = apis();
		const started = await expectOk<Session>(await owner('POST', sessionsPath()));
		await expectOk(await other('DELETE', sessionsPath(`/${started.session_id}`)));
		routed.personal.calls.readFile.length = 0;
		vi.mocked(routed.personal.instance.destroy).mockClear();

		const restarted = await expectOk<Session>(await owner('POST', sessionsPath()));

		expect(restarted.session_id).not.toBe(started.session_id);
		// The capture read the saved notebook, then the old workspace was destroyed.
		expect(routed.personal.calls.readFile).toContain('/workspace/notebook.py');
		expect(routed.personal.instance.destroy).toHaveBeenCalledOnce();
		const old = await createServices(bucket).sessions.getSession(
			pid,
			started.session_id as SessionId,
		);
		expect(old.sandbox_reclaimed_at).toBeDefined();
	});

	it("stops another user's live temporary session through the provider when the notebook is deleted", async () => {
		const { routed, owner, other } = apis();
		await expectOk<Session>(await owner('POST', sessionsPath()));
		const temporary = await expectOk<Session>(
			await other('POST', sessionsPath(), { edit_intent: 'temporary' }),
		);
		vi.mocked(routed.personal.instance.destroy).mockClear();

		await expectOk(await owner('DELETE', `/projects/${pid}/notebooks/${nid}`));

		expect(routed.personal.instance.destroy).toHaveBeenCalledOnce();
		const stored = await createServices(bucket).sessions.getSession(
			pid,
			temporary.session_id as SessionId,
		);
		expect(stored.status).toBe('terminated');
		expect(stored.admin_stopped_at).toBeDefined();
	});

	it('leaves it running when the provider refuses the stop', async () => {
		const { routed, owner, other } = apis();
		const started = await expectOk<Session>(await owner('POST', sessionsPath()));
		vi.mocked(routed.personal.instance.destroy).mockRejectedValueOnce(
			new ForbiddenError('only its administrators can stop it'),
		);

		await expectError(
			await other('DELETE', sessionsPath(`/${started.session_id}`)),
			403,
			'FORBIDDEN',
		);

		const stored = await createServices(bucket).sessions.getSession(
			pid,
			started.session_id as SessionId,
		);
		expect(stored.status).toBe('running');
	});

	it('is never offered for takeover and refuses one', async () => {
		const { routed, owner, other } = apis();
		const started = await expectOk<Session>(await owner('POST', sessionsPath()));
		const editorPath = `/projects/${pid}/notebooks/${nid}/editor-session`;

		const state = await expectOk<{
			can_take_over: boolean;
			holder: { activity: { state: string } };
		}>(await other('GET', editorPath));
		expect(state.can_take_over).toBe(false);
		await expectError(
			await other('POST', `${editorPath}/takeover`, {
				takeover_id: 'takeover-personal-1',
				expected_holder_session_id: started.session_id,
				expected_activity: state.holder.activity.state,
				acknowledge_disruption: true,
			}),
			403,
			'FORBIDDEN',
		);

		const stored = await createServices(bucket).sessions.getSession(
			pid,
			started.session_id as SessionId,
		);
		expect(stored.status).toBe('running');
		expect(routed.personal.instance.destroy).not.toHaveBeenCalled();
	});
});

describe('Editor sharing on a routing compute provider', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let nid: NotebookId;
	const sessionsPath = () => `/projects/${pid}/notebooks/${nid}/sessions`;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;
	});

	/** ACTOR has a personal kernel; STRANGER does not. The deployment shares editors. */
	function apis() {
		const routed = routedCompute(async (owner) => (owner.userId === ACTOR ? PERSONAL : undefined));
		const deps: Partial<ApiDeps> = {
			policy: { editorSandboxSharing: 'shared', defaultRole: 'editor' },
		};
		return {
			routed,
			withKernel: createTestApi({ bucket, userId: ACTOR, compute: routed.compute, deps }).request,
			withoutKernel: createTestApi({ bucket, userId: STRANGER, compute: routed.compute, deps })
				.request,
		};
	}

	type Started = Session & { editor_session: { sharing: string; access: string } };

	it('keeps shared editing for users on the regular backend', async () => {
		const { withoutKernel, routed } = apis();
		const first = await expectOk<Started>(await withoutKernel('POST', sessionsPath()));

		expect(first.editor_session).toEqual({ sharing: 'shared', access: 'shared' });
		expect((await createServices(bucket).sessions.getEditorClaim(pid, nid))?.sharing).toBe(
			'shared',
		);
		expect(routed.personal.create).not.toHaveBeenCalled();
	});

	it('lets a user with a kernel join an editor already shared on the regular backend', async () => {
		const { withKernel, withoutKernel, routed } = apis();
		const shared = await expectOk<Started>(await withoutKernel('POST', sessionsPath()));

		const joined = await expectOk<Started & { reused: boolean }>(
			await withKernel('POST', sessionsPath()),
		);

		expect(joined.reused).toBe(true);
		expect(joined.session_id).toBe(shared.session_id);
		expect(routed.personal.create).not.toHaveBeenCalled();
	});

	it('claims an external-kernel editor exclusively, so others cannot share it', async () => {
		const { withKernel, withoutKernel } = apis();
		const personal = await expectOk<Started>(await withKernel('POST', sessionsPath()));

		expect(personal.editor_session).toEqual({ sharing: 'exclusive', access: 'owner' });
		const stored = await createServices(bucket).sessions.getSession(
			pid,
			personal.session_id as SessionId,
		);
		expect(stored.editor_sandbox_sharing).toBe('exclusive');
		expect((await createServices(bucket).sessions.getEditorClaim(pid, nid))?.sharing).toBe(
			'exclusive',
		);
		await expectError(await withoutKernel('POST', sessionsPath()), 409, 'EDIT_SESSION_OWNED');
		const temporary = await expectOk<Started>(
			await withoutKernel('POST', sessionsPath(), { edit_intent: 'temporary' }),
		);
		expect(temporary.editor_session.access).toBe('temporary');
		expect(temporary.user_id).toBe(STRANGER);
	});
});
