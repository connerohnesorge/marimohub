import { useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { apiClient, apiData } from './client';

interface SourceQuery {
	pid: string;
	nid: string;
	query: string;
	enabled?: boolean;
}
function useSourceRefsQuery(
	{ pid, nid, query, enabled = true }: SourceQuery,
	type: 'branch' | 'commit',
	resolve = false,
) {
	const debounced = useDebouncedValue(query, 200);
	return useQuery({
		queryKey: ['source-refs', pid, nid, type, resolve, debounced],
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/source/refs', {
					params: {
						path: { pid, nid },
						query: { type, query: debounced, resolve: resolve ? 'true' : 'false' },
					},
					signal,
				}),
			),
		enabled,
		staleTime: 15_000,
		gcTime: 60_000,
		retry: false,
	});
}
export function useSourceBranchesQuery(input: SourceQuery) {
	return useSourceRefsQuery(input, 'branch');
}
export function useSourceCommitsQuery(input: SourceQuery) {
	return useSourceRefsQuery(input, 'commit');
}
export function useSourceRefResolutionQuery(input: SourceQuery & { type: 'branch' | 'commit' }) {
	return useSourceRefsQuery(input, input.type, true);
}
