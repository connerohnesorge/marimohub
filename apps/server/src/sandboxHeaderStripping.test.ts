import { createServer } from 'node:http';
import type http from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { createFromEnv } from '@marimo-hub/config';
import { CatalogService, signProxyToken } from '@marimo-hub/core';
import type { Authenticator, ProjectId } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { attachSandboxProxyUpgrade } from './sandboxProxyWs';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';

// What a gateway in front of the hub adds to every browser request.
const GATEWAY_HEADERS = {
	'x-pantheon-email': 'viewer@example.com',
	'x-pantheon-bearer': 'eyJhbGciOiJSUzI1NiJ9.viewer-identity.sig',
	'x-pantheon-groups': 'finance',
	'x-pantheon-subject': 'viewer-subject',
	'x-pantheon-subject-sig': 'a1b2c3',
	// An HMAC over email and groups with a key that many apps share, valid for
	// 300 s and bound to no app: a replayable identity in an author's hands.
	'x-pantheon-gateway-sig': 'd4e5f6',
	'x-pantheon-gateway-exp': '1791240000',
};

const authenticator: Authenticator = {
	authenticate: async () => ({
		id: ACTOR,
		email: `${ACTOR}@example.com`,
		credential: { kind: 'sso' as const },
	}),
};

/**
 * A kernel on an ordinary backend must never see the viewer's gateway identity:
 * notebook code can read request headers, so the notebook's author would get the
 * viewer's token. The defaults come from the real configuration.
 */
describe('kernel proxy header stripping on a non-external backend', () => {
	let kernel: Server;
	let origin: string;
	const seen: IncomingHttpHeaders[] = [];
	const upgrades: IncomingHttpHeaders[] = [];
	const sockets: Duplex[] = [];

	beforeAll(async () => {
		kernel = createServer((req, res) => {
			seen.push(req.headers);
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('kernel');
		});
		kernel.on('upgrade', (req, socket) => {
			upgrades.push(req.headers);
			sockets.push(socket);
			socket.on('error', () => {});
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
			);
		});
		await new Promise<void>((resolve) => kernel.listen(0, '127.0.0.1', resolve));
		origin = `http://127.0.0.1:${(kernel.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => kernel.close(() => resolve()));
	});

	async function proxiedSession() {
		const deps = createFromEnv({
			MARIMOHUB_STORAGE_BACKEND: 'memory',
			MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_COMPUTE_BACKEND: 'local',
			MARIMOHUB_SANDBOX_EXPOSURE: 'proxy',
			MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED: 'true',
			MARIMOHUB_AUTH_SESSION_SECRET: SECRET,
		});
		deps.authenticator = authenticator;
		await new CatalogService(deps.bucket).initialize(ACTOR);
		const { services } = deps;
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
			authorization_expires_at: new Date(Date.now() + 60_000).toISOString(),
		});
		await services.sessions.setRunning(pid, session.session_id, '/proxy/x/', false, origin);
		return { deps, token: await signProxyToken(pid, session.session_id, SECRET) };
	}

	it('drops gateway identity headers from proxied HTTP requests', async () => {
		const { deps, token } = await proxiedSession();
		seen.length = 0;

		const res = await createApi(deps).fetch(
			new Request(`http://hub.example/proxy/${token}/`, {
				headers: { ...GATEWAY_HEADERS, 'x-custom': 'kept' },
			}),
		);

		expect(res.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(Object.keys(seen[0]).filter((name) => name.startsWith('x-pantheon-'))).toEqual([]);
		expect(seen[0]['x-custom']).toBe('kept');
	});

	it('drops gateway identity headers from proxied WebSocket upgrades', async () => {
		const { deps, token } = await proxiedSession();
		const listeners: ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void)[] = [];
		attachSandboxProxyUpgrade({ on: (_event, listener) => listeners.push(listener) }, deps);
		upgrades.length = 0;
		const client = new PassThrough();
		const received: Buffer[] = [];
		client.on('data', (chunk: Buffer) => received.push(chunk));

		listeners[0](
			{
				url: `/proxy/${token}/ws`,
				headers: {
					host: 'hub.example',
					connection: 'Upgrade',
					upgrade: 'websocket',
					'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
					'sec-websocket-version': '13',
					'x-custom': 'kept',
					...GATEWAY_HEADERS,
				},
			} as unknown as http.IncomingMessage,
			client,
			Buffer.alloc(0),
		);

		await vi.waitFor(() => expect(Buffer.concat(received).toString()).toMatch(/^HTTP\/1\.1 101/));
		expect(upgrades).toHaveLength(1);
		expect(Object.keys(upgrades[0]).filter((name) => name.startsWith('x-pantheon-'))).toEqual([]);
		expect(upgrades[0]['x-custom']).toBe('kept');
		client.destroy();
	});
});
