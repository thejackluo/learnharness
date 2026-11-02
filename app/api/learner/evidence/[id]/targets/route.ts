import { learnerTargetProblems } from "@/src/core";
import type { LearningTargetRef } from "@/src/core";
import {
	attachSkillEvidence,
	detachSkillEvidence,
	readSubjectMapJsonRequest,
	subjectMapErrorResponse,
	subjectMapJson,
} from "@/src/server";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function badRequest(issues: string[]) {
	return subjectMapJson({ error: "Invalid evidence link.", issues }, 400);
}

async function body(request: Request) {
	const parsed = await readSubjectMapJsonRequest(request);
	if (!parsed.ok) return { response: subjectMapJson({ error: parsed.error }, parsed.status) };
	if (!isRecord(parsed.value)) return { response: badRequest(["request body must be an object"]) };
	if (!Number.isInteger(parsed.value.expectedRevision) || (parsed.value.expectedRevision as number) < 0) {
		return { response: badRequest(["expectedRevision must be a non-negative integer"]) };
	}
	return { value: parsed.value as Record<string, unknown> & { expectedRevision: number } };
}

function failure(error: unknown, action: string): Response {
	const mapped = subjectMapErrorResponse(error);
	if (mapped) return mapped;
	console.error(`[learner targets] ${action} failed:`, error);
	return subjectMapJson({ error: "Unable to update the evidence link." }, 500);
}

/** Links evidence to a map skill at that skill's current objective revision. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const read = await body(request);
	if (!read.value) return read.response;
	const { mapId, skillId, expectedRevision } = read.value;
	if (typeof mapId !== "string" || typeof skillId !== "string") return badRequest(["mapId and skillId must be strings"]);
	try {
		const profile = attachSkillEvidence({ evidenceId: id, mapId, skillId, expectedRevision });
		return subjectMapJson({ state: "ok", profile });
	} catch (error) {
		return failure(error, "attach");
	}
}

/** Unlinks evidence from an exact target, including targets on deleted maps or retired skills. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const read = await body(request);
	if (!read.value) return read.response;
	const problems = learnerTargetProblems(read.value.target);
	if (problems.length) return badRequest(problems);
	try {
		const profile = detachSkillEvidence({
			evidenceId: id,
			target: read.value.target as LearningTargetRef,
			expectedRevision: read.value.expectedRevision,
		});
		return subjectMapJson({ state: "ok", profile });
	} catch (error) {
		return failure(error, "detach");
	}
}
