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

type Rejection = 'missing' | 'malformed' | 'expired' | 'email_mismatch';

type ReadResult = { credential: EndUserCredential } | { rejection: Rejection };

interface RequestContext {
	userId: UserId;
	read: ReadResult;
}

interface CacheEntry {
	credential: EndUserCredential;
	timer: ReturnType<typeof setTimeout>;
}

// A token this close to expiry could lapse in flight to the external service.
const EXPIRY_SKEW_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

const REJECTION_DETAIL: Record<Rejection, (header: string) => string> = {
	missing: (header) => `the request carried no ${header} header`,
	malformed: (header) => `the ${header} header is not a JWT with an exp claim`,
	expired: (header) => `the token in the ${header} header has expired`,
	email_mismatch: (header) =>
		`the email in the ${header} token does not match the signed-in hub user`,
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
	return { credential: { token, expiresAt, email } };
}

/**
 * The only credentials this adapter ever sends: each user's own token, taken
 * from their requests. A token stays in memory, keyed by hub user id, solely so
 * background work on that user's sandboxes (capture, idle teardown) can run
 * while it is unexpired. It is never persisted and is dropped at `exp`, and it
 * is never used while a request from anyone else is in progress.
 */
export class EndUserCredentials {
	private readonly context = new AsyncLocalStorage<RequestContext>();
	private readonly cache = new Map<UserId, CacheEntry>();

	constructor(
		readonly header: string,
		private readonly now: () => number = Date.now,
	) {}

	run<T>(request: Request, principal: EndUserPrincipal, next: () => Promise<T>): Promise<T> {
		const read = readEndUserCredential(request, this.header, principal, this.now());
		// Refresh only users who already drive a kernel, so the cache never grows
		// to every user who merely browses the hub.
		if ('credential' in read && this.cache.has(principal.userId)) {
			this.remember(principal.userId, read.credential);
		}
		return this.context.run({ userId: principal.userId, read }, next);
	}

	/**
	 * The credential for a proxied kernel request: always the caller's own token
	 * from this request, never a cached one.
	 */
	forRequest(request: Request, principal: EndUserPrincipal): EndUserCredential {
		const read = readEndUserCredential(request, this.header, principal, this.now());
		if ('rejection' in read) return this.unavailable(read.rejection);
		this.remember(principal.userId, read.credential);
		return read.credential;
	}

	/**
	 * The credential for an operation on `owner`'s sandbox: the owner's token from
	 * the owner's own request, or, with no request in progress (a background
	 * sweep), the owner's cached token. A request from anyone else is refused
	 * before anything is sent: their token cannot reach the owner's kernel, and
	 * the owner's cached token is never lent to them.
	 */
	forOwner(owner: UserId | undefined): EndUserCredential {
		const context = this.context.getStore();
		const userId = owner ?? context?.userId;
		if (context && userId && context.userId !== userId) {
			throw new ForbiddenError(
				"This session runs in another user's personal kernel; only its owner can reach it.",
			);
		}
		let rejection: Rejection | undefined;
		if (context && context.userId === userId) {
			if ('credential' in context.read) {
				const { credential } = context.read;
				if (credential.expiresAt - EXPIRY_SKEW_MS > this.now()) {
					this.remember(context.userId, credential);
					return credential;
				}
				rejection = 'expired';
			} else {
				rejection = context.read.rejection;
				// A token for someone else is a refusal, not a reason to use the cache.
				if (rejection === 'email_mismatch') this.unavailable(rejection);
			}
		}
		return (userId ? this.lookup(userId) : undefined) ?? this.unavailable(rejection);
	}

	/**
	 * The caller's own credential when a request from someone other than `owner`
	 * is in progress; undefined for the owner's own request and for background
	 * work. Only the service's admin route accepts it for another user's kernel.
	 */
	foreignRequester(owner: UserId | undefined): EndUserCredential | undefined {
		const context = this.context.getStore();
		if (!context || !owner || context.userId === owner) return;
		if ('rejection' in context.read) return this.unavailable(context.read.rejection);
		if (context.read.credential.expiresAt - EXPIRY_SKEW_MS <= this.now()) {
			return this.unavailable('expired');
		}
		return context.read.credential;
	}

	clear(): void {
		for (const entry of this.cache.values()) clearTimeout(entry.timer);
		this.cache.clear();
	}

	private lookup(userId: UserId): EndUserCredential | undefined {
		const entry = this.cache.get(userId);
		if (!entry) return;
		if (entry.credential.expiresAt - EXPIRY_SKEW_MS > this.now()) return entry.credential;
		this.forget(userId, entry);
		return;
	}

	private remember(userId: UserId, credential: EndUserCredential): void {
		const existing = this.cache.get(userId);
		if (existing && existing.credential.expiresAt >= credential.expiresAt) return;
		if (existing) clearTimeout(existing.timer);
		const entry: CacheEntry = {
			credential,
			timer: setTimeout(
				() => this.forget(userId, entry),
				Math.min(MAX_TIMER_MS, Math.max(0, credential.expiresAt - this.now())),
			),
		};
		entry.timer.unref?.();
		this.cache.set(userId, entry);
	}

	private forget(userId: UserId, entry: CacheEntry): void {
		clearTimeout(entry.timer);
		if (this.cache.get(userId) === entry) this.cache.delete(userId);
	}

	private unavailable(rejection: Rejection | undefined): never {
		const reason = rejection
			? REJECTION_DETAIL[rejection](this.header)
			: 'the kernel owner has no request in progress and no unexpired token in this hub process';
		const message = `No end-user credential for the external kernel: ${reason}. The hub holds no service credential for external kernels.`;
		throw rejection === 'email_mismatch'
			? new ForbiddenError(message)
			: new UnavailableError(message);
	}
}
