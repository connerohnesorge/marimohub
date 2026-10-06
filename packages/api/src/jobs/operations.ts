import {
	BadRequestError,
	ConflictError,
	createJobId,
	JobId,
	MAX_QUEUED_RUNS_PER_JOB,
	Millis,
	NotebookId,
	NotFoundError,
	ProjectId,
	ResourceExhaustedError,
	toPublicJobDefinition,
	withAbortSignal,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	JobDefinition,
	JobRun,
	JobSchedule,
	RunId,
} from '@marimo-hub/core';
import { validateJobSchedule } from '@marimo-hub/core/jobs';
import type { z } from 'zod';
import type { ApiDeps, JobsConfig } from '../context';
import { idempotentOperation } from '../idempotency';
import { appendAudit, errorMetadata, logEvent } from '../log';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor, MAX_PAGE_SIZE } from '../pagination';
import { assertProjectRole, loadAuthorizedNotebook, loadVisibleProject } from '../shared';
import type { CreateJobBody, TriggerRunBody, UpdateJobBody } from './schemas';

export function requireJobs(deps: ApiDeps): JobsConfig {
	if (!deps.jobs) throw new NotFoundError('Notebook jobs are not enabled on this deployment');
	return deps.jobs;
}

function jobLimits(deps: ApiDeps) {
	const config = requireJobs(deps);
	return {
		maxPerNotebook: config.maxPerNotebook,
		maxTimeoutSeconds: Millis.toSeconds(config.maxTimeoutMs),
	};
}

export async function authorizeJobNotebook(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
	action: 'project.read' | 'notebook.write',
) {
	requireJobs(deps);
	const project =
		action === 'notebook.write'
			? await assertProjectRole(deps.services.projects, pid, user, action, deps)
			: await loadVisibleProject(deps.services.projects, pid, user, deps);
	const notebook = await loadAuthorizedNotebook(deps, project, nid, user, action);
	return { project, notebook, user };
}

export type AuthorizedNotebook = Awaited<ReturnType<typeof authorizeJobNotebook>>;

export async function listNotebookJobs(
	deps: ApiDeps,
	pid: ProjectId,
	nid: NotebookId,
	query: { limit?: number; cursor?: string },
) {
	const cursor = decodeCursor(query.cursor);
	let after: { createdAt: string; jobId: JobId } | undefined;
	if (cursor) {
		if (!Number.isFinite(Date.parse(cursor[0])) || !JobId.is(cursor[1])) {
			throw new BadRequestError('Invalid pagination cursor');
		}
		after = { createdAt: cursor[0], jobId: JobId.parse(cursor[1]) };
	}
	const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const page = await deps.services.jobs.listJobsPage(pid, nid, limit, after);
	return {
		items: page.items.map(toPublicJobDefinition),
		next_cursor: page.next ? encodeCursor(page.next.createdAt, page.next.jobId) : null,
	};
}

/** The key a kernel service stores a hub job under: its project, notebook, and job ids. */
export function kernelJobKey(
	job: Pick<JobDefinition, 'project_id' | 'notebook_id' | 'id'>,
): string {
	return `${job.project_id}.${job.notebook_id}.${job.id}`;
}

export function parseKernelJobKey(
	key: string,
): { pid: ProjectId; nid: NotebookId; jid: JobId } | undefined {
	const [pid, nid, jid, ...rest] = key.split('.');
	if (rest.length > 0 || !ProjectId.is(pid) || !NotebookId.is(nid) || !JobId.is(jid)) return;
	return { pid, nid, jid };
}

/**
 * Whether the author's personal kernel should fire this schedule. Asked inside
 * the author's request; only a scheduled job of a notebook stored in the hub
 * qualifies, and unenrolled authors never reach the kernel service.
 */
async function runsInAuthorKernel(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	schedule: JobSchedule | undefined,
): Promise<boolean> {
	const kernelJobs = deps.compute.kernelJobs;
	if (!kernelJobs || !schedule) return false;
	if (!workspaceSourcePolicy(target.notebook.source).persistSessionEdits) return false;
	return kernelJobs.runsJobsOf({ userId: target.user.id, email: target.user.email });
}

function sameSchedule(a: JobSchedule | undefined, b: JobSchedule | undefined): boolean {
	return a?.cron === b?.cron && a?.timezone === b?.timezone;
}

export async function createNotebookJob(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	body: z.infer<typeof CreateJobBody>,
) {
	const pid = target.project.id;
	const nid = target.notebook.meta.id;
	const kernelJobs = deps.compute.kernelJobs;
	if (!kernelJobs || !(await runsInAuthorKernel(deps, target, body.schedule))) {
		return deps.services.jobs.createJob(pid, nid, body, target.user.id, jobLimits(deps));
	}
	// Registered first, so the job is never stored without someone to fire it.
	validateJobSchedule(body.schedule!);
	const id = createJobId();
	const key = kernelJobKey({ project_id: pid, notebook_id: nid, id });
	await kernelJobs.register(target.user.id, key, {
		cron: body.schedule!.cron,
		timezone: body.schedule!.timezone,
		enabled: body.enabled ?? true,
	});
	try {
		return await deps.services.jobs.createJob(pid, nid, body, target.user.id, jobLimits(deps), {
			id,
			kernelSchedule: true,
		});
	} catch (error) {
		await kernelJobs.unregister(target.user.id, key).catch((unregisterError: unknown) =>
			logEvent({
				level: 'warn',
				event: 'kernel_job_unregister_failed',
				project_id: pid,
				job_id: id,
				...errorMetadata(unregisterError),
			}),
		);
		throw error;
	}
}

export function updateNotebookJob(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	job: JobDefinition,
	body: z.infer<typeof UpdateJobBody>,
	expectedUpdatedAt?: string,
	signal?: AbortSignal,
) {
	return deps.services.jobRuns.withJobMutation(job, async () => {
		if (await deps.services.jobs.isDeleting(job))
			throw new NotFoundError(`Job ${job.id} not found`);
		signal?.throwIfAborted();
		const update = () =>
			deps.services.jobs.updateJob(
				target.project.id,
				target.notebook.meta.id,
				job.id,
				body,
				target.user.id,
				expectedUpdatedAt,
				jobLimits(deps),
			);
		const schedule = body.schedule === undefined ? job.schedule : (body.schedule ?? undefined);
		const enabled = body.enabled ?? job.enabled;
		const placementChanges = !sameSchedule(schedule, job.schedule) || enabled !== job.enabled;
		const kernelJobs = deps.compute.kernelJobs;
		if (!placementChanges || !kernelJobs) return update();
		if (target.user.id !== job.created_by) {
			// Disabling takes effect when the kernel asks for the run; a new schedule
			// would need the author's token to reach the kernel.
			if (job.kernel_schedule && !sameSchedule(schedule, job.schedule)) {
				throw new ConflictError(
					"Only this job's author can change its schedule: it runs in their personal kernel.",
				);
			}
			return update();
		}
		const key = kernelJobKey(job);
		if (await runsInAuthorKernel(deps, target, schedule)) {
			validateJobSchedule(schedule!);
			// The hub stops firing it before the kernel starts.
			if (!job.kernel_schedule) {
				await deps.services.jobs.setKernelSchedule(job.project_id, job.notebook_id, job.id, true);
			}
			try {
				await kernelJobs.register(target.user.id, key, { ...schedule!, enabled });
			} catch (error) {
				if (!job.kernel_schedule) {
					await deps.services.jobs.setKernelSchedule(
						job.project_id,
						job.notebook_id,
						job.id,
						false,
					);
				}
				throw error;
			}
			return update();
		}
		const updated = await update();
		if (!job.kernel_schedule) return updated;
		await kernelJobs.unregister(target.user.id, key);
		return deps.services.jobs.setKernelSchedule(job.project_id, job.notebook_id, job.id, false);
	});
}

/**
 * Remove a deleted job from its author's kernel. Best effort: a job the kernel
 * still fires is refused when it asks for the run.
 */
export async function unregisterKernelJob(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	job: JobDefinition,
): Promise<void> {
	const kernelJobs = deps.compute.kernelJobs;
	if (!kernelJobs || !job.kernel_schedule || user.id !== job.created_by) return;
	await kernelJobs.unregister(user.id, kernelJobKey(job)).catch((error: unknown) =>
		logEvent({
			level: 'warn',
			event: 'kernel_job_unregister_failed',
			project_id: job.project_id,
			job_id: job.id,
			...errorMetadata(error),
		}),
	);
}

export async function triggerJobRun(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	job: JobDefinition,
	body: z.infer<typeof TriggerRunBody> | undefined,
	request: { requestId?: string; method: string; path: string },
	signal?: AbortSignal,
	replay?: { scope: string; key?: string },
) {
	const { project, notebook, user } = target;
	return deps.services.jobRuns.withJobMutation(job, async () => {
		if (await deps.services.jobs.isDeleting(job))
			throw new NotFoundError(`Job ${job.id} not found`);
		signal?.throwIfAborted();
		const enqueue = async () => {
			const current = await deps.services.jobs.getJob(project.id, notebook.meta.id, job.id);
			const queued = (await deps.services.jobRuns.listActive()).filter(
				({ marker, run }) => marker.job_id === job.id && run?.status === 'queued',
			);
			if (queued.length >= MAX_QUEUED_RUNS_PER_JOB) {
				throw new ResourceExhaustedError(
					`Too many queued runs for this job (${MAX_QUEUED_RUNS_PER_JOB}); wait for the queue to drain.`,
				);
			}
			const config = requireJobs(deps);
			const requestedMs =
				current.timeout_seconds !== undefined
					? current.timeout_seconds * 1000
					: config.defaultTimeoutMs;
			signal?.throwIfAborted();
			const run = await deps.services.jobRuns.enqueue({
				job: current,
				trigger: 'manual',
				triggeredBy: user.id,
				parameters: body?.parameters ?? current.parameters,
				sourceVersionId: notebook.source.current_version_id ?? undefined,
				timeoutSeconds: Math.floor(Math.min(requestedMs, config.maxTimeoutMs) / 1000),
			});
			await appendAudit({ ...request, userId: user.id }, 'job.run.trigger', () =>
				deps.services.events.append({
					event: 'job.run.trigger',
					actor: user.id,
					project_id: project.id,
					notebook_id: notebook.meta.id,
					job_id: job.id,
					run_id: run.run_id,
				}),
			);
			return run;
		};
		if (!replay?.key) return enqueue();
		// Keep lookup, enqueue, and recording under the same distributed job claim.
		let created: JobRun | undefined;
		const runId = await idempotentOperation(deps, replay.scope, replay.key, async () => {
			created = await enqueue();
			return created.run_id;
		});
		return created ?? withAbortSignal(loadJobRun(deps, job, runId), signal);
	});
}

export async function loadJobRun(deps: ApiDeps, job: JobDefinition, rid: RunId) {
	const run = await deps.services.jobRuns.getRun(job.project_id, job.notebook_id, job.id, rid);
	if (run.job_id !== job.id) throw new NotFoundError(`Run ${rid} not found`);
	return run;
}
