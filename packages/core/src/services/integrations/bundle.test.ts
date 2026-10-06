import { describe, expect, it } from 'vitest';
import { createRunId, createSessionId } from '../../ids';
import type { IntegrationId } from '../../ids';
import { bundleIntegrations, INTEGRATIONS_DIR, INTEGRATIONS_DIR_ENV } from './bundle';
import type { RenderedIntegration } from './bundle';
import type { RenderOutput } from './sdk';

const rendered = (name: string, output: RenderOutput): RenderedIntegration => ({
	id: 'intg-0000000000000001' as IntegrationId,
	name,
	kind: 'synthetic',
	version: 1,
	output,
});

const bundle = (items: RenderedIntegration[]) =>
	bundleIntegrations(items, { kind: 'session', id: createSessionId() });

const file = (path: string, content = 'x') => ({ files: [{ path, content }] });
const yaml = (path: string, value: Record<string, unknown> = { a: 1 }) => ({
	yamlFiles: [{ path, value }],
});

it('identifies a job run without encoding it as a session in the manifest', () => {
	const runId = createRunId();
	const result = bundleIntegrations([], { kind: 'job-run', id: runId });
	const manifest = result.files.find((item) => item.path.endsWith('/manifest.json'));
	expect(JSON.parse(manifest?.content ?? '')).toMatchObject({
		workload_kind: 'job-run',
		workload_id: runId,
	});
	expect(manifest?.content).not.toContain('session_id');
});

describe('rendered path collisions', () => {
	it('rejects a file nested under a sibling integration file', () => {
		expect(() =>
			bundle([rendered('first', file('foo')), rendered('second', file('foo/bar'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a file rendered on a sibling integration directory', () => {
		expect(() =>
			bundle([rendered('first', file('foo/bar')), rendered('second', file('foo'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a file nested under a rendered YAML file, and the reverse', () => {
		expect(() =>
			bundle([rendered('first', yaml('cfg')), rendered('second', file('cfg/x'))]),
		).toThrow(/needs it to be a directory/);
		expect(() =>
			bundle([rendered('first', file('cfg/x')), rendered('second', yaml('cfg'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a deep nesting collision and a self-collision within one integration', () => {
		expect(() =>
			bundle([rendered('first', file('a/b/c')), rendered('second', file('a/b/c/d/e'))]),
		).toThrow(/needs it to be a directory/);
		expect(() =>
			bundle([
				rendered('solo', {
					files: [
						{ path: 'a', content: 'x' },
						{ path: 'a/b', content: 'y' },
					],
				}),
			]),
		).toThrow(/needs it to be a directory/);
	});

	it('still rejects an exact cross-integration file collision', () => {
		expect(() =>
			bundle([rendered('first', file('same')), rendered('second', file('same'))]),
		).toThrow(/both render "same"/);
		expect(() =>
			bundle([rendered('first', file('same')), rendered('second', yaml('same'))]),
		).toThrow(/both render "same"/);
	});

	it('permits sibling paths that merely share a name prefix, and merges shared YAML', () => {
		const result = bundle([
			rendered('first', file('trino/prod.json')),
			rendered('second', file('trino/prod-client.crt')),
			rendered('third', yaml('.pyiceberg.yaml', { catalog: { a: 1 } })),
			rendered('fourth', yaml('.pyiceberg.yaml', { catalog: { b: 2 } })),
		]);
		const paths = result.files.map((f) => f.path);
		expect(paths).toContain(`${INTEGRATIONS_DIR}/trino/prod.json`);
		expect(paths).toContain(`${INTEGRATIONS_DIR}/trino/prod-client.crt`);
		const merged = result.files.find((f) => f.path.endsWith('.pyiceberg.yaml'));
		expect(merged?.content).toContain('a: 1');
		expect(merged?.content).toContain('b: 2');
	});
});

describe('process-wide YAML settings', () => {
	// The real case: the BigQuery catalog requires legacy-current-snapshot-id, so
	// it cannot share a session with a catalog that turns it off.
	it('names both integrations and the setting when a root property disagrees', () => {
		expect(() =>
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { 'legacy-current-snapshot-id': 'true' })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { 'legacy-current-snapshot-id': 'false' })),
			]),
		).toThrow(/Integrations "warehouse" and "lakehouse" disagree on "legacy-current-snapshot-id"/);
	});

	// An integration that merely wrote a different key into the same file is not
	// party to the dispute, and naming it sends the admin after the wrong config.
	it('names only the two integrations that set the conflicting key', () => {
		let message = '';
		try {
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('bystander', yaml('.pyiceberg.yaml', { catalog: { b: { uri: 'https://b' } } })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { 'max-workers': '8' })),
			]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/Integrations "warehouse" and "lakehouse" disagree on "max-workers"/);
		expect(message).not.toContain('bystander');
	});

	it('names every integration that set the value now being contradicted', () => {
		expect(() =>
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('lakeshore', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { 'max-workers': '8' })),
			]),
		).toThrow(/Integrations "warehouse", "lakeshore" and "lakehouse" disagree on "max-workers"/);
	});

	it('names the owners of a nested subtree replaced by a scalar', () => {
		let message = '';
		try {
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { catalog: { a: { uri: 'https://a' } } })),
				rendered('bystander', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { catalog: 'off' })),
			]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/Integrations "warehouse" and "lakehouse" disagree on "catalog"/);
		expect(message).not.toContain('bystander');
	});

	it('reports the nested key path and keeps unrelated nested keys out of the blame', () => {
		let message = '';
		try {
			bundle([
				rendered(
					'warehouse',
					yaml('.pyiceberg.yaml', { catalog: { shared: { uri: 'https://a' } } }),
				),
				rendered(
					'bystander',
					yaml('.pyiceberg.yaml', { catalog: { other: { uri: 'https://b' } } }),
				),
				rendered(
					'lakehouse',
					yaml('.pyiceberg.yaml', { catalog: { shared: { uri: 'https://c' } } }),
				),
			]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/Integrations "warehouse" and "lakehouse" disagree on "uri"/);
		expect(message).toContain('.pyiceberg.yaml:catalog:shared');
		expect(message).not.toContain('bystander');
	});

	it('still names an owner when the contradicted value was an empty object', () => {
		expect(() =>
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { catalog: {} })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { catalog: 'off' })),
			]),
		).toThrow(/Integrations "warehouse" and "lakehouse" disagree on "catalog"/);
	});

	it('still merges disjoint catalogs into one file', () => {
		const result = bundle([
			rendered('a', yaml('.pyiceberg.yaml', { catalog: { a: { uri: 'https://a' } } })),
			rendered('b', yaml('.pyiceberg.yaml', { catalog: { b: { uri: 'https://b' } } })),
		]);
		const merged = result.files.find((f) => f.path.endsWith('.pyiceberg.yaml'));
		expect(merged?.content).toContain('https://a');
		expect(merged?.content).toContain('https://b');
	});
});

describe('bundler-owned env', () => {
	it('rejects a kind that sets the integrations-dir var to another value', () => {
		expect(() =>
			bundle([rendered('greedy', { env: { [INTEGRATIONS_DIR_ENV]: '/tmp/evil' } })]),
		).toThrow(/different values/);
	});

	it('always exports the integrations dir, and tolerates a kind echoing it', () => {
		const result = bundle([
			rendered('echo', { env: { [INTEGRATIONS_DIR_ENV]: INTEGRATIONS_DIR } }),
		]);
		expect(result.vars[INTEGRATIONS_DIR_ENV]).toBe(INTEGRATIONS_DIR);
	});
});

describe('data-source discovery env', () => {
	it('selects one complete discovery contract and warns about later claimants', () => {
		const result = bundle([
			rendered('staging', {
				discoveryEnv: {
					TRINO_HOST: 'staging.internal',
					TRINO_USER: 'staging-user',
					TRINO_CATALOG: 'hive',
				},
			}),
			rendered('prod', {
				discoveryEnv: { TRINO_HOST: 'prod.internal', TRINO_USER: 'prod-user' },
			}),
		]);

		expect(result.vars).toMatchObject({
			TRINO_HOST: 'prod.internal',
			TRINO_USER: 'prod-user',
		});
		expect(result.vars.TRINO_CATALOG).toBeUndefined();
		expect(result.warnings).toEqual([
			expect.stringMatching(/"staging".*"prod".*TRINO_HOST, TRINO_USER/),
		]);
	});

	it('keeps ordinary env collisions strict and records discovery warnings in the manifest', () => {
		expect(() =>
			bundle([
				rendered('first', { env: { SHARED: 'one' } }),
				rendered('second', { env: { SHARED: 'two' } }),
			]),
		).toThrow(/same environment variable/);

		const result = bundle([
			rendered('fallback', {
				warnings: ['Automatic discovery is unavailable.'],
			}),
		]);
		const manifest = result.files.find(({ path }) => path.endsWith('/manifest.json'));
		const parsed = JSON.parse(manifest?.content ?? '{}') as { warnings?: string[] };
		expect(parsed.warnings).toEqual(['Automatic discovery is unavailable.']);
	});
});

describe('network declarations', () => {
	it('keeps only the declared variables each instance still owns', () => {
		const result = bundle([
			rendered('alpha', {
				env: { ALPHA_HOST: 'a.internal', ALPHA_URL: 'pg://a.internal:5432/x' },
				discoveryEnv: { PGHOST: 'a.internal' },
				tunnels: [
					{
						host: 'a.internal',
						port: 5432,
						hostVars: ['ALPHA_HOST', 'PGHOST'],
						portVars: ['ALPHA_PORT'],
						urlVars: ['ALPHA_URL'],
					},
				],
			}),
			rendered('beta', {
				env: { BETA_HOST: 'b.internal', BETA_MONGO: 'mongodb://b' },
				discoveryEnv: { PGHOST: 'b.internal' },
				tunnels: [
					{ host: 'b.internal', port: 5432, hostVars: ['PGHOST'], portVars: [], urlVars: [] },
				],
				mongodb: [{ urlVar: 'BETA_MONGO' }, { urlVar: 'ALPHA_URL' }],
			}),
		]);

		// alpha wins discovery by name order; beta's only tunnel variable went to alpha.
		expect(result.network?.tunnels).toEqual([
			{
				host: 'a.internal',
				port: 5432,
				hostVars: ['ALPHA_HOST', 'PGHOST'],
				portVars: [],
				urlVars: ['ALPHA_URL'],
			},
		]);
		expect(result.network?.mongodb).toEqual([{ urlVar: 'BETA_MONGO' }]);
	});

	it('names every present credential variable and records relay values and gaps', () => {
		const access = {
			services: ['s3'],
			region: 'us-east-1',
			endpoint: 'https://minio.internal:9000',
			accessKeyId: 'AK',
			secretAccessKey: 'SK',
			credentialVars: ['S3_KEY', 'S3_SECRET', 'S3_TOKEN'],
			endpointVars: ['S3_ENDPOINT', 'MISSING'],
		};
		const result = bundle([
			rendered('lake', {
				env: { S3_KEY: 'AK', S3_SECRET: 'SK', S3_ENDPOINT: 'https://minio.internal:9000' },
				aws: [access],
				hosts: [{ host: 'storage.googleapis.com' }],
				relayEnv: { LAKE_URL: 'keyless' },
			}),
			rendered('mongo', { env: { MONGO_URL: 'mongodb+srv://cluster' }, unrelayable: 'srv' }),
		]);

		expect(result.network?.aws).toEqual([
			{ ...access, credentialVars: ['S3_KEY', 'S3_SECRET'], endpointVars: ['S3_ENDPOINT'] },
		]);
		expect(result.network?.hosts).toEqual([{ host: 'storage.googleapis.com' }]);
		expect(result.network?.relayEnv).toEqual({ LAKE_URL: 'keyless' });
		expect(result.network?.unrelayable).toEqual([{ integration: 'mongo', reason: 'srv' }]);
	});

	it('renders the PyIceberg YAML without the properties a relay drops', () => {
		const result = bundle([
			rendered('glue', {
				yamlFiles: [
					{
						path: '.pyiceberg.yaml',
						value: {
							catalog: {
								glue: { type: 'glue', 'glue.access-key-id': 'AK', 'glue.region': 'us-east-2' },
							},
						},
					},
				],
				relayYamlKeys: ['glue.access-key-id'],
			}),
			rendered('rest', {
				yamlFiles: [
					{ path: '.pyiceberg.yaml', value: { catalog: { rest: { type: 'rest', token: 't' } } } },
				],
			}),
		]);

		const yamlPath = `${INTEGRATIONS_DIR}/.pyiceberg.yaml`;
		expect(result.files.find(({ path }) => path === yamlPath)?.content).toContain(
			'glue.access-key-id',
		);
		const relayed = result.network?.relayFiles.find(({ path }) => path === yamlPath)?.content;
		expect(relayed).not.toContain('glue.access-key-id');
		expect(relayed).toContain('glue.region');
		expect(relayed).toContain('token: t');
	});

	it('rejects an invalid tunnel or host and omits the network when nothing is declared', () => {
		expect(() =>
			bundle([
				rendered('bad', {
					env: { X: '1' },
					tunnels: [{ host: 'h', port: 70000, hostVars: [], portVars: ['X'], urlVars: [] }],
				}),
			]),
		).toThrow(/invalid tunnel target/);
		expect(() => bundle([rendered('bad', { hosts: [{ host: 'h', port: 0 }] })])).toThrow(
			/invalid host/,
		);
		expect(bundle([rendered('plain', { env: { X: '1' } })])).not.toHaveProperty('network');
	});
});
