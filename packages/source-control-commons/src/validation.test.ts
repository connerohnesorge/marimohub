import { describe, expect, it } from 'vitest';
import { validateBranch, validateChanges } from './validation';

describe('source-control input validation', () => {
	it.each(['main', 'feature/notebook', 'unicode-α'])('accepts branch %s', (branch) => {
		expect(() => validateBranch(branch)).not.toThrow();
	});
	it.each(['-option', '../main', 'a.lock', 'a/.hidden', 'bad name', 'a@{b', 'a\\b'])(
		'rejects branch %s',
		(branch) => {
			expect(() => validateBranch(branch)).toThrow();
		},
	);
	it.each(['../secret', '/absolute', '.git/config', 'dir/.GIT/config'])(
		'rejects unsafe change path %s',
		(path) => {
			expect(() => validateChanges([{ path, operation: 'delete' }])).toThrow();
		},
	);
});
