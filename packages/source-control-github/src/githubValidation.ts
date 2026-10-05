import {
	validateBranch as validateGitBranch,
	validateChanges,
	validateCommitIdentity,
} from '@marimo-hub/source-control-commons';
export { coAuthorTrailer, refPath } from '@marimo-hub/source-control-commons';
import { ValidationError } from '@marimo-hub/core/errors';
import type {
	OpenChangeRequestInput,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';

export interface GitHubRepository {
	owner: string;
	repo: string;
}

export function parseRepository(value: unknown): GitHubRepository {
	if (typeof value !== 'string') throw new ValidationError('GitHub repository must be owner/repo');
	let path = value.trim();
	if (/^https:\/\//i.test(path)) {
		let url: URL;
		try {
			url = new URL(path);
		} catch {
			throw new ValidationError('Invalid GitHub repository URL');
		}
		if (
			url.hostname.toLowerCase() !== 'github.com' ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new ValidationError('GitHub publishing supports github.com repositories only');
		}
		path = url.pathname.replaceAll(/^\/+|\/+$/g, '');
	}
	const parts = path.replace(/\.git$/, '').split('/');
	const [owner, repo] = parts;
	if (
		parts.length !== 2 ||
		!owner ||
		!repo ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
		!/^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/.test(repo)
	) {
		throw new ValidationError('GitHub repository must be owner/repo');
	}
	return { owner, repo };
}

function validateCommonInput(
	input: OpenChangeRequestInput | UpdateChangeRequestInput,
): GitHubRepository {
	const repository = parseRepository(input.repository);
	validateBranch(input.baseBranch);
	validateChanges(input.changes);
	if (typeof input.baseCommit !== 'string' || input.baseCommit.length === 0) {
		throw new ValidationError('GitHub base commit is required');
	}
	if (typeof input.title !== 'string' || input.title.trim().length === 0) {
		throw new ValidationError('GitHub pull request title is required');
	}
	if (typeof input.body !== 'string') {
		throw new ValidationError('Invalid GitHub pull request metadata');
	}
	validateCommitIdentity(input.coAuthor);
	return repository;
}

export function validateOpenInput(input: OpenChangeRequestInput): GitHubRepository {
	const repository = validateCommonInput(input);
	validateBranch(input.headBranch);
	if (typeof input.draft !== 'boolean') {
		throw new ValidationError('Invalid GitHub pull request metadata');
	}
	return repository;
}

export function validateUpdateInput(input: UpdateChangeRequestInput): GitHubRepository {
	const repository = validateCommonInput(input);
	validateBranch(input.changeRequest.headBranch);
	return repository;
}

export function validateBranch(branch: unknown): asserts branch is string {
	validateGitBranch(branch, 'GitHub');
}
