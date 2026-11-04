import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type {
	SubjectMapDefinition,
	SubjectMapLinks,
	SubjectMapRead,
	SubjectMapSummary,
	SubjectMapV1,
} from "../core/contracts/subject-map.ts";
import { SUBJECT_MAP_LIMITS } from "../core/contracts/subject-map.ts";
import { isSubjectMapId, subjectMapRecordProblems } from "../core/subject-map.ts";
import type { SubjectMapStore, SubjectMapWrite } from "../core/ports.ts";

export class SubjectMapConflictError extends Error {
	constructor(public readonly current: SubjectMapV1) {
		super("Subject map changed since it was loaded.");
		this.name = "SubjectMapConflictError";
	}
}

export class SubjectMapUnavailableError extends Error {
	constructor(public readonly state: "absent" | "corrupt" | "future") {
		super(state === "absent" ? "Subject map not found." : "Subject map is unavailable for writes.");
		this.name = "SubjectMapUnavailableError";
	}
}

export class SubjectMapLimitError extends Error {
	constructor() {
		super(`At most ${SUBJECT_MAP_LIMITS.maps} subject maps can be stored.`);
		this.name = "SubjectMapLimitError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function writeAtomic(file: string, value: SubjectMapV1, exclusive: boolean): void {
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(temporary, 0o600);
		if (exclusive) {
			fs.linkSync(temporary, file);
		} else {
			fs.renameSync(temporary, file);
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

const EMPTY_LINKS: SubjectMapLinks = { propositions: [], topics: [] };

export function createSubjectMapStore(directory: string): SubjectMapStore {
	function fileFor(id: string): string {
		if (!isSubjectMapId(id)) throw new SubjectMapUnavailableError("absent");
		return path.join(directory, `${id}.json`);
	}

	function ids(): string[] {
		let names: string[];
		try {
			names = fs.readdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return names
			.filter((name) => name.endsWith(".json") && isSubjectMapId(name.slice(0, -5)))
			.map((name) => name.slice(0, -5))
			.sort();
	}

	function read(id: string): SubjectMapRead {
		if (!isSubjectMapId(id)) return { state: "absent" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
			return { state: "corrupt" };
		}
		if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version > 1) {
			return { state: "future", version: parsed.version };
		}
		if (subjectMapRecordProblems(parsed).length || (parsed as SubjectMapV1).id !== id) return { state: "corrupt" };
		return { state: "ok", map: parsed as SubjectMapV1 };
	}

	function list(): SubjectMapSummary[] {
		const summaries: SubjectMapSummary[] = [];
		for (const id of ids()) {
			const current = read(id);
			if (current.state === "ok") {
				summaries.push({
					id,
					state: "ok",
					title: current.map.title,
					revision: current.map.revision,
					updatedAt: current.map.updatedAt,
					skills: current.map.skills.length,
					goals: current.map.goals.length,
				});
			} else if (current.state === "corrupt" || current.state === "future") {
				summaries.push({ id, state: current.state });
			}
		}
		return summaries.sort((a, b) =>
			(b.state === "ok" ? b.updatedAt : "").localeCompare(a.state === "ok" ? a.updatedAt : "") || a.id.localeCompare(b.id),
		);
	}

	function requireWritable(id: string, expectedRevision: number): SubjectMapV1 {
		const current = read(id);
		if (current.state !== "ok") throw new SubjectMapUnavailableError(current.state);
		if (!Number.isInteger(expectedRevision) || current.map.revision !== expectedRevision) {
			throw new SubjectMapConflictError(current.map);
		}
		return current.map;
	}

	function validated(candidate: SubjectMapV1): SubjectMapV1 {
		const problems = subjectMapRecordProblems(candidate);
		if (problems.length) throw new Error(`Invalid subject map: ${problems.join("; ")}`);
		return candidate;
	}

	function create(definition: SubjectMapDefinition): SubjectMapV1 {
		if (ids().length >= SUBJECT_MAP_LIMITS.maps) throw new SubjectMapLimitError();
		const now = new Date().toISOString();
		const map = validated({
			...definition,
			version: 1,
			id: `map_${crypto.randomUUID()}`,
			revision: 1,
			createdAt: now,
			updatedAt: now,
			links: EMPTY_LINKS,
		});
		writeAtomic(fileFor(map.id), map, true);
		return map;
	}

	function replace(id: string, next: SubjectMapWrite, expectedRevision: number): SubjectMapV1 {
		const current = requireWritable(id, expectedRevision);
		const map = validated({
			...next,
			version: 1,
			id,
			revision: current.revision + 1,
			createdAt: current.createdAt,
			updatedAt: new Date().toISOString(),
		});
		writeAtomic(fileFor(id), map, false);
		return map;
	}

	function remove(id: string, expectedRevision: number): void {
		requireWritable(id, expectedRevision);
		fs.rmSync(fileFor(id));
	}

	return { list, read, create, replace, remove };
}

export const subjectMapStore = createSubjectMapStore(path.join(PATHS.data, "maps"));
