import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectId } from '@marimo-hub/core/ids';
import { GitLabPublisher } from '@marimo-hub/source-control-gitlab';
import { GitHubAppPublisher } from '@marimo-hub/source-control-github';
import { makeSourceControl } from './sourceControl';
import { buildConfigSummary } from './configSummary';

const projectId = ProjectId.parse('proj-0000000000000000');
const otherProject = ProjectId.parse('proj-1111111111111111');
const env = {
	MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN: 'fake-token',
	MARIMOHUB_SOURCE_CONTROL_GITLAB_BASE_URL: 'https://code.example.com',
};
const result = {
	number: 1,
	url: 'https://code.example.com/Team/group/repo/-/merge_requests/1',
	headBranch: 'change',
	headCommit: 'abc',
};
const input = {
	repository: 'https://code.example.com/Team/group/repo.git',
	baseBranch: 'main',
	baseCommit: 'abc',
	headBranch: 'change',
	title: 'Change',
	body: '',
	draft: true,
	changes: [],
};
function registry(policy: unknown) {
	return makeSourceControl({
		...env,
		MARIMOHUB_SOURCE_CONTROL_GITLAB_ALLOWED_REPOSITORIES: JSON.stringify(policy),
	}).sourceControl!;
}
afterEach(() => vi.restoreAllMocks());

describe('GitLab configuration', () => {
	it('registers GitLab independently and redacts its token', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sources = makeSourceControl(env).sourceControl!;
		expect(sources.publisherProviders()).toEqual(['gitlab']);
		expect(sources.readerProviders()).toEqual(['gitlab']);
		expect(sources.pullSourceProviders()).toEqual(['gitlab']);
		expect(sources.getReader('github')).toBeUndefined();
		expect(sources.getPublisher('gitlab')).toBe(sources.getReader('gitlab'));
		const summary = buildConfigSummary(env);
		expect(JSON.stringify(summary)).not.toContain(env.MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN);
		expect(
			summary.groups
				.flatMap((group) => group.settings)
				.find((setting) => setting.key === 'MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN'),
		).toMatchObject({ secret: true, set: true, value: null });
	});
	it('disables whitespace-only tokens', () => {
		expect(makeSourceControl({ MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN: ' \n ' })).toEqual({});
	});
	it.each([
		'http://code.example.com',
		'https://code.example.com/gitlab',
		'https://secret@code.example.com',
	])('rejects invalid instance %s without leaking credentials', (baseUrl) => {
		expect(() =>
			makeSourceControl({ ...env, MARIMOHUB_SOURCE_CONTROL_GITLAB_BASE_URL: baseUrl }),
		).toThrow('HTTPS origin');
	});
	it('reports an invalid token without including its value', () => {
		expect(() =>
			makeSourceControl({ ...env, MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN: 'secret value' }),
		).toThrow('Invalid GitLab access token.');
	});
	it.each([
		null,
		{},
		[{ resource: 'team/repo', projects: [] }],
		[{ resource: 'https://elsewhere.example/team/repo', projects: '*' }],
	])('rejects malformed or cross-instance policies (%j)', (policy) => {
		expect(() => registry(policy)).toThrow();
	});
});

describe('GitLab project policies', () => {
	it('guards every read and publishing operation before invoking the adapter', async () => {
		const head = vi
			.spyOn(GitLabPublisher.prototype, 'getBranchHead')
			.mockResolvedValue({ commit: 'abc' });
		const files = vi.spyOn(GitLabPublisher.prototype, 'fetchWorkspace').mockResolvedValue([]);
		const git = vi.spyOn(GitLabPublisher.prototype, 'fetchGitDirectory').mockResolvedValue([]);
		const open = vi.spyOn(GitLabPublisher.prototype, 'openChangeRequest').mockResolvedValue(result);
		const update = vi
			.spyOn(GitLabPublisher.prototype, 'updateChangeRequest')
			.mockResolvedValue(result);
		const sources = registry([{ resource: 'Team/group/repo', projects: [projectId] }]);
		const allowed = sources.getReader('gitlab', projectId)!;
		expect(allowed.supportsRepository(input.repository)).toBe(true);
		await allowed.getBranchHead(input.repository, 'main');
		await allowed.fetchWorkspace(input.repository, 'abc', '');
		await allowed.fetchGitDirectory!(input.repository, 'abc', 'main');
		await sources.getPublisher('gitlab', projectId)!.openChangeRequest(input);
		await sources.getPublisher('gitlab', projectId)!.updateChangeRequest!({
			...input,
			changeRequest: result,
		});
		for (const pid of [undefined, otherProject]) {
			const denied = sources.getReader('gitlab', pid)!;
			expect(() => denied.supportsRepository(input.repository)).toThrow('not allowed');
			await expect(denied.getBranchHead(input.repository, 'main')).rejects.toThrow('not allowed');
			await expect(denied.fetchWorkspace(input.repository, 'abc', '')).rejects.toThrow(
				'not allowed',
			);
			await expect(denied.fetchGitDirectory!(input.repository, 'abc', 'main')).rejects.toThrow(
				'not allowed',
			);
			await expect(sources.getPublisher('gitlab', pid)!.openChangeRequest(input)).rejects.toThrow(
				'not allowed',
			);
			await expect(
				sources.getPublisher('gitlab', pid)!.updateChangeRequest!({
					...input,
					changeRequest: result,
				}),
			).rejects.toThrow('not allowed');
		}
		await expect(allowed.getBranchHead('team/group/repo', 'main')).rejects.toThrow('not allowed');
		for (const call of [head, files, git, open, update]) expect(call).toHaveBeenCalledOnce();
	});
	it('supports deny-all and wildcard rules only on the configured instance', async () => {
		const sources = registry([{ resource: '*', projects: [projectId] }]);
		expect(sources.getReader('gitlab', projectId)!.supportsRepository(input.repository)).toBe(true);
		expect(
			sources.getReader('gitlab', projectId)!.supportsRepository('https://gitlab.com/team/repo'),
		).toBe(false);
		expect(() =>
			sources.getReader('gitlab', otherProject)!.supportsRepository(input.repository),
		).toThrow('not allowed');
		expect(() =>
			registry([]).getReader('gitlab', projectId)!.supportsRepository(input.repository),
		).toThrow('not allowed');
		expect(
			registry([{ resource: '*', projects: '*' }])
				.getReader('gitlab')!
				.supportsRepository(input.repository),
		).toBe(true);
	});
	it('preserves shared access and warns when no policy is set', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sources = makeSourceControl(env).sourceControl!;
		expect(sources.getReader('gitlab', otherProject)!.supportsRepository(input.repository)).toBe(
			true,
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('GITLAB_ALLOWED_REPOSITORIES is unset'),
		);
	});
	it('keeps GitHub and GitLab policies independent for the same repository path', async () => {
		const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
			.privateKey.export({ type: 'pkcs8', format: 'pem' })
			.toString();
		const github = vi
			.spyOn(GitHubAppPublisher.prototype, 'getBranchHead')
			.mockResolvedValue({ commit: 'github' });
		const gitlab = vi
			.spyOn(GitLabPublisher.prototype, 'getBranchHead')
			.mockResolvedValue({ commit: 'gitlab' });
		const sources = makeSourceControl({
			...env,
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: key,
			MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES: JSON.stringify([
				{ resource: 'team/repo', projects: [projectId] },
			]),
			MARIMOHUB_SOURCE_CONTROL_GITLAB_ALLOWED_REPOSITORIES: JSON.stringify([
				{ resource: 'team/repo', projects: [otherProject] },
			]),
		}).sourceControl!;
		expect(sources.pullSourceProviders()).toEqual(['github', 'gitlab']);
		await sources.getReader('github', projectId)!.getBranchHead('team/repo', 'main');
		await sources.getReader('gitlab', otherProject)!.getBranchHead('team/repo', 'main');
		await expect(
			sources.getReader('github', otherProject)!.getBranchHead('team/repo', 'main'),
		).rejects.toThrow('not allowed');
		await expect(
			sources.getReader('gitlab', projectId)!.getBranchHead('team/repo', 'main'),
		).rejects.toThrow('not allowed');
		expect(github).toHaveBeenCalledOnce();
		expect(gitlab).toHaveBeenCalledOnce();
	});
});
