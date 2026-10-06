import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySessionNetwork } from '@marimo-hub/core';
import type {
	ManagedSessionEnvironment,
	ProjectId,
	SandboxInstance,
	SandboxProvider,
	Session,
	SessionEnv,
	SessionId,
} from '@marimo-hub/core';
import { scheduleEnvironmentRefresh, sessionEnvExpiry } from './sessionEnvironmentRefresh';
import type { EnvironmentRefresh } from './sessionEnvironmentRefresh';

const START = Date.UTC(2026, 9, 5, 12);
const HOUR = 3_600_000;

function envExpiringAt(at: number, key = 'AK'): SessionEnv {
	return {
		vars: { AWS_ACCESS_KEY_ID: key },
		network: {
			...emptySessionNetwork(),
			aws: [
				{
					services: ['s3'],
					region: 'us-east-1',
					accessKeyId: key,
					secretAccessKey: 'SK',
					expiresAt: new Date(at).toISOString(),
					credentialVars: ['AWS_ACCESS_KEY_ID'],
					endpointVars: [],
				},
			],
		},
	};
}

describe('scheduleEnvironmentRefresh', () => {
	let status: Session['status'];
	let applied: ManagedSessionEnvironment[];
	let refresh: EnvironmentRefresh;
	let rendered: number;

	beforeEach(() => {
		vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'Date'] });
		status = 'running';
		applied = [];
		rendered = 0;
		const instance = {
			applyEnvironment: async (environment: ManagedSessionEnvironment) => {
				applied.push(environment);
			},
		} as unknown as SandboxInstance;
		const compute = { create: () => instance, proxy: async () => null } as SandboxProvider;
		refresh = {
			deps: {
				compute,
				services: {
					sessions: {
						getSession: async () =>
							({
								project_id: 'proj-1',
								session_id: 'sess-1',
								user_id: 'user-1',
								status,
								sandbox_id: 'sb-0123456789abcdef',
							}) as unknown as Session,
					},
				} as never,
			},
			session: { project_id: 'proj-1' as ProjectId, session_id: 'sess-1' as SessionId },
			resolve: async () => envExpiringAt(Date.now() + HOUR, `KEY${++rendered}`),
		};
	});
	afterEach(() => vi.useRealTimers());

	it('re-sends the environment at 80% of the credential lifetime, and again after that', async () => {
		scheduleEnvironmentRefresh(refresh, START + HOUR);

		await vi.advanceTimersByTimeAsync(0.8 * HOUR - 1);
		expect(applied).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(applied.map(({ vars }) => vars.AWS_ACCESS_KEY_ID)).toEqual(['KEY1']);
		expect(applied[0].network.aws[0].accessKeyId).toBe('KEY1');

		await vi.advanceTimersByTimeAsync(0.8 * HOUR);
		expect(applied.map(({ vars }) => vars.AWS_ACCESS_KEY_ID)).toEqual(['KEY1', 'KEY2']);
	});

	it('stops once the session has ended', async () => {
		scheduleEnvironmentRefresh(refresh, START + HOUR);
		status = 'terminated';

		await vi.advanceTimersByTimeAsync(2 * HOUR);

		expect(applied).toEqual([]);
		expect(rendered).toBe(0);
	});

	it('retries a failed refresh until the credentials expire', async () => {
		let failures = 2;
		const resolve = refresh.resolve;
		refresh.resolve = async () => {
			if (failures-- > 0) throw new Error('broker down');
			return resolve();
		};
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			scheduleEnvironmentRefresh(refresh, START + HOUR);
			await vi.advanceTimersByTimeAsync(0.8 * HOUR + 2 * 60_000);
			expect(applied).toHaveLength(1);
		} finally {
			log.mockRestore();
		}
	});

	it('finds the earliest expiry among the delivered credentials', () => {
		const env = envExpiringAt(START + HOUR);
		env.network!.aws.push({
			...env.network!.aws[0],
			expiresAt: new Date(START + 60_000).toISOString(),
		});
		expect(sessionEnvExpiry(env)).toBe(START + 60_000);
		expect(sessionEnvExpiry({ vars: {} })).toBeUndefined();
	});
});
