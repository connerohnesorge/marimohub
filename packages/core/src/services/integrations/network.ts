import type { SessionNetwork } from '../../ports/integrations';

export function emptySessionNetwork(): SessionNetwork {
	return {
		tunnels: [],
		hosts: [],
		mongodb: [],
		aws: [],
		relayEnv: {},
		relayFiles: [],
		unrelayable: [],
	};
}

/** `add` takes precedence: its AWS credentials win and its relay values replace `base`'s. */
export function mergeSessionNetworks(
	base: SessionNetwork | undefined,
	add: SessionNetwork | undefined,
): SessionNetwork | undefined {
	if (!base) return add;
	if (!add) return base;
	return {
		tunnels: [...base.tunnels, ...add.tunnels],
		hosts: [...base.hosts, ...add.hosts],
		mongodb: [...base.mongodb, ...add.mongodb],
		aws: [...base.aws, ...add.aws],
		relayEnv: { ...base.relayEnv, ...add.relayEnv },
		relayFiles: [
			...base.relayFiles.filter(({ path }) => !add.relayFiles.some((file) => file.path === path)),
			...add.relayFiles,
		],
		unrelayable: [...base.unrelayable, ...add.unrelayable],
	};
}
