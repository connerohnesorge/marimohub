import {
	createSandboxId,
	createSessionId,
	managedSessionEnvironment,
	pinnedNotebookFiles,
	sessionCompute,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	NotebookId,
	Project,
	Session,
	VersionId,
} from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';
import { mergeSessionEnv, resolveFederatedEnv, resolveIntegrationRender } from './sandboxEnv';

export interface KernelAppRequest {
	project: Project;
	notebookId: NotebookId;
	viewer: AuthenticatedPrincipal;
	versionId: VersionId;
	/** A viewer's throwaway: integrations and workload identity are withheld. */
	restricted: boolean;
	ephemeral: boolean;
	authorizationExpiresAt?: string;
	appBaseUrl: string;
}

/** Whether `session` is an app session that runs in its author's kernel runtime. */
export function isKernelApp(deps: Pick<ApiDeps, 'compute'>, session: Session): boolean {
	return (
		session.mode === 'app' &&
		session.compute_backend !== undefined &&
		session.compute_backend === deps.compute.kernelApps?.backend
	);
}

/**
 * Start the viewer's own session of an app in its author's kernel runtime, with
 * the viewer's token. Undefined sends the app to the hub's app pool: the author
 * is not enrolled, has no kernel, or the notebook is synced from Git. The hub's
 * access checks have already admitted the viewer; the session never joins a pool.
 */
export async function startKernelApp(
	deps: ApiDeps,
	input: KernelAppRequest,
): Promise<Session | undefined> {
	const kernelApps = deps.compute.kernelApps;
	const exposure = deps.sandbox.exposure;
	// The service is reachable only through the hub's proxy.
	if (!kernelApps || exposure?.mode !== 'proxy') return undefined;
	const { project, notebookId: nid, viewer, versionId } = input;
	const { notebooks, sessions, identities } = deps.services;
	const { version } = await notebooks.getVersion(project.id, nid, versionId);
	const author = await identities.get(version.author).catch(() => null);
	if (!author?.email || !kernelApps.mayRunAppsOf(author.email)) return undefined;
	const pinned = await pinnedNotebookFiles(deps.bucket, notebooks, project.id, nid, versionId);
	if (!pinned) return undefined;

	const sessionId = createSessionId();
	const sandboxId = createSandboxId();
	const workload = { kind: 'session' as const, id: sessionId };
	const [wifEnv, render] = await Promise.all([
		resolveFederatedEnv(deps, { project, workload, restricted: input.restricted }),
		resolveIntegrationRender(deps, {
			projectId: project.id,
			workload,
			principal: { userId: viewer.id, email: viewer.email },
			restricted: input.restricted,
		}),
	]);
	const env = render ? mergeSessionEnv(render, wifEnv ?? {}) : wifEnv;
	const started = await kernelApps.start({
		sandboxId,
		authorEmail: author.email,
		app: nid,
		version: versionId,
		notebook: pinned.notebook,
		files: pinned.files,
		environment: managedSessionEnvironment(env),
	});
	if (!started) return undefined;

	try {
		await sessions.createSession({
			session_id: sessionId,
			notebook_id: nid,
			project_id: project.id,
			user_id: viewer.id,
			sandbox_id: sandboxId,
			compute_backend: kernelApps.backend,
			ephemeral: input.ephemeral,
			mode: 'app',
			source_version_id: versionId,
			authorization_expires_at: input.authorizationExpiresAt,
		});
		const { clientUrl, originUrl } = await exposure.finalize(started.originUrl, {
			sessionId,
			projectId: project.id,
			notebookId: nid,
			sandboxId,
			appBaseUrl: input.appBaseUrl,
		});
		const lifetime = deps.sandbox.sessionLifetime;
		return await sessions.setRunning(
			project.id,
			sessionId,
			clientUrl,
			false,
			originUrl ?? started.originUrl,
			lifetime ? new Date(Date.now() + lifetime.maxLifetimeMs).toISOString() : undefined,
			render?.attachments,
		);
	} catch (error) {
		await sessionCompute(deps.compute, { compute_backend: kernelApps.backend })
			.create(sandboxId, { owner: { projectId: project.id, userId: viewer.id } })
			.destroy()
			.catch((closeError: unknown) =>
				logEvent({
					level: 'warn',
					event: 'kernel_app_close_failed',
					project_id: project.id,
					session_id: sessionId,
					...errorMetadata(closeError),
				}),
			);
		throw error;
	}
}
