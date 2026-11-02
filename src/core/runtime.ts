export type RuntimeMode = "local" | "desktop" | "hosted";

export type RuntimeCapabilities = Readonly<{
	hostFilesystem: boolean;
	remoteResearch: boolean;
	generatedJobs: boolean;
	serverBrowser: boolean;
	generatedHtml: boolean;
	subscriptions: boolean;
}>;

export type RuntimeCapability = keyof RuntimeCapabilities;

export type PublicRuntime = Readonly<{
	mode: RuntimeMode;
	capabilities: RuntimeCapabilities;
	reasons: Readonly<Record<RuntimeCapability, string>>;
}>;

export const CAPABILITY_REASONS: Readonly<Record<RuntimeCapability, string>> = Object.freeze({
	hostFilesystem: "Hosted mode cannot browse the server's files.",
	remoteResearch: "Hosted mode cannot fetch arbitrary remote sources.",
	generatedJobs: "Hosted mode does not run generated research, demo, visual, or PDF jobs.",
	serverBrowser: "Hosted mode does not execute generated content in a server browser.",
	generatedHtml: "Hosted mode does not execute stored generated HTML.",
	subscriptions: "Hosted mode cannot connect to subscription accounts.",
});

const LOCAL_CAPABILITIES: RuntimeCapabilities = Object.freeze({
	hostFilesystem: true,
	remoteResearch: true,
	generatedJobs: true,
	serverBrowser: true,
	generatedHtml: true,
	subscriptions: true,
});

const HOSTED_CAPABILITIES: RuntimeCapabilities = Object.freeze({
	hostFilesystem: false,
	remoteResearch: false,
	generatedJobs: false,
	serverBrowser: false,
	generatedHtml: false,
	subscriptions: false,
});

export function capabilitiesFor(mode: RuntimeMode): RuntimeCapabilities {
	return mode === "hosted" ? HOSTED_CAPABILITIES : LOCAL_CAPABILITIES;
}

export function resolveRuntimeMode(
	env: Record<string, string | undefined>,
): { mode: RuntimeMode } | { error: string } {
	const configured = env.LH_RUNTIME;
	if (configured !== undefined && configured !== "local" && configured !== "hosted") {
		return { error: `Unsupported LH_RUNTIME value: ${configured}` };
	}
	const desktopConfigured = env.LH_DESKTOP_SERVER === "1" || Boolean(env.LH_DESKTOP_API_SECRET);
	if (configured === "hosted") {
		if (desktopConfigured) return { error: "Hosted and desktop runtime flags cannot be combined." };
		return { mode: "hosted" };
	}
	if (desktopConfigured) return { mode: "desktop" };
	return { mode: "local" };
}
