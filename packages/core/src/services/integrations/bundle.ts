// Rendered config stays outside the workspace mount so credentials cannot be
// captured into a notebook version.
import { ValidationError } from '../../errors';
import { hasControlCharacter, isRecord } from '../../internal/validation';
import type {
	IntegrationVersionPin,
	SessionNetwork,
	SessionRender,
	SessionTunnel,
	WorkloadRef,
} from '../../ports/integrations';
import { emptySessionNetwork } from './network';
import type { RenderOutput } from './sdk';
import { CODE_EXECUTION_ENV, SHELL_BASICS_ENV } from './environmentName';
import { stringify } from 'yaml';

/** Sandbox directory containing rendered integration files. */
export const INTEGRATIONS_DIR = '/tmp/marimohub-integrations';
/** Environment variable pointing notebook code to {@link INTEGRATIONS_DIR}. */
export const INTEGRATIONS_DIR_ENV = 'MARIMOHUB_INTEGRATIONS_DIR';

/**
 * Env names a kind may not emit: process-start code-execution vectors and shell
 * basics. Narrower than the user-authored environment blocklist on purpose — kinds are hub
 * code and legitimately set tool vars (`PYICEBERG_HOME`) and `MARIMOHUB_*`.
 */
const FORBIDDEN_ENV = new Set<string>([...SHELL_BASICS_ENV, ...CODE_EXECUTION_ENV]);

const ENV_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

/** Owner label for the env vars and files the bundler itself contributes. */
const BUNDLER = 'marimohub';

/**
 * Instance names parameterize rendered file paths and env fragments, so they
 * are locked to a DNS-label-ish shape that maps cleanly onto both.
 */
const INSTANCE_NAME_REGEX = /^[a-z][a-z0-9-]{0,31}$/;

export function assertValidIntegrationName(name: string): void {
	if (!INSTANCE_NAME_REGEX.test(name)) {
		throw new ValidationError(
			`Invalid integration name "${name}": must match ${INSTANCE_NAME_REGEX} ` +
				'(lowercase letters, digits, and hyphens; starting with a letter).',
		);
	}
}

export interface RenderedIntegration extends IntegrationVersionPin {
	/** Requirements copied into the integration manifest. */
	requirements?: string[];
	output: RenderOutput;
}

export function bundleIntegrations(
	rendered: RenderedIntegration[],
	workload: WorkloadRef,
): SessionRender {
	const files: SessionRender['files'] = [];
	const yamlFiles = new Map<string, MergedYaml>();
	const claimPath = pathClaimer();
	// Claimed up front so a kind emitting the bundler's own key gets the normal
	// collision error instead of having its value silently overwritten.
	const vars: Record<string, string> = { [INTEGRATIONS_DIR_ENV]: INTEGRATIONS_DIR };
	const varOwner = new Map<string, string>([[INTEGRATIONS_DIR_ENV, BUNDLER]]);
	const warnings = rendered.flatMap((item) => item.output.warnings ?? []);

	for (const item of rendered) {
		for (const file of item.output.files ?? []) {
			const path = normalizeRelativePath(file.path, item.name);
			claimPath(path, item.name, false);
			files.push({ path: `${INTEGRATIONS_DIR}/${path}`, content: file.content });
		}
		for (const file of item.output.yamlFiles ?? []) {
			const path = normalizeRelativePath(file.path, item.name);
			claimPath(path, item.name, true);
			const existing = yamlFiles.get(path);
			if (existing) {
				existing.value = mergeYaml(existing.value, file.value, path, existing.owners, item.name);
			} else {
				const owners = new Map<string, string[]>();
				recordOwners(owners, '', file.value, item.name);
				yamlFiles.set(path, { value: structuredClone(file.value), owners });
			}
		}
		for (const [key, value] of Object.entries(item.output.env ?? {})) {
			assertValidEnvValue(key, value, item.name);
			const owner = varOwner.get(key);
			// An identical value from two instances is tolerated (e.g. a shared
			// tool var like PYICEBERG_HOME); a differing one is ambiguous.
			if (owner && vars[key] !== value) {
				throw new ValidationError(
					`Integrations "${owner}" and "${item.name}" set the same environment variable to different values.`,
				);
			}
			varOwner.set(key, item.name);
			vars[key] = value;
		}
	}

	for (const item of [...rendered].sort((a, b) => a.name.localeCompare(b.name))) {
		const discovery = Object.entries(item.output.discoveryEnv ?? {});
		for (const [key, value] of discovery) assertValidEnvValue(key, value, item.name);
		const conflicts = discovery.flatMap(([key]) => {
			const owner = varOwner.get(key);
			return owner ? [{ key, owner }] : [];
		});
		if (conflicts.length > 0) {
			const owners = [...new Set(conflicts.map(({ owner }) => owner))];
			const names = conflicts.map(({ key }) => key).join(', ');
			warnings.push(
				`Integration "${item.name}" is available through its notebook snippet, but not automatic ` +
					`data-source discovery because ${owners.map((owner) => `"${owner}"`).join(', ')} already ` +
					`claims ${names}.`,
			);
			continue;
		}
		for (const [key, value] of discovery) {
			varOwner.set(key, item.name);
			vars[key] = value;
		}
	}
	for (const [path, file] of [...yamlFiles].sort(([a], [b]) => a.localeCompare(b))) {
		files.push({
			path: `${INTEGRATIONS_DIR}/${path}`,
			content: stringify(sortObject(file.value)),
		});
	}

	const manifest = {
		workload_kind: workload.kind,
		workload_id: workload.id,
		...(warnings.length > 0 ? { warnings } : {}),
		integrations: rendered.map((item) => ({
			name: item.name,
			kind: item.kind,
			version: item.version,
			...(item.requirements && item.requirements.length > 0
				? { requirements: item.requirements }
				: {}),
			...(item.output.manifestExtra ? { extra: item.output.manifestExtra } : {}),
		})),
	};
	files.push({
		path: `${INTEGRATIONS_DIR}/manifest.json`,
		content: `${JSON.stringify(manifest, null, '\t')}\n`,
	});
	const network = bundleNetwork(rendered, vars, varOwner, yamlFiles);

	return {
		files,
		vars,
		attachments: rendered.map(({ id, name, kind, version }) => ({ id, name, kind, version })),
		warnings,
		...(network ? { network } : {}),
	};
}

/**
 * Keep only the declared variables that made it into the bundle: a discovery
 * variable another instance claimed no longer carries this instance's target.
 * Undefined when no instance declared anything.
 */
function bundleNetwork(
	rendered: RenderedIntegration[],
	vars: Record<string, string>,
	varOwner: Map<string, string>,
	yamlFiles: Map<string, MergedYaml>,
): SessionNetwork | undefined {
	const network = emptySessionNetwork();
	const yamlKeys = new Map<string, Set<string>>();
	let declared = false;
	for (const item of rendered) {
		const { output } = item;
		const relayEnv = output.relayEnv ?? {};
		for (const [key, value] of Object.entries(relayEnv)) {
			assertValidEnvValue(key, value, item.name);
			network.relayEnv[key] = value;
		}
		const owned = (name: string) =>
			varOwner.get(name) === item.name || Object.hasOwn(relayEnv, name);
		for (const tunnel of output.tunnels ?? []) {
			if (!tunnel.host || !isPort(tunnel.port)) {
				throw new ValidationError(`Integration "${item.name}" declared an invalid tunnel target.`);
			}
			const { credential } = tunnel;
			const kept: SessionTunnel = {
				host: tunnel.host,
				port: tunnel.port,
				hostVars: tunnel.hostVars.filter(owned),
				portVars: tunnel.portVars.filter(owned),
				urlVars: tunnel.urlVars.filter(owned),
				...(credential
					? {
							credential: {
								...credential,
								// Replacing the password must not depend on who owns the variable.
								passwordVars: credential.passwordVars.filter((name) => Object.hasOwn(vars, name)),
								sslmodeVars: credential.sslmodeVars.filter(owned),
								rootCertVars: credential.rootCertVars.filter(owned),
							},
						}
					: {}),
			};
			if (kept.hostVars.length + kept.portVars.length + kept.urlVars.length > 0) {
				network.tunnels.push(kept);
			}
		}
		for (const host of output.hosts ?? []) {
			if (!host.host || (host.port !== undefined && !isPort(host.port))) {
				throw new ValidationError(`Integration "${item.name}" declared an invalid host.`);
			}
			network.hosts.push(host);
		}
		for (const { urlVar } of output.mongodb ?? []) {
			if (owned(urlVar)) network.mongodb.push({ urlVar });
		}
		for (const access of output.aws ?? []) {
			// Withholding a credential variable must not depend on who owns it.
			const present = (name: string) => Object.hasOwn(vars, name);
			network.aws.push({
				...access,
				credentialVars: access.credentialVars.filter(present),
				endpointVars: access.endpointVars.filter(owned),
			});
		}
		if (output.relayYamlKeys?.length) yamlKeys.set(item.name, new Set(output.relayYamlKeys));
		if (output.unrelayable) {
			network.unrelayable.push({ integration: item.name, reason: output.unrelayable });
		}
		declared ||=
			Object.keys(relayEnv).length > 0 ||
			[output.tunnels, output.hosts, output.mongodb, output.aws, output.relayYamlKeys].some(
				(list) => !!list?.length,
			) ||
			!!output.unrelayable;
	}
	network.relayFiles = relayYamlFiles(yamlFiles, yamlKeys);
	return declared ? network : undefined;
}

function isPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The merged PyIceberg YAML with withheld credential properties removed from each catalog. */
function relayYamlFiles(
	yamlFiles: Map<string, MergedYaml>,
	yamlKeys: Map<string, Set<string>>,
): SessionNetwork['relayFiles'] {
	if (yamlKeys.size === 0) return [];
	const relayed: SessionNetwork['relayFiles'] = [];
	for (const [path, file] of [...yamlFiles].sort(([a], [b]) => a.localeCompare(b))) {
		const value = structuredClone(file.value);
		const catalogs = isRecord(value.catalog) ? value.catalog : undefined;
		let changed = false;
		for (const [instance, keys] of yamlKeys) {
			const catalog = catalogs?.[instance];
			if (!isRecord(catalog)) continue;
			for (const key of keys) {
				if (Object.hasOwn(catalog, key)) {
					delete catalog[key];
					changed = true;
				}
			}
		}
		if (changed) {
			relayed.push({ path: `${INTEGRATIONS_DIR}/${path}`, content: stringify(sortObject(value)) });
		}
	}
	return relayed;
}

function assertValidEnvValue(key: string, value: string, instance: string): void {
	assertValidEnvName(key, instance);
	if (hasControlCharacter(value)) {
		throw new ValidationError(
			`Integration "${instance}" emitted an environment value containing a control character.`,
		);
	}
}

/**
 * Tracks rendered paths and the directories they imply. A path may be claimed
 * twice only when both claims are `shared` (YAML fragments, which the bundler
 * merges); anything else — including a file that sits on another file's path
 * prefix, which the sandbox could not materialize — is a collision.
 */
function pathClaimer(): (path: string, instance: string, shared: boolean) => void {
	const fileOwner = new Map<string, { owner: string; shared: boolean }>();
	const dirOwner = new Map<string, { owner: string; path: string }>();

	return (path, instance, shared) => {
		const asDirectory = dirOwner.get(path);
		if (asDirectory) {
			throw nestedPathError(instance, path, asDirectory.owner, asDirectory.path);
		}
		const claim = fileOwner.get(path);
		if (claim && !(claim.shared && shared)) {
			throw new ValidationError(
				`Integrations "${claim.owner}" and "${instance}" both render "${path}".`,
			);
		}
		const segments = path.split('/');
		for (let i = 1; i < segments.length; i++) {
			const dir = segments.slice(0, i).join('/');
			const dirClaim = fileOwner.get(dir);
			if (dirClaim) throw nestedPathError(dirClaim.owner, dir, instance, path);
			if (!dirOwner.has(dir)) dirOwner.set(dir, { owner: instance, path });
		}
		if (!claim) fileOwner.set(path, { owner: instance, shared });
	};
}

function nestedPathError(
	fileInstance: string,
	filePath: string,
	nestedInstance: string,
	nestedPath: string,
): ValidationError {
	return new ValidationError(
		`Integrations "${fileInstance}" and "${nestedInstance}" render conflicting paths: ` +
			`"${filePath}" is a file, but "${nestedPath}" needs it to be a directory.`,
	);
}

/**
 * A merged YAML file plus, per leaf key path, the integrations that put the
 * current value there. Blame is tracked per key rather than per file so a
 * conflict names only the integrations that set the disputed key.
 */
interface MergedYaml {
	value: Record<string, unknown>;
	owners: Map<string, string[]>;
}

/** Key-path separator; cannot appear in a YAML key. */
const KEY_SEP = '\u0000';

function recordOwners(
	owners: Map<string, string[]>,
	keyPath: string,
	value: unknown,
	owner: string,
): void {
	// An empty object has no leaves to attribute, so it is claimed as a leaf
	// itself — otherwise a later value replacing it would blame nobody.
	if (isRecord(value) && Object.keys(value).length > 0) {
		for (const [key, child] of Object.entries(value)) {
			recordOwners(owners, `${keyPath}${KEY_SEP}${key}`, child, owner);
		}
		return;
	}
	const existing = owners.get(keyPath);
	if (!existing) owners.set(keyPath, [owner]);
	else if (!existing.includes(owner)) existing.push(owner);
}

/** Everyone whose contribution is part of the value now being contradicted. */
function ownersOf(owners: Map<string, string[]>, keyPath: string): string[] {
	const found: string[] = [];
	const prefix = `${keyPath}${KEY_SEP}`;
	for (const [key, names] of owners) {
		if (key !== keyPath && !key.startsWith(prefix)) continue;
		for (const name of names) if (!found.includes(name)) found.push(name);
	}
	return found;
}

/**
 * Fail closed on disagreement rather than picking a winner: some PyIceberg root
 * properties (`legacy-current-snapshot-id`, `max-workers`) are process-wide, so
 * silently choosing one integration's value would change how the OTHER one
 * reads data. The message names the disagreeing integrations and both values
 * because this surfaces at session launch, where the admin has no other clue
 * which pair to reconcile.
 */
function mergeYaml(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	path: string,
	owners: Map<string, string[]>,
	rightOwner: string,
	keyPath = '',
): Record<string, unknown> {
	const merged = { ...left };
	for (const [key, value] of Object.entries(right)) {
		const previous = merged[key];
		const childPath = `${keyPath}${KEY_SEP}${key}`;
		if (previous === undefined) {
			merged[key] = structuredClone(value);
			recordOwners(owners, childPath, value, rightOwner);
		} else if (isRecord(previous) && isRecord(value)) {
			merged[key] = mergeYaml(previous, value, `${path}:${key}`, owners, rightOwner, childPath);
		} else if (JSON.stringify(previous) === JSON.stringify(value)) {
			recordOwners(owners, childPath, value, rightOwner);
		} else {
			const disputed = ownersOf(owners, childPath);
			throw new ValidationError(
				`Integrations "${disputed.join('", "')}" and "${rightOwner}" disagree on ` +
					`"${key}" in ${path}. This setting applies to the whole session, so the two ` +
					'cannot run together — align the value or disable one of them.',
			);
		}
	}
	return merged;
}

function sortObject(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortObject);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => [key, sortObject(child)]),
	);
}

function normalizeRelativePath(path: string, instance: string): string {
	const segments = path.split('/');
	if (
		path.startsWith('/') ||
		path.includes('\\') ||
		hasControlCharacter(path) ||
		segments.some((s) => s === '' || s === '.' || s === '..')
	) {
		throw new ValidationError(
			`Integration "${instance}" rendered an invalid file path ${JSON.stringify(path)}: paths must be ` +
				'relative, POSIX, free of control characters, and free of "." / ".." segments.',
		);
	}
	if (segments[0] === 'manifest.json') {
		throw new ValidationError(`Integration "${instance}" may not render "manifest.json".`);
	}
	return path;
}

function assertValidEnvName(name: string, instance: string): void {
	if (!ENV_NAME_REGEX.test(name) || FORBIDDEN_ENV.has(name)) {
		throw new ValidationError(
			`Integration "${instance}" emitted a forbidden or malformed env name "${name}".`,
		);
	}
}
