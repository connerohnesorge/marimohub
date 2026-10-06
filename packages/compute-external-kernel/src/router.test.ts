import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnavailableError } from '@marimo-hub/core/errors';
import type { SandboxId, UserId } from '@marimo-hub/core/ids';
import type {
	EndUserPrincipal,
	SandboxInstance,
	SandboxProvider,
} from '@marimo-hub/core/ports/sandbox';
import { EXTERNAL_KERNEL_BACKEND, ExternalKernelCompute, ExternalKernelRouter } from './index';

const OWNER = 'user-owner' as UserId;
const OWNER_EMAIL = 'owner@example.com';
const SANDBOX = 'sb-0123456789abcdef' as SandboxId;
const NOW = Date.UTC(2026, 9, 5, 12);
const owner: EndUserPrincipal = { userId: OWNER, email: OWNER_EMAIL };

function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'RS256' })}.${part(claims)}.c2lnbmF0dXJl`;
}

const ownerToken = jwt({ email: OWNER_EMAIL, exp: NOW / 1000 + 3600 });

/** `GET /kernel` answers whatever the test sets. */
let answer: { status: number; body?: unknown } = { status: 200, body: { ready: true } };
const seen: IncomingHttpHeaders[] = [];
let server: Server;
let baseUrl = '';

beforeAll(async () => {
	server = createServer((req, res) => {
		seen.push(req.headers);
		res.writeHead(answer.status, { 'content-type': 'application/json' });
		res.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/external-kernel/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
	seen.length = 0;
	answer = { status: 200, body: { ready: true } };
});

function fallbackProvider() {
	const instance = { destroy: vi.fn(async () => {}) } as unknown as SandboxInstance;
	const fallback = {
		capabilities: { multiPort: true, computeProfiles: true },
		warmPool: { maxLifetimeMs: null },
		create: vi.fn(() => instance),
		connectExisting: vi.fn(() => instance),
		listActive: vi.fn(async () => [{ id: SANDBOX }]),
		proxy: vi.fn(async () => null),
	} satisfies SandboxProvider;
	return { fallback, instance };
}

function makeRouter() {
	const external = new ExternalKernelCompute({ baseUrl, now: () => NOW });
	const { fallback, instance } = fallbackProvider();
	return { router: new ExternalKernelRouter(external, fallback), external, fallback, instance };
}

function asOwner<T>(router: ExternalKernelRouter, fn: () => Promise<T>, token = ownerToken) {
	return router.withEndUserRequest(
		new Request('http://hub.example/api/v1/x', { headers: { 'x-pantheon-bearer': token } }),
		owner,
		fn,
	);
}

describe('ExternalKernelRouter', () => {
	it("selects the user's own kernel when the service has one, asking with the user's token", async () => {
		const { router } = makeRouter();

		await expect(asOwner(router, () => router.routing.selectEditBackend(owner))).resolves.toBe(
			EXTERNAL_KERNEL_BACKEND,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0].authorization).toBe(`Bearer ${ownerToken}`);
		expect(seen[0]['x-external-kernel-owner']).toBe(OWNER_EMAIL);
	});

	it('selects the fallback only for 404 no_kernel', async () => {
		const { router } = makeRouter();
		answer = { status: 404, body: { error: { code: 'no_kernel' } } };

		await expect(
			asOwner(router, () => router.routing.selectEditBackend(owner)),
		).resolves.toBeUndefined();
	});

	it('asks again on every session start instead of caching the answer', async () => {
		const { router } = makeRouter();
		await asOwner(router, () => router.routing.selectEditBackend(owner));
		answer = { status: 404, body: { error: { code: 'no_kernel' } } };

		await expect(
			asOwner(router, () => router.routing.selectEditBackend(owner)),
		).resolves.toBeUndefined();
		expect(seen).toHaveLength(2);
	});

	it.each([
		[401, { error: { code: 'unauthorized' } }, UnavailableError, /Sign in again/],
		[403, { error: { code: 'owner_mismatch' } }, ForbiddenError, /owner_mismatch/],
		[403, { error: { code: 'forbidden' } }, ForbiddenError, /does not allow/],
		[404, { error: { code: 'not_found' } }, UnavailableError, /HTTP 404, not_found/],
		[404, undefined, UnavailableError, /HTTP 404/],
		[500, { error: { code: 'internal' } }, UnavailableError, /HTTP 500/],
		[503, undefined, UnavailableError, /HTTP 503/],
	])('fails closed on HTTP %i %j', async (status, body, type, message) => {
		const { router } = makeRouter();
		answer = { status, body };

		const selection = asOwner(router, () => router.routing.selectEditBackend(owner));
		await expect(selection).rejects.toBeInstanceOf(type);
		await expect(selection).rejects.toThrow(message);
	});

	it('fails closed when the user has no token or the service is unreachable', async () => {
		const { router, fallback } = makeRouter();
		await expect(router.routing.selectEditBackend(owner)).rejects.toThrow(/No end-user credential/);
		await expect(
			router.withEndUserRequest(new Request('http://hub.example/'), owner, () =>
				router.routing.selectEditBackend(owner),
			),
		).rejects.toThrow(/carried no x-pantheon-bearer header/);
		expect(seen).toHaveLength(0);

		const unreachable = new ExternalKernelRouter(
			new ExternalKernelCompute({ baseUrl: 'http://127.0.0.1:1/api', now: () => NOW }),
			fallback,
		);
		await expect(
			asOwner(unreachable, () => unreachable.routing.selectEditBackend(owner)),
		).rejects.toThrow(/unreachable/);
	});

	describe('with a list of enrolled users', () => {
		const stranger: EndUserPrincipal = {
			userId: 'user-stranger' as UserId,
			email: 'x@example.com',
		};

		function enrolledRouter(baseUrl: string) {
			const { fallback } = fallbackProvider();
			const external = new ExternalKernelCompute({ baseUrl, now: () => NOW });
			return new ExternalKernelRouter(external, fallback, {
				enrolledUsers: [' Owner@Example.com '],
			});
		}

		it('sends everyone else to the fallback without contacting the service, even when it is down', async () => {
			for (const router of [
				enrolledRouter(baseUrl),
				enrolledRouter('http://127.0.0.1:1/api/external-kernel/v1'),
			]) {
				await expect(
					router.withEndUserRequest(new Request('http://hub.example/'), stranger, () =>
						router.routing.selectEditBackend(stranger),
					),
				).resolves.toBeUndefined();
			}
			expect(seen).toHaveLength(0);
		});

		it('asks the service for a listed user, and fails clearly when it is down', async () => {
			const router = enrolledRouter(baseUrl);
			await expect(asOwner(router, () => router.routing.selectEditBackend(owner))).resolves.toBe(
				EXTERNAL_KERNEL_BACKEND,
			);
			answer = { status: 404, body: { error: { code: 'no_kernel' } } };
			await expect(
				asOwner(router, () => router.routing.selectEditBackend(owner)),
			).resolves.toBeUndefined();

			const down = enrolledRouter('http://127.0.0.1:1/api/external-kernel/v1');
			await expect(asOwner(down, () => down.routing.selectEditBackend(owner))).rejects.toThrow(
				/unreachable/,
			);
		});
	});

	describe('kernelJobs', () => {
		it("places an author's jobs by the same rule as their edit sessions", async () => {
			const { fallback } = fallbackProvider();
			const external = new ExternalKernelCompute({ baseUrl, now: () => NOW });
			const router = new ExternalKernelRouter(external, fallback, {
				enrolledUsers: [OWNER_EMAIL],
			});
			const stranger = { userId: 'user-stranger' as UserId, email: 'x@example.com' };

			await expect(router.kernelJobs.runsJobsOf(stranger)).resolves.toBe(false);
			expect(seen).toHaveLength(0);
			await expect(asOwner(router, () => router.kernelJobs.runsJobsOf(owner))).resolves.toBe(true);
			answer = { status: 404, body: { error: { code: 'no_kernel' } } };
			await expect(asOwner(router, () => router.kernelJobs.runsJobsOf(owner))).resolves.toBe(false);
			answer = { status: 503, body: { error: { code: 'unavailable' } } };
			await expect(asOwner(router, () => router.kernelJobs.runsJobsOf(owner))).rejects.toThrow();
		});

		it('hands a run its environment in the service format, without AWS keys in env', () => {
			const { router } = makeRouter();

			const body = router.kernelJobs.environment({
				vars: { A: '1', AWS_ACCESS_KEY_ID: 'AK' },
				files: [],
				network: {
					tunnels: [],
					hosts: [],
					mongodb: [],
					aws: [
						{
							services: ['s3'],
							region: 'us-east-1',
							accessKeyId: 'AK',
							secretAccessKey: 'SK',
							credentialVars: ['AWS_ACCESS_KEY_ID'],
							endpointVars: [],
						},
					],
					relayEnv: {},
					relayFiles: [],
					unrelayable: [],
				},
			}) as { env: Record<string, string>; aws: unknown[] };

			expect(body.env).toEqual({ A: '1' });
			expect(body.aws).toHaveLength(1);
		});
	});

	it('names each backend and refuses an unknown one', () => {
		const { router, external, fallback } = makeRouter();
		expect(router.routing.backend(undefined)).toBe(fallback);
		expect(router.routing.backend(EXTERNAL_KERNEL_BACKEND)).toBe(external);
		expect(() => router.routing.backend('modal')).toThrow(/Unknown compute backend/);
	});

	it('serves everything that is not a routed edit session from the fallback', async () => {
		const { router, fallback, instance } = makeRouter();
		const options = { owner: { projectId: 'proj-0123456789abcdef' as never, userId: OWNER } };

		expect(router.capabilities).toEqual({ multiPort: true, computeProfiles: true });
		expect(router.warmPool).toEqual({ maxLifetimeMs: null });
		expect(router.create(SANDBOX, options)).toBe(instance);
		expect(fallback.create).toHaveBeenCalledWith(SANDBOX, options);
		expect(router.connectExisting!(SANDBOX)).toBe(instance);
		await expect(router.listActive!()).resolves.toEqual([{ id: SANDBOX }]);
		await expect(router.proxy(new Request('http://hub.example/'))).resolves.toBeNull();
		expect(seen).toHaveLength(0);
	});

	it("runs the fallback's request hook inside the external kernel's", async () => {
		const { router, external, fallback } = makeRouter();
		const inner = vi.fn(async () => 'done');
		let hooks = 0;
		const hooked: SandboxProvider = {
			...fallback,
			withEndUserRequest(_request, _principal, next) {
				hooks++;
				return next();
			},
		};
		const composed = new ExternalKernelRouter(external, hooked);

		await expect(asOwner(composed, inner)).resolves.toBe('done');
		expect(hooks).toBe(1);
		expect(inner).toHaveBeenCalledOnce();
		await router[Symbol.asyncDispose]();
	});
});
