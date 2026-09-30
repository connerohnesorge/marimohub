import type { Bucket } from '../../ports/bucket';
import type { SourceControlReader, SourceControlRegistry } from '../../ports/sourceControl';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { createNotebookId, createVersionId } from '../../ids';
import {
	BadRequestError,
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
} from '../../errors';
import { paths } from '../../paths';
import { sha256Hex } from '../../internal/sha256';
import { parseStored, readStored } from '../../schema';
import type { GitSource } from '../../schema';
import { mutateObject } from '../catalog/cas';
import { deleteByPrefix, listAllKeys } from '../catalog/storage';
import { AppPoolStore } from '../runtime/AppPoolStore';
import type { NotebookService } from './NotebookService';
import { buildVersion } from './notebookMeta';
import { toSyncedWorkspaceFileMap } from '../../integrations/remoteWorkspace';
import {
	PREVIEW_MAX_AGE_MS,
	PREVIEW_POLL_MS,
	PreviewRecordSchema,
	PreviewMaintenanceSchema,
	previewKey,
	previewPrefix,
	previewMaintenanceKey,
} from './notebookPreviews';
import type { NotebookPreview, PreviewCreate } from './notebookPreviews';

type RetireRuntime = (pid: ProjectId, nid: NotebookId) => Promise<boolean>;

export class NotebookPreviewService {
	constructor(
		private bucket: Bucket,
		private notebooks: NotebookService,
	) {}

	async get(pid: ProjectId, nid: NotebookId, id: string): Promise<NotebookPreview> {
		const key = previewKey(pid, nid, id);
		const object = await this.bucket.get(key);
		if (!object) throw new NotFoundError('Preview not found');
		return readStored(PreviewRecordSchema, object, key);
	}

	async list(pid: ProjectId, nid: NotebookId): Promise<NotebookPreview[]> {
		const keys = await listAllKeys(this.bucket, previewPrefix(pid, nid));
		const records: NotebookPreview[] = [];
		for (const key of keys) {
			const object = await this.bucket.get(key);
			if (object) records.push(await readStored(PreviewRecordSchema, object, key));
		}
		return records
			.filter((record) => record.state !== 'deleted')
			.sort((a, b) => b.created_at.localeCompare(a.created_at));
	}

	async source(
		pid: ProjectId,
		nid: NotebookId,
		registry?: SourceControlRegistry,
	): Promise<{ source: GitSource; reader: SourceControlReader }> {
		const notebook = await this.notebooks.getNotebook(pid, nid);
		const source = notebook.source;
		if (notebook.meta.status === 'deleted') throw new NotFoundError('Notebook not found');
		if (notebook.meta.preview || source.type !== 'git')
			throw new BadRequestError('Previews require a GitHub-connected notebook');
		const reader = registry?.getReader('github', pid);
		if (!reader?.previews || !reader.resolveCommit || !reader.supportsRepository(source.repo))
			throw new BadRequestError('Previews require a GitHub App connection');
		return { source, reader };
	}

	private mutate(
		record: Pick<NotebookPreview, 'project_id' | 'notebook_id' | 'id'>,
		update: (record: NotebookPreview) => NotebookPreview | null,
	) {
		const key = previewKey(record.project_id, record.notebook_id, record.id);
		return mutateObject(
			this.bucket,
			key,
			(raw) => parseStored(PreviewRecordSchema, raw, key),
			update,
		);
	}

	private mutateLeased(
		record: NotebookPreview,
		token: string,
		update: (record: NotebookPreview) => NotebookPreview,
	) {
		return this.mutate(record, (current) =>
			current.state === 'active' && current.lease?.token === token ? update(current) : null,
		);
	}

	async create(
		pid: ProjectId,
		nid: NotebookId,
		input: PreviewCreate,
		actor: UserId,
		registry?: SourceControlRegistry,
		idempotencyKey?: string,
	): Promise<NotebookPreview> {
		const { source } = await this.source(pid, nid, registry);
		const now = Date.now();
		const expires = input.expires_at ? Date.parse(input.expires_at) : now + 7 * 24 * 60 * 60_000;
		if (expires <= now || expires > now + PREVIEW_MAX_AGE_MS)
			throw new BadRequestError('Preview expiry must be within the next 30 days');
		const fingerprint = JSON.stringify(input);
		const id = idempotencyKey
			? (await sha256Hex(JSON.stringify([pid, nid, actor, idempotencyKey]))).slice(0, 32)
			: crypto.randomUUID().replaceAll('-', '');
		let record: NotebookPreview = {
			schema_version: 1,
			id,
			project_id: pid,
			notebook_id: nid,
			...input,
			repository: source.repo,
			root_path: source.root_path,
			entry_notebook: source.entry_notebook,
			expires_at: new Date(expires).toISOString(),
			created_by: actor,
			created_at: new Date(now).toISOString(),
			request_fingerprint: fingerprint,
			state: 'active',
			preparation: 'pending',
			runtime_ids: [],
			garbage_ids: [],
		};
		await this.bucket.put(
			previewMaintenanceKey(record),
			JSON.stringify({ project_id: pid, notebook_id: nid, id, created_at: record.created_at }),
		);
		try {
			await this.bucket.put(previewKey(pid, nid, id), JSON.stringify(record), {
				onlyIfNotExists: true,
			});
		} catch (error) {
			if (!(error instanceof PreconditionFailedError)) throw error;
			record = await this.get(pid, nid, id);
			if (record.request_fingerprint !== fingerprint || record.created_by !== actor)
				throw new ConflictError('Idempotency key already used for another preview request');
			if (record.state !== 'active') throw new ConflictError('This preview has been deleted');
		}
		return this.reconcile(record, registry, true);
	}

	async reconcile(
		record: NotebookPreview,
		registry?: SourceControlRegistry,
		force = false,
	): Promise<NotebookPreview> {
		if (record.state !== 'active') return record;
		if (Date.parse(record.expires_at) <= Date.now()) return this.retire(record);
		if (!force && record.checked_at && Date.now() - Date.parse(record.checked_at) < PREVIEW_POLL_MS)
			return record;
		const token = crypto.randomUUID();
		const claimed = await this.mutate(record, (current) => {
			if (current.state !== 'active' || (current.lease && current.lease.expires_at > Date.now()))
				return null;
			return {
				...current,
				preparation: 'preparing',
				lease: { token, expires_at: Date.now() + 600_000 },
			};
		});
		if (claimed.lease?.token !== token) return claimed;
		try {
			const { source, reader } = await this.source(record.project_id, record.notebook_id, registry);
			if (
				source.repo !== record.repository ||
				source.root_path !== record.root_path ||
				source.entry_notebook !== record.entry_notebook
			)
				throw new ConflictError('Notebook source configuration changed');
			if (record.pull_request) {
				if (!reader.getPullRequest)
					throw new BadRequestError('Pull request tracking is unavailable');
				const pr = await reader.getPullRequest(record.repository, record.pull_request);
				if (!pr.sameRepository) throw new BadRequestError('Fork previews are not supported');
				if (pr.state === 'closed') return await this.retire(record);
				if (record.source.type === 'branch' && record.source.branch !== pr.branch)
					throw new ConflictError('Preview branch does not match the pull request');
			}
			const commit =
				record.source.type === 'commit' && claimed.current
					? claimed.current.commit
					: record.source.type === 'branch'
						? (await reader.getBranchHead(record.repository, record.source.branch)).commit
						: (await reader.resolveCommit!(record.repository, record.source.commit)).commit;
			if (claimed.current?.commit === commit)
				return await this.mutateLeased(record, token, (current) => ({
					...current,
					preparation: 'ready',
					lease: undefined,
					error: undefined,
					checked_at: new Date().toISOString(),
				}));
			const runtimeId = createNotebookId();
			const reserved = await this.mutateLeased(record, token, (current) => ({
				...current,
				runtime_ids: [...current.runtime_ids, runtimeId],
			}));
			if (reserved.state !== 'active' || reserved.lease?.token !== token) return reserved;
			const files = toSyncedWorkspaceFileMap(
				await reader.fetchWorkspace(record.repository, commit, record.root_path),
			);
			if (!files.has(record.entry_notebook))
				throw new BadRequestError('The preview revision does not contain the configured notebook');
			const beforeWrite = await this.get(record.project_id, record.notebook_id, record.id);
			if (beforeWrite.state !== 'active' || beforeWrite.lease?.token !== token) return beforeWrite;
			const versionId = createVersionId();
			const nb = paths.project(record.project_id).notebook(runtimeId);
			const version = nb.version(versionId);
			const parent = await this.notebooks.getNotebook(record.project_id, record.notebook_id);
			const now = new Date().toISOString();
			await this.bucket.put(
				nb.meta,
				JSON.stringify({
					...parent.meta,
					id: runtimeId,
					preview: { notebook_id: record.notebook_id, preview_id: record.id },
					compute_profile: record.compute_profile,
					created_at: now,
					updated_at: now,
				}),
				{ onlyIfNotExists: true },
			);
			for (const [path, bytes] of files)
				await this.bucket.put(version.workspaceFile(path), bytes, { onlyIfNotExists: true });
			await this.bucket.put(
				version.meta,
				JSON.stringify(
					buildVersion({
						versionId,
						notebookId: runtimeId,
						now,
						author: record.created_by,
						message: `Preview ${commit}`,
						parentId: null,
						commit,
					}),
				),
				{ onlyIfNotExists: true },
			);
			await this.bucket.put(
				nb.source,
				JSON.stringify({
					...source,
					pending_config: undefined,
					sync_mode: 'push',
					branch: record.source.type === 'branch' ? record.source.branch : source.branch,
					commit,
					current_version_id: versionId,
					last_synced_at: now,
				}),
				{ onlyIfNotExists: true },
			);
			const published = await this.mutateLeased(record, token, (current) => ({
				...current,
				current: { notebook_id: runtimeId, version_id: versionId, commit },
				preparation: 'ready',
				error: undefined,
				lease: undefined,
				checked_at: now,
			}));
			if (published.current?.notebook_id !== runtimeId) await deleteByPrefix(this.bucket, nb.base);
			return published;
		} catch (error) {
			if (error instanceof NotFoundError) return this.retire(record);
			return this.mutateLeased(record, token, (current) => ({
				...current,
				preparation: 'failed',
				error: 'Unable to prepare the preview. Check the source and GitHub App access.',
				lease: undefined,
				checked_at: new Date().toISOString(),
			}));
		}
	}

	async retire(record: NotebookPreview): Promise<NotebookPreview> {
		const retired = await this.mutate(record, (current) =>
			current.state === 'active'
				? {
						...current,
						state: 'deleting',
						cleanup_after: Math.max(Date.now() + 900_000, current.lease?.expires_at ?? 0),
						lease: undefined,
					}
				: null,
		);
		for (const nid of [...retired.runtime_ids, ...retired.garbage_ids])
			await new AppPoolStore(this.bucket).retireForDeletion(retired.project_id, nid);
		return retired;
	}

	private async cleanupRuntime(pid: ProjectId, nid: NotebookId, retireRuntime: RetireRuntime) {
		await new AppPoolStore(this.bucket).retireForDeletion(pid, nid);
		if (!(await retireRuntime(pid, nid))) return false;
		await deleteByPrefix(this.bucket, paths.project(pid).notebook(nid).base);
		return true;
	}

	async cleanup(record: NotebookPreview, retireRuntime: RetireRuntime): Promise<void> {
		if (record.state === 'active') return;
		let complete = true;
		for (const nid of [...record.runtime_ids, ...record.garbage_ids]) {
			if (!(await this.cleanupRuntime(record.project_id, nid, retireRuntime))) complete = false;
		}
		if (complete) {
			await this.mutate(record, (current) => ({ ...current, state: 'deleted' }));
			if ((record.cleanup_after ?? Infinity) <= Date.now())
				await this.bucket.delete(previewMaintenanceKey(record));
		}
	}

	async prune(
		initial: NotebookPreview,
		hasRuntime: (nid: NotebookId) => Promise<boolean>,
		retireRuntime: RetireRuntime,
	): Promise<void> {
		let record = initial;
		if (record.state !== 'active' || record.lease) return;
		for (const nid of record.runtime_ids) {
			if (nid === record.current?.notebook_id || (await hasRuntime(nid))) continue;
			record = await this.mutate(record, (current) =>
				current.state === 'active' &&
				!current.lease &&
				nid !== current.current?.notebook_id &&
				current.runtime_ids.includes(nid)
					? {
							...current,
							runtime_ids: current.runtime_ids.filter((id) => id !== nid),
							garbage_ids: [...current.garbage_ids, nid],
						}
					: null,
			);
		}
		for (const nid of record.garbage_ids) {
			if (!(await this.cleanupRuntime(record.project_id, nid, retireRuntime))) continue;
			await this.mutate(record, (current) => ({
				...current,
				garbage_ids: current.garbage_ids.filter((id) => id !== nid),
			}));
		}
	}

	async all(): Promise<NotebookPreview[]> {
		const records: NotebookPreview[] = [];
		for (const key of await listAllKeys(this.bucket, '_system/preview-maintenance/')) {
			const object = await this.bucket.get(key);
			if (!object) continue;
			const marker = await readStored(PreviewMaintenanceSchema, object, key);
			const record = await this.get(marker.project_id, marker.notebook_id, marker.id).catch(
				(error) => {
					if (error instanceof NotFoundError) return null;
					throw error;
				},
			);
			if (record) records.push(record);
			else if (Date.now() - Date.parse(marker.created_at) > 86_400_000)
				await this.bucket.delete(key);
		}
		return records;
	}
}
