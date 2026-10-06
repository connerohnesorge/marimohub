import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { ExternalKernelCompute } from '@marimo-hub/compute-external-kernel';
import {
	createServices,
	paths,
	ProxyExposure,
	SandboxId,
	SessionLifecycleService,
} from '@marimo-hub/core';
import type { Authenticator, NotebookId, ProjectId, SessionId, UserId } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const SANDBOX = SandboxId.parse('sb-0123456789abcdef');
const ADMIN = uid('user_admin');
const OWNER_EMAIL = `${ACTOR}@example.com`;
const ADMIN_EMAIL = 'admin@example.com';

function jwt(email: string): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'RS256' })}.${part({ email, exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
}

const ownerToken = jwt(OWNER_EMAIL);
const SAVED_NOTEBOOK = 'import marimo as mo\n# saved by the kernel service before the stop\n';
const adminToken = jwt(ADMIN_EMAIL);

function authAs(id: UserId, email: string): Authenticator {
	return { authenticate: async () => ({ id, email, credential: { kind: 'sso' as const } }) };
}

interface Seen {
	method: string;
	url: URL;
	headers: IncomingHttpHeaders;
}

describe("a super admin stopping another user's external-kernel session", () => {
	let kira: Server;
	let baseUrl: string;
	/** Every request the hub makes to the external kernel service, in order. */
	const seen: Seen[] = [];
	const kiraAdmins = new Set<string>();

	beforeAll(async () => {
		kira = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://kira');
			seen.push({ method: req.method ?? '', url, headers: req.headers });
			const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
			const claims = bearer
				? (JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()) as {
						email?: string;
					})
				: {};
			if (url.pathname.endsWith('/admin/kernels/stop')) {
				const admitted = kiraAdmins.has(claims.email ?? '');
				res.writeHead(admitted ? 204 : 403, { 'content-type': 'application/json' });
				res.end(admitted ? undefined : '{"error":{"code":"forbidden"}}');
				return;
			}
			// The workspace after the admin stop: the notebook as the service saved it.
			if (url.pathname.endsWith('/list')) {
				const size = Buffer.byteLength(SAVED_NOTEBOOK);
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify(
						url.searchParams.get('path')
							? { entries: [] }
							: { entries: [{ path: 'notebook.py', type: 'file', size }] },
					),
				);
				return;
			}
			if (url.pathname.endsWith('/files')) {
				const found = url.searchParams.get('path') === 'notebook.py';
				res.writeHead(found ? 200 : 404, { 'content-type': 'application/octet-stream' });
				res.end(found ? SAVED_NOTEBOOK : '{"error":{"code":"not_found"}}');
				return;
			}
			if (req.method === 'DELETE') {
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"ready":true}');
		});
		await new Promise<void>((resolve) => kira.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(kira.address() as AddressInfo).port}/api/external-kernel/v1`;
	});

	afterAll(() => new Promise<void>((resolve) => kira.close(() => resolve())));

	beforeEach(() => {
		seen.length = 0;
		kiraAdmins.clear();
	});

	async function runningSession() {
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		const pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const session = await services.sessions.createSession({
			notebook_id: notebook.id,
			project_id: pid,
			user_id: ACTOR,
			sandbox_id: SANDBOX,
			editor_sandbox_sharing: 'exclusive',
		});
		const originUrl = `${baseUrl}/workspaces/${SANDBOX}/proxy/?file=notebook.py`;
		await services.sessions.setRunning(pid, session.session_id, '/proxy/x/', false, originUrl);
		const compute = new ExternalKernelCompute({
			baseUrl,
			ownerEmail: async (id) => (id === ACTOR ? OWNER_EMAIL : undefined),
		});
		// The owner used their kernel, so the hub holds their token for background work.
		await compute.withEndUserRequest(
			new Request('http://hub.example/api/v1/x', { headers: { 'x-pantheon-bearer': ownerToken } }),
			{ userId: ACTOR, email: OWNER_EMAIL },
			() => compute.create(SANDBOX, { owner: { projectId: pid, userId: ACTOR } }).ready!(),
		);
		seen.length = 0;
		const app = createApi(
			makeTestDeps(bucket, {
				compute,
				authenticator: authAs(ADMIN, ADMIN_EMAIL),
				policy: { superAdmins: [ADMIN_EMAIL], editorSandboxSharing: 'exclusive' },
				sandbox: {
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					exposure: new ProxyExposure(SECRET),
				},
			}),
		);
		const stop = () =>
			app.fetch(
				new Request(
					`http://hub.example/api/v1/projects/${pid}/notebooks/${notebook.id as NotebookId}/sessions/${session.session_id}`,
					{ method: 'DELETE', headers: { 'x-pantheon-bearer': adminToken } },
				),
			);
		const status = async () =>
			(await services.sessions.getSession(pid, session.session_id as SessionId)).status;
		const sweep = () =>
			new SessionLifecycleService(services.sessions, services.notebooks, compute, bucket, {
				idleTimeoutMsByMode: { edit: 3_600_000, app: 3_600_000 },
				snapshotIntervalMs: 0,
				extensionMs: 0,
				connectionAware: false,
				persistWorkspace: 'source',
				automaticThumbnails: false,
				workdir: '/workspace',
			}).sweep();
		const savedCode = async () =>
			(
				await bucket.get(paths.project(pid).notebook(notebook.id).workspaceFile('notebook.py'))
			)?.text();
		return { compute, stop, status, sweep, savedCode };
	}

	it('calls only the admin stop route, with the admin token', async () => {
		kiraAdmins.add(ADMIN_EMAIL);
		const { compute, stop, status, sweep, savedCode } = await runningSession();

		const res = await stop();

		expect(res.status).toBe(200);
		expect(await status()).toBe('terminated');
		expect(seen.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
			'POST /api/external-kernel/v1/admin/kernels/stop',
		]);
		expect(seen[0].url.searchParams.get('owner')).toBe(OWNER_EMAIL.toLowerCase());
		expect(seen[0].url.searchParams.get('workspace')).toBe(SANDBOX);
		expect(seen[0].headers.authorization).toBe(`Bearer ${adminToken}`);

		// Background work, outside any request, captures what the service saved
		// with the owner's own token, then removes the workspace.
		seen.length = 0;
		await sweep();
		expect(await savedCode()).toBe(SAVED_NOTEBOOK);
		expect(seen.map(({ method, url }) => `${method} ${url.pathname.split('/').at(-1)}`)).toEqual(
			expect.arrayContaining(['GET list', 'GET files', `DELETE ${SANDBOX}`]),
		);
		expect(new Set(seen.map(({ headers }) => headers.authorization))).toEqual(
			new Set([`Bearer ${ownerToken}`]),
		);
		expect(seen.at(-1)?.method).toBe('DELETE');
		await compute[Symbol.asyncDispose]();
	});

	it("keeps the session running and never falls back to the owner's token when refused", async () => {
		const { compute, stop, status } = await runningSession();

		const res = await stop();

		expect(res.status).toBe(403);
		expect(await status()).toBe('running');
		expect(seen.map(({ headers }) => headers.authorization)).toEqual([`Bearer ${adminToken}`]);
		await compute[Symbol.asyncDispose]();
	});
});
