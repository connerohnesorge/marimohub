import { describe, expect, it } from 'vitest';
import { toKernelEnvironment } from '@marimo-hub/compute-external-kernel';
import {
	bundleIntegrations,
	createIntegrationId,
	createProjectId,
	createSessionId,
	defaultRegistry,
	INTEGRATIONS_DIR,
	s3CredsToSessionEnv,
	UserId,
} from '@marimo-hub/core';
import type { SessionRender } from '@marimo-hub/core';
import { SAMPLE_CONFIGS } from '@marimo-hub/core/testing';

const registry = defaultRegistry();

function render(kind: string, overrides: object = {}, name = 'prod') {
	const definition = registry.get(kind);
	return {
		id: createIntegrationId(),
		name,
		kind,
		version: 1,
		output: definition.render({
			config: definition.configSchema.parse({
				...(SAMPLE_CONFIGS[kind] as object),
				...overrides,
			}),
			instanceName: name,
			projectId: createProjectId(),
			principal: { userId: UserId.parse('user-1'), email: 'ada@example.com' },
			workload: { kind: 'session', id: createSessionId() },
		}),
	};
}

/** What the external kernel service receives for these integrations, as a session would send it. */
function deliver(...items: ReturnType<typeof render>[]) {
	const bundle: SessionRender = bundleIntegrations(items, {
		kind: 'session',
		id: createSessionId(),
	});
	return toKernelEnvironment({
		vars: bundle.vars,
		files: bundle.files,
		tunnels: bundle.tunnels ?? [],
		s3: bundle.s3 ?? [],
		unrelayable: bundle.unrelayable ?? [],
	});
}

const envNames = (result: ReturnType<typeof deliver>) => Object.keys(result.body.env ?? {});
const omittedNames = (result: ReturnType<typeof deliver>) => result.omitted.map(({ name }) => name);

describe('integrations delivered to an external kernel', () => {
	it.each([
		[
			'postgres',
			'db.internal',
			5432,
			['MARIMOHUB_PG_PROD_HOST', 'PGHOST'],
			['MARIMOHUB_PG_PROD_PORT', 'PGPORT'],
			['MARIMOHUB_PG_PROD_URL'],
		],
		[
			'mysql',
			'mysql.internal',
			3306,
			['MARIMOHUB_MYSQL_PROD_HOST'],
			['MARIMOHUB_MYSQL_PROD_PORT'],
			['MARIMOHUB_MYSQL_PROD_URL'],
		],
		[
			'sqlserver',
			'mssql.internal',
			1433,
			['MARIMOHUB_MSSQL_PROD_HOST'],
			['MARIMOHUB_MSSQL_PROD_PORT'],
			['MARIMOHUB_MSSQL_PROD_URL'],
		],
		[
			'redshift',
			'wg.123456789012.us-east-1.redshift-serverless.amazonaws.com',
			5439,
			['MARIMOHUB_REDSHIFT_PROD_HOST'],
			['MARIMOHUB_REDSHIFT_PROD_PORT'],
			['MARIMOHUB_REDSHIFT_PROD_URL'],
		],
		[
			'clickhouse',
			'ch.internal',
			8443,
			['MARIMOHUB_CLICKHOUSE_PROD_HOST'],
			['MARIMOHUB_CLICKHOUSE_PROD_PORT'],
			['MARIMOHUB_CLICKHOUSE_PROD_URL'],
		],
		[
			'trino',
			'trino.internal',
			443,
			['MARIMOHUB_TRINO_PROD_HOST', 'TRINO_HOST'],
			['MARIMOHUB_TRINO_PROD_PORT', 'TRINO_PORT'],
			['MARIMOHUB_TRINO_PROD_URL'],
		],
		['pyspark', 'spark.internal', 15002, [], [], ['MARIMOHUB_PYSPARK_PROD_REMOTE', 'SPARK_REMOTE']],
		[
			'databricks',
			'dbc-1234abcd-5678.cloud.databricks.com',
			443,
			['MARIMOHUB_DATABRICKS_PROD_HOST'],
			[],
			['MARIMOHUB_DATABRICKS_PROD_URL'],
		],
	])(
		'%s: tunnels its server through the variables that carry it',
		(kind, host, port, hostVars, portVars, urlVars) => {
			const result = deliver(render(kind));

			expect(result.body.tunnels).toEqual([{ host, port, hostVars, portVars, urlVars }]);
			expect(result.body.s3).toBeUndefined();
			for (const name of [...hostVars, ...portVars, ...urlVars]) {
				expect(envNames(result)).toContain(name);
			}
			// The hub's directory, manifest, and descriptor files have no place in the kernel.
			expect(omittedNames(result)).toContain('MARIMOHUB_INTEGRATIONS_DIR');
			expect(omittedNames(result)).toContain(`${INTEGRATIONS_DIR}/manifest.json`);
		},
	);

	it('postgres with a pasted CA: the bundle becomes a file, and the URL that embeds its path is omitted', () => {
		const result = deliver(render('postgres', { ssl: { mode: 'verify-full', ca_bundle: 'PEM' } }));

		expect(result.body.files).toEqual([
			{
				name: 'postgres-prod-ca.pem',
				contentBase64: Buffer.from('PEM').toString('base64'),
				envVar: 'PGSSLROOTCERT',
			},
		]);
		expect(envNames(result)).not.toContain('MARIMOHUB_PG_PROD_URL');
		expect(result.body.tunnels?.[0]).toMatchObject({
			urlVars: [],
			hostVars: ['MARIMOHUB_PG_PROD_HOST', 'PGHOST'],
		});
	});

	it('trino and pyspark: their config files reach the kernel through their variables', () => {
		expect(deliver(render('trino')).body.files).toEqual([
			expect.objectContaining({ name: 'trino-prod.json', envVar: 'MARIMOHUB_TRINO_PROD_CONFIG' }),
		]);
		expect(deliver(render('pyspark')).body.files).toEqual([
			expect.objectContaining({
				name: 'pyspark-prod.json',
				envVar: 'MARIMOHUB_PYSPARK_PROD_CONFIG',
			}),
		]);
	});

	it('mongodb+srv and snowflake: no tunnel can describe the target, so none is sent', () => {
		for (const kind of ['mongodb', 'snowflake']) {
			const result = deliver(render(kind));
			expect(result.body.tunnels).toBeUndefined();
			expect(result.omitted).toContainEqual(
				expect.objectContaining({ kind: 'integration', name: 'prod' }),
			);
		}
		expect(deliver(render('mongodb', { scheme: 'mongodb' })).body.tunnels).toHaveLength(1);
	});

	it('s3 with static keys: the service keeps the keys and the kernel gets none of them', () => {
		const result = deliver(render('s3'));

		expect(result.body.s3).toEqual([
			{
				endpoint: 'https://minio.internal:9000',
				region: 'us-east-1',
				accessKeyId: 'AKIAEXAMPLE',
				secretAccessKey: 's3-secret',
				endpointVar: 'AWS_ENDPOINT_URL_S3',
			},
		]);
		const env = result.body.env ?? {};
		expect(JSON.stringify(env)).not.toMatch(/AKIAEXAMPLE|s3-secret/);
		expect(env).toMatchObject({ AWS_REGION: 'us-east-1', MARIMOHUB_S3_PROD_BUCKET: 'lake' });
		expect(result.body.files).toEqual([
			expect.objectContaining({ name: 's3-prod-aws.conf', envVar: 'AWS_CONFIG_FILE' }),
		]);
		expect(omittedNames(result)).toContain('MARIMOHUB_S3_PROD_ENDPOINT_URL');
	});

	it('federated credentials win over an S3 integration, whose keys are still withheld', () => {
		const items = [render('s3'), render('postgres', {}, 'warehouse')];
		const bundle = bundleIntegrations(items, { kind: 'session', id: createSessionId() });
		const wif = s3CredsToSessionEnv(
			{ accessKeyId: 'WIFKEY', secretAccessKey: 'wif-secret', sessionToken: 'wif-token' },
			'https://objects.example',
			'us-east-2',
		);

		const result = toKernelEnvironment({
			vars: { ...bundle.vars, ...wif.vars },
			files: bundle.files,
			tunnels: bundle.tunnels ?? [],
			s3: [...(bundle.s3 ?? []), ...wif.s3],
			unrelayable: [],
		});

		expect(result.body.s3).toEqual([
			{
				endpoint: 'https://objects.example',
				region: 'us-east-2',
				accessKeyId: 'WIFKEY',
				secretAccessKey: 'wif-secret',
				sessionToken: 'wif-token',
				endpointVar: 'AWS_ENDPOINT_URL_S3',
			},
		]);
		expect(JSON.stringify(result.body.env)).not.toMatch(/AKIAEXAMPLE|s3-secret|WIFKEY|wif-/);
		expect(result.body.tunnels).toHaveLength(1);
	});

	it('bigquery and gcs: key files reach the kernel through each variable that names them', () => {
		const bigquery = deliver(render('bigquery', { ambient_env: true }));
		expect(bigquery.body.files?.map(({ envVar }) => envVar)).toEqual([
			'MARIMOHUB_BIGQUERY_PROD_CREDENTIALS_PATH',
			'GOOGLE_APPLICATION_CREDENTIALS',
		]);
		expect(omittedNames(bigquery)).toContain('MARIMOHUB_BIGQUERY_PROD_URL');
		expect(deliver(render('gcs')).body.files?.map(({ envVar }) => envVar)).toContain(
			'MARIMOHUB_GCS_PROD_CREDENTIALS_PATH',
		);
	});

	it.each([
		'iceberg_rest',
		'iceberg_sql',
		'iceberg_hive',
		'iceberg_glue',
		'iceberg_dynamodb',
		'iceberg_bigquery',
	])('%s: its directory-based PyIceberg configuration cannot be delivered', (kind) => {
		const result = deliver(render(kind));
		expect(result.body.files).toBeUndefined();
		expect(omittedNames(result)).toEqual(
			expect.arrayContaining(['PYICEBERG_HOME', `${INTEGRATIONS_DIR}/.pyiceberg.yaml`]),
		);
	});

	it.each(['athena', 'azure_blob', 'wandb', 'huggingface', 'motherduck', 'custom_env'])(
		'%s: plain variables only, with no tunnel',
		(kind) => {
			const result = deliver(render(kind));
			expect(envNames(result).length).toBeGreaterThan(0);
			expect(result.body.tunnels).toBeUndefined();
			expect(result.body.s3).toBeUndefined();
		},
	);

	it.each(['duckdb_http', 'ducklake'])('%s: renders nothing for a kernel', (kind) => {
		expect(deliver(render(kind)).body).toEqual({});
	});
});
