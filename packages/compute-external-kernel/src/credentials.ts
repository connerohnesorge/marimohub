import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenError, UnavailableError } from '@marimo-hub/core/errors';
import type { UserId } from '@marimo-hub/core/ids';
import type { EndUserPrincipal } from '@marimo-hub/core/ports/sandbox';

export interface EndUserCredential {
	token: string;
	/** Epoch ms from the token's `exp` claim. */
	expiresAt: number;
	/** Lowercased hub email of the user the token was read for. */
	email: string;
}

type Rejection = 'missing' | 'malformed' | 'expired' | 'email_mismatch' | 'audience';

type ReadResult = { credential: EndUserCredential } | { rejection: Rejection };

interface RequestContext {
	userId: UserId;
	read: ReadResult;
}

// A token this close to expiry could lapse in flight to the external service.
const EXPIRY_SKEW_MS = 30_000;

const REJECTION_DETAIL: Record<Rejection, (header: string) => string> = {
	missing: (header) => `the request carried no ${header} header`,
	malformed: (header) => `the ${header} header is not a JWT with an exp claim`,
	expired: (header) => `the token in the ${header} header has expired`,
	email_mismatch: (header) =>
		`the email in the ${header} token does not match the signed-in hub user`,
	audience: (header) =>
		`the token in the ${header} header was not issued for the kernel service; sign in with a token for its audience`,
};

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split('.');
	if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return;
	try {
		const json = Buffer.from(parts[1], 'base64url').toString('utf8');
		const claims: unknown = JSON.parse(json);
		return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
	} catch {
		return;
	}
}

/**
 * Read the end user's own token from the configured header. The hub never
 * verifies the signature (the external service does, on every request); it only
 * refuses tokens it already knows are unusable or belong to someone else.
 */
export function readEndUserCredential(
	request: Request,
	header: string,
	principal: EndUserPrincipal,
	now: number,
	audience?: string,
): ReadResult {
	const raw = request.headers.get(header)?.trim();
	if (!raw) return { rejection: 'missing' };
	const token = raw.replace(/^bearer[ \t]+/i, '');
	const claims = decodeJwtClaims(token);
	if (!claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
		return { rejection: 'malformed' };
	}
	const expiresAt = claims.exp * 1000;
	if (expiresAt - EXPIRY_SKEW_MS <= now) return { rejection: 'expired' };
	const email = principal.email.toLowerCase();
	if (typeof claims.email === 'string' && claims.email.toLowerCase() !== email) {
		return { rejection: 'email_mismatch' };
	}
	// A token for another client (a CLI's own audience) would only earn a 401.
	const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
	if (audience && !(Array.isArray(audiences) && audiences.includes(audience))) {
		return { rejection: 'audience' };
	}
	return { credential: { token, expiresAt, email } };
}

/**
 * The only credentials this adapter ever sends: each user's own token, read from
 * the request in progress. Nothing is kept between requests, so work outside a
 * request (the maintenance sweeps, timers) cannot reach a personal kernel.
 */
export class EndUserCredentials {
	private readonly context = new AsyncLocalStorage<RequestContext>();

	constructor(
		readonly header: string,
		private readonly now: () => number = Date.now,
		private readonly audience?: string,
	) {}

	run<T>(request: Request, principal: EndUserPrincipal, next: () => Promise<T>): Promise<T> {
		const read = readEndUserCredential(request, this.header, principal, this.now(), this.audience);
		return this.context.run({ userId: principal.userId, read }, next);
	}

	/** The credential for a proxied kernel request: the caller's own token from this request. */
	forRequest(request: Request, principal: EndUserPrincipal): EndUserCredential {
		const read = readEndUserCredential(request, this.header, principal, this.now(), this.audience);
		if ('rejection' in read) return this.unavailable(read.rejection);
		return read.credential;
	}

	/**
	 * The credential for an operation on `owner`'s sandbox: the token of the
	 * request in progress, which must be the owner's. A request from anyone else
	 * is refused before anything is sent.
	 */
	forOwner(owner: UserId | undefined): EndUserCredential {
		const context = this.context.getStore();
		if (!context) return this.unavailable(undefined);
		if (owner && context.userId !== owner) {
			throw new ForbiddenError(
				"This session runs in another user's personal kernel; only its owner can reach it.",
			);
		}
		return this.current(context);
	}

	/**
	 * The caller's own credential when a request from someone other than `owner`
	 * is in progress; undefined for the owner's own request and outside requests.
	 * Only the service's admin route accepts it for another user's kernel.
	 */
	foreignRequester(owner: UserId | undefined): EndUserCredential | undefined {
		const context = this.context.getStore();
		if (!context || !owner || context.userId === owner) return;
		return this.current(context);
	}

	private current(context: RequestContext): EndUserCredential {
		if ('rejection' in context.read) return this.unavailable(context.read.rejection);
		if (context.read.credential.expiresAt - EXPIRY_SKEW_MS <= this.now()) {
			return this.unavailable('expired');
		}
		return context.read.credential;
	}

	private unavailable(rejection: Rejection | undefined): never {
		const reason = rejection
			? REJECTION_DETAIL[rejection](this.header)
			: "no request from the kernel's owner is in progress";
		const message = `No end-user credential for the external kernel: ${reason}. The hub holds no service credential for external kernels.`;
		throw rejection === 'email_mismatch'
			? new ForbiddenError(message)
			: new UnavailableError(message);
	}
}
