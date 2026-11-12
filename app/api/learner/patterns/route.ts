import type { WeaknessPatternStatus } from "@/src/core";
import {
	learnerJsonResponse,
	learnerProfileWriteErrorResponse,
	LearnerProfileUnavailableError,
	listWeaknessPatterns,
	readLearnerJsonRequest,
	setWeaknessPatternStatus,
	WeaknessPatternNotFoundError,
} from "@/src/server";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function GET() {
	try {
		return learnerJsonResponse(listWeaknessPatterns());
	} catch (error) {
		console.error("[learner patterns] read failed:", error);
		return learnerJsonResponse({ error: "Unable to read weakness patterns." }, 500);
	}
}

export async function POST(request: Request) {
	const parsed = await readLearnerJsonRequest(request);
	if (!parsed.ok) return learnerJsonResponse({ error: parsed.error }, parsed.status);
	if (!isRecord(parsed.value)) return learnerJsonResponse({ error: "Body must be an object." }, 400);
	const body = parsed.value;
	if (typeof body.id !== "string" || !body.id.trim() || body.id.length > 128) {
		return learnerJsonResponse({ error: "id must be a non-empty bounded string." }, 400);
	}
	if (body.status !== "active" && body.status !== "dismissed" && body.status !== "resolved") {
		return learnerJsonResponse({ error: "status must be active, dismissed, or resolved." }, 400);
	}
	if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
		return learnerJsonResponse({ error: "expectedRevision must be a non-negative integer." }, 400);
	}
	try {
		const profile = setWeaknessPatternStatus(
			body.id,
			body.status as WeaknessPatternStatus,
			body.expectedRevision as number,
		);
		return learnerJsonResponse({ state: "ok", profile, patterns: listWeaknessPatterns().patterns });
	} catch (error) {
		if (error instanceof WeaknessPatternNotFoundError) return learnerJsonResponse({ error: error.message }, 404);
		const mapped = learnerProfileWriteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof LearnerProfileUnavailableError) return learnerProfileWriteErrorResponse(error)!;
		console.error("[learner patterns] status update failed:", error);
		return learnerJsonResponse({ error: "Unable to update weakness pattern." }, 500);
	}
}
