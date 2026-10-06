import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { ExternalKernelCompute, ExternalKernelRouter } from '@marimo-hub/compute-external-kernel';
import { createServices, paths, ProxyExposure, signProxyToken } from '@marimo-hub/core';
import type { Authenticator, ProjectId, SessionId, UserId } from '@marimo-hub/core';
import { ACTOR, makeFakeCompute, uid } from '@marimo-hub/core/testing';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const AUTHOR_EMAIL = `${ACTOR}@example.com`.toLowerCase();
const VIEWER = uid('user_viewer');
const VIEWER_EMAIL = 'viewer@example.com';
const CODE = 'import marimo as mo\napp = mo.App()\n';

function jwt(email: string): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'RS256' })}.${part({ email, exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
}

const viewerToken = jwt(VIEWER_EMAIL);
const authorToken = jwt(AUTHOR_EMAIL);

function authAs(id: UserId, email: string): Authenticator {
	return { authenticate: async () => ({ id, email, credential: { kind: 'sso' as const } }) };
}

interface Seen {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: string;
}

describe("apps in their author's kernel runtime, through a fake kernel service", () => {
	let kira: Server;
	let baseUrl: string;
	const seen: Seen[] = [];
	/** Authors with a kernel; anyone else gets `no_kernel`. */
	const kernels = new Set<string>();

	beforeAll(async () => {
		kira = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const url = new URL(req.url ?? '/', 'http://kira');
				const path = url.pathname.replace('/api/external-kernel/v1', '');
				const body = Buffer.concat(chunks).toString();
				seen.push({ method: req.method ?? '', path, headers: req.headers, body });
				if (req.method === 'POST' && path === '/apps/sessions') {
					if (!kernels.has(String(req.headers['x-external-kernel-owner']))) {
						res.writeHead(404, { 'content-type': 'application/json' });
						res.end('{"error":{"code":"no_kernel"}}');
						return;
					}
					res.writeHead(201, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ session: (JSON.parse(body) as { session: string }).session }));
					return;
				}
				if (path.includes('/proxy/')) {
					res.writeHead(200, { 'content-type': 'text/html' });
					res.end('<html>marimo app</html>');
					return;
				}
				res.writeHead(req.method === 'DELETE' ? 204 : 404);
				res.end();
			});
		});
		await new Promise<void>((resolve) => kira.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(kira.address() as AddressInfo).port}/api/external-kernel/v1`;
	});

	afterAll(() => new Promise<void>((resolve) => kira.close(() => resolve())));

	beforeEach(() => {
		seen.length = 0;
		kernels.clear();
		kernels.add(AUTHOR_EMAIL);
	});

	async function setup(enrolled: readonly string[] = [AUTHOR_EMAIL]) {
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		const pid = project.id as ProjectId;
		await services.projects.addMember(pid, { user_id: VIEWER }, 'editor', ACTOR);
		await services.identities.upsert({ id: ACTOR, email: AUTHOR_EMAIL });
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: CODE },
			ACTOR,
		);
		const fallback = makeFakeCompute();
		const fallbackCreate = vi.spyOn(fallback, 'create');
		const compute = new ExternalKernelRouter(new ExternalKernelCompute({ baseUrl }), fallback, {
			enrolledUsers: enrolled,
		});
		const api = (id: UserId, email: string) =>
			createApi(
				makeTestDeps(bucket, {
					services,
					compute,
					authenticator: authAs(id, email),
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						exposure: new ProxyExposure(SECRET),
					},
				}),
			);
		const viewerApi = api(VIEWER, VIEWER_EMAIL);
		const authorApi = api(ACTOR, AUTHOR_EMAIL);
		const sessionsUrl = `http://hub.example/api/v1/projects/${pid}/notebooks/${notebook.id}/sessions`;
		const open = () =>
			viewerApi.fetch(
				new Request(sessionsUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-pantheon-bearer': viewerToken },
					body: JSON.stringify({ mode: 'app', app_visit_id: 'tab-1' }),
				}),
			);
		return {
			bucket,
			services,
			pid,
			nid: notebook.id,
			fallbackCreate,
			viewerApi,
			authorApi,
			sessionsUrl,
			open,
		};
	}

	it("starts one session for the viewer with the viewer's token, serves it, and closes it on leave", async () => {
		const { bucket, services, pid, nid, viewerApi, authorApi, sessionsUrl, open, fallbackCreate } =
			await setup();

		const res = await open();
		expect(res.status).toBeLessThan(300);
		const { data } = (await res.json()) as {
			data: {
				session_id: SessionId;
				status: string;
				app_assignment: { visit_id: string; generation: string };
			};
		};
		expect(data.status).toBe('running');
		expect(fallbackCreate).not.toHaveBeenCalled();

		const [start] = seen;
		expect(start.method).toBe('POST');
		expect(start.path).toBe('/apps/sessions');
		expect(start.headers.authorization).toBe(`Bearer ${viewerToken}`);
		expect(start.headers['x-external-kernel-owner']).toBe(AUTHOR_EMAIL);
		const sent = JSON.parse(start.body) as {
			session: string;
			app: string;
			notebook: string;
			files: { path: string; contentBase64: string }[];
			environment: Record<string, unknown>;
		};
		expect(sent.app).toBe(nid);
		expect(sent.notebook).toBe('notebook.py');
		expect(sent.session).toBe(data.app_assignment.generation);
		const notebookFile = sent.files.find((file) => file.path === 'notebook.py')!;
		expect(Buffer.from(notebookFile.contentBase64, 'base64').toString()).toBe(CODE);
		const stored = await services.sessions.getSession(pid, data.session_id);
		expect(stored).toMatchObject({
			mode: 'app',
			user_id: VIEWER,
			compute_backend: 'external-kernel-app',
		});
		expect(stored.app_pool).toBeUndefined();

		// The viewer reaches it through the hub's proxy with their own token; nobody else does.
		const token = await signProxyToken(pid, data.session_id, SECRET);
		seen.length = 0;
		const page = await viewerApi.fetch(
			new Request(`http://hub.example/proxy/${token}/`, {
				headers: { 'x-pantheon-bearer': viewerToken, cookie: 'hub=secret' },
			}),
		);
		expect(page.status).toBe(200);
		expect(await page.text()).toBe('<html>marimo app</html>');
		expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
			`GET /apps/sessions/${sent.session}/proxy/`,
		]);
		expect(seen[0].headers.authorization).toBe(`Bearer ${viewerToken}`);
		expect(seen[0].headers.cookie).toBeUndefined();
		seen.length = 0;
		const other = await authorApi.fetch(
			new Request(`http://hub.example/proxy/${token}/`, {
				headers: { 'x-pantheon-bearer': authorToken },
			}),
		);
		expect(other.status).not.toBe(200);
		expect(seen).toEqual([]);

		// Heartbeats keep it alive without ever making it a pool member.
		const heartbeat = await viewerApi.fetch(
			new Request(`${sessionsUrl}/${data.session_id}/heartbeat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-pantheon-bearer': viewerToken },
				body: JSON.stringify(data.app_assignment),
			}),
		);
		expect(heartbeat.status).toBe(200);
		expect(await bucket.get(paths.appPool(pid, nid))).toBeNull();
		seen.length = 0;

		const leave = await viewerApi.fetch(
			new Request(`${sessionsUrl}/${data.session_id}/leave`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-pantheon-bearer': viewerToken },
				body: JSON.stringify(data.app_assignment),
			}),
		);
		expect(leave.status).toBe(200);
		expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
			`DELETE /apps/sessions/${sent.session}`,
		]);
		expect(seen[0].headers.authorization).toBe(`Bearer ${viewerToken}`);
		const closed = await services.sessions.getSession(pid, data.session_id);
		expect(closed.status).toBe('terminated');
		expect(closed.sandbox_reclaimed_at).toBeDefined();
	});

	it("lets someone else end the session in the hub, and closes it at the viewer's next request", async () => {
		const { services, pid, viewerApi, authorApi, sessionsUrl, open } = await setup();
		const { data } = (await (await open()).json()) as {
			data: { session_id: SessionId; app_assignment: { visit_id: string; generation: string } };
		};
		seen.length = 0;

		const stop = await authorApi.fetch(
			new Request(`${sessionsUrl}/${data.session_id}`, {
				method: 'DELETE',
				headers: { 'x-pantheon-bearer': authorToken },
			}),
		);

		expect(stop.status).toBe(200);
		expect(seen).toEqual([]);
		const ended = await services.sessions.getSession(pid, data.session_id);
		expect(ended.status).toBe('terminated');
		expect(ended.sandbox_reclaimed_at).toBeUndefined();

		await viewerApi.fetch(
			new Request(`${sessionsUrl}/${data.session_id}/heartbeat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-pantheon-bearer': viewerToken },
				body: JSON.stringify(data.app_assignment),
			}),
		);
		await vi.waitFor(async () =>
			expect(
				(await services.sessions.getSession(pid, data.session_id)).sandbox_reclaimed_at,
			).toBeDefined(),
		);
		expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
			`DELETE /apps/sessions/${data.app_assignment.generation}`,
		]);
		expect(seen[0].headers.authorization).toBe(`Bearer ${viewerToken}`);
	});

	it("uses the hub's app pool when the author has no kernel", async () => {
		kernels.clear();
		const { open, fallbackCreate } = await setup();

		expect((await open()).status).toBeLessThan(300);

		expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /apps/sessions']);
		expect(fallbackCreate).toHaveBeenCalled();
	});

	it('never contacts the kernel service for an author who is not enrolled', async () => {
		const { open, fallbackCreate } = await setup(['someone-else@example.com']);

		expect((await open()).status).toBeLessThan(300);

		expect(seen).toEqual([]);
		expect(fallbackCreate).toHaveBeenCalled();
	});
});
