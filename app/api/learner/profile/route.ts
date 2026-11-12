import { learnerProfileProblems } from "@/src/core";
import {
	learnerJsonResponse,
	learnerProfileWriteErrorResponse,
	LearnerProfileUnavailableError,
	readLearnerJsonRequest,
	stores,
} from "@/src/server";
import type { LearnerProfileV1 } from "@/src/core";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function badRequest(issues: string[]) {
	return learnerJsonResponse({ error: "Invalid learner profile.", issues }, 400);
}

export async function GET() {
	try {
		const read = stores.learnerProfileStore.read();
		return learnerJsonResponse({
			state: read.state,
			profile: read.state === "absent" || read.state === "ok" ? read.profile : null,
		});
	} catch (error) {
		console.error("[learner profile] read failed:", error);
		return learnerJsonResponse({ error: "Unable to read learner profile." }, 500);
	}
}

export async function PUT(request: Request) {
	const parsed = await readLearnerJsonRequest(request);
	if (!parsed.ok) return learnerJsonResponse({ error: parsed.error }, parsed.status);
	if (!isRecord(parsed.value)) return badRequest(["request body must be an object"]);
	const body = parsed.value;
	if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
		return badRequest(["expectedRevision must be a non-negative integer"]);
	}

	try {
		const current = stores.learnerProfileStore.read();
		if (current.state === "corrupt" || current.state === "future") {
			return learnerProfileWriteErrorResponse(new LearnerProfileUnavailableError(current))!;
		}
		if (current.profile.revision !== body.expectedRevision) {
			return learnerJsonResponse({
				error: "Profile changed since you loaded it.",
				code: "revision_conflict",
				current,
			}, 409);
		}
		const issues: string[] = [];
		const existingTopics = new Map(current.profile.topics.map((topic) => [topic.id, topic]));
		const existingExcerpts = new Map(current.profile.excerpts.map((excerpt) => [excerpt.id, excerpt]));
		const now = new Date().toISOString();
		const topics = Array.isArray(body.topics)
			? body.topics.map((item) => {
					if (!isRecord(item)) return item;
					const existing = typeof item.id === "string" ? existingTopics.get(item.id) : undefined;
					if (item.id !== undefined && !existing) issues.push(`unknown topic id ${String(item.id)}`);
					const unchanged = existing &&
						item.topic === existing.topic &&
						item.familiarity === existing.familiarity &&
						item.note === existing.note;
					return {
						id: existing?.id ?? crypto.randomUUID(),
						topic: item.topic,
						familiarity: item.familiarity,
						...(item.note !== undefined ? { note: item.note } : {}),
						updatedAt: unchanged ? existing.updatedAt : now,
					};
				})
			: body.topics;
		const excerpts = Array.isArray(body.excerpts)
			? body.excerpts.map((item) => {
					if (!isRecord(item)) return item;
					const existing = typeof item.id === "string" ? existingExcerpts.get(item.id) : undefined;
					if (!existing) issues.push(`unknown excerpt id ${String(item.id ?? "")}`);
					return existing
						? { ...existing, text: item.text }
						: { ...item, sourceName: "", importedAt: "" };
				})
			: body.excerpts;
		const candidate = {
			background: body.background,
			coursework: body.coursework,
			topics,
			excerpts,
			associations: current.profile.associations,
			suggestions: current.profile.suggestions,
			patterns: current.profile.patterns,
		};
		issues.push(...learnerProfileProblems(candidate));
		if (issues.length) return badRequest([...new Set(issues)]);
		const profile = stores.learnerProfileStore.replace(
			candidate as Omit<LearnerProfileV1, "version" | "revision" | "updatedAt">,
			body.expectedRevision as number,
		);
		return learnerJsonResponse({ state: "ok", profile });
	} catch (error) {
		const mapped = learnerProfileWriteErrorResponse(error);
		if (mapped) return mapped;
		console.error("[learner profile] update failed:", error);
		return learnerJsonResponse({ error: "Unable to update learner profile." }, 500);
	}
}
