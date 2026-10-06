/**
 * Maps a session's rendered environment onto the external kernel service's
 * workspace environment (`PUT /workspaces/{id}/environment`, version 2).
 *
 * The service writes each file where it chooses; an `env` value names one as
 * `${KIRA_FILE:<name>}`, `envVar` gets its path, and `dirEnvVar` its directory.
 * It relays each tunnel through loopback and rewrites the variables that carry
 * it, lets `hosts` through its egress proxy with TLS end to end, resolves and
 * relays MongoDB URLs itself, and keeps AWS credentials, re-signing each request
 * sent to a loopback endpoint per service. Whatever cannot be expressed is
 * omitted rather than sent with a value that would point somewhere wrong;
 * `omitted` names it (never its value) so the caller can log it.
 */
import type {
	SessionAwsAccess,
	SessionHost,
	SessionTunnel,
	SessionTunnelCredential,
} from '@marimo-hub/core/ports/integrations';
import type { ManagedSessionEnvironment } from '@marimo-hub/core/ports/sandbox';

export interface KernelEnvironmentFile {
	/** A file name, optionally under one directory. */
	name: string;
	contentBase64: string;
	/** Set to the file's path; empty when no variable names the whole path. */
	envVar: string;
	/** Set to the file's directory. */
	dirEnvVar?: string;
}

export interface KernelEnvironmentTunnel {
	host: string;
	port: number;
	hostVars: string[];
	portVars: string[];
	urlVars: string[];
	/** `postgres`: the service signs in upstream with these and keeps them. */
	protocol?: 'postgres';
	user?: string;
	password?: string;
	database?: string;
	sslmode?: string;
	rootCaBase64?: string;
}

export interface KernelEnvironmentHost {
	host: string;
	port: number;
}

export interface KernelEnvironmentAws {
	services: string[];
	region: string;
	/** An S3-compatible endpoint; empty for AWS itself. */
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	expiresAt?: string;
}

/** The request body; each PUT replaces the workspace's whole environment. */
export interface KernelEnvironment {
	env?: Record<string, string>;
	files?: KernelEnvironmentFile[];
	tunnels?: KernelEnvironmentTunnel[];
	hosts?: KernelEnvironmentHost[];
	mongodb?: { urlVar: string }[];
	aws?: KernelEnvironmentAws[];
}

export interface Omission {
	kind: 'variable' | 'file' | 'tunnel' | 'host' | 'mongodb' | 'aws' | 'integration';
	name: string;
	reason: string;
}

// The service's limits, mirrored so a session fails here with a reason instead
// of on a bare 400.
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TUNNELS = 16;
const DNS_NAME =
	/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;
const AWS_SERVICE = /^[a-z0-9-]{1,64}$/;

const utf8 = new TextEncoder();

function byteLength(value: string): number {
	return utf8.encode(value).byteLength;
}

function isHost(host: string, wildcard = false): boolean {
	if (wildcard && host.startsWith('*.')) return DNS_NAME.test(host.slice(2));
	return host.includes(':') ? IPV6.test(host) : DNS_NAME.test(host);
}

function isPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
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

function segment(value: string): string {
	return value.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(-128) || 'file';
}

function urlCarries(value: string, host: string, port: number): boolean {
	const authority = host.includes(':') ? `[${host}]` : host;
	return value.includes(`${authority}:${port}`);
}

function base64(content: string): string {
	return Buffer.from(content, 'utf8').toString('base64');
}

function fileReference(name: string): string {
	return `\${KIRA_FILE:${name}}`;
}

/** Replace every raw or percent-encoded occurrence of `path` in `value`. */
function substitute(value: string, path: string, replacement: string): string {
	const encoded = encodeURIComponent(path);
	let out = value.split(path).join(replacement);
	const index = () => out.toLowerCase().indexOf(encoded.toLowerCase());
	for (let at = index(); at !== -1; at = index()) {
		out = out.slice(0, at) + replacement + out.slice(at + encoded.length);
	}
	return out;
}

export interface KernelEnvironmentResult {
	body: KernelEnvironment;
	omitted: Omission[];
	/** The earliest time a delivered credential stops working. */
	expiresAt?: string;
}

export function toKernelEnvironment(
	environment: ManagedSessionEnvironment,
): KernelEnvironmentResult {
	const { network } = environment;
	const omitted: Omission[] = [];
	const vars = new Map(Object.entries(environment.vars));
	const drop = (name: string, reason: string) => {
		if (vars.delete(name)) omitted.push({ kind: 'variable', name, reason });
	};

	for (const { integration, reason } of network.unrelayable) {
		omitted.push({ kind: 'integration', name: integration, reason });
	}

	// Credentials never ride in the environment, whichever set the service keeps.
	for (const access of network.aws) {
		for (const name of [...access.credentialVars, ...access.endpointVars]) vars.delete(name);
	}
	for (const [name, value] of Object.entries(network.relayEnv)) vars.set(name, value);
	const aws = kernelAws(network.aws, omitted);
	for (const tunnel of network.tunnels) {
		if (tunnel.credential) brokerCredential(tunnel, tunnel.credential, vars);
	}

	const relayed = new Map(network.relayFiles.map((file) => [file.path, file.content]));
	const rendered = environment.files.map((file) => ({
		path: file.path,
		content: relayed.get(file.path) ?? file.content,
	}));
	const files = kernelFiles(rendered, vars, drop, omitted);

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

	const tunnels = kernelTunnels(network.tunnels, env, omitted);
	const hosts = kernelHosts(network.hosts, omitted);
	const mongodb = network.mongodb.filter(({ urlVar }) => {
		if (/^mongodb(\+srv)?:\/\//.test(env[urlVar] ?? '')) return true;
		omitted.push({ kind: 'mongodb', name: urlVar, reason: 'not a MongoDB URL variable' });
		return false;
	});

	const body: KernelEnvironment = {};
	if (Object.keys(env).length > 0) body.env = env;
	if (files.length > 0) body.files = files;
	if (tunnels.length > 0) body.tunnels = tunnels;
	if (hosts.length > 0) body.hosts = hosts;
	if (mongodb.length > 0) body.mongodb = mongodb.map(({ urlVar }) => ({ urlVar }));
	if (aws.length > 0) body.aws = aws;
	const expiries = aws.flatMap(({ expiresAt }) => (expiresAt ? [expiresAt] : []));
	const expiresAt = expiries.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
	return { body, omitted, ...(expiresAt ? { expiresAt } : {}) };
}

/** A later credential set wins every service it names; an earlier one keeps the rest. */
function kernelAws(
	accesses: readonly SessionAwsAccess[],
	omitted: Omission[],
): KernelEnvironmentAws[] {
	const claimed = new Set<string>();
	const entries: KernelEnvironmentAws[] = [];
	for (const access of [...accesses].reverse()) {
		const name = `${access.services.join('+')}@${access.endpoint ?? 'aws'}`;
		if (
			!access.region ||
			!access.accessKeyId ||
			!access.secretAccessKey ||
			(access.endpoint !== undefined && !isHttpOrigin(access.endpoint)) ||
			!access.services.every((service) => AWS_SERVICE.test(service))
		) {
			omitted.push({ kind: 'aws', name, reason: 'incomplete AWS credential set' });
			continue;
		}
		const services = access.services.filter((service) => !claimed.has(service));
		if (services.length === 0) {
			omitted.push({ kind: 'aws', name, reason: 'newer credentials sign every service it names' });
			continue;
		}
		for (const service of services) claimed.add(service);
		entries.unshift({
			services,
			region: access.region,
			endpoint: access.endpoint ?? '',
			accessKeyId: access.accessKeyId,
			secretAccessKey: access.secretAccessKey,
			...(access.sessionToken ? { sessionToken: access.sessionToken } : {}),
			...(access.expiresAt ? { expiresAt: access.expiresAt } : {}),
		});
	}
	return entries;
}

/**
 * A file reaches the kernel through the variables that name it: its whole path
 * becomes `envVar` (or `${KIRA_FILE:<name>}` for a second such variable), an
 * embedded path, plain or percent-encoded, becomes `${KIRA_FILE:<name>}`, and a
 * variable naming a rendered directory ships that directory's files with
 * `dirEnvVar`. A file whose content embeds a rendered path, or that nothing
 * names, is omitted, and so is any value left pointing at a rendered path.
 */
function kernelFiles(
	rendered: readonly { path: string; content: string }[],
	vars: Map<string, string>,
	drop: (name: string, reason: string) => void,
	omitted: Omission[],
): KernelEnvironmentFile[] {
	const root = commonDirectory(rendered.map(({ path }) => path));
	if (root === undefined) return [];
	const underRoot = (dir: string) => dir === root || dir.startsWith(`${root}/`);
	const directories = new Set<string>();
	for (const { path } of rendered) {
		for (let dir = parentDirectory(path); underRoot(dir); dir = parentDirectory(dir)) {
			directories.add(dir);
		}
	}
	const encodedRoot = encodeURIComponent(`${root}/`).toLowerCase();
	const embedsRendered = (value: string) =>
		value.includes(`${root}/`) || value.toLowerCase().includes(encodedRoot);
	const deliverable = (file: { path: string; content: string }): string | undefined => {
		if (byteLength(file.content) > MAX_FILE_BYTES) return 'larger than 1 MiB';
		if (embedsRendered(file.content)) return 'content embeds a rendered file path';
		return;
	};

	const files: KernelEnvironmentFile[] = [];
	const taken = new Set<string>();
	const unique = (name: string) => {
		let candidate = name;
		for (let n = 2; taken.has(candidate); n++) candidate = `${name}-${n}`;
		taken.add(candidate);
		return candidate;
	};
	const shipped = new Set<string>();

	// Deleting the current entry while iterating a Map is safe.
	for (const [variable, value] of vars) {
		if (!directories.has(value)) continue;
		vars.delete(variable);
		const label = segment(variable.toLowerCase().replaceAll('_', '-'));
		for (const file of rendered.filter(({ path }) => parentDirectory(path) === value)) {
			const reason = deliverable(file);
			if (reason) {
				omitted.push({ kind: 'file', name: file.path, reason });
				continue;
			}
			const base = segment(file.path.slice(file.path.lastIndexOf('/') + 1));
			files.push({
				name: unique(`${label}/${base}`),
				contentBase64: base64(file.content),
				envVar: '',
				dirEnvVar: variable,
			});
			shipped.add(file.path);
		}
	}

	for (const file of rendered) {
		const names = [...vars.keys()].sort();
		const exact = names.filter((name) => vars.get(name) === file.path);
		const embedding = names.filter((name) => {
			const value = vars.get(name)!;
			return (
				value !== file.path &&
				(value.includes(file.path) ||
					value.toLowerCase().includes(encodeURIComponent(file.path).toLowerCase()))
			);
		});
		if (exact.length + embedding.length === 0) {
			if (!shipped.has(file.path)) {
				omitted.push({ kind: 'file', name: file.path, reason: 'no variable names this file' });
			}
			continue;
		}
		const reason = deliverable(file);
		if (reason) {
			omitted.push({ kind: 'file', name: file.path, reason });
			for (const name of [...exact, ...embedding]) drop(name, 'names an omitted file');
			continue;
		}
		const relative = file.path.slice(root.length + 1).split('/');
		const base = segment(relative.pop()!);
		const name = unique(relative.length > 0 ? `${segment(relative.join('-'))}/${base}` : base);
		const [envVar = '', ...others] = exact;
		if (envVar) vars.delete(envVar);
		for (const variable of [...others, ...embedding]) {
			vars.set(variable, substitute(vars.get(variable)!, file.path, fileReference(name)));
		}
		files.push({ name, contentBase64: base64(file.content), envVar });
	}

	for (const [name, value] of vars) {
		if (embedsRendered(value) || directories.has(value)) {
			drop(name, 'points at a rendered file the service cannot deliver');
		}
	}
	return files;
}

/** What the kernel sees in place of a password the service keeps. */
export const BROKERED_PASSWORD = 'kira-brokered';

/**
 * The service signs in upstream and answers the kernel's client without a
 * password, over loopback without TLS. So the password becomes a placeholder,
 * and the kernel's side asks for no TLS and names no CA file (left unreferenced,
 * the CA file is not sent).
 */
function brokerCredential(
	tunnel: SessionTunnel,
	credential: SessionTunnelCredential,
	vars: Map<string, string>,
): void {
	for (const name of tunnel.urlVars) {
		const value = vars.get(name);
		if (value === undefined) continue;
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			continue;
		}
		if (url.password) url.password = BROKERED_PASSWORD;
		url.searchParams.delete('sslrootcert');
		url.searchParams.set('sslmode', 'disable');
		vars.set(name, url.toString());
	}
	for (const name of credential.passwordVars) {
		if (vars.get(name) === credential.password) vars.set(name, BROKERED_PASSWORD);
	}
	for (const name of credential.sslmodeVars) {
		if (vars.has(name)) vars.set(name, 'disable');
	}
	for (const name of credential.rootCertVars) vars.delete(name);
}

/**
 * Each tunnel keeps the variables that still carry it after everything above.
 * A tunnel with a credential is never merged: each sign-in gets its own relay.
 */
function kernelTunnels(
	declared: readonly SessionTunnel[],
	env: Record<string, string>,
	omitted: Omission[],
): KernelEnvironmentTunnel[] {
	const byTarget = new Map<string, KernelEnvironmentTunnel>();
	for (const tunnel of declared) {
		const target = `${tunnel.host}:${tunnel.port}`;
		if (!isHost(tunnel.host) || !isPort(tunnel.port)) {
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
		const { credential } = tunnel;
		if (credential) {
			byTarget.set(`${target}#${byTarget.size}`, {
				host: tunnel.host,
				port: tunnel.port,
				hostVars,
				portVars,
				urlVars,
				protocol: credential.protocol,
				user: credential.user,
				password: credential.password,
				database: credential.database,
				sslmode: credential.sslmode,
				rootCaBase64: credential.rootCa ? base64(credential.rootCa) : '',
			});
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

function kernelHosts(
	declared: readonly SessionHost[],
	omitted: Omission[],
): KernelEnvironmentHost[] {
	const hosts = new Map<string, KernelEnvironmentHost>();
	for (const { host, port = 443 } of declared) {
		const name = `${host}:${port}`;
		if (!isHost(host, true) || !isPort(port)) {
			omitted.push({ kind: 'host', name, reason: 'not a DNS name, wildcard, or IP and a port' });
			continue;
		}
		hosts.set(name.toLowerCase(), { host: host.toLowerCase(), port });
	}
	return [...hosts.values()];
}
