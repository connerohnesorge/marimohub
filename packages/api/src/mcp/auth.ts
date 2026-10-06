import type { Context } from 'hono';
import { bearerToken } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from '../context';
import { refreshIdentity } from '../identity';
import { MCP_EXTERNAL_INITIAL_SCOPES, MCP_SCOPE } from './constants';

export interface BearerRequirements {
	resource?: string;
	scope?: string;
	allowExternal?: boolean;
}

export async function authenticateBearer(
	deps: ApiDeps,
	request: Request,
	requirements: BearerRequirements = {},
): Promise<AuthenticatedPrincipal | null> {
	if (!bearerToken(request)) return null;
	const principal = await deps.authenticator.authenticate(request);
	if (
		!principal ||
		(principal.credential.kind !== 'personal-access-token' &&
			!(requirements.allowExternal && principal.credential.kind === 'external-access-token'))
	)
		return null;
	const oauth = principal.credential.oauth;
	if (requirements.resource !== undefined && oauth?.resource !== requirements.resource) return null;
	if (requirements.scope !== undefined && !oauth?.scopes.includes(requirements.scope)) return null;
	if (await deps.services.identities.isSuspended(principal.id)) return null;
	return principal;
}

/** Whether a browser marked `request` as sent by another site. */
function fromAnotherSite(request: Request, publicBaseUrl: string): boolean {
	const site = request.headers.get('sec-fetch-site');
	if (site === 'cross-site' || site === 'same-site') return true;
	const origin = request.headers.get('origin');
	if (!origin) return false;
	try {
		return new URL(origin).origin !== new URL(publicBaseUrl).origin;
	} catch {
		return true;
	}
}

/**
 * The caller a trusted gateway identified, for a request that carries no bearer
 * (the gateway consumed it). Only with `gatewayIdentity`, never cross-site.
 */
export async function authenticateGatewayCaller(
	deps: ApiDeps,
	request: Request,
): Promise<AuthenticatedPrincipal | null> {
	if (!deps.mcp?.gatewayIdentity || bearerToken(request)) return null;
	if (fromAnotherSite(request, deps.mcp.publicBaseUrl)) return null;
	const principal = await deps.authenticator.authenticate(request);
	if (!principal || (await deps.services.identities.isSuspended(principal.id))) return null;
	return principal;
}

export async function authenticateMcpRequest(
	c: Context<HonoEnv>,
	deps: ApiDeps,
): Promise<AuthenticatedPrincipal | Response> {
	const resource = `${deps.mcp?.publicBaseUrl ?? new URL(c.req.url).origin}/mcp`;
	const principal =
		(await authenticateBearer(deps, c.req.raw, {
			resource,
			scope: MCP_SCOPE,
			allowExternal: Boolean(deps.mcp?.externalAuthorizationServer),
		})) ?? (await authenticateGatewayCaller(deps, c.req.raw));
	if (principal) {
		await refreshIdentity(c, deps, principal);
		return principal;
	}
	const resourceMetadata = `${deps.mcp?.publicBaseUrl ?? new URL(c.req.url).origin}/.well-known/oauth-protected-resource/mcp`;
	// Clients prefer the challenge scope over the complete supported-scope list.
	const scope = deps.mcp?.externalAuthorizationServer
		? `, scope="${MCP_EXTERNAL_INITIAL_SCOPES.join(' ')}"`
		: '';
	return c.json(
		{ error: 'invalid_token', error_description: 'A valid bearer token is required' },
		401,
		{
			'WWW-Authenticate': `Bearer realm="mcp", error="invalid_token", resource_metadata="${resourceMetadata}"${scope}`,
		},
	);
}
