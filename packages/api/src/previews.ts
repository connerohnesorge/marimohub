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
	for (const session of await deps.services.sessions.listSessions(nid)) {
		if (session.status === 'starting') {
			complete = false;
			continue;
		}
		if (session.sandbox_reclaimed_at) continue;
		try {
			await deps.services.sessions.beginTerminating(pid, session.session_id);
			await sessionRetirer(deps).retire(session, { captureBeforeDestroy: false });
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
				record =
					!project || project.status === 'deleted' || !parent || parent.status === 'deleted'
						? await deps.services.previews.retire(record)
						: await deps.services.previews.reconcile(record, deps.sourceControl);
			}
			if (record.state !== 'active') await cleanupPreview(deps, record);
			else
				await deps.services.previews.prune(
					record,
					async (nid) =>
						(await deps.services.sessions.listSessions(nid)).some(
							(session) => !session.sandbox_reclaimed_at,
						),
					(pid, nid) => retirePreviewRuntime(deps, pid, nid),
				);
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
	const records = nid
		? await deps.services.previews.list(pid, nid)
		: (await deps.services.previews.all()).filter((item) => item.project_id === pid);
	for (const record of records)
		await cleanupPreview(deps, await deps.services.previews.retire(record));
}
