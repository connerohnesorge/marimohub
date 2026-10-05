import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnavailableError } from '../../errors';
import { createNotebookId, createProjectId, createSandboxId, createVersionId } from '../../ids';
import { paths } from '../../paths';
import type { MarimoLaunchSpec, SandboxInstance } from '../../ports/sandbox';
import { EXPOSED_URL, fakeComputeFrom, makeFakeSandbox, MemoryBucket } from '../../testing';
import { SandboxProvisioner } from './SandboxProvisioner';
import type { BucketConfig } from './SandboxProvisioner';

const projectId = createProjectId();
const notebookId = createNotebookId();
const sandboxId = createSandboxId();
const bucket: BucketConfig = { name: 'test-bucket', endpoint: 'https://r2.example' };

/** A managed-environment sandbox whose command channel fails the test if touched. */
function managedSandbox() {
	const { instance, calls } = makeFakeSandbox();
	const forbidden = (name: string) =>
		vi.fn(async () => {
			throw new Error(`${name} must not run in a managed environment`);
		});
	const launches: MarimoLaunchSpec[] = [];
	const directories: string[][] = [];
	const managed: SandboxInstance = {
		...instance,
		supportsBucketMount: false,
		ready: vi.fn(async () => {}),
		exec: forbidden('exec'),
		setEnvVars: forbidden('setEnvVars'),
		mountBucket: forbidden('mountBucket'),
		startProcess: forbidden('startProcess'),
		launchMarimo: vi.fn(async (spec: MarimoLaunchSpec) => {
			launches.push(spec);
		}),
		ensureDirectories: vi.fn(async (paths: readonly string[]) => {
			directories.push([...paths]);
		}),
	};
	const provider = fakeComputeFrom(managed, {
		capabilities: { multiPort: false, managedEnvironment: true },
	});
	return { instance: managed, calls, launches, directories, provider };
}

async function workspaceBucket(): Promise<MemoryBucket> {
	const bucketHandle = new MemoryBucket();
	const nb = paths.project(projectId).notebook(notebookId);
	await bucketHandle.put(nb.workspaceFile('notebook.py'), 'import marimo as mo');
	await bucketHandle.put(nb.workspaceFile('data/input.csv'), 'a,b\n1,2\n');
	return bucketHandle;
}

describe('SandboxProvisioner with a managed-environment provider', () => {
	it('copies the workspace and launches marimo without injecting anything', async () => {
		const { instance, calls, launches, provider } = managedSandbox();
		const sessionEnv = vi.fn();

		const result = await new SandboxProvisioner(provider).provision({
			sandboxId,
			projectId,
			notebookId,
			hostname: 'localhost',
			bucket,
			bucketHandle: await workspaceBucket(),
			baseUrl: '/proxy/token',
			kernelAuthToken: 'kernel-token-that-must-not-be-written',
			notebookBridge: {
				launcher: 'marimo-bridge.py',
				files: [{ name: 'marimo-bridge.py', content: 'launcher' }],
			},
			bridgeParentOrigin: 'https://hub.example',
			launchStrategy: 'uv-script-pins',
			sessionEnv: Promise.resolve({
				vars: { AWS_SECRET_ACCESS_KEY: 'wif-secret' },
				defaults: { OPENAI_API_KEY: 'ai-token' },
				files: [{ path: '/etc/marimohub/integrations/db.json', content: 'secret' }],
			}).finally(sessionEnv),
		});

		expect(result.url).toBe(EXPOSED_URL);
		expect(result.usedFallback).toBe(true);
		expect(instance.exec).not.toHaveBeenCalled();
		expect(instance.setEnvVars).not.toHaveBeenCalled();
		expect(instance.mountBucket).not.toHaveBeenCalled();
		expect(instance.startProcess).not.toHaveBeenCalled();
		const written = calls.writeFiles.flat().map((file) => file.path);
		expect(written.sort()).toEqual(['/workspace/data/input.csv', '/workspace/notebook.py']);
		expect(launches).toEqual([
			{
				workdir: '/workspace',
				notebookFile: 'notebook.py',
				mode: 'edit',
				port: 2718,
				projectId,
				notebookId,
				baseUrl: '/proxy/token',
				assetUrl: undefined,
				watch: undefined,
				timeoutMs: expect.any(Number),
			},
		]);
		expect(calls.exposePort).toHaveLength(1);
		expect(sessionEnv).toHaveBeenCalled();
	});

	it('creates workspace directories through ensureDirectories, not mkdir', async () => {
		const { instance, directories, provider } = managedSandbox();

		await new SandboxProvisioner(provider).provision({
			sandboxId,
			projectId,
			notebookId,
			hostname: 'localhost',
			bucket,
			bucketHandle: new MemoryBucket(),
		});

		expect(directories).toEqual([['/workspace']]);
		expect(instance.exec).not.toHaveBeenCalled();
	});

	it('restores a synced workspace file by file and runs no Git or archive commands', async () => {
		const { instance, calls, provider } = managedSandbox();
		const bucketHandle = new MemoryBucket();
		const version = paths.project(projectId).notebook(notebookId).version(createVersionId());
		await bucketHandle.put(version.workspaceArchive, new Uint8Array([80, 75, 3, 4]));
		await bucketHandle.put(version.workspaceFile('app.py'), 'canonical');
		await bucketHandle.put(version.gitFile('HEAD'), 'ref: refs/heads/main\n');

		await new SandboxProvisioner(provider).provision({
			sandboxId,
			projectId,
			notebookId,
			hostname: 'localhost',
			bucket,
			bucketHandle,
			workspaceLoadMode: 'copy-only',
			workspacePrefix: version.workspacePrefix,
			gitPrefix: version.gitPrefix,
			gitRootPath: 'pkg',
			workspaceArchive: version.workspaceArchive,
			entryNotebook: 'app.py',
		});

		expect(instance.exec).not.toHaveBeenCalled();
		const written = calls.writeFiles.flat().map((file) => file.path);
		expect(written).toContain('/workspace/pkg/app.py');
		expect(written).toContain('/workspace/.git/HEAD');
		expect(written.some((path) => path.includes('.marimohub-packed-restore'))).toBe(false);
		expect(vi.mocked(instance.launchMarimo!).mock.calls[0][0]).toMatchObject({
			workdir: '/workspace/pkg',
			notebookFile: 'app.py',
		});
	});

	it('keeps the message of a domain error from readiness', async () => {
		const { instance, provider } = managedSandbox();
		vi.mocked(instance.ready!).mockRejectedValue(
			new UnavailableError('You have no personal kernel (no_kernel).'),
		);

		await expect(
			new SandboxProvisioner(provider).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket,
				bucketHandle: new MemoryBucket(),
			}),
		).rejects.toThrow('You have no personal kernel (no_kernel).');
	});

	it('keeps the message of a domain error from launchMarimo', async () => {
		const { instance, provider } = managedSandbox();
		vi.mocked(instance.launchMarimo!).mockRejectedValue(new ForbiddenError('Not your kernel'));

		await expect(
			new SandboxProvisioner(provider).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket,
				bucketHandle: new MemoryBucket(),
			}),
		).rejects.toThrow('Not your kernel');
	});

	it('refuses headless job preparation before creating a sandbox', async () => {
		const { provider } = managedSandbox();
		const create = vi.spyOn(provider, 'create');

		await expect(
			new SandboxProvisioner(provider).prepare({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket,
				launchMode: 'job',
			}),
		).rejects.toThrow('cannot run headless jobs');
		expect(create).not.toHaveBeenCalled();
	});

	it('keeps the generic reachability message for providers without the capability', async () => {
		const { instance } = makeFakeSandbox();
		instance.ready = async () => {
			throw new UnavailableError('adapter detail');
		};

		await expect(
			new SandboxProvisioner(fakeComputeFrom(instance)).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket,
			}),
		).rejects.toThrow('Sandbox compute backend is not available');
	});
});
