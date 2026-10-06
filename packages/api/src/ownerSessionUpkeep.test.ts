import { describe, expect, it } from 'vitest';
import { createServices, emptySessionNetwork, SandboxId } from '@marimo-hub/core';
import type {
	ManagedSessionEnvironment,
	ProjectId,
	ProjectIntegrationsService,
	SandboxInstance,
	SandboxProvider,
	SessionId,
	SessionRender,
} from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { attendOwnerSession, environmentRefreshAt } from './ownerSessionUpkeep';
import { createInitializedBucket, makeTestDeps } from './testing';

const HOUR = 3_600_000;
const SANDBOX = SandboxId.parse('sb-0123456789abcdef');

function render(expiresAt: number, key: string): SessionRender {
	return {
		files: [],
		vars: { AWS_ACCESS_KEY_ID: key },
		attachments: [],
		warnings: [],
		network: {
			...emptySessionNetwork(),
			aws: [
				{
					services: ['s3'],
					region: 'us-east-1',
					accessKeyId: key,
					secretAccessKey: 'SK',
					expiresAt: new Date(expiresAt).toISOString(),
					credentialVars: ['AWS_ACCESS_KEY_ID'],
					endpointVars: [],
				},
			],
		},
	};
}

describe('environmentRefreshAt', () => {
	it('is at 80% of the remaining credential life, and at least 30 seconds away', () => {
		const now = Date.UTC(2026, 9, 5, 12);
		expect(environmentRefreshAt(render(now + HOUR, 'A'), now)).toBe(
			new Date(now + 0.8 * HOUR).toISOString(),
		);
		expect(environmentRefreshAt(render(now + 10_000, 'A'), now)).toBe(
			new Date(now + 30_000).toISOString(),
		);
		expect(environmentRefreshAt({ vars: {} }, now)).toBeUndefined();
	});
});

describe('attendOwnerSession', () => {
	async function setup(options: { requestCredentials?: boolean } = {}) {
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		const pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const created = await services.sessions.createSession({
			notebook_id: notebook.id,
			project_id: pid,
			user_id: ACTOR,
			sandbox_id: SANDBOX,
			editor_sandbox_sharing: 'exclusive',
		});
		const sid = created.session_id as SessionId;
		await services.sessions.setRunning(pid, sid, '/proxy/x/', false, 'http://kira/proxy/');
		await services.sessions.scheduleEnvironmentRefresh(
			pid,
			sid,
			new Date(Date.now() - 1000).toISOString(),
		);

		const applied: ManagedSessionEnvironment[] = [];
		const instance = {
			applyEnvironment: async (environment: ManagedSessionEnvironment) => {
				applied.push(environment);
			},
		} as unknown as SandboxInstance;
		const compute = {
			capabilities: {
				multiPort: false,
				managedEnvironment: true,
				sessionEnvironment: true,
				requestCredentials: options.requestCredentials ?? true,
			},
			create: () => instance,
			proxy: async () => null,
		} as SandboxProvider;
		let rendered = 0;
		const integrations = {
			resolveForSession: async () => render(Date.now() + HOUR, `KEY${++rendered}`),
		} as unknown as ProjectIntegrationsService;
		const background: Promise<unknown>[] = [];
		const deps = makeTestDeps(bucket, {
			services,
			compute,
			integrations,
			backgroundTasks: { defer: (task) => background.push(task) },
		});
		const attend = async (userId = ACTOR) => {
			attendOwnerSession(deps, {
				project,
				user: { id: userId, email: `${userId}@example.com` },
				session: await services.sessions.getSession(pid, sid),
			});
			await Promise.all(background.splice(0));
		};
		const record = () => services.sessions.getSession(pid, sid);
		return { attend, applied, record };
	}

	it("sends a due environment again within the owner's request and schedules the next", async () => {
		const { attend, applied, record } = await setup();
		const before = Date.now();

		await attend();

		expect(applied).toHaveLength(1);
		expect(applied[0].vars.AWS_ACCESS_KEY_ID).toBe('KEY1');
		expect(applied[0].network.aws[0].accessKeyId).toBe('KEY1');
		const next = Date.parse((await record()).environment_refresh_at!);
		expect(next).toBeGreaterThanOrEqual(before + 0.8 * HOUR - 1000);

		// Not due again yet.
		await attend();
		expect(applied).toHaveLength(1);
	});

	it('does nothing for a request from anyone else', async () => {
		const { attend, applied, record } = await setup();

		await attend(uid('user_other'));

		expect(applied).toEqual([]);
		expect(Date.parse((await record()).environment_refresh_at!)).toBeLessThan(Date.now());
	});

	it('leaves sessions on backends the sweeps keep to the sweeps', async () => {
		const { attend, applied } = await setup({ requestCredentials: false });

		await attend();

		expect(applied).toEqual([]);
	});
});
