import { managedSessionEnvironment, sessionCompute, sessionOwner } from '@marimo-hub/core';
import type { Session, SessionEnv } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';

/** Re-send this long before credentials expire (at 80% of their remaining life). */
const REFRESH_AT = 0.8;
const MIN_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 60_000;

/** The earliest time a credential in `env` stops working. */
export function sessionEnvExpiry(env: SessionEnv | undefined): number | undefined {
	const expiries = (env?.network?.aws ?? []).flatMap(({ expiresAt }) =>
		expiresAt && Number.isFinite(Date.parse(expiresAt)) ? [Date.parse(expiresAt)] : [],
	);
	return expiries.length > 0 ? Math.min(...expiries) : undefined;
}

export interface EnvironmentRefresh {
	deps: Pick<ApiDeps, 'compute' | 'services'>;
	session: Pick<Session, 'project_id' | 'session_id'>;
	/** Renders the session's environment again, with fresh federated credentials. */
	resolve: () => Promise<SessionEnv | undefined>;
	now?: () => number;
}

/**
 * Keep a delivered session environment valid: before its earliest credential
 * expires, render it again and replace the workspace environment. The timer
 * lives in the API process that started the session, which holds the owner's
 * token; it stops once the session is no longer live.
 */
export function scheduleEnvironmentRefresh(refresh: EnvironmentRefresh, expiresAt: number): void {
	const now = refresh.now ?? Date.now;
	const delay = Math.max(MIN_DELAY_MS, Math.floor((expiresAt - now()) * REFRESH_AT));
	const timer = setTimeout(() => void refreshEnvironment(refresh, expiresAt), delay);
	timer.unref?.();
}

async function refreshEnvironment(refresh: EnvironmentRefresh, expiresAt: number): Promise<void> {
	const { deps } = refresh;
	const { project_id: pid, session_id: sid } = refresh.session;
	const now = refresh.now ?? Date.now;
	try {
		const session = await deps.services.sessions.getSession(pid, sid);
		if ((session.status !== 'running' && session.status !== 'starting') || !session.sandbox_id) {
			return;
		}
		const env = await refresh.resolve();
		const sandbox = sessionCompute(deps.compute, session).create(session.sandbox_id, {
			owner: sessionOwner(session),
		});
		await sandbox.applyEnvironment?.(managedSessionEnvironment(env));
		const next = sessionEnvExpiry(env);
		if (next !== undefined) scheduleEnvironmentRefresh(refresh, next);
	} catch (error) {
		logEvent({
			level: 'warn',
			event: 'session_environment_refresh_failed',
			project_id: pid,
			session_id: sid,
			...errorMetadata(error),
		});
		if (now() < expiresAt) {
			const timer = setTimeout(
				() => void refreshEnvironment(refresh, expiresAt),
				Math.min(RETRY_DELAY_MS, Math.max(1, expiresAt - now())),
			);
			timer.unref?.();
		}
	}
}
