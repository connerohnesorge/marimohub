import {
	exchangeFederatedStorageSessionEnv,
	mergeSessionNetworks,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core';
import type {
	JobDefinition,
	Project,
	ProjectId,
	RunId,
	SessionEnv,
	SessionRender,
	UserId,
	WorkloadRef,
} from '@marimo-hub/core';
import type { JobRunContext } from '@marimo-hub/core/jobs';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';

/**
 * The credential layers a sandbox receives before its kernel (or a job's
 * export) starts. Shared by the session create route and the job runner so the
 * two injection paths cannot drift: a job runs the same notebook code with the
 * same resolved secrets an app session would carry.
 */

/** `add` wins variable collisions, and its AWS credentials take precedence. */
export function mergeSessionEnv(base: SessionEnv | undefined, add: SessionEnv): SessionEnv {
	const network = mergeSessionNetworks(base?.network, add.network);
	return {
		files: [...(base?.files ?? []), ...(add.files ?? [])],
		vars: { ...base?.vars, ...add.vars },
		defaults: { ...base?.defaults, ...add.defaults },
		...(network ? { network } : {}),
	};
}

export interface FederatedVarsOptions {
	project: Project;
	workload: WorkloadRef;
	/** True for a viewer's throwaway sandbox: never federated credentials. */
	restricted: boolean;
	onError?: (err: unknown) => void;
}

/**
 * WIF: best-effort project-scoped federated S3 creds. A federation/policy gap
 * yields no creds, never a failed sandbox. The JWT and creds are never logged.
 */
export async function resolveFederatedEnv(
	deps: Pick<ApiDeps, 'wif'>,
	options: FederatedVarsOptions,
): Promise<SessionEnv | undefined> {
	if (!(deps.wif && options.project.federation?.enabled && !options.restricted)) return;
	try {
		return await exchangeFederatedStorageSessionEnv(
			deps.wif.issuer,
			deps.wif.issuerUrl,
			deps.wif.target,
			options.project.id,
			options.workload,
		);
	} catch (err) {
		options.onError?.(err);
		return;
	}
}

export interface IntegrationRenderOptions {
	projectId: ProjectId;
	workload: WorkloadRef;
	principal: { userId: UserId; email: string };
	restricted: boolean;
	onRendered?: (render: SessionRender) => void;
	onError?: (err: unknown) => void;
}

/**
 * Integrations FAIL CLOSED — a configured data source is load-bearing, so a
 * render failure aborts provisioning rather than starting a sandbox with
 * partial config. Only curated validation errors are safe to return to a caller.
 */
export async function resolveIntegrationRender(
	deps: Pick<ApiDeps, 'integrations'>,
	options: IntegrationRenderOptions,
): Promise<SessionRender | undefined> {
	if (!(deps.integrations && !options.restricted)) return;
	try {
		const render = await deps.integrations.resolveForSession(options.projectId, {
			workload: options.workload,
			principal: options.principal,
		});
		if (render) options.onRendered?.(render);
		return render;
	} catch (err) {
		options.onError?.(err);
		if (err instanceof ValidationError) throw err;
		throw new UnavailableError(
			'integration_render_failed: could not render this project’s integrations',
		);
	}
}

/**
 * The job runner's env: the same two layers an app session gets, attributed to
 * the run and to the principal the run acts for (the manual triggerer, else
 * the job's author). Integrations stay the lower-precedence base.
 */
export async function resolveJobSandboxEnv(
	deps: Pick<ApiDeps, 'wif' | 'integrations' | 'services'>,
	context: JobRunContext,
): Promise<SessionEnv | undefined> {
	const { run, job, project } = context;
	return resolveJobRunEnv(deps, {
		project,
		job,
		runId: run.run_id,
		userId: run.triggered_by ?? job.created_by,
	});
}

/** A job run's env, attributed to the run and to the principal it acts for. */
export async function resolveJobRunEnv(
	deps: Pick<ApiDeps, 'wif' | 'integrations' | 'services'>,
	input: { project: Project; job: JobDefinition; runId: RunId; userId: UserId },
): Promise<SessionEnv | undefined> {
	const { project, job, runId, userId } = input;
	const identity = await deps.services.identities.get(userId).catch(() => null);
	const fields = { project_id: project.id, job_id: job.id, run_id: runId };
	const [wifEnv, render] = await Promise.all([
		resolveFederatedEnv(deps, {
			project,
			workload: { kind: 'job-run', id: runId },
			restricted: false,
			onError: (err) =>
				logEvent({
					level: 'warn',
					event: 'job_wif_exchange_failed',
					...fields,
					...errorMetadata(err),
				}),
		}),
		resolveIntegrationRender(deps, {
			projectId: project.id,
			workload: { kind: 'job-run', id: runId },
			principal: { userId, email: identity?.email ?? '' },
			restricted: false,
			onRendered: (rendered) => {
				if (rendered.warnings.length > 0) {
					logEvent({
						level: 'warn',
						event: 'job_integration_warnings',
						...fields,
						integration_warning_count: rendered.warnings.length,
					});
				}
			},
			onError: (err) =>
				logEvent({
					level: 'error',
					event: 'job_integration_render_failed',
					...fields,
					...errorMetadata(err),
				}),
		}),
	]);
	if (render) return mergeSessionEnv(render, wifEnv ?? {});
	return wifEnv;
}
