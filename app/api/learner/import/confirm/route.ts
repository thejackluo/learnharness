import { learnerProfileProblems } from "@/src/core";
import {
	learnerJsonResponse,
	learnerProfileWriteErrorResponse,
	LearnerProfileUnavailableError,
	readLearnerJsonRequest,
	stores,
	validLearnerImportSourceName,
} from "@/src/server";
import type { LearnerProfileV1 } from "@/src/core";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request) {
	const parsed = await readLearnerJsonRequest(request);
	if (!parsed.ok) return learnerJsonResponse({ error: parsed.error }, parsed.status);
	if (!isRecord(parsed.value)) return learnerJsonResponse({ error: "Invalid learner import.", issues: ["request body must be an object"] }, 400);
	const body = parsed.value;
	if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
		return learnerJsonResponse({ error: "Invalid learner import.", issues: ["expectedRevision must be a non-negative integer"] }, 400);
	}
	if (!Array.isArray(body.excerpts)) {
		return learnerJsonResponse({ error: "Invalid learner import.", issues: ["excerpts must be an array"] }, 400);
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
		const now = new Date().toISOString();
		const newExcerpts = body.excerpts.map((item, index) => {
			if (!isRecord(item)) {
				issues.push(`excerpt ${index + 1} must be an object`);
				return item;
			}
			if (typeof item.sourceName !== "string" || !validLearnerImportSourceName(item.sourceName)) {
				issues.push(`excerpt ${index + 1} has an invalid sourceName`);
			}
			if (typeof item.text !== "string" || !item.text.trim()) {
				issues.push(`excerpt ${index + 1} text must be non-empty`);
			}
			return {
				id: crypto.randomUUID(),
				sourceName: item.sourceName,
				text: item.text,
				importedAt: now,
			};
		});
		const candidate = {
			background: current.profile.background,
			coursework: current.profile.coursework,
			topics: current.profile.topics,
			excerpts: [...current.profile.excerpts, ...newExcerpts],
			associations: current.profile.associations,
			suggestions: current.profile.suggestions,
			patterns: current.profile.patterns,
		};
		issues.push(...learnerProfileProblems(candidate));
		if (issues.length) {
			return learnerJsonResponse({ error: "Invalid learner import.", issues: [...new Set(issues)] }, 400);
		}
		const profile = stores.learnerProfileStore.replace(
			candidate as Omit<LearnerProfileV1, "version" | "revision" | "updatedAt">,
			body.expectedRevision as number,
		);
		return learnerJsonResponse({ state: "ok", profile });
	} catch (error) {
		const mapped = learnerProfileWriteErrorResponse(error);
		if (mapped) return mapped;
		console.error("[learner import] confirmation failed:", error);
		return learnerJsonResponse({ error: "Unable to confirm learner import." }, 500);
	}
}
