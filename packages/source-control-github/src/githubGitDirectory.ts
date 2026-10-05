import { BadRequestError, UnavailableError } from '@marimo-hub/core/errors';
import { materializeGitDirectory as materialize } from '@marimo-hub/source-control-commons';
import type { SourceWorkspaceFile } from '@marimo-hub/core/ports/source-control';
import type { GitHubFetch } from './githubClient';
export {
	GitFetchByteLimit,
	assertGitCheckoutLimits,
	collectGitDirectoryFiles,
} from '@marimo-hub/source-control-commons';
export async function materializeGitDirectory(options: {
	repository: string;
	owner: string;
	repo: string;
	commit: string;
	branch: string;
	token: string;
	fetcher: GitHubFetch;
}): Promise<SourceWorkspaceFile[]> {
	try {
		return await materialize({
			...options,
			remoteUrl: `https://github.com/${options.owner}/${options.repo}.git`,
			headers: {
				authorization: `Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
			},
		});
	} catch (error) {
		if (error instanceof BadRequestError || error instanceof UnavailableError) throw error;
		throw new UnavailableError('GitHub Git data could not be fetched', { cause: error });
	}
}
