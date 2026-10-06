/**
 * Maps a session's rendered environment onto the external kernel service's
 * workspace environment (`PUT /workspaces/{id}/environment`).
 *
 * The service writes each file where it chooses and sets one variable to its
 * path, relays each tunnel through loopback and rewrites the variables that
 * carry it, and keeps S3 credentials itself, re-signing requests sent to a
 * loopback endpoint. Whatever cannot be expressed that way is omitted rather
 * than sent with a value that would point somewhere wrong; `omitted` names it
 * (never its value) so the caller can log it.
 */
import type { SessionS3Access, SessionTunnel } from '@marimo-hub/core/ports/integrations';
import type { ManagedSessionEnvironment } from '@marimo-hub/core/ports/sandbox';

export interface KernelEnvironmentFile {
	name: string;
	contentBase64: string;
	envVar: string;
}

export interface KernelEnvironmentTunnel {
	host: string;
	port: number;
	hostVars: string[];
	portVars: string[];
	urlVars: string[];
}

export interface KernelEnvironmentS3 {
	endpoint: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	endpointVar: string;
}

/** The request body; each PUT replaces the workspace's whole environment. */
export interface KernelEnvironment {
	env?: Record<string, string>;
	files?: KernelEnvironmentFile[];
	tunnels?: KernelEnvironmentTunnel[];
	s3?: KernelEnvironmentS3[];
}

export interface Omission {
	kind: 'variable' | 'file' | 'tunnel' | 's3' | 'integration';
	name: string;
	reason: string;
}

// The service's limits, mirrored so a session fails here with a reason instead
// of on a bare 400.
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TUNNELS = 16;
const DNS_NAME =
	/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;
const DEFAULT_ENDPOINT_VAR = 'AWS_ENDPOINT_URL_S3';

const utf8 = new TextEncoder();

function byteLength(value: string): number {
	return utf8.encode(value).byteLength;
}

function isHost(host: string): boolean {
	return host.includes(':') ? IPV6.test(host) : DNS_NAME.test(host);
}

function isHttpOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username;
	} catch {
		return false;
	}
}

function parentDirectory(path: string): string {
	return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** The deepest directory that holds every rendered file. */
function commonDirectory(paths: readonly string[]): string | undefined {
	if (paths.length === 0) return;
	let common = parentDirectory(paths[0]);
	for (const path of paths.slice(1)) {
		while (common !== '/' && !path.startsWith(`${common}/`)) common = parentDirectory(common);
	}
	return common === '/' ? undefined : common;
}

/** `postgres/db-ca.pem` under the rendered root becomes `postgres-db-ca.pem`. */
function fileName(path: string, root: string | undefined, taken: Set<string>): string {
	const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
	const base =
		relative
			.split('/')
			.filter(Boolean)
			.join('-')
			.replaceAll(/[^A-Za-z0-9._-]/g, '_')
			.slice(-120) || 'file';
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	taken.add(name);
	return name;
}

function urlCarries(value: string, host: string, port: number): boolean {
	const authority = host.includes(':') ? `[${host}]` : host;
	return value.includes(`${authority}:${port}`);
}

function base64(content: string): string {
	return Buffer.from(content, 'utf8').toString('base64');
}

export function toKernelEnvironment(environment: ManagedSessionEnvironment): {
	body: KernelEnvironment;
	omitted: Omission[];
} {
	const omitted: Omission[] = [];
	const vars = new Map(Object.entries(environment.vars));
	const drop = (name: string, reason: string) => {
		if (vars.delete(name)) omitted.push({ kind: 'variable', name, reason });
	};

	for (const { integration, reason } of environment.unrelayable) {
		omitted.push({ kind: 'integration', name: integration, reason: `no tunnel: ${reason}` });
	}

	// Credentials never ride in the environment, whichever set the service keeps.
	const s3 = environment.s3.at(-1);
	for (const access of environment.s3) {
		for (const name of access.credentialVars) vars.delete(name);
		for (const name of access.endpointVars) vars.delete(name);
		if (access !== s3) {
			omitted.push({
				kind: 's3',
				name: access.endpoint,
				reason: 'the service keeps one S3 credential set per workspace; a later one won',
			});
		}
	}
	const s3Body = s3 ? kernelS3(s3, omitted) : undefined;
	if (s3Body) vars.delete(s3Body.endpointVar);

	const files = kernelFiles(environment.files, vars, drop, omitted);

	const env: Record<string, string> = {};
	for (const [name, value] of vars) {
		if (!ENV_NAME.test(name)) {
			omitted.push({ kind: 'variable', name, reason: 'not a valid variable name' });
		} else if (/[\r\n]/.test(value) || byteLength(value) > MAX_ENV_VALUE_BYTES) {
			omitted.push({ kind: 'variable', name, reason: 'value is multi-line or over 32 KiB' });
		} else {
			env[name] = value;
		}
	}

	const tunnels = kernelTunnels(environment.tunnels, env, omitted);

	const body: KernelEnvironment = {};
	if (Object.keys(env).length > 0) body.env = env;
	if (files.length > 0) body.files = files;
	if (tunnels.length > 0) body.tunnels = tunnels;
	if (s3Body) body.s3 = [s3Body];
	return { body, omitted };
}

function kernelS3(access: SessionS3Access, omitted: Omission[]): KernelEnvironmentS3 | undefined {
	const endpointVar = access.endpointVars[0] ?? DEFAULT_ENDPOINT_VAR;
	if (
		!isHttpOrigin(access.endpoint) ||
		!access.region ||
		!access.accessKeyId ||
		!access.secretAccessKey ||
		!ENV_NAME.test(endpointVar)
	) {
		omitted.push({ kind: 's3', name: access.endpoint, reason: 'incomplete S3 credential set' });
		return;
	}
	for (const extra of access.endpointVars.slice(1)) {
		omitted.push({
			kind: 'variable',
			name: extra,
			reason: `the service points only ${endpointVar} at its S3 relay`,
		});
	}
	return {
		endpoint: access.endpoint,
		region: access.region,
		accessKeyId: access.accessKeyId,
		secretAccessKey: access.secretAccessKey,
		...(access.sessionToken ? { sessionToken: access.sessionToken } : {}),
		endpointVar,
	};
}

/**
 * A file reaches the kernel only through a variable whose whole value is its
 * path; the service picks the real path and sets that variable to it. A value
 * that only embeds a rendered path, or names a rendered directory, would point
 * at nothing, so it is omitted. So is a file whose content embeds one.
 */
function kernelFiles(
	rendered: ManagedSessionEnvironment['files'],
	vars: Map<string, string>,
	drop: (name: string, reason: string) => void,
	omitted: Omission[],
): KernelEnvironmentFile[] {
	const root = commonDirectory(rendered.map(({ path }) => path));
	const paths = new Set(rendered.map(({ path }) => path));
	const directories = new Set<string>();
	const underRoot = (dir: string) =>
		root !== undefined && (dir === root || dir.startsWith(`${root}/`));
	for (const path of paths) {
		let dir = parentDirectory(path);
		while (underRoot(dir)) {
			directories.add(dir);
			dir = parentDirectory(dir);
		}
	}
	// URLs carry the path percent-encoded (`sslrootcert=%2Ftmp%2F...`).
	const encodedRoot = root && encodeURIComponent(`${root}/`).toLowerCase();
	const embedsRenderedPath = (value: string) =>
		root !== undefined &&
		!paths.has(value) &&
		(value.includes(`${root}/`) || value.toLowerCase().includes(encodedRoot!));

	// Deleting the current entry while iterating a Map is safe.
	for (const [name, value] of vars) {
		if (directories.has(value)) drop(name, 'names a directory of rendered files');
		else if (embedsRenderedPath(value)) drop(name, 'embeds the path of a rendered file');
	}

	const taken = new Set<string>();
	const files: KernelEnvironmentFile[] = [];
	for (const file of rendered) {
		const references = [...vars].filter(([, value]) => value === file.path).map(([name]) => name);
		let reason: string | undefined;
		if (references.length === 0) reason = 'no variable names this file';
		else if (byteLength(file.content) > MAX_FILE_BYTES) reason = 'larger than 1 MiB';
		else if (embedsRenderedPath(file.content)) reason = 'content embeds a rendered file path';
		if (reason) {
			omitted.push({ kind: 'file', name: file.path, reason });
			for (const name of references) drop(name, 'names an omitted file');
			continue;
		}
		const contentBase64 = base64(file.content);
		for (const envVar of references) {
			vars.delete(envVar);
			if (!ENV_NAME.test(envVar)) {
				omitted.push({ kind: 'variable', name: envVar, reason: 'not a valid variable name' });
				continue;
			}
			const name = fileName(file.path, root, taken);
			if (!FILE_NAME.test(name)) {
				omitted.push({ kind: 'file', name: file.path, reason: 'no valid file name' });
				continue;
			}
			files.push({ name, contentBase64, envVar });
		}
	}
	return files;
}

/** Each tunnel keeps the variables that still carry it after everything above. */
function kernelTunnels(
	declared: readonly SessionTunnel[],
	env: Record<string, string>,
	omitted: Omission[],
): KernelEnvironmentTunnel[] {
	const byTarget = new Map<string, KernelEnvironmentTunnel>();
	for (const tunnel of declared) {
		const target = `${tunnel.host}:${tunnel.port}`;
		if (
			!isHost(tunnel.host) ||
			!Number.isInteger(tunnel.port) ||
			tunnel.port < 1 ||
			tunnel.port > 65535
		) {
			omitted.push({ kind: 'tunnel', name: target, reason: 'not a DNS name or IP and a port' });
			continue;
		}
		const keep = (names: readonly string[], carries: (value: string) => boolean) =>
			names.filter((name) => Object.hasOwn(env, name) && carries(env[name]));
		const hostVars = keep(tunnel.hostVars, (value) => value === tunnel.host);
		const portVars = keep(tunnel.portVars, (value) => value === String(tunnel.port));
		const urlVars = keep(tunnel.urlVars, (value) => urlCarries(value, tunnel.host, tunnel.port));
		if (hostVars.length + portVars.length + urlVars.length === 0) {
			omitted.push({ kind: 'tunnel', name: target, reason: 'no variable carries it any more' });
			continue;
		}
		const merged = byTarget.get(target);
		if (merged) {
			merged.hostVars = [...new Set([...merged.hostVars, ...hostVars])];
			merged.portVars = [...new Set([...merged.portVars, ...portVars])];
			merged.urlVars = [...new Set([...merged.urlVars, ...urlVars])];
		} else {
			byTarget.set(target, { host: tunnel.host, port: tunnel.port, hostVars, portVars, urlVars });
		}
	}
	const tunnels = [...byTarget.values()];
	for (const extra of tunnels.slice(MAX_TUNNELS)) {
		omitted.push({
			kind: 'tunnel',
			name: `${extra.host}:${extra.port}`,
			reason: `the service relays at most ${MAX_TUNNELS} tunnels per workspace`,
		});
	}
	return tunnels.slice(0, MAX_TUNNELS);
}
