import type { Bucket } from '../../ports/bucket';
import { execResult } from '../../ports/sandbox';
import type { SandboxFileWrite } from '../../ports/sandbox';
import type { NotebookId, ProjectId, VersionId } from '../../ids';
import { NotFoundError, ValidationError } from '../../errors';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import { paths } from '../../paths';
import type { NotebookService } from '../content/NotebookService';
import { restoreWorkspace } from './sandboxFiles';
import type { WorkspaceRestoreTarget } from './sandboxFiles';

/** These files travel base64-encoded in one JSON body. */
export const MAX_PINNED_FILES_BYTES = 32 * 1024 * 1024;

const ROOT = '/pinned';

export interface PinnedNotebookFiles {
	/** Workspace-relative path of the notebook to run. */
	notebook: string;
	version: VersionId;
	files: { path: string; content: Uint8Array }[];
}

/**
 * A notebook version as a file tree: the version's `notebook.py` and
 * `pyproject.toml` over the notebook's workspace mirror, the tree a hub app or
 * job sandbox starts from. Undefined for a notebook synced from Git, whose
 * tree only a hub sandbox can assemble.
 */
export async function pinnedNotebookFiles(
	bucket: Bucket,
	notebooks: Pick<NotebookService, 'getNotebookSource'>,
	projectId: ProjectId,
	notebookId: NotebookId,
	versionId?: VersionId,
	/** Paths the receiving backend owns: left out like the sandbox's own. */
	reservedPaths: readonly string[] = [],
): Promise<PinnedNotebookFiles | undefined> {
	const source = await notebooks.getNotebookSource(projectId, notebookId);
	if (!workspaceSourcePolicy(source).persistSessionEdits) return undefined;
	const version = versionId ?? source.current_version_id;
	if (!version) throw new NotFoundError(`Notebook ${notebookId} has no saved version`);

	const nb = paths.project(projectId).notebook(notebookId);
	const files = new Map<string, Uint8Array>();
	const encoder = new TextEncoder();
	// The workspace restore's path, size, and ignore rules decide the tree; this
	// sandbox only collects what it would write.
	const collector: WorkspaceRestoreTarget = {
		writeFiles: async (batch: readonly SandboxFileWrite[]) => {
			for (const file of batch) {
				const content =
					typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
				files.set(file.path.slice(ROOT.length + 1), content);
			}
		},
		exec: async () => execResult(true, '', ''),
		ensureDirectories: async () => {},
		reservedPaths,
	};
	await restoreWorkspace(collector, bucket, nb.workspacePrefix, ROOT, {
		excludeRelativeRoots: ['notebook.py', 'pyproject.toml'],
	});

	const pinned = nb.version(version);
	const code = await bucket.get(pinned.code);
	if (!code) throw new NotFoundError(`Version ${version} of notebook ${notebookId} not found`);
	files.set('notebook.py', await code.bytes());
	const deps = await bucket.get(pinned.deps);
	if (deps) files.set('pyproject.toml', await deps.bytes());

	let total = 0;
	for (const content of files.values()) total += content.byteLength;
	if (total > MAX_PINNED_FILES_BYTES) {
		throw new ValidationError(
			`The notebook's files total ${total} bytes, over the ${MAX_PINNED_FILES_BYTES}-byte limit for a kernel-run app or job`,
		);
	}
	return {
		notebook: 'notebook.py',
		version,
		files: [...files].map(([path, content]) => ({ path, content })),
	};
}
