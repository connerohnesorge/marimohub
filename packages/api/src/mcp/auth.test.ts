import { describe, expect, it, vi } from 'vitest';
import { UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing';
import { makeTestDeps } from '../testing';
import { authenticateBearer, authenticateGatewayCaller } from './auth';

const PRINCIPAL: AuthenticatedPrincipal = {
	id: UserId.parse('oauth-user'),
	email: 'oauth@example.com',
	name: 'OAuth User',
	credential: { kind: 'personal-access-token', id: 'tok-oauth' },
};

describe('authenticateBearer', () => {
	it('does not invoke the authenticator without a bearer credential', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		const authenticate = vi.fn();
		deps.authenticator = { authenticate };

		await expect(
			authenticateBearer(deps, new Request('https://hub.example/mcp')),
		).resolves.toBeNull();
		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', { headers: { Authorization: 'Basic abc' } }),
			),
		).resolves.toBeNull();
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('rejects bearer credentials that the authenticator cannot verify', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		const authenticate = vi.fn().mockResolvedValue(null);
		deps.authenticator = { authenticate };
		const request = new Request('https://hub.example/mcp', {
			headers: { Authorization: 'Bearer invalid' },
		});

		await expect(authenticateBearer(deps, request)).resolves.toBeNull();
		expect(authenticate).toHaveBeenCalledWith(request);
	});

	it('rejects a bearer request that falls through to an SSO principal', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = {
			authenticate: vi.fn().mockResolvedValue({
				...PRINCIPAL,
				credential: { kind: 'sso' },
			}),
		};
		const suspended = vi.spyOn(deps.services.identities, 'isSuspended');

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer opaque-sso-token' },
				}),
			),
		).resolves.toBeNull();
		expect(suspended).not.toHaveBeenCalled();
	});

	it('rejects a valid credential when its identity is suspended', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = { authenticate: vi.fn().mockResolvedValue(PRINCIPAL) };
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(true);
		const request = new Request('https://hub.example/mcp', {
			headers: { Authorization: 'Bearer suspended' },
		});

		await expect(authenticateBearer(deps, request)).resolves.toBeNull();
	});

	it('returns an active bearer principal', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = { authenticate: vi.fn().mockResolvedValue(PRINCIPAL) };
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(false);

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer valid' },
				}),
			),
		).resolves.toBe(PRINCIPAL);
	});

	it.each([
		{ resource: 'https://other.example/mcp', scopes: ['mcp:tools'] },
		{ resource: 'https://hub.example/mcp', scopes: ['other'] },
	])('rejects an OAuth credential outside the required boundary: %j', async (oauth) => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = {
			authenticate: vi
				.fn()
				.mockResolvedValue({ ...PRINCIPAL, credential: { ...PRINCIPAL.credential, oauth } }),
		};
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(false);

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer valid' },
				}),
				{ resource: 'https://hub.example/mcp', scope: 'mcp:tools' },
			),
		).resolves.toBeNull();
	});

	it('accepts an OAuth credential with the required resource and scope', async () => {
		const oauthPrincipal: AuthenticatedPrincipal = {
			...PRINCIPAL,
			credential: {
				...PRINCIPAL.credential,
				oauth: {
					clientId: 'client-one',
					resource: 'https://hub.example/mcp',
					scopes: ['mcp:tools'],
				},
			},
		};
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = { authenticate: vi.fn().mockResolvedValue(oauthPrincipal) };
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(false);

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer valid' },
				}),
				{ resource: 'https://hub.example/mcp', scope: 'mcp:tools' },
			),
		).resolves.toBe(oauthPrincipal);
	});
});

describe('authenticateGatewayCaller', () => {
	const GATEWAY: AuthenticatedPrincipal = { ...PRINCIPAL, credential: { kind: 'sso' } };

	function gatewayDeps(gatewayIdentity = true) {
		const deps = makeTestDeps(new MemoryBucket(), {
			mcp: { publicBaseUrl: 'https://hub.example', gatewayIdentity },
		});
		deps.authenticator = { authenticate: vi.fn().mockResolvedValue(GATEWAY) };
		return deps;
	}

	it("accepts the gateway's caller for a request without a bearer", async () => {
		const deps = gatewayDeps();

		await expect(
			authenticateGatewayCaller(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { 'x-pantheon-email': 'oauth@example.com', origin: 'https://hub.example' },
				}),
			),
		).resolves.toEqual(GATEWAY);
	});

	it('refuses it when off, with a bearer, or for a request from another site', async () => {
		const requests = [
			new Request('https://hub.example/mcp', { headers: { Authorization: 'Bearer x' } }),
			new Request('https://hub.example/mcp', { headers: { origin: 'https://evil.example' } }),
			new Request('https://hub.example/mcp', { headers: { 'sec-fetch-site': 'cross-site' } }),
			new Request('https://hub.example/mcp', { headers: { 'sec-fetch-site': 'same-site' } }),
		];
		for (const request of requests) {
			await expect(authenticateGatewayCaller(gatewayDeps(), request)).resolves.toBeNull();
		}
		await expect(
			authenticateGatewayCaller(gatewayDeps(false), new Request('https://hub.example/mcp')),
		).resolves.toBeNull();
	});

	it('refuses a suspended caller', async () => {
		const deps = gatewayDeps();
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(true);

		await expect(
			authenticateGatewayCaller(deps, new Request('https://hub.example/mcp')),
		).resolves.toBeNull();
	});
});
