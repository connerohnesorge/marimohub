import { isNotFoundError } from '@/api/request';
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { apiClient, apiData } from '@/api/client';
import { usePreviewQuery } from '@/api/previews';
import { Button } from '@/components/ui';
import { NotebookFrame } from '@/components/NotebookPage/NotebookFrame';
import { useNotebookFrameLocation } from '@/hooks/useNotebookFrameLocation';
import { useTheme } from '@/context/ThemeContext';
import { useAuth } from '@/context/AuthContext';
import { PreviewBadge } from './PreviewsPage';

type Runtime = {
	userId: string;
	nid: string;
	sid: string;
	mode: 'app' | 'edit';
	version?: string;
	assignment?: { visit_id: string; generation: string };
};
function readRuntime(key: string, userId: string): Runtime | null {
	try {
		const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Runtime | null;
		return value &&
			typeof value.nid === 'string' &&
			typeof value.sid === 'string' &&
			value.userId === userId &&
			value.mode === 'edit'
			? value
			: null;
	} catch {
		return null;
	}
}
export function PreviewPage() {
	const { pid = '', nid = '', previewId = '' } = useParams();
	const { user } = useAuth();
	if (!user) return null;
	return (
		<PreviewRuntime
			key={`${user.id}/${pid}/${nid}/${previewId}`}
			userId={user.id}
			pid={pid}
			nid={nid}
			previewId={previewId}
		/>
	);
}
function PreviewRuntime({
	pid,
	nid,
	previewId,
	userId,
}: {
	pid: string;
	nid: string;
	previewId: string;
	userId: string;
}) {
	const storageKey = `preview-session:${userId}:${pid}:${nid}:${previewId}`;
	const [runtime, setRuntime] = useState<Runtime | null>(() => readRuntime(storageKey, userId));
	const preview = usePreviewQuery(pid, nid, previewId);
	const start = useMutation({
		mutationFn: async (mode: 'app' | 'edit') => {
			if (runtime?.mode === 'edit')
				await apiData(
					apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}', {
						params: { path: { pid, nid: runtime.nid, sid: runtime.sid } },
					}),
				).catch((error: unknown) => {
					if (!isNotFoundError(error)) throw error;
				});

			return apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/previews/{preview_id}/sessions', {
					params: { path: { pid, nid, preview_id: previewId } },
					body: { mode, ...(mode === 'app' ? { app_visit_id: crypto.randomUUID() } : {}) },
				}),
			);
		},
		onSuccess: (session, mode) => {
			const next: Runtime = {
				userId,
				nid: session.notebook_id,
				sid: session.session_id,
				mode,
				version: session.preview_version_id,
				assignment: session.app_assignment,
			};
			setRuntime(next);
			if (mode === 'edit') sessionStorage.setItem(storageKey, JSON.stringify(next));
			else sessionStorage.removeItem(storageKey);
		},
	});
	const session = useQuery({
		queryKey: ['preview-session', userId, pid, previewId, runtime?.nid, runtime?.sid],
		queryFn: () =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/heartbeat', {
					params: { path: { pid, nid: runtime!.nid, sid: runtime!.sid } },
					...(runtime?.assignment ? { body: runtime.assignment } : {}),
				}),
			),
		enabled: !!runtime && !!preview.data && !preview.isError,
		refetchInterval: 15_000,
		retry: false,
		gcTime: 0,
	});
	useEffect(
		() => () => {
			if (runtime?.assignment)
				void apiClient
					.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/leave', {
						params: { path: { pid, nid: runtime.nid, sid: runtime.sid } },
						body: runtime.assignment,
						keepalive: true,
					})
					.catch(() => {});
		},
		[pid, runtime],
	);
	const { theme } = useTheme();
	const sandboxUrl =
		!session.isError && !preview.isError && session.data?.status === 'running'
			? session.data.sandbox_url
			: undefined;
	const frame = useNotebookFrameLocation(sandboxUrl, theme, runtime?.mode === 'app');
	if (preview.isError)
		return (
			<main className="p-6" role="alert">
				This preview is unavailable or you no longer have access.
			</main>
		);
	if (!preview.data) return <p className="p-6">Loading preview…</p>;
	const record = preview.data;
	return (
		<div className="flex h-dvh flex-col">
			<header className="flex flex-wrap items-center gap-3 border-b p-3">
				<Link to={`/projects/${pid}/notebooks/${nid}/previews`} className="text-sm">
					Previews
				</Link>
				<h1 className="font-medium">{record.name}</h1>
				<PreviewBadge preview={record} />
				<span className="text-xs text-muted-foreground">Latest: {record.commit?.slice(0, 12)}</span>
				<Button
					variant="default"
					onPress={() => {
						void navigator.clipboard
							.writeText(record.url)
							.then(() => toast.success('Preview link copied'))
							.catch(() => toast.error('Unable to copy the link'));
					}}
				>
					Copy link
				</Button>
				{record.can.app && (
					<Button
						isDisabled={start.isPending || !record.commit}
						onPress={() => start.mutate('app')}
					>
						{runtime?.mode === 'edit'
							? 'Discard edits and open app'
							: runtime
								? 'Open latest app'
								: 'Open app'}
					</Button>
				)}
				{record.can.edit && (
					<Button
						variant="default"
						isDisabled={start.isPending || !record.commit}
						onPress={() => start.mutate('edit')}
					>
						{runtime?.mode === 'edit' ? 'Discard edits and open latest' : 'Open temporary editor'}
					</Button>
				)}
			</header>
			{runtime?.mode === 'edit' && (
				<p className="border-b bg-muted px-4 py-2 text-sm">
					Temporary preview editor · Changes stay in your sandbox and will be discarded.
				</p>
			)}
			{runtime?.version && record.version_id && runtime.version !== record.version_id && (
				<p className="border-b px-4 py-2 text-sm">
					A newer revision is available. Your session is still running its original commit.
				</p>
			)}
			{record.error && (
				<p role="alert" className="px-4 py-2 text-sm">
					{record.error} {record.commit && 'Serving the last prepared revision.'}
				</p>
			)}
			{start.isError && (
				<p role="alert" className="p-4">
					{start.error.message}
				</p>
			)}
			{session.isError && (
				<p role="alert" className="p-4">
					This session has ended or is unavailable. Open the preview again.
				</p>
			)}
			{start.isPending || (runtime && session.isPending) ? (
				<output className="p-6">Starting preview…</output>
			) : sandboxUrl ? (
				<div className="min-h-0 flex-1">
					<NotebookFrame
						key={frame.frameKey}
						src={frame.iframeSrc}
						retrySrc={frame.latestSrc}
						sandboxUrl={sandboxUrl}
						onQuery={frame.onQuery}
						title={record.name}
					/>
				</div>
			) : (
				<p className="p-6 text-sm text-muted-foreground">
					Choose an app or temporary editor to open this preview.
				</p>
			)}
		</div>
	);
}
