import { UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import type { SourceControlCommitIdentity } from '@marimo-hub/core/ports/source-control';
import { validateCommitIdentity } from '@marimo-hub/source-control-commons';
import type { SourceControlFetch } from '@marimo-hub/source-control-commons';

export interface GitLabOptions {
	token: string;
	baseUrl?: string;
}

export interface GitLabRuntime {
	fetcher?: SourceControlFetch;
	now?: () => number;
}

export function gitLabBaseUrl(value = 'https://gitlab.com'): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ValidationError('Invalid GitLab base URL');
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	) {
		throw new ValidationError('GitLab base URL must be an HTTPS origin');
	}
	return url.origin;
}

export function parseGitLabRepository(repository: string, baseUrl = 'https://gitlab.com'): string {
	const origin = gitLabBaseUrl(baseUrl);
	let path = repository.trim();
	if (path.includes('://')) {
		let url: URL;
		try {
			url = new URL(path);
		} catch {
			throw new ValidationError('Invalid GitLab repository URL');
		}
		if (url.origin !== origin || url.username || url.password || url.search || url.hash) {
			throw new ValidationError('GitLab repository must belong to the configured instance');
		}
		path = url.pathname.slice(1);
	}
	path = path.replace(/\/$/, '').replace(/\.git$/, '');
	const segments = path.split('/');
	if (segments.length < 2 || segments.some((part) => !/^(?!\.+$)[A-Za-z0-9_.-]+$/.test(part))) {
		throw new ValidationError('GitLab repository must be group[/subgroup]/project');
	}
	return path;
}

export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new UnavailableError('GitLab returned an invalid response');
	}
	return value as Record<string, unknown>;
}

export function stringField(value: unknown, key: string): string {
	const field = record(value)[key];
	if (typeof field !== 'string' || field.length === 0) {
		throw new UnavailableError('GitLab returned an invalid response');
	}
	return field;
}

export async function responseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new UnavailableError('GitLab returned invalid JSON');
	}
}

class GitLabRequestError extends UnavailableError {
	readonly providerStatus: number;
	constructor(status: number) {
		super(`GitLab request failed with status ${status}`);
		this.name = 'GitLabRequestError';
		this.providerStatus = status;
	}
}

export class GitLabClient {
	readonly baseUrl: string;
	readonly fetcher: SourceControlFetch;
	readonly gitHeaders: Record<string, string>;
	readonly now: () => number;
	private readonly token: string;
	private user?: Promise<SourceControlCommitIdentity>;

	constructor(options: GitLabOptions, runtime: GitLabRuntime = {}) {
		this.baseUrl = gitLabBaseUrl(options.baseUrl);
		this.token = options.token.trim();
		if (!this.token || /\s/.test(this.token)) throw new ValidationError('Invalid GitLab token');
		const fetcher = runtime.fetcher ?? fetch;
		this.fetcher = async (input, init = {}) => {
			if (new URL(input).origin !== this.baseUrl) {
				throw new ValidationError('GitLab request must belong to the configured instance');
			}
			let response: Response;
			try {
				response = await fetcher(input, { ...init, redirect: 'error' });
			} catch {
				throw new UnavailableError('GitLab request failed');
			}
			if (response.redirected || (response.status >= 300 && response.status < 400)) {
				throw new UnavailableError('GitLab redirects are not supported');
			}
			if (!response.ok) throw new GitLabRequestError(response.status);
			return response;
		};
		this.now = runtime.now ?? Date.now;
		this.gitHeaders = {
			authorization: `Basic ${Buffer.from(`oauth2:${this.token}`).toString('base64')}`,
		};
	}

	async request(
		path: string,
		init: RequestInit = {},
		allowedStatuses: readonly number[] = [],
	): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('private-token', this.token);
		headers.set('content-type', 'application/json');
		// API callers inspect expected 404/409 responses; Git transport failures always throw.
		try {
			return await this.fetcher(`${this.baseUrl}/api/v4${path}`, { ...init, headers });
		} catch (error) {
			if (error instanceof GitLabRequestError && allowedStatuses.includes(error.providerStatus)) {
				return new Response(null, { status: error.providerStatus });
			}
			throw error;
		}
	}

	identity(): Promise<SourceControlCommitIdentity> {
		this.user ??= this.loadIdentity().catch((error: unknown) => {
			this.user = undefined;
			throw error;
		});
		return this.user;
	}

	private async loadIdentity(): Promise<SourceControlCommitIdentity> {
		const user = await responseJson(await this.request('/user'));
		const fields = record(user);
		const commitEmail = fields.commit_email;
		const identity = {
			name: stringField(user, 'name'),
			email: stringField(
				user,
				typeof commitEmail === 'string' && commitEmail.includes('@') ? 'commit_email' : 'email',
			),
		};
		try {
			validateCommitIdentity(identity);
		} catch {
			throw new UnavailableError('GitLab returned an invalid commit identity');
		}
		return identity;
	}
}
