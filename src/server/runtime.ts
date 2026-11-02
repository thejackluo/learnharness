import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../../config.ts";
import {
	capabilitiesFor,
	CAPABILITY_REASONS,
	resolveRuntimeMode,
	type PublicRuntime,
	type RuntimeMode,
} from "../core/runtime.ts";
import { createOwnerStore } from "../store/owner.ts";

let cachedMode: RuntimeMode | undefined;

export function runtimeMode(): RuntimeMode {
	if (cachedMode) return cachedMode;
	const resolved = resolveRuntimeMode(process.env);
	if ("error" in resolved) throw new Error(resolved.error);
	cachedMode = resolved.mode;
	return cachedMode;
}

function inside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hostedPath(
	value: string | undefined,
	label: string,
	kind: "directory" | "file",
	problems: string[],
): string | null {
	if (!value || !path.isAbsolute(value)) {
		problems.push(`${label} must be an absolute path.`);
		return null;
	}
	const resolved = path.resolve(value);
	try {
		const base = kind === "directory" ? resolved : path.dirname(resolved);
		const realBase = fs.realpathSync(base);
		fs.accessSync(realBase, fs.constants.W_OK);
		if (kind === "directory") {
			if (!fs.statSync(realBase).isDirectory()) throw new Error("not a directory");
			return realBase;
		}
		const canonical = path.join(realBase, path.basename(resolved));
		if (fs.existsSync(canonical)) {
			const stat = fs.statSync(canonical);
			if (!stat.isFile()) throw new Error("not a file");
			fs.accessSync(canonical, fs.constants.W_OK);
			return fs.realpathSync(canonical);
		}
		return canonical;
	} catch {
		problems.push(`${label} must exist in a writable location (${kind === "directory" ? "directory" : "parent directory"} required).`);
		return null;
	}
}

export function validateHostedRuntime(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const problems: string[] = [];
	const resolvedMode = resolveRuntimeMode(env);
	if ("error" in resolvedMode) {
		problems.push(resolvedMode.error);
		return problems;
	}
	if (resolvedMode.mode !== "hosted") return problems;

	const origin = env.LH_PUBLIC_ORIGIN;
	try {
		if (!origin) throw new Error();
		const parsed = new URL(origin);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.origin !== origin
		) throw new Error();
	} catch {
		problems.push("LH_PUBLIC_ORIGIN must be a canonical HTTPS origin without credentials, path, or query.");
	}

	const data = hostedPath(env.LH_DATA_DIR, "LH_DATA_DIR", "directory", problems);
	const auth = hostedPath(env.LH_AUTH_FILE, "LH_AUTH_FILE", "file", problems);
	const owner = hostedPath(env.LH_OWNER_DIR, "LH_OWNER_DIR", "directory", problems);
	let root: string;
	try {
		root = fs.realpathSync(ROOT);
	} catch {
		root = path.resolve(ROOT);
	}
	for (const [label, value] of [["LH_DATA_DIR", data], ["LH_AUTH_FILE", auth], ["LH_OWNER_DIR", owner]] as const) {
		if (value && inside(root, value)) problems.push(`${label} must be outside the application directory.`);
	}
	const locations = [["LH_DATA_DIR", data], ["LH_AUTH_FILE", auth], ["LH_OWNER_DIR", owner]] as const;
	const configuredLocations = locations.map(([label, canonical]) => {
		const configured = env[label];
		return [label, canonical ?? (configured && path.isAbsolute(configured) ? path.resolve(configured) : null)] as const;
	});
	for (let i = 0; i < configuredLocations.length; i++) {
		for (let j = i + 1; j < configuredLocations.length; j++) {
			const [leftLabel, left] = configuredLocations[i]!;
			const [rightLabel, right] = configuredLocations[j]!;
			if (left && right && (inside(left, right) || inside(right, left))) {
				problems.push(`${leftLabel} and ${rightLabel} must not be equal or nested.`);
			}
		}
	}
	if (env.LH_OWNER_DIR && path.isAbsolute(env.LH_OWNER_DIR)) {
		const verifier = createOwnerStore(env.LH_OWNER_DIR).readOwner();
		if (!verifier) problems.push("LH_OWNER_DIR must contain a valid owner.json verifier.");
	}
	return problems;
}

export function publicRuntime(): PublicRuntime {
	const mode = runtimeMode();
	return {
		mode,
		capabilities: capabilitiesFor(mode),
		reasons: CAPABILITY_REASONS,
	};
}
