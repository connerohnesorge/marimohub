import { isSafeWorkspacePath } from '@marimo-hub/core/remote-workspace';
import { ValidationError } from '@marimo-hub/core/errors';
import type {
	OpenChangeRequestInput,
	SourceControlCommitIdentity,
} from '@marimo-hub/core/ports/source-control';

function hasForbiddenGitRefCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x20 || codeUnit === 0x7f || '~^:?*[\\'.includes(value[index] ?? '')) {
			return true;
		}
	}
	return false;
}

export function validateBranch(branch: unknown, provider = 'Git'): asserts branch is string {
	if (typeof branch !== 'string') throw new ValidationError(`Invalid ${provider} branch name`);
	const components = branch.split('/');
	if (
		branch.length === 0 ||
		branch === '@' ||
		branch.startsWith('-') ||
		hasForbiddenGitRefCharacter(branch) ||
		branch.startsWith('/') ||
		branch.endsWith('/') ||
		branch.endsWith('.') ||
		branch.includes('..') ||
		branch.includes('//') ||
		branch.includes('@{') ||
		components.some((component) => component.startsWith('.') || component.endsWith('.lock'))
	) {
		throw new ValidationError(`Invalid ${provider} branch name`);
	}
}

export function refPath(value: string): string {
	return value.split('/').map(encodeURIComponent).join('/');
}

export function validateChanges(
	changes: unknown,
): asserts changes is OpenChangeRequestInput['changes'] {
	if (!Array.isArray(changes) || changes.length === 0) {
		throw new ValidationError('A pull request requires at least one change');
	}
	const paths = new Set<string>();
	for (const change of changes) {
		if (!isRecord(change) || typeof change.path !== 'string') {
			throw new ValidationError('Invalid source-control change');
		}
		if (
			!isSafeWorkspacePath(change.path) ||
			change.path.split('/').some((part) => part.toLowerCase() === '.git')
		) {
			throw new ValidationError(`Invalid repository path: ${change.path}`);
		}
		if (paths.has(change.path)) {
			throw new ValidationError(`Duplicate repository path: ${change.path}`);
		}
		paths.add(change.path);
		if (
			typeof change.operation !== 'string' ||
			!['add', 'modify', 'delete'].includes(change.operation)
		) {
			throw new ValidationError(`Invalid operation for ${change.path}`);
		}
		if (change.operation !== 'delete' && !(change.content instanceof Uint8Array)) {
			throw new ValidationError(`Missing content for ${change.path}`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnsafeCommitIdentityCharacter(value: string): boolean {
	if (/[<>\u2028\u2029]/u.test(value)) return true;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
	}
	return false;
}

export function validateCommitIdentity(
	value: unknown,
): asserts value is SourceControlCommitIdentity | undefined {
	if (value === undefined) return;
	if (!isRecord(value) || typeof value.name !== 'string' || typeof value.email !== 'string') {
		throw new ValidationError('Invalid source-control commit co-author');
	}
	if (
		value.name.length === 0 ||
		value.name.length > 256 ||
		value.name !== value.name.trim() ||
		hasUnsafeCommitIdentityCharacter(value.name)
	) {
		throw new ValidationError('Invalid source-control commit co-author name');
	}
	const at = value.email.indexOf('@');
	if (
		value.email.length > 320 ||
		at <= 0 ||
		at !== value.email.lastIndexOf('@') ||
		at === value.email.length - 1 ||
		/\s/u.test(value.email) ||
		hasUnsafeCommitIdentityCharacter(value.email)
	) {
		throw new ValidationError('Invalid source-control commit co-author email');
	}
}

export function coAuthorTrailer(coAuthor: SourceControlCommitIdentity | undefined): string {
	validateCommitIdentity(coAuthor);
	return coAuthor ? `Co-authored-by: ${coAuthor.name} <${coAuthor.email}>` : '';
}
