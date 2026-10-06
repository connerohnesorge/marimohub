import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Duplex } from 'node:stream';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { ExternalKernelCompute } from '@marimo-hub/compute-external-kernel';
import { createServices, ProxyExposure, SandboxId, signProxyToken } from '@marimo-hub/core';
import type { Authenticator, ProjectId, UserId } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { attachSandboxProxyUpgrade } from './sandboxProxyWs';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const SANDBOX = SandboxId.parse('sb-0123456789abcdef');
const FILE_KEY = '/home/kira/workspaces/sb-0123456789abcdef/notebook.py';
const EMAIL = `${ACTOR}@example.com`;

function jwt(email: string): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'RS256' })}.${part({ email, exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
}

function authAs(userId: UserId): Authenticator {
	return {
		authenticate: async () => ({
			id: userId,
			email: EMAIL,
			credential: { kind: 'sso' as const },
		}),
	};
}

interface Seen {
	url: string;
	headers: IncomingHttpHeaders;
}

describe('proxy exposure through an external kernel', () => {
	let kira: Server;
	let baseUrl: string;
	const http: Seen[] = [];
	const upgrades: Seen[] = [];
	const upstreamSockets: Duplex[] = [];

	beforeAll(async () => {
		kira = createServer((req, res) => {
			http.push({ url: req.url ?? '', headers: req.headers });
			res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'kira=1; Path=/' });
			res.end('<html>marimo editor</html>');
		});
		kira.on('upgrade', (req, socket) => {
			upgrades.push({ url: req.url ?? '', headers: req.headers });
			upstreamSockets.push(socket);
			// The hub tears the relay down by destroying its end; that resets this one.
			socket.on('error', () => {});
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
			);
			socket.on('data', (chunk) => socket.write(chunk));
		});
		await new Promise<void>((resolve) => kira.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(kira.address() as AddressInfo).port}/api/external-kernel/v1`;
	});

	afterAll(async () => {
		for (const socket of upstreamSockets) socket.destroy();
		await new Promise<void>((resolve) => kira.close(() => resolve()));
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
			authorization_expires_at: new Date(Date.now() + 60_000).toISOString(),
		});
		const originUrl = `${baseUrl}/workspaces/${SANDBOX}/proxy/?file=${encodeURIComponent(FILE_KEY)}`;
		await services.sessions.setRunning(pid, session.session_id, '/proxy/x/', false, originUrl);
		const token = await signProxyToken(pid, session.session_id, SECRET);
		const compute = new ExternalKernelCompute({ baseUrl });
		const deps = makeTestDeps(bucket, {
			compute,
			authenticator: authAs(ACTOR),
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure(SECRET),
				credentialHeaders: ['x-pantheon-email'],
			},
		});
		return { deps, token };
	}

	it('forwards HTTP to the per-user server root with the user token and the file pinned', async () => {
		const { deps, token } = await runningSession();
		const app = createApi(deps);
		const bearer = jwt(EMAIL);
		http.length = 0;

		const res = await app.fetch(
			new Request(`http://hub.example/proxy/${token}/?theme=dark`, {
				headers: {
					cookie: 'hub_session=secret',
					authorization: 'Bearer mhub_pat_secret',
					'x-pantheon-email': EMAIL,
					'x-pantheon-bearer': bearer,
					'x-pantheon-groups': 'admins',
					'x-custom': 'kept',
				},
			}),
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('<html>marimo editor</html>');
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(http).toHaveLength(1);
		const url = new URL(http[0].url, 'http://kira');
		expect(url.pathname).toBe(`/api/external-kernel/v1/workspaces/${SANDBOX}/proxy/`);
		expect(url.searchParams.get('theme')).toBe('dark');
		expect(url.searchParams.get('file')).toBe(FILE_KEY);
		expect(http[0].headers.authorization).toBe(`Bearer ${bearer}`);
		expect(http[0].headers['x-external-kernel-owner']).toBe(EMAIL.toLowerCase());
		expect(http[0].headers.cookie).toBeUndefined();
		expect(Object.keys(http[0].headers).filter((name) => name.startsWith('x-pantheon-'))).toEqual(
			[],
		);
		expect(http[0].headers['x-custom']).toBe('kept');
	});

	it('relays a WebSocket upgrade to the per-user server with the user token and the file pinned', async () => {
		const { deps, token } = await runningSession();
		const server = { listeners: [] as ((...args: never[]) => void)[] };
		attachSandboxProxyUpgrade(
			{ on: (_event, listener) => server.listeners.push(listener as never) },
			deps,
		);
		const bearer = jwt(EMAIL);
		upgrades.length = 0;

		const client = new PassThrough();
		const received: Buffer[] = [];
		client.on('data', (chunk: Buffer) => received.push(chunk));
		const req = {
			url: `/proxy/${token}/ws?session_id=s1`,
			headers: {
				host: 'hub.example',
				connection: 'Upgrade',
				upgrade: 'websocket',
				'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'sec-websocket-version': '13',
				cookie: 'hub_session=secret',
				'x-pantheon-email': EMAIL,
				'x-pantheon-bearer': bearer,
			},
		} as unknown as http.IncomingMessage;
		(server.listeners[0] as (r: http.IncomingMessage, s: Duplex, h: Buffer) => void)(
			req,
			client,
			Buffer.alloc(0),
		);

		await vi.waitFor(() => expect(Buffer.concat(received).toString()).toMatch(/^HTTP\/1\.1 101/));
		expect(upgrades).toHaveLength(1);
		const url = new URL(upgrades[0].url, 'http://kira');
		expect(url.pathname).toBe(`/api/external-kernel/v1/workspaces/${SANDBOX}/proxy/ws`);
		expect(url.searchParams.get('session_id')).toBe('s1');
		expect(url.searchParams.get('file')).toBe(FILE_KEY);
		expect(upgrades[0].headers.authorization).toBe(`Bearer ${bearer}`);
		expect(upgrades[0].headers['x-external-kernel-owner']).toBe(EMAIL.toLowerCase());
		expect(upgrades[0].headers.host).toBe(new URL(baseUrl).host);
		expect(upgrades[0].headers.cookie).toBeUndefined();
		expect(upgrades[0].headers['x-pantheon-bearer']).toBeUndefined();
		expect(upgrades[0].headers['x-pantheon-email']).toBeUndefined();

		received.length = 0;
		client.write('ping-frame');
		await vi.waitFor(() => expect(Buffer.concat(received).toString()).toBe('ping-frame'));
		client.destroy();
	});

	it('rejects an upgrade without the user token instead of dialing the kernel', async () => {
		const { deps, token } = await runningSession();
		const server = { listeners: [] as ((...args: never[]) => void)[] };
		attachSandboxProxyUpgrade(
			{ on: (_event, listener) => server.listeners.push(listener as never) },
			deps,
		);
		upgrades.length = 0;
		const client = new PassThrough();
		const received: Buffer[] = [];
		client.on('data', (chunk: Buffer) => received.push(chunk));
		const req = {
			url: `/proxy/${token}/ws`,
			headers: { host: 'hub.example', connection: 'Upgrade', upgrade: 'websocket' },
		} as unknown as http.IncomingMessage;

		(server.listeners[0] as (r: http.IncomingMessage, s: Duplex, h: Buffer) => void)(
			req,
			client,
			Buffer.alloc(0),
		);

		await vi.waitFor(() => expect(client.destroyed).toBe(true));
		expect(Buffer.concat(received).toString()).toMatch(/^HTTP\/1\.1 503 SERVICE_UNAVAILABLE/);
		expect(upgrades).toHaveLength(0);
	});
});
