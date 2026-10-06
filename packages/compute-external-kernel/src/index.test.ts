import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError, UnavailableError } from '@marimo-hub/core/errors';
import type { NotebookId, ProjectId, SandboxId, UserId } from '@marimo-hub/core/ids';
import type { EndUserPrincipal } from '@marimo-hub/core/ports/sandbox';
import { ExternalKernelCompute } from './index';

const OWNER = 'user-owner' as UserId;
const ADMIN = 'user-admin' as UserId;
const OWNER_EMAIL = 'owner@example.com';
const ADMIN_EMAIL = 'admin@example.com';
const SANDBOX = 'sb-0123456789abcdef' as SandboxId;
const PROJECT = 'proj-0123456789abcdef' as ProjectId;
const NOTEBOOK = 'nb-0123456789abcdef' as NotebookId;
const NOW = Date.UTC(2026, 9, 5, 12);

function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'RS256' })}.${part(claims)}.c2lnbmF0dXJl`;
}

const ownerToken = jwt({ email: OWNER_EMAIL, exp: NOW / 1000 + 3600 });
const ownerLaterToken = jwt({ email: OWNER_EMAIL, exp: NOW / 1000 + 7200 });
const adminToken = jwt({ email: ADMIN_EMAIL, exp: NOW / 1000 + 3600 });

interface Recorded {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
}

/** The external kernel API, keyed by the bearer's email like the real service. */
class FakeKernelService {
	readonly requests: Recorded[] = [];
	readonly files = new Map<string, Uint8Array>();
	readonly workspaces = new Set<string>();
	readonly kernels = new Set([OWNER_EMAIL, ADMIN_EMAIL]);
	readonly admins = new Set([ADMIN_EMAIL]);
	forbidden = new Set<string>();
	ownerMismatch = false;
	private server?: Server;
	baseUrl = '';

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const body = Buffer.concat(chunks);
				this.requests.push({
					method: req.method ?? '',
					url: req.url ?? '',
					headers: req.headers,
					body: body.toString('utf8'),
				});
				this.handle(req.method ?? '', new URL(req.url ?? '/', 'http://kira'), req.headers, body, {
					status: (code, json) => {
						res.writeHead(code, json ? { 'content-type': 'application/json' } : {});
						res.end(json ? JSON.stringify(json) : undefined);
					},
					bytes: (data) => {
						res.writeHead(200, { 'content-type': 'application/octet-stream' });
						res.end(Buffer.from(data));
					},
				});
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/external-kernel/v1`;
	}

	stop(): Promise<void> {
		return new Promise((resolve) => this.server?.close(() => resolve()));
	}

	private handle(
		method: string,
		url: URL,
		headers: IncomingHttpHeaders,
		body: Buffer,
		reply: {
			status: (code: number, json?: unknown) => void;
			bytes: (data: Uint8Array) => void;
		},
	): void {
		const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
		const email = bearer
			? (JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()) as { email: string })
					.email
			: undefined;
		if (!email) return reply.status(401, { error: { code: 'unauthorized' } });
		if (this.ownerMismatch || headers['x-external-kernel-owner'] !== email.toLowerCase()) {
			return reply.status(403, { error: { code: 'owner_mismatch' } });
		}
		if (this.forbidden.has(email)) return reply.status(403, { error: { code: 'forbidden' } });
		const path = url.pathname.replace('/api/external-kernel/v1', '');
		if (method === 'POST' && path === '/admin/kernels/stop') {
			if (!this.admins.has(email)) return reply.status(403, { error: { code: 'forbidden' } });
			return reply.status(204);
		}
		if (!this.kernels.has(email)) return reply.status(404, { error: { code: 'no_kernel' } });
		if (method === 'GET' && path === '/kernel')
			return reply.status(200, { ready: true, user: email });
		const match = /^\/workspaces\/([^/]+)(\/.*)?$/.exec(path);
		if (!match) return reply.status(404, { error: { code: 'not_found' } });
		const [, workspace, rest = ''] = match;
		const key = (rel: string) => `${email}:${workspace}:${rel}`;
		const rel = url.searchParams.get('path') ?? '';
		if (method === 'PUT' && rest === '/files') {
			this.workspaces.add(`${email}:${workspace}`);
			this.files.set(key(rel), new Uint8Array(body));
			return reply.status(204);
		}
		if (method === 'GET' && rest === '/files' && rel === 'slow.bin') {
			setTimeout(() => reply.bytes(new Uint8Array([1])), 500);
			return;
		}
		if (method === 'GET' && rest === '/files') {
			const file = this.files.get(key(rel));
			return file ? reply.bytes(file) : reply.status(404, { error: { code: 'not_found' } });
		}
		if (method === 'GET' && rest === '/list') {
			if (!this.workspaces.has(`${email}:${workspace}`)) {
				return reply.status(404, { error: { code: 'not_found' } });
			}
			const prefix = key(rel ? `${rel}/` : '');
			const entries = new Map<string, { path: string; type: string; size: number }>();
			for (const [stored, data] of this.files) {
				if (!stored.startsWith(prefix)) continue;
				const below = stored.slice(prefix.length);
				const child = below.split('/')[0];
				const childPath = rel ? `${rel}/${child}` : child;
				entries.set(
					childPath,
					below.includes('/')
						? { path: childPath, type: 'directory', size: 0 }
						: { path: childPath, type: 'file', size: data.byteLength },
				);
			}
			if (entries.size === 0 && rel) return reply.status(404, { error: { code: 'not_found' } });
			return reply.status(200, { entries: [...entries.values()] });
		}
		if (method === 'POST' && rest === '/open') {
			const { notebook } = JSON.parse(body.toString()) as { notebook: string };
			return reply.status(200, { file: `/home/kira/workspaces/${workspace}/${notebook}` });
		}
		if (method === 'DELETE' && rest === '') return reply.status(204);
		return reply.status(404, { error: { code: 'not_found' } });
	}
}

const service = new FakeKernelService();
let clock = NOW;
let provider: ExternalKernelCompute;

beforeAll(() => service.start());
afterAll(() => service.stop());
afterEach(async () => {
	await provider?.[Symbol.asyncDispose]();
	service.requests.length = 0;
	service.files.clear();
	service.workspaces.clear();
	service.forbidden.clear();
	service.admins.clear();
	service.admins.add(ADMIN_EMAIL);
	service.ownerMismatch = false;
	clock = NOW;
});

const EMAILS = new Map<UserId, string>([
	[OWNER, OWNER_EMAIL],
	[ADMIN, ADMIN_EMAIL],
]);

function makeProvider(options: { ownerEmail?: boolean } = {}) {
	provider = new ExternalKernelCompute({
		baseUrl: service.baseUrl,
		now: () => clock,
		...(options.ownerEmail === false ? {} : { ownerEmail: async (id) => EMAILS.get(id) }),
	});
	return provider;
}

function browserRequest(token: string | undefined, headers: Record<string, string> = {}): Request {
	return new Request('http://hub.example/api/v1/anything', {
		headers: { ...(token ? { 'x-pantheon-bearer': token } : {}), ...headers },
	});
}

const owner: EndUserPrincipal = { userId: OWNER, email: OWNER_EMAIL };
const admin: EndUserPrincipal = { userId: ADMIN, email: ADMIN_EMAIL };

function asOwner<T>(fn: () => Promise<T>, token = ownerToken): Promise<T> {
	return provider.withEndUserRequest(browserRequest(token), owner, fn);
}

describe('ExternalKernelCompute', () => {
	it('sends the bearer from the request header and nothing from configuration', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		await asOwner(() => sandbox.ready!());

		expect(service.requests).toHaveLength(1);
		expect(service.requests[0]).toMatchObject({
			method: 'GET',
			url: '/api/external-kernel/v1/kernel',
		});
		expect(service.requests[0].headers.authorization).toBe(`Bearer ${ownerToken}`);
		expect(service.requests[0].headers['x-external-kernel-owner']).toBe(OWNER_EMAIL);
	});

	it('names the owner by lowercased hub email on every request', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		await provider.withEndUserRequest(
			browserRequest(ownerToken),
			{ userId: OWNER, email: 'Owner@Example.COM' },
			async () => {
				await sandbox.ready!();
				await sandbox.writeFiles([{ path: '/workspace/notebook.py', content: '' }]);
				await sandbox.destroy();
			},
		);

		expect(service.requests).toHaveLength(3);
		expect(service.requests.map((request) => request.headers['x-external-kernel-owner'])).toEqual([
			OWNER_EMAIL,
			OWNER_EMAIL,
			OWNER_EMAIL,
		]);
	});

	it('maps owner_mismatch to a refusal', async () => {
		makeProvider();
		service.ownerMismatch = true;
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		const failure = asOwner(() => sandbox.ready!());

		await expect(failure).rejects.toBeInstanceOf(ForbiddenError);
		await expect(failure).rejects.toThrow(
			/does not belong to this kernel's owner \(owner_mismatch\)/,
		);
	});

	it("refuses a token for someone else in the owner's own request instead of using the cache", async () => {
		makeProvider();
		const owned = { owner: { projectId: PROJECT, userId: OWNER } };
		await asOwner(() => provider.create(SANDBOX, owned).ready!());
		service.requests.length = 0;

		const failure = asOwner(() => provider.create(SANDBOX, owned).destroy(), adminToken);

		await expect(failure).rejects.toBeInstanceOf(ForbiddenError);
		expect(service.requests).toHaveLength(0);
	});

	it('fails with a clear error and sends nothing when no end-user token exists', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		await expect(sandbox.ready!()).rejects.toThrow(/No end-user credential/);
		await expect(asOwner(() => sandbox.ready!(), '')).rejects.toThrow(
			/carried no x-pantheon-bearer header/,
		);
		expect(service.requests).toHaveLength(0);
	});

	it('refuses tokens that are expired, malformed, or for another email', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		await expect(
			asOwner(() => sandbox.ready!(), jwt({ email: OWNER_EMAIL, exp: NOW / 1000 - 1 })),
		).rejects.toThrow(/has expired/);
		await expect(asOwner(() => sandbox.ready!(), 'not-a-jwt')).rejects.toThrow(/not a JWT/);
		await expect(asOwner(() => sandbox.ready!(), adminToken)).rejects.toThrow(/does not match/);
		expect(service.requests).toHaveLength(0);
	});

	it.each([
		{ setup: () => service.forbidden.add(OWNER_EMAIL), error: ForbiddenError, text: /HTTP 403/ },
		{
			setup: () => service.kernels.delete(OWNER_EMAIL),
			error: UnavailableError,
			text: /no personal kernel .*no_kernel/,
		},
	])('maps service refusals to session errors ($text)', async ({ setup, error, text }) => {
		makeProvider();
		setup();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });
		try {
			const failure = asOwner(() => sandbox.ready!());
			await expect(failure).rejects.toBeInstanceOf(error);
			await expect(failure).rejects.toThrow(text);
		} finally {
			service.kernels.add(OWNER_EMAIL);
		}
	});

	it('maps a rejected token to a sign-in error', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });
		const unsigned = jwt({ exp: NOW / 1000 + 3600 });

		const failure = provider.withEndUserRequest(browserRequest(unsigned), owner, () =>
			sandbox.ready!(),
		);

		// The fake service maps a token without an email to no identity.
		await expect(failure).rejects.toThrow(/rejected the end-user token .*HTTP 401/);
	});

	it('round-trips workspace files relative to the workdir', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });
		const binary = new Uint8Array([0, 255, 1, 2]);

		await asOwner(async () => {
			await sandbox.writeFiles([
				{ path: '/workspace/notebook.py', content: 'import marimo' },
				{ path: '/workspace/data/blob.bin', content: binary },
			]);
			const read = await sandbox.readFileBounded!('/workspace/data/blob.bin', {
				maxBytes: 4,
				timeoutMs: 1000,
			});
			expect(read).toEqual({
				success: true,
				content: Buffer.from(binary).toString('base64'),
				encoding: 'base64',
			});
			expect(
				await sandbox.readFileBounded!('/workspace/data/blob.bin', {
					maxBytes: 3,
					timeoutMs: 1000,
				}),
			).toMatchObject({ success: false, error: { code: 'READ_FAILED' } });
			expect(await sandbox.readFile('/workspace/missing.py')).toMatchObject({
				success: false,
				error: { code: 'NOT_FOUND' },
			});
			const listing = await sandbox.listFiles('/workspace', { recursive: true });
			expect(listing.success && listing.files.map((file) => file.relativePath).sort()).toEqual([
				'data',
				'data/blob.bin',
				'notebook.py',
			]);
			expect(
				listing.success && listing.files.find((file) => file.relativePath === 'data/blob.bin'),
			).toMatchObject({ absolutePath: '/workspace/data/blob.bin', type: 'file', size: 4 });
		});

		const puts = service.requests.filter((request) => request.method === 'PUT');
		expect(puts.map((request) => request.url).sort()).toEqual([
			`/api/external-kernel/v1/workspaces/${SANDBOX}/files?path=data%2Fblob.bin`,
			`/api/external-kernel/v1/workspaces/${SANDBOX}/files?path=notebook.py`,
		]);
	});

	it('treats a bounded-read deadline as a failed read', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		const read = await asOwner(() =>
			sandbox.readFileBounded!('/workspace/slow.bin', { maxBytes: 10, timeoutMs: 50 }),
		);

		expect(read).toMatchObject({ success: false, error: { code: 'READ_FAILED' } });
	});

	it('refuses paths outside the workdir before sending anything', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		await asOwner(async () => {
			await expect(
				sandbox.writeFiles([
					{ path: '/workspace/notebook.py', content: 'ok' },
					{ path: '/etc/marimohub/integrations/db.json', content: 'secret' },
				]),
			).rejects.toBeInstanceOf(ForbiddenError);
			await expect(
				sandbox.writeFiles([{ path: '/workspace/../etc/passwd', content: 'x' }]),
			).rejects.toBeInstanceOf(ForbiddenError);
			await expect(sandbox.ensureDirectories!(['/tmp/bridge'])).rejects.toBeInstanceOf(
				ForbiddenError,
			);
			expect(await sandbox.readFile('/var/run/marimohub/token')).toMatchObject({ success: false });
		});

		expect(service.requests).toHaveLength(0);
	});

	it('rejects command-shaped operations without contacting the service', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		await asOwner(async () => {
			await expect(sandbox.exec('true')).rejects.toThrow(/runs no commands/);
			await expect(sandbox.execStream('true')).rejects.toThrow(/runs no commands/);
			await expect(sandbox.setEnvVars({ A: 'b' })).rejects.toThrow(/runs no commands/);
			await expect(
				sandbox.mountBucket({ bucketName: 'b', mountPath: '/workspace', prefix: '' }),
			).rejects.toThrow(/runs no commands/);
			await expect(sandbox.gitCheckout('https://example.com/repo.git')).rejects.toThrow(
				/runs no commands/,
			);
			await expect(sandbox.startProcess('marimo edit')).rejects.toThrow(/runs no commands/);
		});

		expect(provider.capabilities).toEqual({ multiPort: false, managedEnvironment: true });
		expect(service.requests).toHaveLength(0);
	});

	it('opens the notebook and exposes an origin that carries its file key', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		const { url } = await asOwner(async () => {
			await sandbox.launchMarimo!({
				workdir: '/workspace/pkg',
				notebookFile: 'app.py',
				mode: 'edit',
				port: 2718,
				projectId: PROJECT,
				notebookId: NOTEBOOK,
				timeoutMs: 5000,
			});
			return sandbox.exposePort(2718, { hostname: 'ignored' });
		});

		const open = service.requests.find((request) => request.method === 'POST');
		expect(open?.url).toBe(`/api/external-kernel/v1/workspaces/${SANDBOX}/open`);
		expect(JSON.parse(open!.body)).toEqual({
			notebook: 'pkg/app.py',
			projectId: PROJECT,
			notebookId: NOTEBOOK,
		});
		expect(url).toBe(
			`${service.baseUrl}/workspaces/${SANDBOX}/proxy/?file=${encodeURIComponent(
				`/home/kira/workspaces/${SANDBOX}/pkg/app.py`,
			)}`,
		);
	});

	it('refuses app sessions, which a shared marimo edit server cannot serve', async () => {
		makeProvider();
		const sandbox = provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } });

		await expect(
			asOwner(() =>
				sandbox.launchMarimo!({
					workdir: '/workspace',
					notebookFile: 'notebook.py',
					mode: 'app',
					port: 2718,
					projectId: PROJECT,
					notebookId: NOTEBOOK,
					timeoutMs: 5000,
				}),
			),
		).rejects.toThrow(/edit sessions only/);
	});

	it("keeps only the owner's token in memory for background calls, until it expires", async () => {
		makeProvider();
		const owned = { owner: { projectId: PROJECT, userId: OWNER } };
		await asOwner(() => provider.create(SANDBOX, owned).ready!());
		// A later request from the owner refreshes the cached token.
		await asOwner(async () => {}, ownerLaterToken);

		await provider.create(SANDBOX, owned).destroy();
		const deletes = service.requests.filter((request) => request.method === 'DELETE');
		expect(deletes.map((request) => request.headers.authorization)).toEqual([
			`Bearer ${ownerLaterToken}`,
		]);

		clock = NOW + 7200_000;
		await expect(provider.create(SANDBOX, owned).destroy()).rejects.toThrow(
			/No end-user credential/,
		);
	});

	it('does not cache tokens of users who never drive a kernel', async () => {
		makeProvider();
		await provider.withEndUserRequest(browserRequest(adminToken), admin, async () => {});

		await expect(
			provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: ADMIN } }).destroy(),
		).rejects.toThrow(/No end-user credential/);
	});

	it('attaches only to a workspace that exists', async () => {
		makeProvider();
		const owned = { owner: { projectId: PROJECT, userId: OWNER } };
		await asOwner(() =>
			provider.create(SANDBOX, owned).writeFiles([{ path: '/workspace/a.py', content: '' }]),
		);

		await expect(
			asOwner(() => provider.connectExisting(SANDBOX, owned).ready!()),
		).resolves.toBeUndefined();
		await expect(
			asOwner(() => provider.connectExisting('sb-ffffffffffffffff' as SandboxId, owned).ready!()),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	describe("another user's request on the owner's sandbox", () => {
		const owned = { owner: { projectId: PROJECT, userId: OWNER } };

		/** The owner drove their kernel, so their token is cached for background work. */
		async function withCachedOwnerToken() {
			makeProvider();
			await asOwner(() => provider.create(SANDBOX, owned).ready!());
			service.requests.length = 0;
		}

		function asAdmin<T>(fn: () => Promise<T>, token = adminToken): Promise<T> {
			return provider.withEndUserRequest(browserRequest(token), admin, fn);
		}

		it('stops the session through the admin route with only the caller token', async () => {
			await withCachedOwnerToken();

			await asAdmin(() => provider.create(SANDBOX, owned).destroy());

			expect(service.requests).toHaveLength(1);
			const [stop] = service.requests;
			expect(stop.method).toBe('POST');
			const url = new URL(stop.url, 'http://kira');
			expect(url.pathname).toBe('/api/external-kernel/v1/admin/kernels/stop');
			expect(url.searchParams.get('owner')).toBe(OWNER_EMAIL);
			expect(url.searchParams.get('workspace')).toBe(SANDBOX);
			expect(stop.headers.authorization).toBe(`Bearer ${adminToken}`);
			expect(stop.headers['x-external-kernel-owner']).toBe(ADMIN_EMAIL);
		});

		it('never sends any token to the data routes or replays the cached owner token', async () => {
			await withCachedOwnerToken();
			const sandbox = provider.create(SANDBOX, owned);
			const operations: [string, () => Promise<unknown>][] = [
				['ready', () => sandbox.ready!()],
				['readFile', () => sandbox.readFile('/workspace/notebook.py')],
				['listFiles', () => sandbox.listFiles('/workspace', { recursive: true })],
				['writeFiles', () => sandbox.writeFiles([{ path: '/workspace/a.py', content: 'x' }])],
				[
					'launchMarimo',
					() =>
						sandbox.launchMarimo!({
							workdir: '/workspace',
							notebookFile: 'notebook.py',
							mode: 'edit',
							port: 2718,
							projectId: PROJECT,
							notebookId: NOTEBOOK,
							timeoutMs: 5000,
						}),
				],
			];

			for (const [name, operation] of operations) {
				await expect(asAdmin(operation), name).rejects.toBeInstanceOf(ForbiddenError);
			}
			expect(service.requests).toEqual([]);
		});

		it('fails closed when the service refuses the caller as an admin', async () => {
			await withCachedOwnerToken();
			service.admins.clear();

			await expect(asAdmin(() => provider.create(SANDBOX, owned).destroy())).rejects.toThrow(
				/only its administrators/,
			);
			expect(service.requests.map((request) => request.headers.authorization)).toEqual([
				`Bearer ${adminToken}`,
			]);
		});

		it('sends nothing when the caller has no token or the owner cannot be named', async () => {
			await withCachedOwnerToken();
			await expect(
				asAdmin(() => provider.create(SANDBOX, owned).destroy(), ''),
			).rejects.toBeInstanceOf(UnavailableError);

			makeProvider({ ownerEmail: false });
			await asOwner(() => provider.create(SANDBOX, owned).ready!());
			service.requests.length = 0;
			await expect(asAdmin(() => provider.create(SANDBOX, owned).destroy())).rejects.toThrow(
				/only the owner can stop/,
			);
			expect(service.requests).toEqual([]);
		});

		it("still lets background work close the workspace with the owner's cached token", async () => {
			await withCachedOwnerToken();

			await provider.create(SANDBOX, owned).destroy();

			expect(
				service.requests.map((request) => [request.method, request.headers.authorization]),
			).toEqual([['DELETE', `Bearer ${ownerToken}`]]);
		});
	});

	describe('resolveKernelProxyTarget', () => {
		const origin = () =>
			`${service.baseUrl}/workspaces/${SANDBOX}/proxy/?file=${encodeURIComponent('/home/kira/a b.py')}`;

		function proxyInput(kernelPath: string, principal = owner, token = ownerToken) {
			const request = new Request(`http://hub.example/proxy/tok${kernelPath}`, {
				headers: {
					'x-pantheon-bearer': token,
					'x-pantheon-email': principal.email,
					cookie: 'hub_session=secret',
					authorization: 'Bearer hub-pat',
					'x-custom': 'kept',
				},
			});
			const headers = new Headers(request.headers);
			headers.delete('cookie');
			headers.delete('authorization');
			return {
				request,
				principal,
				ownerUserId: OWNER,
				sandboxId: SANDBOX,
				originUrl: origin(),
				kernelPath,
				headers,
			};
		}

		it('strips hub credentials, sets the bearer, and pins the opened file', async () => {
			makeProvider();

			const target = await provider.resolveKernelProxyTarget(proxyInput('/ws?session_id=s1'));

			expect(target.url).toBe(
				`${service.baseUrl}/workspaces/${SANDBOX}/proxy/ws?session_id=s1&file=%2Fhome%2Fkira%2Fa+b.py`,
			);
			expect(Object.fromEntries(target.headers)).toEqual({
				authorization: `Bearer ${ownerToken}`,
				'x-external-kernel-owner': OWNER_EMAIL,
				'x-custom': 'kept',
			});
		});

		it('overwrites a browser-supplied owner header', async () => {
			makeProvider();
			const input = proxyInput('/');
			input.headers.set('x-external-kernel-owner', ADMIN_EMAIL);

			const target = await provider.resolveKernelProxyTarget(input);

			expect(target.headers.get('x-external-kernel-owner')).toBe(OWNER_EMAIL);
		});

		it("never falls back to the owner's cached token for a proxied request", async () => {
			makeProvider();
			await asOwner(() =>
				provider.create(SANDBOX, { owner: { projectId: PROJECT, userId: OWNER } }).ready!(),
			);

			await expect(
				provider.resolveKernelProxyTarget(proxyInput('/', admin, adminToken)),
			).rejects.toBeInstanceOf(ForbiddenError);
			await expect(provider.resolveKernelProxyTarget(proxyInput('/', owner, ''))).rejects.toThrow(
				/carried no x-pantheon-bearer header/,
			);
		});

		it('pins the file on the editor page and keeps an explicit file parameter', async () => {
			makeProvider();

			const page = await provider.resolveKernelProxyTarget(proxyInput('/'));
			const explicit = await provider.resolveKernelProxyTarget(
				proxyInput('/api/kernel/run?file=other.py'),
			);

			expect(new URL(page.url).pathname).toBe(
				`/api/external-kernel/v1/workspaces/${SANDBOX}/proxy/`,
			);
			expect(new URL(page.url).searchParams.get('file')).toBe('/home/kira/a b.py');
			expect(new URL(explicit.url).searchParams.getAll('file')).toEqual(['other.py']);
		});

		it('refuses a caller who is not the session owner', async () => {
			makeProvider();

			await expect(
				provider.resolveKernelProxyTarget(proxyInput('/', admin, adminToken)),
			).rejects.toBeInstanceOf(ForbiddenError);
		});

		it('refuses an origin that is not this service', async () => {
			makeProvider();

			await expect(
				provider.resolveKernelProxyTarget({
					...proxyInput('/'),
					originUrl: 'http://elsewhere.example/proxy/?file=x',
				}),
			).rejects.toThrow(/not routed/);
		});
	});
});
