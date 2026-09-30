import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { userKeys } from '@/api/queryKeys';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import { PreviewPage } from './PreviewPage';

const route = '/projects/project/notebooks/notebook/previews/preview';
const endpoint = `/api/v1${route}`;
const storageKey = (userId: string) => `preview-session:${userId}:project:notebook:preview`;
const savedEditor = {
	userId: 'alice',
	nid: 'runtime',
	sid: 'alice-session',
	mode: 'edit',
	version: 'first-version',
};

function setup({ appUser = false } = {}) {
	let userId: string | null = 'alice';
	let version = 'first-version';
	const calls: { url: string; method: string }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			calls.push({ url, method });
			if (url === '/api/v1/me') return jsonOk({ id: userId, email: `${userId}@example.com` });
			if (url === endpoint) {
				return jsonOk({
					id: 'preview',
					name: 'Review preview',
					state: 'active',
					preparation: 'ready',
					source_type: 'branch',
					commit: version === 'first-version' ? 'a'.repeat(40) : 'b'.repeat(40),
					version_id: version,
					url: `https://hub.example.com${route}`,
					can: { app: true, edit: !appUser, manage: false },
				});
			}
			if (url === `${endpoint}/sessions`) {
				return jsonOk({
					notebook_id: 'runtime',
					session_id: `${userId}-session`,
					preview_version_id: version,
					...(appUser ? {} : { user_id: userId, source_version_id: version }),
				});
			}
			if (url.includes('/sessions/')) {
				if (url.includes('/alice-session') && userId !== 'alice')
					return jsonError('FORBIDDEN', 'Another user owns this editor', 403);
				if (method === 'DELETE' || url.endsWith('/leave')) return jsonOk(null);
				if (url.endsWith('/heartbeat'))
					return jsonOk({
						status: 'running',
						sandbox_url: `https://sandbox.example.com/${userId}`,
					});
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		}),
	);
	const view = renderWithClient(
		<AuthProvider>
			<ThemeProvider>
				<Routes>
					<Route
						path="/projects/:pid/notebooks/:nid/previews/:previewId"
						element={<PreviewPage />}
					/>
				</Routes>
			</ThemeProvider>
		</AuthProvider>,
		{ route, toaster: false },
	);
	return {
		...view,
		calls,
		async signIn(next: string | null) {
			userId = next;
			await act(async () => {
				view.client.setQueryData(
					userKeys.me(),
					next ? { id: next, email: `${next}@example.com` } : null,
				);
			});
		},
		async advanceBranch() {
			version = 'second-version';
			await act(async () => {
				await view.client.invalidateQueries({
					queryKey: ['preview', 'project', 'notebook', 'preview'],
				});
			});
		},
	};
}

beforeEach(() => {
	sessionStorage.clear();
	installMatchMedia();
});
afterEach(() => {
	sessionStorage.clear();
	vi.unstubAllGlobals();
});

describe('PreviewPage', () => {
	it('restores only the current user’s editor and discards it before opening another', async () => {
		sessionStorage.setItem(storageKey('alice'), JSON.stringify(savedEditor));
		const { calls } = setup();
		const user = userEvent.setup();
		expect(await screen.findByTitle('Review preview')).toHaveAttribute(
			'src',
			expect.stringContaining('/alice'),
		);
		await user.click(screen.getByRole('button', { name: 'Discard edits and open latest' }));
		await waitFor(() =>
			expect(calls).toContainEqual({ url: `${endpoint}/sessions`, method: 'POST' }),
		);
		const deletion = calls.findIndex((call) => call.method === 'DELETE');
		expect(calls[deletion].url).toContain('/alice-session');
		expect(deletion).toBeLessThan(calls.findIndex((call) => call.url === `${endpoint}/sessions`));
		expect(JSON.parse(sessionStorage.getItem(storageKey('alice'))!)).toMatchObject({
			userId: 'alice',
		});
	});

	it.each([false, true])(
		'resets the runtime on account changes (logout first: %s)',
		async (logout) => {
			sessionStorage.setItem(storageKey('alice'), JSON.stringify(savedEditor));
			const { calls, signIn } = setup();
			const user = userEvent.setup();
			await screen.findByTitle('Review preview');
			if (logout) {
				await signIn(null);
				await waitFor(() => expect(screen.queryByTitle('Review preview')).not.toBeInTheDocument());
			}
			await signIn('bob');
			await user.click(await screen.findByRole('button', { name: 'Open temporary editor' }));
			await waitFor(() => expect(sessionStorage.getItem(storageKey('bob'))).not.toBeNull());
			expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
			expect(JSON.parse(sessionStorage.getItem(storageKey('bob'))!)).toMatchObject({
				userId: 'bob',
				sid: 'bob-session',
			});
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		},
	);

	it.each(['legacy', 'foreign-owner', 'missing-owner'])(
		'ignores %s storage without deleting another user’s editor',
		async (kind) => {
			const key =
				kind === 'legacy' ? 'preview-session:project:notebook:preview' : storageKey('alice');
			const value = { ...savedEditor, userId: kind === 'missing-owner' ? undefined : 'bob' };
			sessionStorage.setItem(key, JSON.stringify(value));
			const { calls } = setup();
			const user = userEvent.setup();
			await user.click(await screen.findByRole('button', { name: 'Open temporary editor' }));
			await waitFor(() =>
				expect(calls).toContainEqual({ url: `${endpoint}/sessions`, method: 'POST' }),
			);
			expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
		},
	);

	it('shows an updated revision to app-users while keeping their existing app open', async () => {
		const { advanceBranch } = setup({ appUser: true });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		const frame = await screen.findByTitle('Review preview');
		expect(screen.queryByText(/A newer revision is available/)).not.toBeInTheDocument();
		await advanceBranch();
		expect(await screen.findByText(/A newer revision is available/)).toBeInTheDocument();
		expect(screen.getByTitle('Review preview')).toBe(frame);
		expect(sessionStorage.getItem(storageKey('alice'))).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Open latest app' }));
		await waitFor(() =>
			expect(screen.queryByText(/A newer revision is available/)).not.toBeInTheDocument(),
		);
	});
});
