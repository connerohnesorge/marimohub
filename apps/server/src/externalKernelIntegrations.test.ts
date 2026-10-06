import { describe, expect, it } from 'vitest';
import { toKernelEnvironment } from '@marimo-hub/compute-external-kernel';
import {
	bundleIntegrations,
	createIntegrationId,
	createProjectId,
	createSessionId,
	defaultRegistry,
	emptySessionNetwork,
	INTEGRATIONS_DIR,
	mergeSessionNetworks,
	s3CredsToSessionEnv,
	UserId,
} from '@marimo-hub/core';
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

type Rendered = ReturnType<typeof render>;

/** What the external kernel service receives for these integrations, as a session sends it. */
function deliver(items: Rendered[], wif?: ReturnType<typeof s3CredsToSessionEnv>) {
	const bundle = bundleIntegrations(items, { kind: 'session', id: createSessionId() });
	return toKernelEnvironment({
		vars: { ...bundle.vars, ...wif?.vars },
		files: bundle.files,
		network: mergeSessionNetworks(bundle.network, wif?.network) ?? emptySessionNetwork(),
	});
}

/** A compact view of one delivery, so each kind's mapping reads as one line. */
function summary(result: ReturnType<typeof deliver>) {
	const { body } = result;
	return {
		// Every bundle ships MARIMOHUB_INTEGRATIONS_DIR; asserted once below.
		files: (body.files ?? [])
			.filter(({ dirEnvVar }) => dirEnvVar !== 'MARIMOHUB_INTEGRATIONS_DIR')
			.map(({ name, envVar, dirEnvVar }) =>
				[name, envVar || undefined, dirEnvVar].filter(Boolean).join(' '),
			),
		tunnels: (body.tunnels ?? []).map(({ host, port }) => `${host}:${port}`),
		hosts: (body.hosts ?? []).map(({ host, port }) => `${host}:${port}`),
		mongodb: (body.mongodb ?? []).map(({ urlVar }) => urlVar),
		aws: (body.aws ?? []).map(
			({ services, endpoint }) => `${services.join('+')}@${endpoint || 'aws'}`,
		),
	};
}

const none = { files: [], tunnels: [], hosts: [], mongodb: [], aws: [] };
const googleAuth = ['oauth2.googleapis.com:443', 'www.googleapis.com:443'];

describe('integrations delivered to an external kernel (environment v2)', () => {
	it.each([
		['postgres', {}, { ...none, tunnels: ['db.internal:5432'] }],
		// The CA travels with the tunnel's credential; the kernel names no CA file.
		[
			'postgres',
			{ ssl: { mode: 'verify-full', ca_bundle: 'PEM' } },
			{ ...none, tunnels: ['db.internal:5432'] },
		],
		['mysql', {}, { ...none, tunnels: ['mysql.internal:3306'] }],
		[
			'mysql',
			{ ssl: { mode: 'verify_identity', ca_bundle: 'PEM' } },
			{ ...none, files: ['mysql/prod-ca.pem'], tunnels: ['mysql.internal:3306'] },
		],
		['sqlserver', {}, { ...none, tunnels: ['mssql.internal:1433'] }],
		[
			'redshift',
			{},
			{ ...none, tunnels: ['wg.123456789012.us-east-1.redshift-serverless.amazonaws.com:5439'] },
		],
		['clickhouse', {}, { ...none, tunnels: ['ch.internal:8443'] }],
		[
			'trino',
			{},
			{
				...none,
				files: ['trino/prod.json MARIMOHUB_TRINO_PROD_CONFIG'],
				tunnels: ['trino.internal:443'],
			},
		],
		[
			'trino',
			{ tls: { verification: 'custom_ca', ca_bundle: 'PEM' } },
			{ ...none, files: ['trino/prod-ca.pem'], tunnels: ['trino.internal:443'] },
		],
		[
			'pyspark',
			{},
			{
				...none,
				files: ['pyspark/prod.json MARIMOHUB_PYSPARK_PROD_CONFIG'],
				tunnels: ['spark.internal:15002'],
			},
		],
		['databricks', {}, { ...none, hosts: ['dbc-1234abcd-5678.cloud.databricks.com:443'] }],
		['mongodb', {}, { ...none, mongodb: ['MARIMOHUB_MONGODB_PROD_URL'] }],
		['mongodb', { scheme: 'mongodb' }, { ...none, mongodb: ['MARIMOHUB_MONGODB_PROD_URL'] }],
		[
			'mongodb',
			{ tls: { mode: 'enabled', ca_bundle: 'PEM' } },
			{ ...none, files: ['mongodb/prod-ca.pem'], mongodb: ['MARIMOHUB_MONGODB_PROD_URL'] },
		],
		['snowflake', {}, { ...none, hosts: ['*.snowflakecomputing.com:443'] }],
		[
			'snowflake',
			{ auth: { method: 'key_pair', private_key: 'KEY' } },
			{
				...none,
				files: ['snowflake/prod-key.pem MARIMOHUB_SNOWFLAKE_PROD_PRIVATE_KEY_PATH'],
				hosts: ['*.snowflakecomputing.com:443'],
			},
		],
		[
			'bigquery',
			{ ambient_env: true },
			{
				...none,
				files: ['bigquery/prod-sa.json GOOGLE_APPLICATION_CREDENTIALS'],
				hosts: ['bigquery.googleapis.com:443', 'bigquerystorage.googleapis.com:443', ...googleAuth],
			},
		],
		['athena', {}, { ...none, aws: ['athena+s3@aws'] }],
		[
			's3',
			{},
			{
				...none,
				files: ['s3/prod-aws.conf AWS_CONFIG_FILE'],
				aws: ['s3@https://minio.internal:9000'],
			},
		],
		[
			'gcs',
			{},
			{
				...none,
				files: ['gcs/prod-sa.json GOOGLE_APPLICATION_CREDENTIALS'],
				hosts: ['storage.googleapis.com:443', ...googleAuth],
			},
		],
		[
			'azure_blob',
			{},
			{
				...none,
				hosts: ['lakeaccount.blob.core.windows.net:443', 'lakeaccount.dfs.core.windows.net:443'],
			},
		],
		[
			'motherduck',
			{},
			{
				...none,
				hosts: ['*.motherduck.com:443', 'extensions.duckdb.org:443', 'extensions.duckdb.org:80'],
			},
		],
		['wandb', {}, { ...none, hosts: ['api.wandb.ai:443'] }],
		[
			'huggingface',
			{},
			{ ...none, hosts: ['huggingface.co:443', '*.huggingface.co:443', '*.hf.co:443'] },
		],
		['custom_env', {}, none],
		[
			'iceberg_rest',
			{},
			{
				...none,
				files: [
					'pyiceberg-home/.pyiceberg.yaml PYICEBERG_HOME',
					'pyiceberg-home/manifest.json PYICEBERG_HOME',
				],
				hosts: ['catalog.internal:443', 'idp.internal:443'],
			},
		],
		[
			'iceberg_sql',
			{},
			{
				...none,
				files: [
					'pyiceberg-home/.pyiceberg.yaml PYICEBERG_HOME',
					'pyiceberg-home/manifest.json PYICEBERG_HOME',
				],
				tunnels: ['db.internal:5432'],
			},
		],
		[
			'iceberg_hive',
			{},
			{
				...none,
				files: [
					'pyiceberg-home/.pyiceberg.yaml PYICEBERG_HOME',
					'pyiceberg-home/manifest.json PYICEBERG_HOME',
				],
				tunnels: ['hive.internal:9083'],
			},
		],
		[
			'iceberg_glue',
			{ credentials: { method: 'static', access_key_id: 'GLUEKEY', secret_access_key: 'g' } },
			{
				...none,
				files: [
					'pyiceberg-home/.pyiceberg.yaml PYICEBERG_HOME',
					'pyiceberg-home/manifest.json PYICEBERG_HOME',
				],
				aws: ['glue@aws'],
			},
		],
		[
			'iceberg_dynamodb',
			{
				unified_credentials: { method: 'static', access_key_id: 'CLIENT', secret_access_key: 'c' },
			},
			{
				...none,
				files: [
					'pyiceberg-home/.pyiceberg.yaml PYICEBERG_HOME',
					'pyiceberg-home/manifest.json PYICEBERG_HOME',
				],
				aws: ['dynamodb+s3@aws'],
			},
		],
		[
			'iceberg_bigquery',
			{},
			{
				...none,
				files: [
					'pyiceberg-home/.pyiceberg.yaml PYICEBERG_HOME',
					'pyiceberg-home/manifest.json PYICEBERG_HOME',
				],
				hosts: ['bigquery.googleapis.com:443', 'bigquerystorage.googleapis.com:443', ...googleAuth],
			},
		],
		['duckdb_http', {}, none],
		['ducklake', {}, none],
	])('%s %j', (kind, overrides, expected) => {
		const result = deliver([render(kind, overrides)]);
		expect(summary(result)).toEqual(expected);
		// No delivered value points at the hub's own rendered paths.
		expect(JSON.stringify(result.body.env ?? {})).not.toContain(INTEGRATIONS_DIR);
		expect(JSON.stringify(result.body.env ?? {})).not.toContain(
			encodeURIComponent(INTEGRATIONS_DIR),
		);
	});

	it('ships the integration manifest for MARIMOHUB_INTEGRATIONS_DIR', () => {
		const files = deliver([render('postgres')]).body.files ?? [];
		expect(files.filter(({ dirEnvVar }) => dirEnvVar === 'MARIMOHUB_INTEGRATIONS_DIR')).toEqual([
			expect.objectContaining({ name: 'marimohub-integrations-dir/manifest.json', envVar: '' }),
		]);
	});

	it('names every kind of the registry in the table above', () => {
		const covered = new Set([
			'postgres',
			'mysql',
			'sqlserver',
			'redshift',
			'clickhouse',
			'trino',
			'pyspark',
			'databricks',
			'mongodb',
			'snowflake',
			'bigquery',
			'athena',
			's3',
			'gcs',
			'azure_blob',
			'motherduck',
			'wandb',
			'huggingface',
			'custom_env',
			'iceberg_rest',
			'iceberg_sql',
			'iceberg_hive',
			'iceberg_glue',
			'iceberg_dynamodb',
			'iceberg_bigquery',
			'duckdb_http',
			'ducklake',
		]);
		expect(
			registry
				.list()
				.map(({ kind }) => kind)
				.filter((kind) => !covered.has(kind)),
		).toEqual([]);
	});

	it('puts a delivered CA or key file where a URL embeds its path', () => {
		const mongo = deliver([render('mongodb', { tls: { mode: 'enabled', ca_bundle: 'PEM' } })]);
		expect(mongo.body.env?.MARIMOHUB_MONGODB_PROD_URL).toContain(
			'tlsCAFile=${KIRA_FILE:mongodb/prod-ca.pem}',
		);
		const bigquery = deliver([render('bigquery')]);
		expect(bigquery.body.env?.MARIMOHUB_BIGQUERY_PROD_URL).toContain(
			'credentials_path=${KIRA_FILE:bigquery/prod-sa.json}',
		);
		expect(bigquery.body.files?.find(({ name }) => name === 'bigquery/prod-sa.json')?.envVar).toBe(
			'MARIMOHUB_BIGQUERY_PROD_CREDENTIALS_PATH',
		);
		const trino = deliver([
			render('trino', { tls: { verification: 'custom_ca', ca_bundle: 'PEM' } }),
		]);
		expect(trino.body.env?.MARIMOHUB_TRINO_PROD_URL).toContain('${KIRA_FILE:trino/prod-ca.pem}');
	});

	describe('Postgres sign-in through the service', () => {
		it('sends the credential and TLS settings with the tunnel, never the password in env', () => {
			const result = deliver([
				render('postgres', {
					ssl: { mode: 'verify-full', ca_bundle: 'PEM' },
					ambient_env: true,
				}),
			]);

			expect(result.body.tunnels).toEqual([
				{
					host: 'db.internal',
					port: 5432,
					hostVars: ['MARIMOHUB_PG_PROD_HOST', 'PGHOST'],
					portVars: ['MARIMOHUB_PG_PROD_PORT', 'PGPORT'],
					urlVars: ['MARIMOHUB_PG_PROD_URL'],
					protocol: 'postgres',
					user: 'svc user',
					password: 'p@ss:word',
					database: 'analytics',
					sslmode: 'verify-full',
					rootCaBase64: Buffer.from('PEM').toString('base64'),
				},
			]);
			const env = result.body.env ?? {};
			expect(JSON.stringify(env)).not.toContain('p@ss');
			expect(JSON.stringify(env)).not.toContain(encodeURIComponent('p@ss:word'));
			// The hop to the service is loopback without TLS; TLS runs upstream.
			expect(env.MARIMOHUB_PG_PROD_URL).toBe(
				'postgresql://svc%20user:kira-brokered@db.internal:5432/analytics?sslmode=disable',
			);
			expect(env).toMatchObject({
				MARIMOHUB_PG_PROD_PASSWORD: 'kira-brokered',
				PGPASSWORD: 'kira-brokered',
				PGSSLMODE: 'disable',
			});
			expect(env).not.toHaveProperty('PGSSLROOTCERT');
		});

		it('relays each sign-in on its own tunnel, even to the same server', () => {
			const result = deliver([
				render('postgres', {}, 'reader'),
				render('postgres', { username: 'writer', password: 'other-secret' }, 'writer'),
			]);

			expect(
				(result.body.tunnels ?? []).map(({ host, port, user }) => `${user}@${host}:${port}`),
			).toEqual(['svc user@db.internal:5432', 'writer@db.internal:5432']);
		});

		it('leaves Redshift on a plain tunnel: its driver cannot turn TLS off for the loopback hop', () => {
			const result = deliver([render('redshift')]);

			expect(result.body.tunnels?.[0]).not.toHaveProperty('protocol');
		});
	});

	it('never puts AWS keys in env, and federated credentials win S3 with their expiry', () => {
		const wif = s3CredsToSessionEnv(
			{
				accessKeyId: 'WIFKEY',
				secretAccessKey: 'wif-secret',
				sessionToken: 'wif-token',
				expiration: '2026-10-06T01:00:00Z',
			},
			'https://objects.example',
			'us-east-2',
		);
		const result = deliver([render('s3'), render('athena', {}, 'queries')], wif);

		expect(summary(result).aws).toEqual(['athena@aws', 's3@https://objects.example']);
		expect(result.expiresAt).toBe('2026-10-06T01:00:00Z');
		const env = JSON.stringify(result.body.env);
		expect(env).not.toMatch(/AKIAEXAMPLE|s3-secret|AKIAATHENA|athena-secret|WIFKEY|wif-/);
		expect(result.body.env?.MARIMOHUB_ATHENA_QUERIES_URL).toMatch(
			/^awsathena\+rest:\/\/:@athena\./,
		);
	});

	it('ships Iceberg YAML without the AWS keys the service keeps', () => {
		const result = deliver([
			render('iceberg_glue', {
				credentials: { method: 'static', access_key_id: 'GLUEKEY', secret_access_key: 'g-secret' },
			}),
		]);
		const yaml = Buffer.from(result.body.files![0].contentBase64, 'base64').toString();
		expect(yaml).toContain('type: glue');
		expect(yaml).not.toMatch(/GLUEKEY|g-secret/);
	});

	it.each([
		['mongodb', { scheme: 'mongodb+srv' }, undefined],
		['iceberg_rest', { auth: { method: 'sigv4', region: 'us-east-1' } }, /SigV4/],
		['iceberg_sql', { storage: { scheme: 'hdfs', host: 'nn.internal' } }, /datanode/],
		['athena', { auth: { method: 'ambient' } }, /ambient/],
	])('%s %j: reports what cannot be relayed', (kind, overrides, reason) => {
		const omitted = deliver([render(kind, overrides)]).omitted.filter(
			({ kind: what }) => what === 'integration',
		);
		if (reason) expect(omitted[0]?.reason).toMatch(reason);
		else expect(omitted).toEqual([]);
	});
});
