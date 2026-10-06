import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { ExternalKernelCompute, ExternalKernelRouter } from '@marimo-hub/compute-external-kernel';
import { createServices, emptySessionNetwork, ProxyExposure } from '@marimo-hub/core';
import type {
	Authenticator,
	ProjectId,
	ProjectIntegrationsService,
	SessionRender,
} from '@marimo-hub/core';
import { ACTOR, makeFakeCompute } from '@marimo-hub/core/testing';

const EMAIL = `${ACTOR}@example.com`.toLowerCase();
const REFUSAL =
	'The integration "queries" (kind athena) is not available on your Kira kernel yet. Remove it from this project, or ask an admin to move you back to the hub\'s own kernels.';

function jwt(email: string): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'RS256' })}.${part({ email, exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
}

describe('an external-kernel session with an integration the service cannot serve', () => {
	let kira: Server;
	let baseUrl: string;
	const seen: string[] = [];

	beforeAll(async () => {
		kira = createServer((req, res) => {
			req.resume();
			req.on('end', () => {
				const path = new URL(req.url ?? '/', 'http://kira').pathname;
				seen.push(`${req.method} ${path.split('/').at(-1)}`);
				res.writeHead(200, { 'content-type': 'application/json' });
				if (path.endsWith('/kernel')) res.end('{"ready":true}');
				else if (path.endsWith('/list')) res.end('{"entries":[]}');
				else if (path.endsWith('/open')) res.end('{"file":"/home/kira/notebook.py"}');
				else res.end('{}');
			});
		});
		await new Promise<void>((resolve) => kira.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(kira.address() as AddressInfo).port}/api/external-kernel/v1`;
	});

	afterAll(() => new Promise<void>((resolve) => kira.close(() => resolve())));

	it('fails the start with a message naming it, and never falls back to the hub', async () => {
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		const pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const fallback = makeFakeCompute();
		const fallbackCreate = vi.spyOn(fallback, 'create');
		const render: SessionRender = {
			files: [],
			vars: { ATHENA_URL: 'awsathena+rest://@athena.us-east-1.amazonaws.com' },
			attachments: [],
			warnings: [],
			network: {
				...emptySessionNetwork(),
				unrelayable: [
					{
						integration: 'queries',
						kind: 'athena',
						reason: 'ambient AWS credentials do not reach a relayed kernel',
					},
				],
			},
		};
		const authenticator: Authenticator = {
			authenticate: async () => ({ id: ACTOR, email: EMAIL, credential: { kind: 'sso' as const } }),
		};
		const api = createApi(
			makeTestDeps(bucket, {
				services,
				compute: new ExternalKernelRouter(new ExternalKernelCompute({ baseUrl }), fallback),
				authenticator,
				integrations: {
					resolveForSession: async () => render,
				} as unknown as ProjectIntegrationsService,
				sandbox: {
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					exposure: new ProxyExposure('a-test-signing-secret-at-least-32-bytes-long!!'),
				},
			}),
		);

		const res = await api.fetch(
			new Request(`http://hub.example/api/v1/projects/${pid}/notebooks/${notebook.id}/sessions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-pantheon-bearer': jwt(EMAIL) },
				body: '{}',
			}),
		);

		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { message: string } }).error.message).toBe(REFUSAL);
		expect(seen).not.toContain('PUT environment');
		expect(fallbackCreate).not.toHaveBeenCalled();
		const [session] = await services.sessions.listSessions(notebook.id);
		expect(session).toMatchObject({
			status: 'failed',
			compute_backend: 'external-kernel',
			error: { code: 'VALIDATION_ERROR', message: REFUSAL },
		});
	});
});
