import type { SandboxId } from '@marimo-hub/core/ids';
import { logEvent } from '@marimo-hub/core/logs';
import type {
	CreateSandboxOptions,
	EndUserPrincipal,
	KernelJobs,
	SandboxInstance,
	SandboxProvider,
	SandboxRouting,
} from '@marimo-hub/core/ports/sandbox';
import { toKernelEnvironment } from './environment';
import type { ExternalKernelCompute } from './index';

/** The name sessions on the external kernel record as their `compute_backend`. */
export const EXTERNAL_KERNEL_BACKEND = 'external-kernel';

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
	private readonly enrolled?: ReadonlySet<string>;

	constructor(
		readonly external: ExternalKernelCompute,
		readonly fallback: SandboxProvider,
		options: ExternalKernelRouterOptions = {},
	) {
		this.enrolled = options.enrolledUsers
			? new Set(options.enrolledUsers.map((email) => email.trim().toLowerCase()))
			: undefined;
		this.routing = {
			selectEditBackend: async (owner: EndUserPrincipal) => {
				if (!this.isEnrolled(owner.email)) return;
				return (await this.external.hasKernel(owner.userId)) ? EXTERNAL_KERNEL_BACKEND : undefined;
			},
			backend: (name) => {
				if (name === undefined) return this.fallback;
				if (name === EXTERNAL_KERNEL_BACKEND) return this.external;
				throw new Error(`Unknown compute backend on session record: ${name}`);
			},
		};
		this.kernelJobs = {
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
