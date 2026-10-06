import type { SandboxOwner, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';

/**
 * The owner a session record names, for adapters that partition compute per
 * tenant. Passed on every `create` that starts from a record, so an adapter
 * can find the sandbox's partition again after a restart.
 */
export function sessionOwner(session: Pick<Session, 'project_id' | 'user_id'>): SandboxOwner {
	return { projectId: session.project_id, userId: session.user_id };
}

/**
 * The provider that holds a session's sandbox. Every operation on a session's
 * sandbox and every capability check for it goes through here, so a routing
 * provider never sends one backend's sandbox id to another.
 */
export function sessionCompute(
	compute: SandboxProvider,
	session: Pick<Session, 'compute_backend'>,
): SandboxProvider {
	return compute.routing ? compute.routing.backend(session.compute_backend) : compute;
}
