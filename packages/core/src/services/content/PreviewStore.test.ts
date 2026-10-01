import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { createNotebookId, createProjectId } from '../../ids';
import { ACTOR } from '../../testing/fixtures';
import { ConflictError, NotFoundError, ResourceExhaustedError } from '../../errors';
import {
	PreviewStore,
	PREVIEW_LIMITS,
	previewProjectKey,
	previewReceiptsKey,
} from './PreviewStore';
import { PreviewRecordSchema } from './notebookPreviews';

function fixture() {
	const bucket = new MemoryBucket();
	const store = new PreviewStore(bucket);
	const pid = createProjectId();
	const intent = (id = crypto.randomUUID().replaceAll('-', '')) =>
		PreviewRecordSchema.parse({
			schema_version: 1,
			id,
			project_id: pid,
			notebook_id: createNotebookId(),
			name: 'Preview',
			source: { type: 'branch', branch: 'feature' },
			repository: 'owner/repo',
			root_path: '',
			entry_notebook: 'app.py',
			created_by: ACTOR,
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 86400000).toISOString(),
			request_fingerprint: 'request',
			state: 'active',
			preparation: 'pending',
			runtime_ids: [],
		});
	return { bucket, store, pid, intent };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('PreviewStore membership and receipts', () => {
	it('reserves a single membership under concurrent retries', async () => {
		const { store, pid, intent } = fixture();
		const record = intent();
		const results = await Promise.all([store.reserve(record), store.reserve(record)]);
		expect(results).toEqual([record, record]);
		expect((await store.project(pid)).entries).toHaveLength(1);
	});

	it('enforces project capacity under concurrent creation and retains deleting slots', async () => {
		const { store, pid, intent } = fixture();
		for (let i = 0; i < PREVIEW_LIMITS.perProject - 1; i++) await store.reserve(intent());
		const results = await Promise.allSettled([store.reserve(intent()), store.reserve(intent())]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(
			(results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
		).toBeInstanceOf(ResourceExhaustedError);
		const record = (await store.project(pid)).entries[0].intent;
		await store.markCleaned(record);
		await expect(store.reserve(intent())).rejects.toThrow(ResourceExhaustedError);
		await store.forget(record);
		await expect(store.reserve(intent())).resolves.toBeDefined();
	});

	it('fences a delayed create after its membership has been reclaimed', async () => {
		const { store, intent } = fixture();
		const record = intent();
		await store.reserve(record);
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse(record.created_at) + 60000);
		expect(await store.reserve(record)).toEqual(record);
		await store.forget(record);
		await expect(store.reserve(record)).rejects.toThrow(ConflictError);
	});

	it('replays receipts, rejects changed requests and retains deletion until expiry', async () => {
		const { store, pid } = fixture();
		const first = await store.receipt(pid, 'key', 'one');
		expect(await store.receipt(pid, 'key', 'one')).toEqual(first);
		await expect(store.receipt(pid, 'key', 'two')).rejects.toThrow(ConflictError);
		await store.pruneReceipts(pid, first.id);
		await expect(store.receipt(pid, 'key', 'one')).rejects.toThrow('deleted');
		vi.spyOn(Date, 'now').mockReturnValue(first.expires_at);
		const next = await store.receipt(pid, 'key', 'two');
		expect(next.id).not.toBe(first.id);
	});

	it('bounds receipt history independently and prunes it without listing previews', async () => {
		const { store, bucket, pid } = fixture();
		const first = await store.receipt(pid, 'key', 'one');
		await bucket.put(
			previewReceiptsKey(pid),
			JSON.stringify({
				entries: Array.from({ length: PREVIEW_LIMITS.receiptsPerProject }, (_, i) => ({
					...first,
					key: String(i),
				})),
			}),
		);
		await expect(store.receipt(pid, 'overflow', 'one')).rejects.toThrow(ResourceExhaustedError);
		vi.spyOn(Date, 'now').mockReturnValue(first.expires_at);
		await store.pruneReceipts(pid);
		expect(await (await bucket.get(previewReceiptsKey(pid)))!.json()).toEqual({ entries: [] });
		const reads = vi.spyOn(bucket, 'get');
		await store.project(pid);
		expect(reads).toHaveBeenCalledExactlyOnceWith(previewProjectKey(pid));
	});
});

describe('PreviewStore artifact quotas', () => {
	it('charges reservations before uploads and releases only explicitly reclaimed artifacts', async () => {
		const { store, pid, intent } = fixture();
		const record = intent();
		await store.reserve(record);
		const nid = createNotebookId();
		await store.reserveArtifact(record, nid, PREVIEW_LIMITS.bytesPerProject);
		await store.reserveArtifact(record, nid, PREVIEW_LIMITS.bytesPerProject);
		await expect(store.reserveArtifact(record, createNotebookId(), 1)).rejects.toThrow(
			ResourceExhaustedError,
		);
		await expect(
			store.commitArtifactBytes(record, nid, PREVIEW_LIMITS.bytesPerProject + 1),
		).rejects.toThrow(ResourceExhaustedError);
		await store.commitArtifactBytes(record, nid, 100);
		await store.reserveArtifact(record, createNotebookId(), 1);
		await store.releaseArtifact(record, nid);
		expect((await store.project(pid)).entries[0].artifacts).toHaveLength(1);
		await expect(store.commitArtifactBytes(record, nid, 0)).rejects.toThrow(NotFoundError);
		await store.forget(record);
		await store.releaseArtifact(record, nid);
		await expect(store.reserveArtifact(record, nid, 1)).rejects.toThrow(NotFoundError);
	});

	it('bounds revision count even for zero-byte artifacts', async () => {
		const { store, intent } = fixture();
		const record = intent();
		await store.reserve(record);
		for (let i = 0; i < PREVIEW_LIMITS.revisionsPerPreview; i++)
			await store.reserveArtifact(record, createNotebookId(), 0);
		await expect(store.reserveArtifact(record, createNotebookId(), 0)).rejects.toThrow(
			ResourceExhaustedError,
		);
	});

	it('shares the byte budget across previews and competing workers', async () => {
		const { store, intent } = fixture();
		const a = await store.reserve(intent());
		const b = await store.reserve(intent());
		const results = await Promise.allSettled([
			store.reserveArtifact(a, createNotebookId(), PREVIEW_LIMITS.bytesPerProject),
			store.reserveArtifact(b, createNotebookId(), PREVIEW_LIMITS.bytesPerProject),
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
	});
});

describe('PreviewStore scheduling', () => {
	it('enforces global and per-project concurrency, recovers leases, and fences stale releases', async () => {
		const { store, pid } = fixture();
		const id = 'a'.repeat(32);
		const first = (await store.claim(pid, id))!;
		expect(await store.claim(pid, 'b'.repeat(32))).toBeUndefined();
		for (let i = 1; i < PREVIEW_LIMITS.concurrency; i++)
			expect(await store.claim(createProjectId(), id)).toBeDefined();
		expect(await store.claim(createProjectId(), id)).toBeUndefined();
		vi.spyOn(Date, 'now').mockReturnValue(first.expires_at);
		const replacement = (await store.claim(pid, id))!;
		await store.release(first.token);
		expect(await store.claim(pid, id)).toBeUndefined();
		await store.release(replacement.token);
		expect(await store.claim(pid, id)).toBeDefined();
	});

	it('rotates bounded project pages independently for preparation and cleanup', async () => {
		const { store, intent } = fixture();
		const projects = [];
		for (let i = 0; i < PREVIEW_LIMITS.projectsPerTick + 1; i++) {
			const record = { ...intent(), project_id: createProjectId() };
			await store.reserve(record);
			projects.push(record.project_id);
		}
		const first = await store.nextProjects('prepare');
		expect(first).toHaveLength(PREVIEW_LIMITS.projectsPerTick);
		expect(await store.nextProjects('cleanup')).toEqual(first);
		const second = await store.nextProjects('prepare');
		expect([...first, ...second].sort()).toEqual(projects.sort());
		expect(await store.nextProjects('prepare')).toEqual(first);
	});
});

it('rejects delayed artifact reservations after lease expiry or cleanup', async () => {
	const { store, intent } = fixture();
	const record = await store.reserve(intent());
	await expect(store.reserveArtifact(record, createNotebookId(), 1, Date.now())).rejects.toThrow(
		ConflictError,
	);
	await store.markCleaned(record);
	await expect(store.reserveArtifact(record, createNotebookId(), 1)).rejects.toThrow(NotFoundError);
});
