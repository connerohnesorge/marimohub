/**
 * Map temporary S3 credentials onto the environment variables an S3 SDK (boto3,
 * s3fs, aws-cli) reads, so a notebook can use a federated bucket with no code.
 * Pure — no I/O.
 */
import type { TempS3Creds } from '../../ports/credentialBroker';
import type { SessionNetwork } from '../../ports/integrations';
import { emptySessionNetwork } from '../integrations/network';

/** The region an S3 SDK signs for when none is configured. */
export const DEFAULT_S3_REGION = 'us-east-1';

/** The regional AWS S3 endpoint an SDK uses when no endpoint is configured. */
export function awsS3Endpoint(region: string): string {
	// China is its own partition, with its own DNS suffix.
	return `https://s3.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
}

/**
 * @param creds    temporary credentials from a `CredentialBroker.exchange`.
 * @param endpoint object-store S3 endpoint (e.g. CAIOS) for a non-AWS store; omit
 *                 for AWS S3. Injected S3-scoped (`AWS_ENDPOINT_URL_S3`).
 * @param region   optional region; some SDKs require one to be set.
 */
export function s3CredsToEnv(
	creds: TempS3Creds,
	endpoint?: string,
	region?: string,
): Record<string, string> {
	const env: Record<string, string> = {
		AWS_ACCESS_KEY_ID: creds.accessKeyId,
		AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
	};
	if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken;
	// S3-scoped endpoint only — NOT the generic AWS_ENDPOINT_URL, which points every
	// AWS service (STS, etc.) at this store and breaks unrelated SDK calls.
	if (endpoint) env.AWS_ENDPOINT_URL_S3 = endpoint;
	if (region) env.AWS_REGION = region;
	return env;
}

/**
 * {@link s3CredsToEnv} plus the declaration of which of its variables carry the
 * credentials, for a backend that keeps credentials out of the kernel.
 */
export function s3CredsToSessionEnv(
	creds: TempS3Creds,
	endpoint?: string,
	region?: string,
): { vars: Record<string, string>; network: SessionNetwork } {
	return {
		vars: s3CredsToEnv(creds, endpoint, region),
		network: {
			...emptySessionNetwork(),
			aws: [
				{
					services: ['s3'],
					region: region ?? DEFAULT_S3_REGION,
					...(endpoint ? { endpoint } : {}),
					accessKeyId: creds.accessKeyId,
					secretAccessKey: creds.secretAccessKey,
					...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
					...(creds.expiration ? { expiresAt: creds.expiration } : {}),
					credentialVars: [
						'AWS_ACCESS_KEY_ID',
						'AWS_SECRET_ACCESS_KEY',
						...(creds.sessionToken ? ['AWS_SESSION_TOKEN'] : []),
					],
					endpointVars: ['AWS_ENDPOINT_URL_S3'],
				},
			],
		},
	};
}
