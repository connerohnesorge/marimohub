import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServices, JobId, UnavailableError, ValidationError } from '@marimo-hub/core';
import type {
	KernelJobs,
	ManagedSessionEnvironment,
	ProjectId,
	SandboxProvider,
} from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const EDITOR = uid('editor-1');
const SCHEDULE = { cron: '0 6 * * *', timezone: 'Europe/Berlin' };
const CODE = 'import marimo\napp = marimo.App()\n';

describe("Jobs fired by their author's personal kernel", () => {
	let bucket: MemoryBucket;
	let services: ReturnType<typeof createServices>;
	let pid: ProjectId;
	let nid: string;
	let kernelJobs: { [K in keyof KernelJobs]: ReturnType<typeof vi.fn> & KernelJobs[K] };
	let compute: SandboxProvider;

	const as = (userId = ACTOR) => createTestApi({ bucket, userId, compute }).request;
	const base = () => `/projects/${pid}/notebooks/${nid}/jobs`;
	const keyOf = (id: string) => `${pid}.${nid}.${id}`;
	const stored = (id: string) => services.jobs.getJob(pid, nid as never, JobId.parse(id));

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		services = createServices(bucket);
		kernelJobs = {
			runsJobsOf: vi.fn(async () => true),
			register: vi.fn(async () => {}),
			unregister: vi.fn(async () => {}),
			environment: vi.fn((env: ManagedSessionEnvironment) => ({ env: env.vars })),
		} as never;
		compute = { create: () => ({}) as never, proxy: async () => null, kernelJobs };
		const project = await services.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		await services.projects.addMember(pid, { user_id: EDITOR }, 'editor', ACTOR);
		nid = (
			await services.notebooks.createNotebook(
				pid,
				{ title: 'nb', description: '', code: CODE },
				ACTOR,
			)
		).id;
	});

	async function createScheduled(body: Record<string, unknown> = {}) {
		return expectOk<any>(
			await as()('POST', base(), { name: 'nightly', schedule: SCHEDULE, ...body }),
			201,
		);
	}

	it("registers a scheduled job with the author's kernel, which the hub then never fires", async () => {
		const job = await createScheduled();

		expect(kernelJobs.runsJobsOf).toHaveBeenCalledWith({
			userId: ACTOR,
			email: expect.any(String),
		});
		expect(kernelJobs.register).toHaveBeenCalledWith(ACTOR, keyOf(job.id), {
			...SCHEDULE,
			enabled: true,
		});
		expect((await stored(job.id)).kernel_schedule).toBe(true);
		expect(job).not.toHaveProperty('kernel_schedule');
	});

	it('keeps jobs on the hub for authors without a kernel and for manual-only jobs', async () => {
		kernelJobs.runsJobsOf.mockResolvedValueOnce(false);
		const hubJob = await createScheduled();
		const manual = await expectOk<any>(await as()('POST', base(), { name: 'manual' }), 201);

		expect(kernelJobs.runsJobsOf).toHaveBeenCalledOnce();
		expect(kernelJobs.register).not.toHaveBeenCalled();
		expect((await stored(hubJob.id)).kernel_schedule).toBeUndefined();
		expect((await stored(manual.id)).kernel_schedule).toBeUndefined();
	});

	it('creates nothing when the kernel service cannot answer or register', async () => {
		kernelJobs.runsJobsOf.mockRejectedValueOnce(new UnavailableError('kernel service unreachable'));
		await expectError(await as()('POST', base(), { name: 'a', schedule: SCHEDULE }), 503);
		kernelJobs.register.mockRejectedValueOnce(new UnavailableError('kernel service unreachable'));
		await expectError(await as()('POST', base(), { name: 'b', schedule: SCHEDULE }), 503);

		expect(await services.jobs.listJobs(pid, nid as never)).toEqual([]);
	});

	it("lets other editors disable it but not reschedule it, and never calls the author's kernel", async () => {
		const job = await createScheduled();
		kernelJobs.register.mockClear();

		await expectError(
			await as(EDITOR)(
				'PATCH',
				`${base()}/${job.id}`,
				{ schedule: { ...SCHEDULE, cron: '0 7 * * *' } },
				{ 'if-match': job.updated_at },
			),
			409,
		);
		const disabled = await expectOk<any>(
			await as(EDITOR)(
				'PATCH',
				`${base()}/${job.id}`,
				{ enabled: false },
				{ 'if-match': job.updated_at },
			),
		);

		expect(disabled.enabled).toBe(false);
		expect(kernelJobs.runsJobsOf).toHaveBeenCalledOnce();
		expect(kernelJobs.register).not.toHaveBeenCalled();
	});

	it("re-registers the author's changes and takes the job back when the schedule goes", async () => {
		const job = await createScheduled();

		const disabled = await expectOk<any>(
			await as()(
				'PATCH',
				`${base()}/${job.id}`,
				{ enabled: false },
				{ 'if-match': job.updated_at },
			),
		);
		expect(kernelJobs.register).toHaveBeenLastCalledWith(ACTOR, keyOf(job.id), {
			...SCHEDULE,
			enabled: false,
		});

		await expectOk(
			await as()(
				'PATCH',
				`${base()}/${job.id}`,
				{ schedule: null },
				{ 'if-match': disabled.updated_at },
			),
		);
		expect(kernelJobs.unregister).toHaveBeenCalledWith(ACTOR, keyOf(job.id));
		expect((await stored(job.id)).kernel_schedule).toBeUndefined();
	});

	it('removes it from the kernel when the author deletes it', async () => {
		const job = await createScheduled();

		await expectOk(
			await as()('DELETE', `${base()}/${job.id}`, undefined, { 'if-match': job.updated_at }),
		);

		expect(kernelJobs.unregister).toHaveBeenCalledWith(ACTOR, keyOf(job.id));
	});

	describe('the run spec and run reports', () => {
		it('give the author the pinned files and environment, and 404 to anyone else', async () => {
			const job = await createScheduled({ parameters: { region: 'eu' } });

			const spec = await expectOk<any>(await as()('GET', `/jobs/${keyOf(job.id)}/run-spec`));

			expect(spec.notebook).toBe('notebook.py');
			const notebook = spec.files.find((file: { path: string }) => file.path === 'notebook.py');
			expect(Buffer.from(notebook.content_base64, 'base64').toString()).toBe(CODE);
			expect(spec.parameters).toEqual({ region: 'eu' });
			expect(spec.environment).toEqual({ env: expect.any(Object) });
			expect(spec.run_id).toMatch(/^run_/);
			await expectError(await as(EDITOR)('GET', `/jobs/${keyOf(job.id)}/run-spec`), 404);
			await expectError(await as()('GET', `/jobs/not-a-key/run-spec`), 404);
		});

		it("record a failed run naming integrations the author's kernel cannot serve", async () => {
			const job = await createScheduled();
			const refusal =
				'The integration "queries" (kind athena) is not available on your Kira kernel yet.';
			kernelJobs.environment.mockImplementationOnce(() => {
				throw new ValidationError(refusal);
			});

			const failed = await expectError(
				await as()('GET', `/jobs/${keyOf(job.id)}/run-spec`),
				422,
				'VALIDATION_ERROR',
			);

			expect(failed.message).toBe(refusal);
			const runs = await services.jobRuns.listRuns(pid, nid as never, JobId.parse(job.id));
			expect(runs).toMatchObject([
				{
					status: 'failed',
					runner: 'kernel',
					error: { code: 'VALIDATION_ERROR', message: refusal },
				},
			]);
		});

		it('refuse a disabled job or one that runs on the hub with 409', async () => {
			const job = await createScheduled({ enabled: false });
			kernelJobs.runsJobsOf.mockResolvedValueOnce(false);
			const hubJob = await createScheduled();

			await expectError(await as()('GET', `/jobs/${keyOf(job.id)}/run-spec`), 409);
			await expectError(await as()('GET', `/jobs/${keyOf(hubJob.id)}/run-spec`), 409);
		});

		it('record a reported run with its HTML, once per run id', async () => {
			const job = await createScheduled();
			const spec = await expectOk<any>(await as()('GET', `/jobs/${keyOf(job.id)}/run-spec`));
			const report = {
				run_id: spec.run_id,
				status: 'failed',
				started_at: '2026-10-05T06:00:00.000Z',
				finished_at: '2026-10-05T06:01:00.000Z',
				html_base64: Buffer.from('<p>out</p>').toString('base64'),
				error: 'cell 3 raised',
				version: spec.version,
			};

			const run = await expectOk<any>(
				await as()('POST', `/jobs/${keyOf(job.id)}/external-runs`, report),
				201,
			);
			const again = await expectOk<any>(
				await as()('POST', `/jobs/${keyOf(job.id)}/external-runs`, report),
				201,
			);

			expect(run).toMatchObject({
				run_id: spec.run_id,
				status: 'failed',
				trigger: 'schedule',
				source_version_id: spec.version,
				error: { code: 'KERNEL_RUN_FAILED', message: 'cell 3 raised' },
				output: { html_bytes: 10 },
			});
			expect(again.run_id).toBe(run.run_id);
			const html = await as()('GET', `${base()}/${job.id}/runs/${run.run_id}/html`);
			expect(await html.text()).toBe('<p>out</p>');
			await expectError(
				await as(EDITOR)('POST', `/jobs/${keyOf(job.id)}/external-runs`, report),
				404,
			);
		});
	});
});
