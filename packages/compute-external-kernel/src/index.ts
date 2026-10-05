/**
 * External-kernel compute backend.
 *
 * Each user owns one long-lived marimo server run by an external service. A hub
 * sandbox maps to a workspace directory on that server: the hub uploads the
 * notebook workspace, asks the service to open the notebook, and proxies the
 * browser to the server's root with the opened file pinned. The server is one
 * per user, not per session, so it has no per-session `--base-url`.
 *
 * Every call authenticates with the end user's own bearer token alone, and names
 * the kernel owner so the service can refuse a token for anyone else. The hub
 * holds no service credential, so it can only reach a kernel while its owner's
 * token is available (see `EndUserCredentials`).
 *
 * The kernel image is the environment: the provider declares
 * `managedEnvironment`, so the hub sends no env vars, secrets, setup commands,
 * or kernel token, and it runs no commands. Command-shaped operations throw.
 */
import { base64Encode, mapWithConcurrency, WRITE_CONCURRENCY } from '@marimo-hub/compute-commons';
import { MARIMO_PORT } from '@marimo-hub/core/constants';
import { ForbiddenError, NotFoundError, UnavailableError } from '@marimo-hub/core/errors';
import type { SandboxId, UserId } from '@marimo-hub/core/ids';
import type {
	BoundedReadOptions,
	CreateSandboxOptions,
	EndUserPrincipal,
	ExecResult,
	ExposePortResult,
	FileInfo,
	KernelProxyRequest,
	KernelProxyTarget,
	ListFilesOptions,
	ListFilesResult,
	MarimoLaunchSpec,
	ReadFileResult,
	SandboxFileWrite,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
} from '@marimo-hub/core/ports/sandbox';
import { listFilesFailure, readFileFailure } from '@marimo-hub/core/ports/sandbox';
import { EndUserCredentials } from './credentials';
import type { EndUserCredential } from './credentials';

export { EndUserCredentials, readEndUserCredential } from './credentials';
export type { EndUserCredential } from './credentials';

export interface ExternalKernelComputeOptions {
	/** Base URL of the external kernel API, e.g. `http://kira.example/api/external-kernel/v1`. */
	baseUrl: string;
	tokenHeader?: string;
	/** Browser header prefixes never forwarded to the kernel, besides cookies and Authorization. */
	stripHeaderPrefixes?: readonly string[];
	/** Absolute sandbox directory the hub writes workspaces under. */
	workdir?: string;
	requestTimeoutMs?: number;
	now?: () => number;
}

export const DEFAULT_TOKEN_HEADER = 'x-pantheon-bearer';
/** Names the kernel owner; the service refuses a token whose email differs. */
export const OWNER_HEADER = 'x-external-kernel-owner';
export const DEFAULT_STRIP_HEADER_PREFIXES = ['x-pantheon-'] as const;
const DEFAULT_WORKDIR = '/workspace';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OPEN_TIMEOUT_MS = 120_000;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Bounds a listing walk; capture applies its own count and byte caps afterwards.
const MAX_LIST_ENTRIES = 50_000;

function unsupported(operation: string): UnavailableError {
	return new UnavailableError(
		`The external-kernel compute backend cannot ${operation}: the kernel image is the environment and the hub runs no commands in it`,
	);
}

async function errorCode(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: { code?: unknown } };
		return typeof body?.error?.code === 'string' ? body.error.code : undefined;
	} catch {
		return;
	}
}

async function serviceError(response: Response, action: string): Promise<Error> {
	const code = await errorCode(response);
	if (response.status === 401) {
		return new UnavailableError(
			`The external kernel service rejected the end-user token while ${action} (HTTP 401). Sign in again, then retry.`,
		);
	}
	if (response.status === 403 && code === 'owner_mismatch') {
		return new ForbiddenError(
			"The external kernel service refused the request: the signed-in user's token does not belong to this kernel's owner (owner_mismatch).",
		);
	}
	if (response.status === 403) {
		return new ForbiddenError(
			`The external kernel service does not allow this user to use a kernel (HTTP 403 while ${action}).`,
		);
	}
	if (response.status === 404 && code === 'no_kernel') {
		return new UnavailableError(
			'You have no personal kernel in the external kernel service (no_kernel). Start your kernel there, then retry.',
		);
	}
	return new UnavailableError(
		`The external kernel service failed while ${action} (HTTP ${response.status}${code ? `, ${code}` : ''}).`,
	);
}

/** Normalize an absolute sandbox path; undefined when it is relative or escapes the root. */
function normalizeAbsolute(path: string): string | undefined {
	if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')) return;
	const segments: string[] = [];
	for (const segment of path.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') return;
		segments.push(segment);
	}
	return `/${segments.join('/')}`;
}

/** Release an unread body so its connection returns to the pool. */
async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {});
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

class ExternalKernelSandbox implements SandboxInstance {
	readonly supportsBucketMount = false;
	private fileKey?: string;

	constructor(
		private readonly provider: ExternalKernelCompute,
		private readonly id: SandboxId,
		private readonly owner: UserId | undefined,
		private readonly attachOnly: boolean,
	) {}

	private get workspaceUrl(): string {
		return `${this.provider.baseUrl}/workspaces/${encodeURIComponent(this.id)}`;
	}

	private credential(): EndUserCredential {
		return this.provider.credentials.forOwner(this.owner);
	}

	async ready(): Promise<void> {
		const response = await this.provider.call(`${this.provider.baseUrl}/kernel`, {
			credential: this.credential(),
			action: 'checking the kernel',
		});
		const body = (await response.json().catch(() => null)) as { ready?: unknown } | null;
		if (body?.ready !== true) {
			throw new UnavailableError('Your personal kernel is not ready yet. Retry shortly.');
		}
		if (!this.attachOnly) return;
		const listing = await this.provider.call(this.listUrl(''), {
			credential: this.credential(),
			action: 'attaching to the workspace',
			allow: [404],
		});
		await discard(listing);
		if (listing.status === 404) {
			throw new NotFoundError(`External kernel workspace ${this.id} does not exist`);
		}
	}

	exec(): Promise<ExecResult> {
		return Promise.reject(unsupported('run commands'));
	}

	execStream(): Promise<ReadableStream> {
		return Promise.reject(unsupported('run commands'));
	}

	gitCheckout(): Promise<void> {
		return Promise.reject(unsupported('run git'));
	}

	setEnvVars(): Promise<void> {
		return Promise.reject(unsupported('set environment variables'));
	}

	mountBucket(): Promise<void> {
		return Promise.reject(unsupported('mount storage'));
	}

	unmountBucket(): Promise<void> {
		return Promise.reject(unsupported('mount storage'));
	}

	startProcess(): Promise<SandboxProcess> {
		return Promise.reject(unsupported('start processes'));
	}

	/**
	 * Workspace paths are relative to the configured workdir. Anything outside it
	 * is refused rather than ignored: that is where the hub would put credential
	 * files, which must never reach this kernel.
	 */
	private relative(path: string, operation: string): string {
		const normalized = normalizeAbsolute(path);
		const root = this.provider.workdir;
		if (normalized === root) return '';
		if (normalized?.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
		throw new ForbiddenError(
			`The external-kernel compute backend refuses to ${operation} outside ${root}`,
		);
	}

	private fileUrl(rel: string): string {
		return `${this.workspaceUrl}/files?path=${encodeURIComponent(rel)}`;
	}

	private listUrl(rel: string): string {
		return `${this.workspaceUrl}/list?path=${encodeURIComponent(rel)}`;
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		// Validate the whole set first so a refused path sends nothing.
		const writes = files.map((file) => {
			const rel = this.relative(file.path, 'write files');
			if (!rel) throw new ForbiddenError('Cannot write the workspace root as a file');
			return { rel, content: file.content };
		});
		if (writes.length === 0) return;
		const credential = this.credential();
		await mapWithConcurrency(writes, WRITE_CONCURRENCY, async ({ rel, content }) => {
			const response = await this.provider.call(this.fileUrl(rel), {
				method: 'PUT',
				credential,
				action: 'writing a workspace file',
				// fetch copies any byte view; the narrower type is only what lib.dom accepts.
				body:
					typeof content === 'string'
						? new TextEncoder().encode(content)
						: (content as Uint8Array<ArrayBuffer>),
				headers: { 'content-type': 'application/octet-stream' },
			});
			await discard(response);
		});
	}

	/** The external service creates parents on write and stores no empty directories. */
	async ensureDirectories(paths: readonly string[]): Promise<void> {
		for (const path of paths) this.relative(path, 'create directories');
	}

	async readFile(path: string): Promise<ReadFileResult> {
		return this.read(path, { maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 0 });
	}

	async readFileBounded(path: string, options: BoundedReadOptions): Promise<ReadFileResult> {
		if (
			!Number.isSafeInteger(options.maxBytes) ||
			options.maxBytes < 0 ||
			!Number.isFinite(options.timeoutMs) ||
			options.timeoutMs <= 0 ||
			options.timeoutMs > 2 ** 31 - 1
		) {
			return readFileFailure('READ_FAILED');
		}
		return this.read(path, options);
	}

	private async read(path: string, options: BoundedReadOptions): Promise<ReadFileResult> {
		let rel: string;
		try {
			rel = this.relative(path, 'read files');
		} catch {
			return readFileFailure('READ_FAILED');
		}
		if (!rel) return readFileFailure('READ_FAILED');
		let response: Response;
		try {
			response = await this.provider.call(this.fileUrl(rel), {
				credential: this.credential(),
				action: 'reading a workspace file',
				allow: [404],
				timeoutMs: options.timeoutMs > 0 ? Math.ceil(options.timeoutMs) : undefined,
			});
		} catch (error) {
			// A deadline is a per-file read failure; credential and service errors are not.
			if ((error as { cause?: { name?: string } }).cause?.name === 'TimeoutError') {
				return readFileFailure('READ_FAILED');
			}
			throw error;
		}
		if (response.status === 404) {
			await discard(response);
			return readFileFailure('NOT_FOUND');
		}
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > options.maxBytes) {
			await response.body?.cancel().catch(() => {});
			return readFileFailure('READ_FAILED');
		}
		if (!response.body) return { success: true, content: '', encoding: 'base64' };
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > options.maxBytes) {
					await reader.cancel().catch(() => {});
					return readFileFailure('READ_FAILED');
				}
				chunks.push(value);
			}
		} catch {
			return readFileFailure('READ_FAILED');
		}
		return {
			success: true,
			content: base64Encode(concatBytes(chunks, length)),
			encoding: 'base64',
		};
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		let root: string;
		try {
			root = this.relative(path, 'list files');
		} catch {
			return listFilesFailure('LIST_FAILED');
		}
		const credential = this.credential();
		const entries = new Map<string, { type: FileInfo['type']; size: number }>();
		const pending = [root];
		const listed = new Set<string>();
		while (pending.length > 0) {
			const directory = pending.shift()!;
			listed.add(directory);
			const response = await this.provider.call(this.listUrl(directory), {
				credential,
				action: 'listing workspace files',
				allow: [404],
			});
			if (response.status === 404) {
				await discard(response);
				// A subdirectory removed mid-walk is simply no longer there.
				if (directory === root) return listFilesFailure('LIST_FAILED');
				continue;
			}
			const body = (await response.json().catch(() => null)) as {
				entries?: { path?: unknown; type?: unknown; size?: unknown }[];
			} | null;
			if (!Array.isArray(body?.entries)) return listFilesFailure('BACKEND_ERROR');
			const prefix = directory ? `${directory}/` : '';
			for (const entry of body.entries) {
				if (typeof entry.path !== 'string' || !entry.path.startsWith(prefix)) continue;
				const rel = entry.path.slice(prefix.length);
				if (!rel || normalizeAbsolute(`/${entry.path}`) !== `/${entry.path}`) continue;
				if (!options?.includeHidden && rel.split('/').some((part) => part.startsWith('.'))) {
					continue;
				}
				const type =
					entry.type === 'directory' ? 'directory' : entry.type === 'file' ? 'file' : 'other';
				const size = typeof entry.size === 'number' && entry.size >= 0 ? entry.size : 0;
				entries.set(entry.path, { type, size });
				if (options?.recursive && type === 'directory' && !listed.has(entry.path)) {
					pending.push(entry.path);
				}
			}
			if (entries.size > MAX_LIST_ENTRIES) return listFilesFailure('LIST_FAILED');
		}
		const base = root ? `${root}/` : '';
		const files: FileInfo[] = [...entries].map(([rel, { type, size }]) => {
			const relativePath = rel.slice(base.length);
			return {
				name: rel.slice(rel.lastIndexOf('/') + 1),
				absolutePath: `${path.replace(/\/+$/, '')}/${relativePath}`,
				relativePath,
				type,
				size,
			};
		});
		return { success: true, files };
	}

	async launchMarimo(spec: MarimoLaunchSpec): Promise<void> {
		if (spec.mode !== 'edit') {
			throw new UnavailableError(
				'External kernels serve edit sessions only; run the notebook as an app on another backend.',
			);
		}
		const directory = this.relative(spec.workdir, 'open notebooks');
		const notebook = normalizeAbsolute(`/${directory ? `${directory}/` : ''}${spec.notebookFile}`);
		if (!notebook || notebook === '/') throw new ForbiddenError('Invalid notebook path');
		const response = await this.provider.call(`${this.workspaceUrl}/open`, {
			method: 'POST',
			credential: this.credential(),
			action: 'opening the notebook',
			body: new TextEncoder().encode(
				JSON.stringify({
					notebook: notebook.slice(1),
					projectId: spec.projectId,
					notebookId: spec.notebookId,
				}),
			),
			headers: { 'content-type': 'application/json' },
			timeoutMs: spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_OPEN_TIMEOUT_MS,
		});
		const body = (await response.json().catch(() => null)) as { file?: unknown } | null;
		if (typeof body?.file !== 'string' || !body.file) {
			throw new UnavailableError('The external kernel service did not return a notebook file key.');
		}
		this.fileKey = body.file;
	}

	async exposePort(port: number): Promise<ExposePortResult> {
		if (port !== MARIMO_PORT) throw unsupported(`expose port ${port}`);
		if (!this.fileKey) throw new UnavailableError('The notebook was not opened before exposure.');
		// The origin URL is persisted on the session and is the only place the file
		// key survives, so every hub replica can pin it on proxied requests.
		return { url: `${this.workspaceUrl}/proxy/?file=${encodeURIComponent(this.fileKey)}` };
	}

	async destroy(): Promise<void> {
		const response = await this.provider.call(this.workspaceUrl, {
			method: 'DELETE',
			credential: this.credential(),
			action: 'closing the workspace',
			allow: [404],
		});
		await discard(response);
	}
}

interface CallOptions {
	method?: string;
	credential: EndUserCredential;
	action: string;
	body?: Uint8Array<ArrayBuffer>;
	headers?: Record<string, string>;
	/** Non-2xx statuses returned to the caller instead of thrown. */
	allow?: readonly number[];
	timeoutMs?: number;
}

export class ExternalKernelCompute implements SandboxProvider {
	readonly capabilities = { multiPort: false, managedEnvironment: true } as const;
	readonly baseUrl: string;
	readonly workdir: string;
	readonly credentials: EndUserCredentials;
	private readonly stripHeaderPrefixes: readonly string[];
	private readonly requestTimeoutMs: number;

	constructor(options: ExternalKernelComputeOptions) {
		const base = new URL(options.baseUrl);
		if (base.protocol !== 'http:' && base.protocol !== 'https:') {
			throw new Error('External kernel base URL must use http or https');
		}
		if (base.search || base.hash || base.username || base.password) {
			throw new Error('External kernel base URL must not carry a query, fragment, or credentials');
		}
		this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
		const workdir = normalizeAbsolute(options.workdir ?? DEFAULT_WORKDIR);
		if (!workdir || workdir === '/') throw new Error('External kernel workdir must be a directory');
		this.workdir = workdir;
		this.credentials = new EndUserCredentials(
			(options.tokenHeader ?? DEFAULT_TOKEN_HEADER).toLowerCase(),
			options.now,
		);
		this.stripHeaderPrefixes = (options.stripHeaderPrefixes ?? DEFAULT_STRIP_HEADER_PREFIXES).map(
			(prefix) => prefix.toLowerCase(),
		);
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return this.instance(id, options, false);
	}

	connectExisting(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return this.instance(id, options, true);
	}

	private instance(
		id: SandboxId,
		options: CreateSandboxOptions | undefined,
		attachOnly: boolean,
	): SandboxInstance {
		if (!WORKSPACE_ID.test(id)) throw new Error(`Invalid external kernel workspace id: ${id}`);
		return new ExternalKernelSandbox(this, id, options?.owner?.userId, attachOnly);
	}

	async proxy(): Promise<Response | null> {
		return null;
	}

	withEndUserRequest<T>(
		request: Request,
		principal: EndUserPrincipal,
		next: () => Promise<T>,
	): Promise<T> {
		return this.credentials.run(request, principal, next);
	}

	async resolveKernelProxyTarget(input: KernelProxyRequest): Promise<KernelProxyTarget> {
		if (input.principal.userId !== input.ownerUserId) {
			throw new ForbiddenError(
				"This session runs in another user's personal kernel; only its owner can open it.",
			);
		}
		const prefix = `${this.baseUrl}/workspaces/${encodeURIComponent(input.sandboxId)}/proxy/`;
		const origin = new URL(input.originUrl);
		const fileKey = origin.searchParams.get('file');
		if (`${origin.origin}${origin.pathname}` !== prefix || !fileKey) {
			throw new UnavailableError('This session is not routed to the configured external kernel.');
		}
		const query = input.kernelPath.indexOf('?');
		const path = query === -1 ? input.kernelPath : input.kernelPath.slice(0, query);
		const target = new URL(prefix);
		target.pathname = `${target.pathname}${path.replace(/^\/+/, '')}`;
		target.search = query === -1 ? '' : input.kernelPath.slice(query);
		if (!`${target.origin}${target.pathname}`.startsWith(prefix)) {
			throw new ForbiddenError('Invalid kernel path');
		}
		// One server serves many notebooks; marimo picks the notebook by `file`.
		if (!target.searchParams.has('file')) target.searchParams.set('file', fileKey);

		const credential = this.credentials.forRequest(input.request, input.principal);
		const headers = new Headers(input.headers);
		const stripped = [...headers.keys()].filter(
			(name) =>
				name === 'cookie' ||
				name === 'authorization' ||
				name === this.credentials.header ||
				this.stripHeaderPrefixes.some((prefix) => name.startsWith(prefix)),
		);
		for (const name of stripped) headers.delete(name);
		headers.set('authorization', `Bearer ${credential.token}`);
		headers.set(OWNER_HEADER, credential.email);
		return { url: target.toString(), headers };
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.credentials.clear();
	}

	async call(url: string, options: CallOptions): Promise<Response> {
		let response: Response;
		try {
			response = await fetch(url, {
				method: options.method ?? 'GET',
				headers: {
					...options.headers,
					authorization: `Bearer ${options.credential.token}`,
					[OWNER_HEADER]: options.credential.email,
				},
				body: options.body,
				redirect: 'manual',
				signal: AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs),
			});
		} catch (cause) {
			throw new UnavailableError(
				`The external kernel service is unreachable while ${options.action}.`,
				{ cause },
			);
		}
		const ok = response.status >= 200 && response.status < 300;
		if (ok || options.allow?.includes(response.status)) return response;
		throw await serviceError(response, options.action);
	}
}
