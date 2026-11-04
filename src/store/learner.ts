import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { LearnerProfileRead, LearnerProfileV1 } from "../core/contracts.ts";
import { emptyLearnerProfile, learnerProfileProblems } from "../core/learner.ts";
import type { LearnerProfileStore } from "../core/ports.ts";

const PROFILE_FILE = "profile.json";

export class LearnerProfileConflictError extends Error {
	constructor(public readonly current: LearnerProfileRead) {
		super("Learner profile changed since it was loaded.");
		this.name = "LearnerProfileConflictError";
	}
}

export class LearnerProfileUnavailableError extends Error {
	constructor(public readonly current: Extract<LearnerProfileRead, { state: "corrupt" | "future" }>) {
		super("Learner profile is unavailable for writes.");
		this.name = "LearnerProfileUnavailableError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStoredProfile(value: unknown): value is LearnerProfileV1 {
	if (!isRecord(value) || value.version !== 1 || !Number.isInteger(value.revision) || (value.revision as number) < 0) return false;
	if (typeof value.updatedAt !== "string") return false;
	if (learnerProfileProblems(value).length) return false;
	if (!Array.isArray(value.topics) || value.topics.some((topic) => !isRecord(topic) || typeof topic.id !== "string" || typeof topic.updatedAt !== "string")) return false;
	if (!Array.isArray(value.excerpts) || value.excerpts.some((excerpt) =>
		!isRecord(excerpt) ||
		typeof excerpt.id !== "string" ||
		typeof excerpt.sourceName !== "string" ||
		typeof excerpt.text !== "string" ||
		typeof excerpt.importedAt !== "string",
	)) return false;
	return Array.isArray(value.associations);
}

function writeAtomic(file: string, value: LearnerProfileV1): void {
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(temporary, 0o600);
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export function createLearnerProfileStore(directory: string): LearnerProfileStore {
	const profileFile = path.join(directory, PROFILE_FILE);

	function read(): LearnerProfileRead {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(profileFile, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { state: "absent", profile: emptyLearnerProfile(new Date().toISOString()) };
			}
			return { state: "corrupt" };
		}
		if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version > 1) {
			return { state: "future", version: parsed.version };
		}
		if (!isStoredProfile(parsed)) return { state: "corrupt" };
		return { state: "ok", profile: parsed };
	}

	function replace(
		next: Omit<LearnerProfileV1, "version" | "revision" | "updatedAt">,
		expectedRevision: number,
	): LearnerProfileV1 {
		const current = read();
		if (current.state === "corrupt" || current.state === "future") {
			throw new LearnerProfileUnavailableError(current);
		}
		if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
			throw new Error("Expected profile revision must be a non-negative integer.");
		}
		if (current.profile.revision !== expectedRevision) throw new LearnerProfileConflictError(current);
		const candidate = {
			...next,
			version: 1 as const,
			revision: current.profile.revision + 1,
			updatedAt: new Date().toISOString(),
		};
		if (candidate.topics.some((topic) => !topic.id || !topic.updatedAt) ||
			candidate.excerpts.some((excerpt) => !excerpt.id || !excerpt.importedAt) ||
			learnerProfileProblems(candidate).length) {
			throw new Error("Invalid learner profile.");
		}
		writeAtomic(profileFile, candidate);
		return candidate;
	}

	return { read, replace };
}

export const learnerProfileStore = createLearnerProfileStore(path.join(PATHS.data, "learner"));
