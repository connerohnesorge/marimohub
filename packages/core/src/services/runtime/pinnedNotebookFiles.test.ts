import { describe, expect, it, vi } from 'vitest';
import { paths } from '../../paths';
import { ACTOR, setupTestEnv } from '../../testing';
import type { Source } from '../../schema';
import { MAX_PINNED_FILES_BYTES, pinnedNotebookFiles } from './pinnedNotebookFiles';

describe('pinnedNotebookFiles', () => {
	async function notebook() {
		const env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'p', description: '' }, ACTOR);
		const created = await env.notebooks.createNotebook(
			project.id,
			{ title: 'nb', description: '', code: 'import marimo  # v1' },
			ACTOR,
		);
		const nb = paths.project(project.id).notebook(created.id);
		return { env, pid: project.id, nid: created.id, nb };
	}

	const text = (files: { path: string; content: Uint8Array }[], path: string) => {
		const file = files.find((f) => f.path === path);
		return file && new TextDecoder().decode(file.content);
	};

	it("lays the version's notebook over the workspace mirror, skipping Git hooks", async () => {
		const { env, pid, nid, nb } = await notebook();
		await env.bucket.put(nb.workspaceFile('data/input.csv'), 'a,b\n');
		await env.bucket.put(nb.workspaceFile('notebook.py'), 'mirror copy, never sent');
		await env.bucket.put(nb.workspaceFile('.git/hooks/pre-commit'), 'never restored');

		const pinned = await pinnedNotebookFiles(env.bucket, env.notebooks, pid, nid);

		expect(pinned?.notebook).toBe('notebook.py');
		expect(text(pinned!.files, 'notebook.py')).toBe('import marimo  # v1');
		expect(text(pinned!.files, 'data/input.csv')).toBe('a,b\n');
		expect(pinned!.files.map((f) => f.path)).not.toContain('.git/hooks/pre-commit');
	});

	it('is undefined for a notebook synced from Git', async () => {
		const { env, pid, nid } = await notebook();
		vi.spyOn(env.notebooks, 'getNotebookSource').mockResolvedValue({
			type: 'git',
			current_version_id: null,
		} as unknown as Source);

		await expect(pinnedNotebookFiles(env.bucket, env.notebooks, pid, nid)).resolves.toBeUndefined();
	});

	it('refuses a tree too large to send inline', async () => {
		const { env, pid, nid, nb } = await notebook();
		const big = new Uint8Array(MAX_PINNED_FILES_BYTES / 4);
		for (const name of ['a', 'b', 'c', 'd', 'e']) {
			await env.bucket.put(nb.workspaceFile(`${name}.bin`), big);
		}

		await expect(pinnedNotebookFiles(env.bucket, env.notebooks, pid, nid)).rejects.toThrow(
			/over the .*-byte limit/,
		);
	});
});
