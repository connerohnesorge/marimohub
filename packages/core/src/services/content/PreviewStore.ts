import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId } from '../../ids';
import { ConflictError, NotFoundError, ResourceExhaustedError } from '../../errors';
import { readStored, ProjectIdSchema, NotebookIdSchema } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import { PreviewRecordSchema, PreviewIdSchema } from './notebookPreviews';
import type { NotebookPreview } from './notebookPreviews';

export const PREVIEW_LIMITS = {
	projectsPerTick: 4,
	perProject: 25,
	receiptsPerProject: 1000,
	bytesPerProject: 500 * 1024 * 1024,
	revisionsPerPreview: 12,
	concurrency: 4,
	concurrencyPerProject: 1,
	attemptMs: 120_000,
	idempotencyMs: 7 * 86_400_000,
} as const;
const Epoch = z.number().describe('Milliseconds since the Unix epoch.');
export const PreviewProjectSchema = z.object({
	entries: z.array(
		z.object({
			intent: PreviewRecordSchema,
			artifacts: z.array(
				z.object({ notebook_id: NotebookIdSchema, bytes: z.number().nonnegative() }),
			),
		}),
	),
});
export const PreviewReceiptsSchema = z.object({
	entries: z.array(
		z.object({
			key: z.string(),
			fingerprint: z.string(),
			id: PreviewIdSchema,
			created_at: z.iso.datetime(),
			expires_at: Epoch,
			deleted: z.boolean(),
		}),
	),
});
export const PreviewWorkSchema = z.object({
	cursor: z.string().optional(),
	claims: z.array(
		z.object({
			project_id: ProjectIdSchema,
			preview_id: PreviewIdSchema,
			token: z.string(),
			expires_at: Epoch,
		}),
	),
});
export const previewProjectPrefix = '_system/preview-projects/';
export const previewProjectKey = (pid: ProjectId) => `${previewProjectPrefix}${pid}.json`;
export const previewReceiptsKey = (pid: ProjectId) => `_system/preview-receipts/${pid}.json`;
export const previewWorkKey = '_system/preview-work.json';
export const previewCleanupCursorKey = '_system/preview-cleanup-cursor.json';
export const PreviewCursorSchema = z.object({ cursor: z.string().optional() });

export class PreviewStore {
	constructor(private readonly bucket: Bucket) {}

	private async change<T, R>(
		key: string,
		schema: z.ZodType<T>,
		initial: T,
		apply: (value: T) => R,
	): Promise<R> {
		return withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			const value = object ? await readStored(schema, object, key) : structuredClone(initial);
			const result = apply(value);
			await cas.put(
				key,
				JSON.stringify(value),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return result;
		});
	}

	async project(pid: ProjectId) {
		const key = previewProjectKey(pid);
		const object = await this.bucket.get(key);
		return object ? readStored(PreviewProjectSchema, object, key) : { entries: [] };
	}

	async receipt(pid: ProjectId, key: string, fingerprint: string) {
		return this.change(
			previewReceiptsKey(pid),
			PreviewReceiptsSchema,
			{ entries: [] },
			(record) => {
				record.entries = record.entries.filter((entry) => entry.expires_at > Date.now());
				const existing = record.entries.find((entry) => entry.key === key);
				if (existing) {
					if (existing.fingerprint !== fingerprint)
						throw new ConflictError('Idempotency key already used for another preview request');
					if (existing.deleted) throw new ConflictError('This preview has been deleted');
					return existing;
				}
				if (record.entries.length >= PREVIEW_LIMITS.receiptsPerProject)
					throw new ResourceExhaustedError('Preview idempotency receipt limit reached');
				const entry = {
					key,
					fingerprint,
					id: crypto.randomUUID().replaceAll('-', ''),
					created_at: new Date().toISOString(),
					expires_at: Date.now() + PREVIEW_LIMITS.idempotencyMs,
					deleted: false,
				};
				record.entries.push(entry);
				return entry;
			},
		);
	}

	async pruneReceipts(pid: ProjectId, deletedId?: string) {
		await this.change(previewReceiptsKey(pid), PreviewReceiptsSchema, { entries: [] }, (record) => {
			record.entries = record.entries.filter((entry) => entry.expires_at > Date.now());
			for (const entry of record.entries) if (entry.id === deletedId) entry.deleted = true;
		});
	}

	async reserve(intent: NotebookPreview): Promise<NotebookPreview> {
		return this.change(
			previewProjectKey(intent.project_id),
			PreviewProjectSchema,
			{ entries: [] },
			(record) => {
				const existing = record.entries.find((entry) => entry.intent.id === intent.id);
				if (existing) return existing.intent;
				// A delayed create must not restore membership after deletion and cleanup.
				if (Date.now() - Date.parse(intent.created_at) >= 60_000)
					throw new ConflictError('Preview creation expired; retry with a new idempotency key');
				if (record.entries.length >= PREVIEW_LIMITS.perProject)
					throw new ResourceExhaustedError(
						'Project preview limit reached, including previews awaiting cleanup',
					);
				record.entries.push({ intent, artifacts: [] });
				return intent;
			},
		);
	}

	async reserveArtifact(
		record: NotebookPreview,
		nid: NotebookId,
		bytes: number,
		expiresAt = Infinity,
	) {
		await this.change(
			previewProjectKey(record.project_id),
			PreviewProjectSchema,
			{ entries: [] },
			(project) => {
				const entry = project.entries.find((item) => item.intent.id === record.id);
				if (entry?.intent.state !== 'active') throw new NotFoundError('Preview not found');
				if (expiresAt <= Date.now()) throw new ConflictError('Preview preparation lease expired');
				if (entry.artifacts.some((item) => item.notebook_id === nid)) return;
				if (entry.artifacts.length >= PREVIEW_LIMITS.revisionsPerPreview)
					throw new ResourceExhaustedError('Preview revision limit reached; waiting for cleanup');
				const total = project.entries
					.flatMap((item) => item.artifacts)
					.reduce((sum, item) => sum + item.bytes, 0);
				if (total + bytes > PREVIEW_LIMITS.bytesPerProject)
					throw new ResourceExhaustedError('Project preview storage limit reached');
				entry.artifacts.push({ notebook_id: nid, bytes });
			},
		);
	}

	async commitArtifactBytes(record: NotebookPreview, nid: NotebookId, bytes: number) {
		await this.change(
			previewProjectKey(record.project_id),
			PreviewProjectSchema,
			{ entries: [] },
			(project) => {
				const artifact = project.entries
					.find((entry) => entry.intent.id === record.id)
					?.artifacts.find((item) => item.notebook_id === nid);
				if (!artifact) throw new NotFoundError('Preview artifact reservation not found');
				if (bytes > artifact.bytes)
					throw new ResourceExhaustedError('Preview exceeded its artifact reservation');
				artifact.bytes = bytes;
			},
		);
	}

	async markCleaned(record: NotebookPreview) {
		await this.change(
			previewProjectKey(record.project_id),
			PreviewProjectSchema,
			{ entries: [] },
			(project) => {
				const entry = project.entries.find((item) => item.intent.id === record.id);
				if (entry) entry.intent = { ...record, state: 'deleted' };
			},
		);
	}

	async releaseArtifact(record: NotebookPreview, nid: NotebookId) {
		await this.change(
			previewProjectKey(record.project_id),
			PreviewProjectSchema,
			{ entries: [] },
			(project) => {
				const entry = project.entries.find((item) => item.intent.id === record.id);
				if (entry) entry.artifacts = entry.artifacts.filter((item) => item.notebook_id !== nid);
			},
		);
	}

	async forget(record: NotebookPreview) {
		await this.pruneReceipts(record.project_id, record.id);
		await this.change(
			previewProjectKey(record.project_id),
			PreviewProjectSchema,
			{ entries: [] },
			(project) => {
				project.entries = project.entries.filter((entry) => entry.intent.id !== record.id);
			},
		);
	}

	async projectPage(cursor?: string) {
		const page = await this.bucket.list({
			prefix: previewProjectPrefix,
			startAfter: cursor,
			limit: PREVIEW_LIMITS.projectsPerTick,
		});
		return {
			projects: page.objects.map(
				(object) => object.key.slice(previewProjectPrefix.length, -5) as ProjectId,
			),
			cursor: page.truncated ? page.objects.at(-1)?.key : undefined,
		};
	}

	async nextProjects(lane: 'prepare' | 'cleanup'): Promise<ProjectId[]> {
		const key = lane === 'prepare' ? previewWorkKey : previewCleanupCursorKey;
		return withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			const schema = lane === 'prepare' ? PreviewWorkSchema : PreviewCursorSchema;
			const record = object
				? await readStored(schema, object, key)
				: { cursor: undefined, claims: [] };
			const page = await this.projectPage(record.cursor);
			await cas.put(
				key,
				JSON.stringify({ ...record, cursor: page.cursor }),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return page.projects;
		});
	}

	async claim(pid: ProjectId, id: string) {
		return this.change(previewWorkKey, PreviewWorkSchema, { claims: [] }, (record) => {
			record.claims = record.claims.filter((entry) => entry.expires_at > Date.now());
			if (
				record.claims.length >= PREVIEW_LIMITS.concurrency ||
				record.claims.filter((entry) => entry.project_id === pid).length >=
					PREVIEW_LIMITS.concurrencyPerProject
			)
				return;
			const claim = {
				project_id: pid,
				preview_id: id,
				token: crypto.randomUUID(),
				expires_at: Date.now() + PREVIEW_LIMITS.attemptMs,
			};
			record.claims.push(claim);
			return claim;
		});
	}

	async release(token: string) {
		await this.change(previewWorkKey, PreviewWorkSchema, { claims: [] }, (record) => {
			record.claims = record.claims.filter((entry) => entry.token !== token);
		});
	}
}
