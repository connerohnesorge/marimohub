import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServices } from '@marimo-hub/core';
import type {
	MarimoLaunchSpec,
	NotebookId,
	ProjectId,
	SandboxInstance,
	SandboxProvider,
	Session,
	SessionId,
} from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFakeSandbox } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import type { ApiDeps } from '../context';
import { createInitializedBucket, createTestApi, expectOk } from '../testing';

describe('Session start on a managed-environment compute provider', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		pid = project.id as ProjectId;
		await services.projects.updateProject(pid, { federation: { enabled: true } }, ACTOR);
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;
	});

	function managedCompute(): {
		compute: SandboxProvider;
		instance: SandboxInstance;
		calls: ReturnType<typeof makeFakeSandbox>['calls'];
		launches: MarimoLaunchSpec[];
	} {
		const { instance, calls } = makeFakeSandbox();
		const launches: MarimoLaunchSpec[] = [];
		const managed: SandboxInstance = {
			...instance,
			supportsBucketMount: false,
			ready: async () => {},
			exec: vi.fn(async () => {
				throw new Error('exec must not run');
			}),
			launchMarimo: async (spec) => {
				launches.push(spec);
			},
			ensureDirectories: async () => {},
		};
		const compute = fakeComputeFrom(managed, {
			capabilities: { multiPort: false, managedEnvironment: true },
		});
		return { compute, instance: managed, calls, launches };
	}

	it('mints no kernel token, AI token, workload identity, or session env', async () => {
		const { compute, instance, calls, launches } = managedCompute();
		const exchange = vi.fn(async () => ({
			accessKeyId: 'CWAK',
			secretAccessKey: 'sk',
			sessionToken: 'tok',
		}));
		const deps = {
			ai: {
				upstreamBaseUrl: 'https://provider.example/v1',
				upstreamApiKey: 'real-upstream-key',
				model: 'gpt-test',
				signingSecret: 'test-signing-secret',
			},
			wif: {
				issuer: { mint: async () => 'jwt.value', jwks: async () => ({ keys: [] }) },
				issuerUrl: 'https://hub.example.com',
				target: {
					broker: { exchange },
					audience: 'object-storage',
					storage: { endpoint: 'https://objects.example', region: 'us-east-1' },
				},
			},
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				auth: 'on',
			},
		} as unknown as Partial<ApiDeps>;
		const request = createTestApi({ bucket, userId: ACTOR, compute, deps }).request;

		const data = await expectOk<Session>(
			await request('POST', `/projects/${pid}/notebooks/${nid}/sessions`),
		);

		expect(data.status).toBe('running');
		const stored = await createServices(bucket).sessions.getSession(
			pid,
			data.session_id as SessionId,
		);
		expect(stored.kernel_auth_token).toBeUndefined();
		expect(exchange).not.toHaveBeenCalled();
		expect(calls.setEnvVars).toEqual([]);
		expect(calls.setEnvDefaults).toEqual([]);
		// Only the notebook workspace is written; no marimo config, credentials, or token file.
		expect(
			calls.writeFiles
				.flat()
				.map((file) => file.path)
				.sort(),
		).toEqual(['/workspace/notebook.py', '/workspace/pyproject.toml']);
		expect(instance.exec).not.toHaveBeenCalled();
		expect(launches).toHaveLength(1);
		expect(launches[0]).toMatchObject({ workdir: '/workspace', notebookFile: 'notebook.py' });
	});
});
