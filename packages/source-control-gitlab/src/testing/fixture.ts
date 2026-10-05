import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitLabPublisher } from '../index';
import type { OpenChangeRequestInput } from '@marimo-hub/core/ports/source-control';
import type { SourceControlFetch } from '@marimo-hub/source-control-commons';

export class GitLabTestWorld {
	readonly origin = 'https://code.example.com';
	readonly path = 'team/subgroup/notebooks';
	readonly token = 'fixture-token';
	readonly requests: { url: string; headers: Headers; body?: unknown }[] = [];
	readonly mergeRequests: Record<string, unknown>[] = [];
	readonly publisher: GitLabPublisher;
	failMetadata = false;
	failCreate = false;
	beforeAdvertisement?: () => void;
	beforeReceive?: () => void;
	afterReceive?: () => void;
	afterCreate?: () => void;
	private constructor(
		readonly directory: string,
		readonly baseCommit: string,
	) {
		this.publisher = new GitLabPublisher(
			{ token: this.token, baseUrl: this.origin },
			{ fetcher: this.fetcher, now: () => 1_800_000_000_000 },
		);
	}

	static async create(): Promise<GitLabTestWorld> {
		const directory = await mkdtemp(join(tmpdir(), 'marimohub-gitlab-test-'));
		const world = new GitLabTestWorld(directory, '');
		world.git(['init', '--initial-branch=main']);
		await mkdir(join(directory, 'apps'));
		await writeFile(join(directory, 'apps/app.py'), 'print(1)\n');
		await writeFile(join(directory, 'keep.txt'), 'untouched\n');
		await writeFile(join(directory, 'remove.txt'), 'remove\n');
		await writeFile(join(directory, 'script.sh'), '#!/bin/sh\n', { mode: 0o755 });
		await symlink('app.py', join(directory, 'apps/link.py'));
		world.git(['add', '.']);
		world.git(['commit', '-m', 'Initial files']);
		world.git(['config', 'receive.denyCurrentBranch', 'ignore']);
		return new GitLabTestWorld(directory, world.git(['rev-parse', 'HEAD']));
	}

	git(args: string[], input?: string | Uint8Array): string {
		return execFileSync('git', args, {
			cwd: this.directory,
			input,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'Fixture',
				GIT_AUTHOR_EMAIL: 'fixture@example.com',
				GIT_COMMITTER_NAME: 'Fixture',
				GIT_COMMITTER_EMAIL: 'fixture@example.com',
			},
		}).trim();
	}

	head(branch: string): string | null {
		try {
			return this.git(['rev-parse', '--verify', `refs/heads/${branch}`]);
		} catch {
			return null;
		}
	}

	advance(branch: string): string {
		const parent = this.head(branch)!;
		const tree = this.git(['rev-parse', `${parent}^{tree}`]);
		const commit = this.git(['commit-tree', tree, '-p', parent], 'External commit\n');
		this.git(['update-ref', `refs/heads/${branch}`, commit, parent]);
		return commit;
	}

	input(
		changes: OpenChangeRequestInput['changes'] = [
			{ path: 'apps/app.py', operation: 'modify', content: new TextEncoder().encode('print(2)\n') },
		],
	): OpenChangeRequestInput {
		return {
			repository: `${this.origin}/${this.path}`,
			baseBranch: 'main',
			baseCommit: this.baseCommit,
			headBranch: 'marimohub/notebook/proposal',
			title: 'Update notebook',
			body: 'Notebook changes',
			draft: true,
			coAuthor: { name: 'Notebook Editor', email: 'editor@example.com' },
			changes,
		};
	}

	async dispose(): Promise<void> {
		await rm(this.directory, { recursive: true, force: true });
	}

	readonly fetcher: SourceControlFetch = async (input, init) => {
		const url = new URL(input);
		const headers = new Headers(init?.headers);
		this.requests.push({ url: input, headers });
		if (url.pathname.endsWith('.git/info/refs')) {
			const service = url.searchParams.get('service')!;
			if (service === 'git-receive-pack') this.beforeAdvertisement?.();
			const advertised = execFileSync('git', [
				service.slice(4),
				'--stateless-rpc',
				'--advertise-refs',
				this.directory,
			]);
			const line = `# service=${service}\n`;
			const prefix = `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}0000`;
			const body = Buffer.concat([Buffer.from(prefix), advertised]);
			return new Response(new Uint8Array(body), {
				headers: { 'content-type': `application/x-${service}-advertisement` },
			});
		}
		if (url.pathname.endsWith('/git-upload-pack') || url.pathname.endsWith('/git-receive-pack')) {
			const service = url.pathname.endsWith('/git-upload-pack') ? 'upload-pack' : 'receive-pack';
			if (service === 'receive-pack') this.beforeReceive?.();
			const request = new Uint8Array(await new Response(init?.body).arrayBuffer());
			const response = execFileSync('git', [service, '--stateless-rpc', this.directory], {
				input: request,
			});
			if (service === 'receive-pack') this.afterReceive?.();
			return new Response(new Uint8Array(response), {
				headers: { 'content-type': `application/x-git-${service}-result` },
			});
		}
		if (url.pathname === '/api/v4/user')
			return Response.json({
				name: 'Integration Bot',
				email: 'bot@example.com',
				commit_email: 'bot@example.com',
			});
		const prefix = `/api/v4/projects/${encodeURIComponent(this.path)}`;
		if (!url.pathname.startsWith(prefix)) return new Response(null, { status: 404 });
		const path = url.pathname.slice(prefix.length);
		if (path.startsWith('/repository/branches/')) {
			const commit = this.head(decodeURIComponent(path.slice('/repository/branches/'.length)));
			return commit
				? Response.json({ commit: { id: commit } })
				: new Response(null, { status: 404 });
		}
		if (path === '/repository/archive.tar.gz') {
			const archive = execFileSync('git', [
				'-C',
				this.directory,
				'archive',
				'--format=tar.gz',
				'--prefix=notebooks-commit/',
				url.searchParams.get('sha')!,
			]);
			return new Response(new Uint8Array(archive));
		}
		if (path === '/merge_requests') {
			if (init?.method === 'POST') {
				if (this.failCreate) return new Response(null, { status: 503 });
				const body = JSON.parse(String(init.body)) as Record<string, any>;
				this.requests[this.requests.length - 1].body = body;
				const existing = this.mergeRequests.find(
					(mr) => mr.source_branch === body.source_branch && mr.state === 'opened',
				);
				if (existing) return new Response(null, { status: 409 });
				const iid = this.mergeRequests.length + 7;
				const request = {
					id: 123456 + iid,
					iid,
					web_url: `${this.origin}/${this.path}/-/merge_requests/${iid}`,
					state: 'opened',
					draft: /^draft:/i.test(body.title),
					...body,
				};
				this.mergeRequests.push(request);
				this.afterCreate?.();
				return Response.json(request, { status: 201 });
			}
			return Response.json(
				this.mergeRequests.filter(
					(mr) =>
						mr.source_branch === url.searchParams.get('source_branch') &&
						mr.target_branch === url.searchParams.get('target_branch'),
				),
			);
		}
		if (path.startsWith('/merge_requests/')) {
			const request = this.mergeRequests.find(
				(mr) => mr.iid === Number(path.slice('/merge_requests/'.length)),
			);
			if (!request) return new Response(null, { status: 404 });
			if (init?.method === 'PUT') {
				if (this.failMetadata) return new Response(null, { status: 503 });
				Object.assign(request, JSON.parse(String(init.body)));
			}
			return Response.json(request);
		}
		throw new Error(`Unexpected fixture request: ${input}`);
	};
}
