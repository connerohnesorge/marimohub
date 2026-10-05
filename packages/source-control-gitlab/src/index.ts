import {
	BadRequestError,
	ConflictError,
	ProposalRetryRequiredError,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core/errors';
import { markSourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type {
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	SourceControlPublisher,
	SourceControlPublishStage,
	SourceControlReader,
	SourceControlCommitIdentity,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';
import {
	collectTarballWorkspace,
	materializeGitDirectory,
	validateBranch,
	validateChanges,
	validateCommit,
	validateCommitIdentity,
	validateRootPath,
	withGitCheckout,
} from '@marimo-hub/source-control-commons';
import { GitLabClient, parseGitLabRepository, record, responseJson, stringField } from './client';
import type { GitLabOptions, GitLabRuntime } from './client';
import { GitLabRepository } from './repository';

export { gitLabBaseUrl, parseGitLabRepository } from './client';
export type { GitLabOptions, GitLabRuntime } from './client';

interface MergeRequest {
	number: number;
	url: string;
	headBranch: string;
	baseBranch: string;
	state: string;
	draft: boolean;
}

export class GitLabPublisher implements SourceControlReader, SourceControlPublisher {
	readonly provider = 'gitlab' as const;
	private readonly client: GitLabClient;

	constructor(options: GitLabOptions, runtime: GitLabRuntime = {}) {
		this.client = new GitLabClient(options, runtime);
	}

	private path(repository: string): string {
		return parseGitLabRepository(repository, this.client.baseUrl);
	}
	private api(repository: string): string {
		return `/projects/${encodeURIComponent(this.path(repository))}`;
	}
	private remote(repository: string): string {
		return `${this.client.baseUrl}/${this.path(repository)}.git`;
	}

	supportsRepository(repository: string): boolean {
		try {
			this.path(repository);
			return true;
		} catch {
			return false;
		}
	}

	private async head(repository: string, branch: string): Promise<string | null> {
		const response = await this.client.request(
			`${this.api(repository)}/repository/branches/${encodeURIComponent(branch)}`,
			{},
			[404],
		);
		if (response.status === 404) return null;
		const commit = stringField(record(await responseJson(response)).commit, 'id');
		validateCommit(commit);
		return commit;
	}

	async getBranchHead(repository: string, branch: string) {
		validateBranch(branch, 'GitLab');
		const commit = await this.head(repository, branch);
		if (!commit) throw new ValidationError(`GitLab branch not found: ${branch}`);
		return { commit };
	}

	async fetchWorkspace(repository: string, commit: string, rootPath: string) {
		validateCommit(commit);
		validateRootPath(rootPath);
		const query = new URLSearchParams({ sha: commit });
		const response = await this.client.request(
			`${this.api(repository)}/repository/archive.tar.gz?${query}`,
			// Node fetch defaults to Sec-Fetch-Mode: cors, which GitLab's archive hotlink guard rejects.
			{ mode: 'same-origin' },
		);
		return collectTarballWorkspace(response, rootPath);
	}

	private checkoutOptions(repository: string, commit: string, branch: string) {
		return {
			repository,
			remoteUrl: this.remote(repository),
			commit,
			branch,
			headers: this.client.gitHeaders,
			fetcher: this.client.fetcher,
		};
	}

	async fetchGitDirectory(repository: string, commit: string, branch: string) {
		validateCommit(commit);
		validateBranch(branch, 'GitLab');
		try {
			return await materializeGitDirectory(this.checkoutOptions(repository, commit, branch));
		} catch (error) {
			if (error instanceof BadRequestError || error instanceof UnavailableError) throw error;
			throw new UnavailableError('GitLab Git data could not be fetched');
		}
	}

	private async atStage<T>(stage: SourceControlPublishStage, action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (error) {
			const status = (error as { providerStatus?: number })?.providerStatus;
			throw markSourceControlPublishFailure(error, { provider: this.provider, stage, status });
		}
	}

	private validate(input: OpenChangeRequestInput | UpdateChangeRequestInput): void {
		this.path(input.repository);
		validateBranch(input.baseBranch, 'GitLab');
		validateCommit(input.baseCommit);
		validateChanges(input.changes);
		validateCommitIdentity(input.coAuthor);
		if (typeof input.title !== 'string' || !input.title.trim() || typeof input.body !== 'string') {
			throw new ValidationError('Invalid GitLab merge request metadata');
		}
	}

	private mergeRequest(repository: string, payload: unknown): MergeRequest {
		const data = record(payload);
		const number = data.iid;
		if (!Number.isSafeInteger(number) || typeof number !== 'number' || number < 1)
			throw new UnavailableError('GitLab returned an invalid merge request');
		const url = stringField(data, 'web_url');
		if (url !== `${this.client.baseUrl}/${this.path(repository)}/-/merge_requests/${number}`)
			throw new UnavailableError('GitLab returned an invalid merge request URL');
		return {
			number,
			url,
			headBranch: stringField(data, 'source_branch'),
			baseBranch: stringField(data, 'target_branch'),
			state: stringField(data, 'state'),
			draft: data.draft === true,
		};
	}

	private async requests(input: OpenChangeRequestInput): Promise<MergeRequest[]> {
		const requests: MergeRequest[] = [];
		let page = 1;
		for (;;) {
			const query = new URLSearchParams({
				source_branch: input.headBranch,
				target_branch: input.baseBranch,
				state: 'all',
				per_page: '100',
				page: String(page),
			});
			const response = await this.client.request(
				`${this.api(input.repository)}/merge_requests?${query}`,
			);
			const body = await responseJson(response);
			if (!Array.isArray(body))
				throw new UnavailableError('GitLab returned an invalid merge request list');
			for (const item of body) {
				const request = this.mergeRequest(input.repository, item);
				if (request.headBranch === input.headBranch && request.baseBranch === input.baseBranch)
					requests.push(request);
			}
			const next = response.headers.get('x-next-page');
			if (!next) return requests;
			if (Number(next) !== page + 1 || page >= 100)
				throw new UnavailableError('GitLab returned invalid merge request pagination');
			page += 1;
		}
	}

	private result(request: MergeRequest, headCommit: string): OpenChangeRequestResult {
		return { number: request.number, url: request.url, headBranch: request.headBranch, headCommit };
	}

	private async createRequest(
		input: OpenChangeRequestInput,
		headCommit: string,
	): Promise<OpenChangeRequestResult> {
		const title =
			input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title;
		const response = await this.client.request(
			`${this.api(input.repository)}/merge_requests`,
			{
				method: 'POST',
				body: JSON.stringify({
					source_branch: input.headBranch,
					target_branch: input.baseBranch,
					title,
					description: input.body,
				}),
			},
			[409],
		);
		if (response.status === 409) {
			const existing = (await this.requests(input)).find((request) => request.state === 'opened');
			if (!existing)
				throw new ConflictError('GitLab merge request already exists but cannot be recovered');
			return this.result(existing, headCommit);
		}
		const request = this.mergeRequest(input.repository, await responseJson(response));
		if (request.headBranch !== input.headBranch || request.baseBranch !== input.baseBranch)
			throw new UnavailableError('GitLab returned a different merge request');
		return this.result(request, headCommit);
	}

	private async identity(): Promise<SourceControlCommitIdentity> {
		const identity = await this.atStage('auth', () => this.client.identity());
		validateCommitIdentity(identity);
		return identity;
	}

	async openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
		this.validate(input);
		validateBranch(input.headBranch, 'GitLab');
		if (input.headBranch === input.baseBranch || typeof input.draft !== 'boolean')
			throw new ValidationError('Invalid GitLab proposal branch or metadata');
		const identity = await this.identity();
		const existingHead = await this.atStage('branch', () =>
			this.head(input.repository, input.headBranch),
		);
		const requests = await this.atStage('pr', () => this.requests(input));
		return this.atStage('push', () =>
			withGitCheckout(
				this.checkoutOptions(input.repository, input.baseCommit, input.baseBranch),
				async (directory) => {
					const repository = new GitLabRepository(
						this.client,
						directory,
						this.remote(input.repository),
					);
					const tree = await repository.tree(input.baseCommit, input.changes);
					let headCommit = existingHead;
					if (headCommit) {
						await repository.fetchCommit(input.headBranch, headCommit);
						if (!(await repository.matches(headCommit, input.baseCommit, tree, input, identity)))
							throw new ProposalRetryRequiredError(
								'The GitLab proposal branch no longer matches the captured proposal; retry with a new idempotency key',
							);
						if (requests.length > 0) return this.result(requests[0], headCommit);
					} else {
						headCommit = await repository.commit(
							input.baseCommit,
							tree,
							input.title,
							input.body,
							identity,
							input.coAuthor,
						);
						try {
							await this.atStage('branch', () =>
								repository.push(input.headBranch, headCommit!, null),
							);
						} catch (error) {
							const recovered = await this.head(input.repository, input.headBranch);
							if (!recovered) throw error;
							await repository.fetchCommit(input.headBranch, recovered);
							if (!(await repository.matches(recovered, input.baseCommit, tree, input, identity)))
								throw error;
							headCommit = recovered;
						}
					}
					return this.atStage('pr', () => this.createRequest(input, headCommit));
				},
			),
		);
	}

	private async updateMetadata(
		input: UpdateChangeRequestInput,
		request: MergeRequest,
		headCommit: string,
	): Promise<OpenChangeRequestResult> {
		const title =
			request.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title;
		const response = await this.client.request(
			`${this.api(input.repository)}/merge_requests/${request.number}`,
			{ method: 'PUT', body: JSON.stringify({ title, description: input.body }) },
		);
		const updated = this.mergeRequest(input.repository, await responseJson(response));
		if (
			updated.url !== request.url ||
			updated.headBranch !== request.headBranch ||
			updated.baseBranch !== request.baseBranch ||
			updated.state !== 'opened'
		)
			throw new ConflictError('The GitLab merge request changed while updating');
		return this.result(updated, headCommit);
	}

	async updateChangeRequest(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult> {
		this.validate(input);
		validateBranch(input.changeRequest.headBranch, 'GitLab');
		validateCommit(input.changeRequest.headCommit);
		if (
			input.changeRequest.headBranch === input.baseBranch ||
			!Number.isSafeInteger(input.changeRequest.number) ||
			input.changeRequest.number < 1
		)
			throw new ValidationError('Invalid GitLab merge request target');
		const identity = await this.identity();
		const request = await this.atStage('pr', async () => {
			const response = await this.client.request(
				`${this.api(input.repository)}/merge_requests/${input.changeRequest.number}`,
				{},
				[404],
			);
			if (response.status === 404)
				throw new ConflictError('The GitLab merge request was deleted; create a new merge request');
			const target = this.mergeRequest(input.repository, await responseJson(response));
			if (
				target.url !== input.changeRequest.url ||
				target.headBranch !== input.changeRequest.headBranch ||
				target.baseBranch !== input.baseBranch ||
				target.state !== 'opened'
			)
				throw new ConflictError(
					'The GitLab merge request is closed or no longer matches; create a new merge request',
				);
			return target;
		});
		const currentHead = await this.atStage('branch', () =>
			this.head(input.repository, request.headBranch),
		);
		if (!currentHead)
			throw markSourceControlPublishFailure(
				new ConflictError(
					'The GitLab merge request branch was deleted; create a new merge request',
				),
				{ provider: this.provider, stage: 'branch', condition: 'branch_deleted' },
			);
		return this.atStage('push', () =>
			withGitCheckout(
				this.checkoutOptions(input.repository, input.baseCommit, input.baseBranch),
				async (directory) => {
					const repository = new GitLabRepository(
						this.client,
						directory,
						this.remote(input.repository),
					);
					const expected = input.changeRequest.headCommit;
					if (currentHead !== expected) {
						await repository.fetchCommit(request.headBranch, currentHead);
						const replacementTree = await repository.tree(input.baseCommit, input.changes);
						if (
							await repository.matches(
								currentHead,
								input.baseCommit,
								replacementTree,
								input,
								identity,
							)
						)
							return this.atStage('pr', () => this.updateMetadata(input, request, currentHead));
						if (!(await repository.hasParent(currentHead, expected)))
							throw markSourceControlPublishFailure(
								new ConflictError('The GitLab merge request branch changed outside marimohub'),
								{ provider: this.provider, stage: 'branch', condition: 'branch_changed' },
							);
					}
					await repository.fetchCommit(request.headBranch, expected);
					let tree: string;
					let parent = expected;
					try {
						tree = await repository.tree(expected, input.changes);
					} catch (error) {
						if (!(error instanceof ConflictError)) throw error;
						parent = input.baseCommit;
						tree = await repository.tree(parent, input.changes);
					}
					if (currentHead !== expected) {
						if (!(await repository.matches(currentHead, parent, tree, input, identity)))
							throw markSourceControlPublishFailure(
								new ConflictError('The GitLab merge request branch changed outside marimohub'),
								{ provider: this.provider, stage: 'branch', condition: 'branch_changed' },
							);
						return this.atStage('pr', () => this.updateMetadata(input, request, currentHead));
					}
					let headCommit = await repository.commit(
						parent,
						tree,
						input.title,
						input.body,
						identity,
						input.coAuthor,
					);
					try {
						await this.atStage('branch', () =>
							repository.push(request.headBranch, headCommit, expected, parent !== expected),
						);
					} catch (error) {
						const recovered = await this.head(input.repository, request.headBranch);
						if (!recovered) throw error;
						await repository.fetchCommit(request.headBranch, recovered);
						if (!(await repository.matches(recovered, parent, tree, input, identity)))
							throw markSourceControlPublishFailure(error, {
								provider: this.provider,
								stage: 'branch',
								condition: 'branch_changed',
							});
						headCommit = recovered;
					}
					return this.atStage('pr', () => this.updateMetadata(input, request, headCommit));
				},
			),
		);
	}
}
