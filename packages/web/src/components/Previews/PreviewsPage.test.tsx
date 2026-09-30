import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithClient } from '@/test/render';
import type * as PreviewsApi from '@/api/previews';
import { CreatePreviewForm, PreviewsPage } from './PreviewsPage';

const state = vi.hoisted(() => ({
	role: 'manager',
	previewProviders: ['github'] as string[] | undefined,
	sourceType: 'local',
	notebook: vi.fn(),
	create: vi.fn(),
}));
vi.mock('@/api/apps', () => ({ useAppQuery: () => ({ data: { your_role: state.role } }) }));
vi.mock('@/api/hooks', () => ({
	useNotebookQuery: () => state.notebook(),
	useCapabilitiesQuery: () => ({
		data: state.previewProviders
			? { source_control: { preview_providers: state.previewProviders } }
			: undefined,
		isSuccess: state.previewProviders !== undefined,
	}),
}));
vi.mock('@/api/previews', async (importOriginal) => ({
	...(await importOriginal<typeof PreviewsApi>()),
	usePreviewsQuery: () => ({ data: [] }),
	useDeletePreview: () => ({ mutate: vi.fn() }),
	useCreatePreview: () => ({ mutate: state.create }),
}));

vi.mock('./SourceRefInput', () => ({
	SourceRefInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
		<input
			aria-label="Source ref"
			value={value}
			onChange={(event) => onChange(event.target.value)}
		/>
	),
}));

function setup() {
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid/notebooks/:nid/previews" element={<PreviewsPage />} />
		</Routes>,
		{ route: '/projects/p/notebooks/n/previews', toaster: false },
	);
}

beforeEach(() => {
	state.create.mockReset();
	state.role = 'manager';
	state.previewProviders = ['github'];
	state.sourceType = 'local';
	state.notebook
		.mockReset()
		.mockImplementation(() => ({ data: { source: { type: state.sourceType } } }));
});

describe('preview creation eligibility', () => {
	it('explains why a local notebook cannot create previews', () => {
		setup();
		expect(screen.queryByRole('button', { name: 'Create preview' })).not.toBeInTheDocument();
		expect(screen.getByText('Preview creation requires a Git notebook.')).toBeInTheDocument();
	});

	it('offers preview creation for a Git notebook manager', () => {
		state.sourceType = 'git';
		setup();
		expect(screen.getByRole('button', { name: 'Create preview' })).toBeInTheDocument();
	});

	it.each([[], undefined])(
		'hides creation without confirmed preview capability: %s',
		(providers) => {
			state.previewProviders = providers;
			state.sourceType = 'git';
			setup();
			expect(screen.queryByRole('button', { name: 'Create preview' })).not.toBeInTheDocument();
			expect(state.notebook).not.toHaveBeenCalled();
			if (providers)
				expect(
					screen.getByText('Preview creation requires a GitHub App connection.'),
				).toBeInTheDocument();
		},
	);

	it('does not request privileged notebook source data for app-users', () => {
		state.role = 'app-user';
		setup();
		expect(state.notebook).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Create preview' })).not.toBeInTheDocument();
	});
	it('reuses a creation key on retry and rotates it when the request changes', async () => {
		state.sourceType = 'git';
		const user = userEvent.setup();
		renderWithClient(<CreatePreviewForm pid="p" nid="n" onCreated={() => {}} />);
		await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Review');
		await user.type(screen.getByRole('textbox', { name: 'Source ref' }), 'feature/chart');
		const submit = screen.getByRole('button', { name: 'Create preview' });
		await user.click(submit);
		await user.click(submit);
		const initial = state.create.mock.calls[0][0].requestKey;
		expect(state.create.mock.calls[1][0].requestKey).toBe(initial);
		await user.type(screen.getByRole('textbox', { name: 'Name' }), ' again');
		await user.click(submit);
		expect(state.create.mock.calls[2][0].requestKey).not.toBe(initial);
	});
});
