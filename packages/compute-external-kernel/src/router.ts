import type { SandboxId } from '@marimo-hub/core/ids';
import { logEvent } from '@marimo-hub/core/logs';
import { ForbiddenError, UnavailableError } from '@marimo-hub/core/errors';
import type {
	CreateSandboxOptions,
	EndUserPrincipal,
	KernelApps,
	KernelJobs,
	KernelProxyRequest,
	KernelProxyTarget,
	SandboxInstance,
	SandboxProvider,
	SandboxRouting,
} from '@marimo-hub/core/ports/sandbox';
import { RESERVED_PATHS, toKernelEnvironment } from './environment';
import type { ExternalKernelCompute } from './index';

/** The name sessions on the external kernel record as their `compute_backend`. */
export const EXTERNAL_KERNEL_BACKEND = 'external-kernel';
/** The name app sessions in an author's runtime record as their `compute_backend`. */
export const EXTERNAL_KERNEL_APP_BACKEND = 'external-kernel-app';

/**
 * App sessions that the kernel service runs in their author's runtime. Each
 * belongs to the viewer who opened it: only that viewer's requests reach it,
 * and only that viewer's token closes it.
 */
export class ExternalKernelApps implements SandboxProvider {
	readonly capabilities = {
		multiPort: false,
		managedEnvironment: true,
		requestCredentials: true,
	} as const;

	constructor(private readonly kernel: ExternalKernelCompute) {}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return this.kernel.appSession(id, options);
	}

	async proxy(): Promise<Response | null> {
		return null;
	}

	async resolveKernelProxyTarget(input: KernelProxyRequest): Promise<KernelProxyTarget> {
		if (input.principal.userId !== input.ownerUserId) {
			throw new ForbiddenError('This app session belongs to the viewer who opened it.');
		}
		const prefix = `${this.kernel.baseUrl}/apps/sessions/${encodeURIComponent(input.sandboxId)}/proxy/`;
		const origin = new URL(input.originUrl);
		if (`${origin.origin}${origin.pathname}` !== prefix) {
			throw new UnavailableError(
				'This app session is not routed to the configured kernel service.',
			);
		}
		const { target, headers } = this.kernel.proxyTarget(prefix, input);
		return { url: target.toString(), headers };
	}
}

/**
 * Sends each edit session to its owner's personal kernel when the owner has
 * one, and everything else to a regular backend: edit sessions of users with
 * no kernel, apps, jobs, warm pools, and previews.
 *
 * The choice is made per session start with the owner's own token and is not
 * cached. Only the service's `404 no_kernel` selects the fallback; a refused,
 * missing, or expired token, or an unreachable service, fails the start.
 */
export interface ExternalKernelRouterOptions {
	/**
	 * Emails of the users who have a personal kernel. Everyone else goes straight
	 * to the fallback and never contacts the service, so its outages cannot block
	 * them. Unset: every user asks the service.
	 */
	enrolledUsers?: readonly string[];
}

export class ExternalKernelRouter implements SandboxProvider {
	readonly routing: SandboxRouting;
	/** Scheduled jobs of authors with a personal kernel; the same choice as their edit sessions. */
	readonly kernelJobs: KernelJobs;
	/** Apps of enrolled authors, one session per viewer in the author's runtime. */
	readonly kernelApps: KernelApps;
	private readonly apps: ExternalKernelApps;
	private readonly enrolled?: ReadonlySet<string>;

	constructor(
		readonly external: ExternalKernelCompute,
		readonly fallback: SandboxProvider,
		options: ExternalKernelRouterOptions = {},
	) {
		this.enrolled = options.enrolledUsers
			? new Set(options.enrolledUsers.map((email) => email.trim().toLowerCase()))
			: undefined;
		this.apps = new ExternalKernelApps(external);
		this.routing = {
			selectEditBackend: async (owner: EndUserPrincipal) => {
				if (!this.isEnrolled(owner.email)) return;
				return (await this.external.hasKernel(owner.userId)) ? EXTERNAL_KERNEL_BACKEND : undefined;
			},
			backend: (name) => {
				if (name === undefined) return this.fallback;
				if (name === EXTERNAL_KERNEL_BACKEND) return this.external;
				if (name === EXTERNAL_KERNEL_APP_BACKEND) return this.apps;
				throw new Error(`Unknown compute backend on session record: ${name}`);
			},
		};
		this.kernelApps = {
			backend: EXTERNAL_KERNEL_APP_BACKEND,
			reservedPaths: RESERVED_PATHS,
			mayRunAppsOf: (authorEmail) => this.isEnrolled(authorEmail),
			start: (input) => this.external.startApp(input),
		};
		this.kernelJobs = {
			reservedPaths: RESERVED_PATHS,
			runsJobsOf: async (author) =>
				this.isEnrolled(author.email) && (await this.external.hasKernel(author.userId)),
			register: (author, jobKey, schedule) => this.external.registerJob(author, jobKey, schedule),
			unregister: (author, jobKey) => this.external.unregisterJob(author, jobKey),
			environment: (env) => {
				const { body, omitted } = toKernelEnvironment(env);
				if (omitted.length > 0) {
					logEvent(
						{ level: 'warn', event: 'external_kernel_environment_omitted', omitted },
						{ channel: 'warn' },
					);
				}
				return body;
			},
		};
	}

	/** Whether `email` may have a personal kernel, so the service must be asked. */
	isEnrolled(email: string): boolean {
		return !this.enrolled || this.enrolled.has(email.trim().toLowerCase());
	}

	get capabilities(): SandboxProvider['capabilities'] {
		return this.fallback.capabilities;
	}

	get warmPool(): SandboxProvider['warmPool'] {
		return this.fallback.warmPool;
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return this.fallback.create(id, options);
	}

	get connectExisting(): SandboxProvider['connectExisting'] {
		return this.fallback.connectExisting?.bind(this.fallback);
	}

	get listActive(): SandboxProvider['listActive'] {
		return this.fallback.listActive?.bind(this.fallback);
	}

	/** The fallback's optional reachability probe, which deploy-time preflight duck-types. */
	get healthCheck(): (() => Promise<void>) | undefined {
		const probe = (this.fallback as { healthCheck?: () => Promise<void> }).healthCheck;
		return probe?.bind(this.fallback);
	}

	proxy(request: Request): Promise<Response | null> {
		return this.fallback.proxy(request);
	}

	withEndUserRequest<T>(
		request: Request,
		principal: EndUserPrincipal,
		next: () => Promise<T>,
	): Promise<T> {
		const fallback = this.fallback.withEndUserRequest?.bind(this.fallback);
		return this.external.withEndUserRequest(request, principal, () =>
			fallback ? fallback(request, principal, next) : next(),
		);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.fallback[Symbol.asyncDispose]?.();
	}
}
