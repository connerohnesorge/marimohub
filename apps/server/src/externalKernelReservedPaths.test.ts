import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExternalKernelCompute } from '@marimo-hub/compute-external-kernel';
import {
	captureWorkspace,
	createNotebookId,
	createProjectId,
	paths,
	restoreWorkspace,
	SandboxId,
} from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';

const SANDBOX = SandboxId.parse('sb-0123456789abcdef');
const EMAIL = `${ACTOR}@example.com`.toLowerCase();

function jwt(email: string): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'RS256' })}.${part({ email, exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
}

/** Like the service: its own integration files are refused on the file routes and never listed. */
const reserved = (path: string) => path === '.env' || path.startsWith('.kira-integrations/');

describe("the kernel service's reserved workspace paths", () => {
	let kira: Server;
	let baseUrl: string;
	const files = new Map<string, Buffer>([
		['notebook.py', Buffer.from('import marimo')],
		['.env', Buffer.from('KIRA=its-own')],
		['.kira-integrations/pg.json', Buffer.from('{}')],
	]);
	const requested: string[] = [];

	beforeAll(async () => {
		kira = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const url = new URL(req.url ?? '/', 'http://kira');
				const path = url.searchParams.get('path') ?? '';
				requested.push(`${req.method} ${url.pathname.split('/').at(-1)} ${path}`);
				if (url.pathname.endsWith('/files') && reserved(path)) {
					res.writeHead(403, { 'content-type': 'application/json' });
					res.end('{"error":{"code":"forbidden"}}');
					return;
				}
				if (url.pathname.endsWith('/files') && req.method === 'PUT') {
					files.set(path, Buffer.concat(chunks));
					res.writeHead(204);
					res.end();
					return;
				}
				if (url.pathname.endsWith('/files')) {
					const file = files.get(path);
					res.writeHead(file ? 200 : 404);
					res.end(file);
					return;
				}
				if (url.pathname.endsWith('/list')) {
					const entries = [...files]
						.filter(([name]) => !reserved(name) && !name.includes('/'))
						.map(([name, data]) => ({ path: name, type: 'file', size: data.byteLength }));
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ entries }));
					return;
				}
				res.writeHead(404);
				res.end();
			});
		});
		await new Promise<void>((resolve) => kira.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(kira.address() as AddressInfo).port}/api/external-kernel/v1`;
	});

	afterAll(() => new Promise<void>((resolve) => kira.close(() => resolve())));

	it('are never written on restore nor read or mirror-deleted on capture', async () => {
		const compute = new ExternalKernelCompute({ baseUrl, workdir: '/workspace' });
		const projectId = createProjectId();
		const notebookId = createNotebookId();
		const nb = paths.project(projectId).notebook(notebookId);
		const bucket = new MemoryBucket();
		await bucket.put(nb.workspaceFile('data.csv'), 'a,b');
		await bucket.put(nb.workspaceFile('.env'), 'TOKEN=user-owned');
		const asOwner = <T>(work: () => Promise<T>) =>
			compute.withEndUserRequest(
				new Request('http://hub.example/', { headers: { 'x-pantheon-bearer': jwt(EMAIL) } }),
				{ userId: ACTOR, email: EMAIL },
				work,
			);
		const sandbox = compute.create(SANDBOX, { owner: { projectId, userId: ACTOR } });

		await asOwner(() => restoreWorkspace(sandbox, bucket, nb.workspacePrefix, '/workspace'));
		await asOwner(() =>
			captureWorkspace(sandbox, bucket, projectId, notebookId, '/workspace', 'workspace'),
		);

		expect(requested.filter((line) => line.includes('.env') || line.includes('.kira-'))).toEqual(
			[],
		);
		expect(files.get('data.csv')?.toString()).toBe('a,b');
		expect(await (await bucket.get(nb.workspaceFile('.env')))?.text()).toBe('TOKEN=user-owned');
	});
});
