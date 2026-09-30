import { logOperationalError, NotFoundError } from '@marimo-hub/core';
import type { NotebookPreview } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { sessionRetirer } from './shared';

export async function cleanupPreview(deps: ApiDeps, record: NotebookPreview): Promise<void> {
	await deps.services.previews.cleanup(record, (pid, nid) => retirePreviewRuntime(deps, pid, nid));
}

async function retirePreviewRuntime(
	deps: ApiDeps,
	pid: NotebookPreview['project_id'],
	nid: NotebookPreview['notebook_id'],
): Promise<boolean> {
	let complete = true;
	for (const session of await deps.services.sessions.listByProject(pid, nid)) {
		if (
			session.status === 'starting' &&
			Date.now() - Date.parse(session.started_at) <
				Math.max(deps.sandbox.startupTimeoutMs ?? 900_000, 900_000)
		) {
			complete = false;
			continue;
		}
		if (session.sandbox_reclaimed_at) continue;
		try {
			const result = await deps.services.sessions.beginTerminating(pid, session.session_id);
			if (!result.transitioned && result.session.status === 'terminating') {
				complete = false;
				continue;
			}
			if (result.session.sandbox_reclaimed_at) continue;
			await sessionRetirer(deps).retire(result.session, { captureBeforeDestroy: false });
			if (!(await deps.services.sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at)
				complete = false;
		} catch (error) {
			complete = false;
			logOperationalError(
				'preview_cleanup_failed',
				{ operation: 'preview.cleanup', session_id: session.session_id },
				error,
			);
		}
	}
	return complete;
}

export async function sweepPreviews(deps: ApiDeps): Promise<void> {
	for (let record of await deps.services.previews.all()) {
		try {
			if (record.state === 'active') {
				const project = await deps.services.projects
					.getProject(record.project_id)
					.catch((error) => {
						if (error instanceof NotFoundError) return null;
						throw error;
					});
				const parent = await deps.services.notebooks
					.getNotebookMeta(record.project_id, record.notebook_id)
					.catch((error) => {
						if (error instanceof NotFoundError) return null;
						throw error;
					});
				if (
					!project ||
					project.status === 'deleted' ||
					!parent ||
					parent.status === 'deleted' ||
					Date.parse(record.expires_at) <= Date.now()
				)
					record = await deps.services.previews.retire(record);
				else if (deps.sourceControl)
					record = await deps.services.previews.reconcile(record, deps.sourceControl);
			}
			if (record.state !== 'active') await cleanupPreview(deps, record);
			else {
				record = await deps.services.previews.reapAdmissions(record, async (sid) => {
					try {
						return !(await deps.services.sessions.getSession(record.project_id, sid))
							.sandbox_reclaimed_at;
					} catch (error) {
						if (error instanceof NotFoundError) return;
						throw error;
					}
				});
				await deps.services.previews.prune(
					record,
					async (nid) =>
						(await deps.services.sessions.listByProject(record.project_id, nid)).some(
							(session) => !session.sandbox_reclaimed_at,
						),
					(pid, nid) => retirePreviewRuntime(deps, pid, nid),
				);
			}
		} catch (error) {
			logOperationalError(
				'preview_reconciliation_failed',
				{ operation: 'preview.reconcile', preview_id: record.id },
				error,
			);
		}
	}
}

export async function retireNotebookPreviews(
	deps: ApiDeps,
	pid: NotebookPreview['project_id'],
	nid?: NotebookPreview['notebook_id'],
): Promise<void> {
	const logFailure = (error: unknown, previewId?: string) =>
		logOperationalError(
			'preview_retirement_failed',
			{ operation: 'preview.retire', project_id: pid, notebook_id: nid, preview_id: previewId },
			error,
		);
	let records: NotebookPreview[];
	try {
		records = nid
			? await deps.services.previews.list(pid, nid)
			: (await deps.services.previews.all()).filter((item) => item.project_id === pid);
	} catch (error) {
		logFailure(error);
		return;
	}
	for (const record of records) {
		try {
			await cleanupPreview(deps, await deps.services.previews.retire(record));
		} catch (error) {
			logFailure(error, record.id);
		}
	}
}
