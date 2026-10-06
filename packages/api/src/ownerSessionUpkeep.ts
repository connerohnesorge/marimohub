import {
	SessionLifecycleService,
	managedSessionEnvironment,
	sessionCompute,
	sessionOwner,
} from '@marimo-hub/core';
import type { Project, Session, SessionEnv, SessionId, SweepResult } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';
import { mergeSessionEnv, resolveFederatedEnv, resolveIntegrationRender } from './sandboxEnv';

/** Send credentials again at 80% of their remaining life. */
const REFRESH_AT = 0.8;
const MIN_REFRESH_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 60_000;

/** Upkeep in flight in this process, so overlapping requests do not repeat it. */
const attending = new Set<SessionId>();

/**
 * Whether only requests from the session's owner can reach its sandbox. The
 * maintenance sweeps skip such sessions; `attendOwnerSession` keeps them.
 */
export function needsOwnerRequests(deps: Pick<ApiDeps, 'compute'>, session: Session): boolean {
	try {
		return sessionCompute(deps.compute, session).capabilities?.requestCredentials === true;
	} catch {
		return false;
	}
}

/** When a delivered environment must be sent again, or undefined if nothing in it expires. */
export function environmentRefreshAt(
	env: SessionEnv | undefined,
	now = Date.now(),
): string | undefined {
	const expiries = (env?.network?.aws ?? []).flatMap(({ expiresAt }) =>
		expiresAt && Number.isFinite(Date.parse(expiresAt)) ? [Date.parse(expiresAt)] : [],
	);
	if (expiries.length === 0) return undefined;
	const delay = Math.floor((Math.min(...expiries) - now) * REFRESH_AT);
	return new Date(now + Math.max(MIN_REFRESH_DELAY_MS, delay)).toISOString();
}

export interface OwnerRequest {
	project: Project;
	user: { id: string; email: string };
	session: Session;
	/** Save now instead of on the snapshot cadence: the owner's editor is leaving. */
	saveNow?: boolean;
}

/**
 * Run the session upkeep the maintenance sweep would, inside the owner's own
 * request and with its token: save on the snapshot cadence, extend or end the
 * session at its deadline, settle a session that already ended, and send
 * expiring credentials again. Requests from anyone else do nothing. The work
 * continues after the response; failures are logged.
 */
export function attendOwnerSession(deps: ApiDeps, request: OwnerRequest): void {
	const { session, user } = request;
	if (session.user_id !== user.id || !needsOwnerRequests(deps, session)) return;
	if (attending.has(session.session_id)) return;
	attending.add(session.session_id);
	const task = attend(deps, request)
		.catch((error: unknown) =>
			logEvent({
				level: 'warn',
				event: 'owner_session_upkeep_failed',
				project_id: session.project_id,
				session_id: session.session_id,
				...errorMetadata(error),
			}),
		)
		.finally(() => attending.delete(session.session_id));
	if (deps.backgroundTasks) deps.backgroundTasks.defer(task);
	else void task;
}

/**
 * Settle the owner's ended session before a new one takes its editor claim:
 * its kernel kept the notebook, and only this request can capture it.
 */
export async function settleOwnerSession(deps: ApiDeps, session: Session): Promise<SweepResult> {
	return lifecycle(deps).attend(session);
}

async function attend(deps: ApiDeps, request: OwnerRequest): Promise<void> {
	const { project, user, session } = request;
	await lifecycle(deps).attend(session, { saveNow: request.saveNow });
	await refreshEnvironmentIfDue(deps, project, user, session);
}

/**
 * Without a configured lifetime nothing expires or snapshots on a cadence, so
 * upkeep only settles ended sessions and saves for a leaving editor.
 */
function lifecycle(deps: ApiDeps): SessionLifecycleService {
	const lifetime = deps.sandbox.sessionLifetime;
	return new SessionLifecycleService(
		deps.services.sessions,
		deps.services.notebooks,
		deps.compute,
		deps.bucket,
		{
			idleTimeoutMsByMode: lifetime?.idleTimeoutMsByMode ?? { edit: Infinity, app: Infinity },
			snapshotIntervalMs: lifetime?.snapshotIntervalMs ?? 0,
			extensionMs: lifetime?.extensionMs ?? 0,
			connectionAware: lifetime?.connectionAware ?? false,
			persistWorkspace: deps.sandbox.persistWorkspace,
			automaticThumbnails: deps.sandbox.automaticThumbnails,
			thumbnailDeadline: deps.sandbox.thumbnailDeadline,
			workdir: deps.sandbox.workdir,
		},
	);
}

async function refreshEnvironmentIfDue(
	deps: ApiDeps,
	project: Project,
	user: OwnerRequest['user'],
	session: Session,
): Promise<void> {
	const now = Date.now();
	const due = session.environment_refresh_at;
	if (!due || Date.parse(due) > now || !session.sandbox_id) return;
	const { sessions } = deps.services;
	const retryAt = new Date(now + RETRY_DELAY_MS).toISOString();
	if (!(await sessions.claimEnvironmentRefresh(project.id, session.session_id, now, retryAt))) {
		return;
	}
	const workload = { kind: 'session' as const, id: session.session_id };
	const restricted = session.ephemeral === true;
	let federationError: Error | undefined;
	const [wifEnv, integrationEnv] = await Promise.all([
		resolveFederatedEnv(deps, {
			project,
			workload,
			restricted,
			onError: (error) => {
				federationError = error instanceof Error ? error : new Error(String(error));
			},
		}),
		resolveIntegrationRender(deps, {
			projectId: project.id,
			workload,
			principal: { userId: session.user_id, email: user.email },
			restricted,
		}),
	]);
	// A partial environment would withdraw credentials that still work.
	if (federationError !== undefined) throw federationError;
	const env = integrationEnv ? mergeSessionEnv(integrationEnv, wifEnv ?? {}) : wifEnv;
	const sandbox = sessionCompute(deps.compute, session).create(session.sandbox_id, {
		owner: sessionOwner(session),
	});
	await sandbox.applyEnvironment?.(managedSessionEnvironment(env));
	await sessions.scheduleEnvironmentRefresh(
		project.id,
		session.session_id,
		environmentRefreshAt(env),
	);
}
