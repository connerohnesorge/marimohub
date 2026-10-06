import { describe, expect, it } from 'vitest';
import type { SessionS3Access } from '@marimo-hub/core/ports/integrations';
import type { ManagedSessionEnvironment } from '@marimo-hub/core/ports/sandbox';
import { toKernelEnvironment } from './environment';

const ROOT = '/tmp/marimohub-integrations';

function environment(overrides: Partial<ManagedSessionEnvironment>): ManagedSessionEnvironment {
	return { vars: {}, files: [], tunnels: [], s3: [], unrelayable: [], ...overrides };
}

const b64 = (value: string) => Buffer.from(value).toString('base64');

function access(overrides: Partial<SessionS3Access> = {}): SessionS3Access {
	return {
		endpoint: 'https://minio.internal:9000',
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

	it('sends a file once per variable whose whole value is its path', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: {
					MARIMOHUB_BIGQUERY_PROD_CREDENTIALS_PATH: `${ROOT}/bigquery/prod-sa.json`,
					GOOGLE_APPLICATION_CREDENTIALS: `${ROOT}/bigquery/prod-sa.json`,
					MARIMOHUB_BIGQUERY_PROD_URL: `bigquery://p/d?credentials_path=${encodeURIComponent(`${ROOT}/bigquery/prod-sa.json`)}`,
					MARIMOHUB_INTEGRATIONS_DIR: ROOT,
					PYICEBERG_HOME: ROOT,
				},
				files: [
					{ path: `${ROOT}/bigquery/prod-sa.json`, content: '{"key":1}' },
					{ path: `${ROOT}/bigquery/prod.json`, content: '{}' },
					{ path: `${ROOT}/manifest.json`, content: '{}' },
				],
			}),
		);

		expect(body.files).toEqual([
			{
				name: 'bigquery-prod-sa.json',
				contentBase64: b64('{"key":1}'),
				envVar: 'MARIMOHUB_BIGQUERY_PROD_CREDENTIALS_PATH',
			},
			{
				name: 'bigquery-prod-sa.json-2',
				contentBase64: b64('{"key":1}'),
				envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
			},
		]);
		expect(body.env).toBeUndefined();
		expect(omitted).toEqual(
			expect.arrayContaining([
				{
					kind: 'variable',
					name: 'MARIMOHUB_BIGQUERY_PROD_URL',
					reason: 'embeds the path of a rendered file',
				},
				{
					kind: 'variable',
					name: 'MARIMOHUB_INTEGRATIONS_DIR',
					reason: 'names a directory of rendered files',
				},
				{ kind: 'variable', name: 'PYICEBERG_HOME', reason: 'names a directory of rendered files' },
				{ kind: 'file', name: `${ROOT}/bigquery/prod.json`, reason: 'no variable names this file' },
				{ kind: 'file', name: `${ROOT}/manifest.json`, reason: 'no variable names this file' },
			]),
		);
	});

	it('omits a file whose content embeds another rendered path, and its variable', () => {
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

	it('omits a file over 1 MiB', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: { KEY_PATH: `${ROOT}/big.pem` },
				files: [{ path: `${ROOT}/big.pem`, content: 'x'.repeat(1024 * 1024 + 1) }],
			}),
		);
		expect(body).toEqual({});
		expect(omitted.map(({ reason }) => reason)).toEqual([
			'larger than 1 MiB',
			'names an omitted file',
		]);
	});

	it('keeps each tunnel with the variables that still carry it', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: {
					PG_HOST: 'db.internal',
					PG_PORT: '5432',
					PG_URL: 'postgresql://u:p@db.internal:5432/x',
					PG_CA_URL: `postgresql://u:p@db.internal:5432/x?sslrootcert=${ROOT}/ca.pem`,
					PGSSLROOTCERT: `${ROOT}/ca.pem`,
					V6_URL: 'postgresql://u:p@[fd00::1]:5433/x',
					STALE: 'other.internal',
				},
				files: [{ path: `${ROOT}/ca.pem`, content: 'pem' }],
				tunnels: [
					{
						host: 'db.internal',
						port: 5432,
						hostVars: ['PG_HOST', 'STALE', 'MISSING'],
						portVars: ['PG_PORT'],
						urlVars: ['PG_URL', 'PG_CA_URL'],
					},
					{ host: 'db.internal', port: 5432, hostVars: ['PG_HOST'], portVars: [], urlVars: [] },
					{ host: 'fd00::1', port: 5433, hostVars: [], portVars: [], urlVars: ['V6_URL'] },
					{ host: 'gone.internal', port: 1, hostVars: ['NOPE'], portVars: [], urlVars: [] },
					{ host: 'bad host', port: 5432, hostVars: ['PG_HOST'], portVars: [], urlVars: [] },
				],
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

		const { body, omitted } = toKernelEnvironment(environment({ vars, tunnels }));

		expect(body.tunnels).toHaveLength(16);
		expect(omitted).toEqual([
			{ kind: 'tunnel', name: 'db16.internal:5432', reason: expect.stringMatching(/at most 16/) },
		]);
	});

	it('keeps S3 credentials out of the environment and lets the last set win', () => {
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: {
					MARIMOHUB_S3_LAKE_ACCESS_KEY_ID: 'static-key',
					MARIMOHUB_S3_LAKE_SECRET_ACCESS_KEY: 'static-secret',
					MARIMOHUB_S3_LAKE_ENDPOINT_URL: 'https://minio.internal:9000',
					MARIMOHUB_S3_LAKE_BUCKET: 'lake',
					AWS_ACCESS_KEY_ID: 'wif-key',
					AWS_SECRET_ACCESS_KEY: 'wif-secret',
					AWS_SESSION_TOKEN: 'wif-token',
					AWS_ENDPOINT_URL_S3: 'https://objects.example',
					AWS_REGION: 'us-east-2',
				},
				s3: [
					access({
						accessKeyId: 'static-key',
						secretAccessKey: 'static-secret',
						credentialVars: [
							'MARIMOHUB_S3_LAKE_ACCESS_KEY_ID',
							'MARIMOHUB_S3_LAKE_SECRET_ACCESS_KEY',
						],
						endpointVars: ['MARIMOHUB_S3_LAKE_ENDPOINT_URL'],
					}),
					access({
						endpoint: 'https://objects.example',
						region: 'us-east-2',
						accessKeyId: 'wif-key',
						secretAccessKey: 'wif-secret',
						sessionToken: 'wif-token',
						credentialVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
					}),
				],
			}),
		);

		expect(body.env).toEqual({ MARIMOHUB_S3_LAKE_BUCKET: 'lake', AWS_REGION: 'us-east-2' });
		expect(body.s3).toEqual([
			{
				endpoint: 'https://objects.example',
				region: 'us-east-2',
				accessKeyId: 'wif-key',
				secretAccessKey: 'wif-secret',
				sessionToken: 'wif-token',
				endpointVar: 'AWS_ENDPOINT_URL_S3',
			},
		]);
		expect(omitted).toEqual([
			{ kind: 's3', name: 'https://minio.internal:9000', reason: expect.stringMatching(/one S3/) },
		]);
		expect(JSON.stringify(omitted)).not.toMatch(/static-|wif-/);
	});

	it('defaults the endpoint variable and omits an incomplete set', () => {
		expect(
			toKernelEnvironment(environment({ s3: [access({ endpointVars: [] })] })).body.s3?.[0]
				.endpointVar,
		).toBe('AWS_ENDPOINT_URL_S3');
		const { body, omitted } = toKernelEnvironment(
			environment({
				vars: { AWS_ACCESS_KEY_ID: 'AK' },
				s3: [access({ endpoint: 'ftp://nope' })],
			}),
		);
		expect(body).toEqual({});
		expect(omitted).toEqual([
			{ kind: 's3', name: 'ftp://nope', reason: 'incomplete S3 credential set' },
		]);
	});

	it('reports integrations whose target no tunnel can describe', () => {
		expect(
			toKernelEnvironment(
				environment({ unrelayable: [{ integration: 'mongo', reason: 'srv records' }] }),
			).omitted,
		).toEqual([{ kind: 'integration', name: 'mongo', reason: 'no tunnel: srv records' }]);
	});
});
