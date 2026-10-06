import { describe, expect, it } from 'vitest';
import type { SessionAwsAccess, SessionNetwork } from '@marimo-hub/core/ports/integrations';
import type { ManagedSessionEnvironment } from '@marimo-hub/core/ports/sandbox';
import { ValidationError } from '@marimo-hub/core/errors';
import { refuseUndeliverable, toKernelEnvironment } from './environment';
import type { Omission } from './environment';

const ROOT = '/tmp/marimohub-integrations';

function environment(
	overrides: Partial<Omit<ManagedSessionEnvironment, 'network'>> & {
		network?: Partial<SessionNetwork>;
	},
): ManagedSessionEnvironment {
	return {
		vars: overrides.vars ?? {},
		files: overrides.files ?? [],
		network: {
			tunnels: [],
			hosts: [],
			mongodb: [],
			aws: [],
			relayEnv: {},
			relayFiles: [],
			unrelayable: [],
			...overrides.network,
		},
	};
}

const b64 = (value: string) => Buffer.from(value).toString('base64');

function access(overrides: Partial<SessionAwsAccess> = {}): SessionAwsAccess {
	return {
		services: ['s3'],
		region: 'us-east-1',
		accessKeyId: 'AK',
		secretAccessKey: 'SK',
		credentialVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
		endpointVars: ['AWS_ENDPOINT_URL_S3'],
		...overrides,
	};
}

describe('toKernelEnvironment', () => {
	it('sends plain variables and omits what the service would refuse', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: {
					PLAIN: 'value',
					lower_case: 'x',
					MULTI: 'hidden-value\nb',
					BIG: 'x'.repeat(32 * 1024 + 1),
					EDGE: 'x'.repeat(32 * 1024),
				},
			}),
		);

		expect(Object.keys(body.env ?? {})).toEqual(['PLAIN', 'EDGE']);
		expect(omitted.map(({ name }) => name).sort()).toEqual(['BIG', 'MULTI', 'lower_case']);
		expect(JSON.stringify(omitted)).not.toContain('hidden-value');
	});

	it('delivers a file once and names it in every variable that refers to it', () => {
		const sa = `${ROOT}/bigquery/prod-sa.json`;
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: {
					MARIMOHUB_BIGQUERY_PROD_CREDENTIALS_PATH: sa,
					GOOGLE_APPLICATION_CREDENTIALS: sa,
					MARIMOHUB_BIGQUERY_PROD_URL: `bigquery://p/d?credentials_path=${encodeURIComponent(sa)}`,
					RAW_EMBED: `--key=${sa}`,
				},
				files: [
					{ path: sa, content: '{"key":1}' },
					{ path: `${ROOT}/bigquery/prod.json`, content: '{}' },
					{ path: `${ROOT}/manifest.json`, content: '{}' },
				],
			}),
		);

		expect(body.files).toEqual([
			{
				name: 'bigquery/prod-sa.json',
				contentBase64: b64('{"key":1}'),
				envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
			},
		]);
		expect(body.env).toEqual({
			MARIMOHUB_BIGQUERY_PROD_CREDENTIALS_PATH: '${KIRA_FILE:bigquery/prod-sa.json}',
			MARIMOHUB_BIGQUERY_PROD_URL:
				'bigquery://p/d?credentials_path=${KIRA_FILE:bigquery/prod-sa.json}',
			RAW_EMBED: '--key=${KIRA_FILE:bigquery/prod-sa.json}',
		});
		expect(omitted).toEqual([
			{ kind: 'file', name: `${ROOT}/bigquery/prod.json`, reason: 'no variable names this file' },
			{ kind: 'file', name: `${ROOT}/manifest.json`, reason: 'no variable names this file' },
		]);
	});

	it('ships the files of a directory variable under one directory with dirEnvVar', () => {
		const { body } = toKernelEnvironment(
			environment({
				vars: { PYICEBERG_HOME: ROOT },
				files: [
					{ path: `${ROOT}/.pyiceberg.yaml`, content: 'catalog: {}\n' },
					{ path: `${ROOT}/iceberg/prod.json`, content: '{}' },
				],
			}),
		);

		expect(body.files).toEqual([
			{
				name: 'pyiceberg-home/.pyiceberg.yaml',
				contentBase64: b64('catalog: {}\n'),
				envVar: '',
				dirEnvVar: 'PYICEBERG_HOME',
			},
		]);
		expect(body.env).toBeUndefined();
	});

	it('delivers the relayed version of a file that carries withheld credentials', () => {
		const yaml = `${ROOT}/.pyiceberg.yaml`;
		const { body } = toKernelEnvironment(
			environment({
				vars: { PYICEBERG_HOME: ROOT },
				files: [{ path: yaml, content: 'glue.access-key-id: AK\n' }],
				network: { relayFiles: [{ path: yaml, content: 'glue.region: us-east-2\n' }] },
			}),
		);
		expect(body.files?.[0].contentBase64).toBe(b64('glue.region: us-east-2\n'));
	});

	it('omits a file whose content embeds a rendered path, and what points at it', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: { MARIMOHUB_TRINO_PROD_CONFIG: `${ROOT}/trino/prod.json` },
				files: [
					{ path: `${ROOT}/trino/prod.json`, content: `{"ca":"${ROOT}/trino/prod-ca.pem"}` },
					{ path: `${ROOT}/trino/prod-ca.pem`, content: 'pem' },
				],
			}),
		);

		expect(body).toEqual({});
		expect(omitted.map(({ kind, name }) => `${kind} ${name}`)).toEqual([
			`file ${ROOT}/trino/prod.json`,
			'variable MARIMOHUB_TRINO_PROD_CONFIG',
			`file ${ROOT}/trino/prod-ca.pem`,
		]);
	});

	it('omits a file over 1 MiB and every variable that names it', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: { KEY_PATH: `${ROOT}/big.pem`, KEY_URL: `x?k=${ROOT}/big.pem` },
				files: [{ path: `${ROOT}/big.pem`, content: 'x'.repeat(1024 * 1024 + 1) }],
			}),
		);
		expect(body).toEqual({});
		expect(omitted.map(({ name, reason }) => `${name}: ${reason}`)).toEqual([
			`${ROOT}/big.pem: larger than 1 MiB`,
			'KEY_PATH: names an omitted file',
			'KEY_URL: names an omitted file',
		]);
	});

	it('keeps each tunnel with the variables that still carry it', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: {
					PG_HOST: 'db.internal',
					PG_PORT: '5432',
					PG_URL: `postgresql://u:p@db.internal:5432/x?sslrootcert=${encodeURIComponent(`${ROOT}/ca.pem`)}`,
					PGSSLROOTCERT: `${ROOT}/ca.pem`,
					V6_URL: 'postgresql://u:p@[fd00::1]:5433/x',
					STALE: 'other.internal',
				},
				files: [{ path: `${ROOT}/ca.pem`, content: 'pem' }],
				network: {
					tunnels: [
						{
							host: 'db.internal',
							port: 5432,
							hostVars: ['PG_HOST', 'STALE', 'MISSING'],
							portVars: ['PG_PORT'],
							urlVars: ['PG_URL'],
						},
						{ host: 'db.internal', port: 5432, hostVars: ['PG_HOST'], portVars: [], urlVars: [] },
						{ host: 'fd00::1', port: 5433, hostVars: [], portVars: [], urlVars: ['V6_URL'] },
						{ host: 'gone.internal', port: 1, hostVars: ['NOPE'], portVars: [], urlVars: [] },
						{ host: 'bad host', port: 5432, hostVars: ['PG_HOST'], portVars: [], urlVars: [] },
					],
				},
			}),
		);

		expect(body.tunnels).toEqual([
			{
				host: 'db.internal',
				port: 5432,
				hostVars: ['PG_HOST'],
				portVars: ['PG_PORT'],
				urlVars: ['PG_URL'],
			},
			{ host: 'fd00::1', port: 5433, hostVars: [], portVars: [], urlVars: ['V6_URL'] },
		]);
		expect(body.env?.PG_URL).toContain('sslrootcert=${KIRA_FILE:ca.pem}');
		expect(omitted.filter(({ kind }) => kind === 'tunnel').map(({ name }) => name)).toEqual([
			'gone.internal:1',
			'bad host:5432',
		]);
	});

	it('relays at most 16 tunnels', () => {
		const vars: Record<string, string> = {};
		const tunnels = Array.from({ length: 17 }, (_, index) => {
			vars[`HOST_${index}`] = `db${index}.internal`;
			return {
				host: `db${index}.internal`,
				port: 5432,
				hostVars: [`HOST_${index}`],
				portVars: [],
				urlVars: [],
			};
		});

		const { body, omitted } = toKernelEnvironment(environment({ vars, network: { tunnels } }));

		expect(body.tunnels).toHaveLength(16);
		expect(omitted).toEqual([
			{ kind: 'tunnel', name: 'db16.internal:5432', reason: expect.stringMatching(/at most 16/) },
		]);
	});

	it('sends hosts and MongoDB URL variables as declared', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: { MONGO_URL: 'mongodb+srv://u:p@cluster0.example.net/db', NOT_MONGO: 'https://x' },
				network: {
					hosts: [
						{ host: 'BigQuery.googleapis.com' },
						{ host: 'bigquery.googleapis.com', port: 443 },
						{ host: '*.snowflakecomputing.com' },
						{ host: 'extensions.duckdb.org', port: 80 },
						{ host: '*.', port: 443 },
					],
					mongodb: [{ urlVar: 'MONGO_URL' }, { urlVar: 'NOT_MONGO' }],
				},
			}),
		);

		expect(body.hosts).toEqual([
			{ host: 'bigquery.googleapis.com', port: 443 },
			{ host: '*.snowflakecomputing.com', port: 443 },
			{ host: 'extensions.duckdb.org', port: 80 },
		]);
		expect(body.mongodb).toEqual([{ urlVar: 'MONGO_URL' }]);
		expect(body.env?.MONGO_URL).toBe('mongodb+srv://u:p@cluster0.example.net/db');
		expect(omitted.map(({ kind, name }) => `${kind} ${name}`)).toEqual([
			'host *.:443',
			'mongodb NOT_MONGO',
		]);
	});

	it('keeps AWS credentials out of the environment; a later set wins the services it names', () => {
		const { body, omitted, expiresAt } = toKernelEnvironment(
			environment({
				vars: {
					MARIMOHUB_S3_LAKE_ACCESS_KEY_ID: 'static-key',
					MARIMOHUB_S3_LAKE_SECRET_ACCESS_KEY: 'static-secret',
					MARIMOHUB_S3_LAKE_ENDPOINT_URL: 'https://minio.internal:9000',
					MARIMOHUB_S3_LAKE_BUCKET: 'lake',
					MARIMOHUB_ATHENA_Q_URL: 'awsathena+rest://AKATHENA:athena-secret@athena/x',
					AWS_ACCESS_KEY_ID: 'wif-key',
					AWS_SECRET_ACCESS_KEY: 'wif-secret',
					AWS_SESSION_TOKEN: 'wif-token',
					AWS_ENDPOINT_URL_S3: 'https://objects.example',
					AWS_REGION: 'us-east-2',
				},
				network: {
					aws: [
						access({
							endpoint: 'https://minio.internal:9000',
							accessKeyId: 'static-key',
							secretAccessKey: 'static-secret',
							credentialVars: [
								'MARIMOHUB_S3_LAKE_ACCESS_KEY_ID',
								'MARIMOHUB_S3_LAKE_SECRET_ACCESS_KEY',
							],
							endpointVars: ['MARIMOHUB_S3_LAKE_ENDPOINT_URL'],
						}),
						access({
							services: ['athena', 's3'],
							accessKeyId: 'AKATHENA',
							secretAccessKey: 'athena-secret',
							credentialVars: ['MARIMOHUB_ATHENA_Q_URL'],
							endpointVars: [],
						}),
						access({
							endpoint: 'https://objects.example',
							region: 'us-east-2',
							accessKeyId: 'wif-key',
							secretAccessKey: 'wif-secret',
							sessionToken: 'wif-token',
							expiresAt: '2026-10-06T00:00:00Z',
							credentialVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
						}),
					],
					relayEnv: { MARIMOHUB_ATHENA_Q_URL: 'awsathena+rest://:@athena/x' },
				},
			}),
		);

		expect(body.env).toEqual({
			MARIMOHUB_S3_LAKE_BUCKET: 'lake',
			MARIMOHUB_ATHENA_Q_URL: 'awsathena+rest://:@athena/x',
			AWS_REGION: 'us-east-2',
		});
		expect(body.aws).toEqual([
			{
				services: ['athena'],
				region: 'us-east-1',
				endpoint: '',
				accessKeyId: 'AKATHENA',
				secretAccessKey: 'athena-secret',
			},
			{
				services: ['s3'],
				region: 'us-east-2',
				endpoint: 'https://objects.example',
				accessKeyId: 'wif-key',
				secretAccessKey: 'wif-secret',
				sessionToken: 'wif-token',
				expiresAt: '2026-10-06T00:00:00Z',
			},
		]);
		expect(expiresAt).toBe('2026-10-06T00:00:00Z');
		expect(omitted).toEqual([
			{
				kind: 'aws',
				name: 's3@https://minio.internal:9000',
				reason: expect.stringMatching(/newer/),
			},
		]);
		expect(JSON.stringify(omitted)).not.toMatch(/static-|wif-|secret/);
	});

	it('omits an incomplete AWS credential set', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: { AWS_ACCESS_KEY_ID: 'AK' },
				network: { aws: [access({ endpoint: 'ftp://nope' })] },
			}),
		);
		expect(body).toEqual({});
		expect(omitted).toEqual([
			{ kind: 'aws', name: 's3@ftp://nope', reason: 'incomplete AWS credential set' },
		]);
	});

	it('reports integrations whose network cannot be declared', () => {
		expect(
			toKernelEnvironment(
				environment({
					network: {
						unrelayable: [{ integration: 'lake', kind: 'iceberg_rest', reason: 'hdfs datanodes' }],
					},
				}),
			).omitted,
		).toEqual([
			{
				kind: 'integration',
				name: 'lake',
				reason: 'hdfs datanodes',
				integrationKind: 'iceberg_rest',
			},
		]);
	});

	describe('refuseUndeliverable', () => {
		const omit = (name: string, kind: string): Omission => ({
			kind: 'integration',
			name,
			reason: 'unrelayable',
			integrationKind: kind,
		});

		it('names an integration the kernel cannot serve, and its kind', () => {
			expect(() => refuseUndeliverable([omit('warehouse', 'snowflake')])).toThrow(
				new ValidationError(
					'The integration "warehouse" (kind snowflake) is not available on your Kira kernel yet. Remove it from this project, or ask an admin to move you back to the hub\'s own kernels.',
				),
			);
		});

		it('names every one of several', () => {
			const refuse = () =>
				refuseUndeliverable([omit('queries', 'athena'), omit('lake', 'iceberg_rest')]);
			expect(refuse).toThrow(ValidationError);
			expect(refuse).toThrow(
				'The integrations "queries" (kind athena) and "lake" (kind iceberg_rest) are not available on your Kira kernel yet. Remove them from this project, or ask an admin to move you back to the hub\'s own kernels.',
			);
		});

		it('lets supported integrations through, and only logs omitted values', () => {
			const { omitted } = toKernelEnvironment(
				environment({
					vars: { PGHOST: 'db.internal', 'BAD-NAME': 'x' },
					network: {
						tunnels: [
							{ host: 'db.internal', port: 5432, hostVars: ['PGHOST'], portVars: [], urlVars: [] },
						],
					},
				}),
			);
			expect(omitted.map(({ kind }) => kind)).toEqual(['variable']);
			expect(() => refuseUndeliverable(omitted)).not.toThrow();
		});
	});
});
