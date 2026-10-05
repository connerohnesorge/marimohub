import fs from 'node:fs';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { ConflictError, UnavailableError } from '@marimo-hub/core/errors';
import type {
	OpenChangeRequestInput,
	SourceControlChange,
	SourceControlCommitIdentity,
} from '@marimo-hub/core/ports/source-control';
import {
	assertGitCheckoutLimits,
	assertGitDirectoryLimits,
	coAuthorTrailer,
	gitHttp,
} from '@marimo-hub/source-control-commons';
import type { GitLabClient } from './client';

type CommitMetadata = Pick<OpenChangeRequestInput, 'title' | 'body' | 'coAuthor'>;

function commitMessage(metadata: CommitMetadata): string {
	return [`${metadata.title}\n\n${metadata.body}`.trim(), coAuthorTrailer(metadata.coAuthor)]
		.filter(Boolean)
		.join('\n\n');
}

export class GitLabRepository {
	constructor(
		private readonly client: GitLabClient,
		private readonly dir: string,
		private readonly remoteUrl: string,
	) {}

	async fetchCommit(branch: string, commit: string): Promise<void> {
		const result = await git.fetch({
			fs,
			dir: this.dir,
			http: gitHttp(this.client.fetcher, this.remoteUrl),
			url: this.remoteUrl,
			ref: branch,
			remoteRef: commit,
			singleBranch: true,
			depth: 1,
			tags: false,
			headers: this.client.gitHeaders,
		});
		if (result.fetchHead !== commit)
			throw new UnavailableError('GitLab returned a different commit than requested');
		await git.checkout({ fs, dir: this.dir, ref: commit, force: true });
		await assertGitCheckoutLimits(this.dir, this.remoteUrl);
		await assertGitDirectoryLimits(join(this.dir, '.git'), this.remoteUrl);
	}

	async tree(parent: string, changes: readonly SourceControlChange[]): Promise<string> {
		const { commit } = await git.readCommit({ fs, dir: this.dir, oid: parent });
		return this.changeTree(commit.tree, changes);
	}

	private async changeTree(
		oid: string | undefined,
		changes: readonly SourceControlChange[],
	): Promise<string> {
		const entries = oid ? (await git.readTree({ fs, dir: this.dir, oid })).tree : [];
		const byName = new Map(entries.map((entry) => [entry.path, entry]));
		const nested = new Map<string, SourceControlChange[]>();
		for (const change of changes) {
			const slash = change.path.indexOf('/');
			if (slash !== -1) {
				const name = change.path.slice(0, slash);
				const children = nested.get(name) ?? [];
				children.push({ ...change, path: change.path.slice(slash + 1) });
				nested.set(name, children);
				continue;
			}
			const entry = byName.get(change.path);
			if (
				(change.operation === 'add' && entry) ||
				(change.operation !== 'add' &&
					(entry?.type !== 'blob' || !['100644', '100755'].includes(entry.mode)))
			) {
				throw new ConflictError(
					`GitLab base tree cannot apply ${change.operation} at ${change.path}`,
				);
			}
			if (change.operation === 'delete') byName.delete(change.path);
			else {
				const blob = await git.writeBlob({ fs, dir: this.dir, blob: change.content });
				byName.set(change.path, {
					path: change.path,
					mode: entry?.mode ?? '100644',
					type: 'blob',
					oid: blob,
				});
			}
		}
		for (const [name, children] of nested) {
			const entry = byName.get(name);
			if (entry && entry.type !== 'tree')
				throw new ConflictError(`GitLab base tree has no directory at ${name}`);
			const tree = await this.changeTree(entry?.oid, children);
			const remaining = await git.readTree({ fs, dir: this.dir, oid: tree });
			if (remaining.tree.length === 0) byName.delete(name);
			else byName.set(name, { path: name, mode: '040000', type: 'tree', oid: tree });
		}
		return git.writeTree({ fs, dir: this.dir, tree: [...byName.values()] });
	}

	async commit(
		parent: string,
		tree: string,
		title: string,
		body: string,
		identity: SourceControlCommitIdentity,
		coAuthor?: SourceControlCommitIdentity,
	): Promise<string> {
		const author = {
			...identity,
			timestamp: Math.floor(this.client.now() / 1000),
			timezoneOffset: 0,
		};
		const message = commitMessage({ title, body, coAuthor });
		return git.writeCommit({
			fs,
			dir: this.dir,
			commit: { tree, parent: [parent], author, committer: author, message },
		});
	}

	async hasParent(commitOid: string, parent: string): Promise<boolean> {
		const { commit } = await git.readCommit({ fs, dir: this.dir, oid: commitOid });
		return commit.parent.length === 1 && commit.parent[0] === parent;
	}

	async matches(
		commitOid: string,
		parent: string,
		tree: string,
		metadata: CommitMetadata,
		identity: SourceControlCommitIdentity,
	): Promise<boolean> {
		const { commit } = await git.readCommit({ fs, dir: this.dir, oid: commitOid });
		return (
			commit.parent.length === 1 &&
			commit.parent[0] === parent &&
			commit.tree === tree &&
			commit.message.trimEnd() === commitMessage(metadata) &&
			commit.committer.name === identity.name &&
			commit.committer.email === identity.email
		);
	}

	async push(branch: string, oid: string, expected: string | null, replace = false): Promise<void> {
		await git.writeRef({ fs, dir: this.dir, ref: `refs/heads/${branch}`, value: oid, force: true });
		let changed = false;
		try {
			const result = await git.push({
				fs,
				dir: this.dir,
				http: gitHttp(this.client.fetcher, this.remoteUrl),
				url: this.remoteUrl,
				ref: branch,
				remoteRef: branch,
				force: replace,
				headers: this.client.gitHeaders,
				onPrePush: ({ remoteRef }) => {
					changed = remoteRef.oid !== (expected ?? '0'.repeat(40));
					return !changed;
				},
			});
			if (!result.ok || !result.refs[`refs/heads/${branch}`]?.ok)
				throw new ConflictError('GitLab rejected the proposal branch update');
		} catch (error) {
			if (changed) throw new ConflictError('The GitLab proposal branch changed while publishing');
			throw error;
		}
	}
}
