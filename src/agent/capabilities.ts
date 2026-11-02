import {
	CAPABILITY_REASONS,
	capabilitiesFor,
	resolveRuntimeMode,
	type RuntimeCapabilities,
	type RuntimeCapability,
} from "../core/runtime.ts";

export const capabilitiesOverride: { current?: RuntimeCapabilities } = {};

let cachedCapabilities: RuntimeCapabilities | undefined;

export function agentCapabilities(): RuntimeCapabilities {
	if (capabilitiesOverride.current) return capabilitiesOverride.current;
	if (cachedCapabilities) return cachedCapabilities;
	const resolved = resolveRuntimeMode(process.env);
	cachedCapabilities = capabilitiesFor("mode" in resolved ? resolved.mode : "hosted");
	return cachedCapabilities;
}

export class CapabilityDeniedError extends Error {
	readonly capability: RuntimeCapability;

	constructor(capability: RuntimeCapability, reason?: string) {
		super(reason ?? CAPABILITY_REASONS[capability]);
		this.name = "CapabilityDeniedError";
		this.capability = capability;
	}
}

export function assertCapability(capability: RuntimeCapability): void {
	if (!agentCapabilities()[capability]) throw new CapabilityDeniedError(capability);
}

const TOOL_CAPABILITIES: Readonly<Record<string, RuntimeCapability>> = Object.freeze({
	read: "hostFilesystem",
	ls: "hostFilesystem",
	find: "hostFilesystem",
	grep: "hostFilesystem",
	research: "remoteResearch",
	web_search: "remoteResearch",
	web_fetch: "remoteResearch",
	web_fetch_pdf: "remoteResearch",
	demo: "generatedJobs",
	visual: "generatedJobs",
	pdf: "generatedJobs",
});

export function capabilityFilter<T extends Record<string, unknown>>(
	tools: T,
	capabilities: RuntimeCapabilities = agentCapabilities(),
): T {
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => {
			const capability = TOOL_CAPABILITIES[name];
			return !capability || capabilities[capability];
		}),
	) as T;
}
