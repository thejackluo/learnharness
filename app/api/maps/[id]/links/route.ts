import {
	linkSubjectSkill,
	readSubjectMapJsonRequest,
	requireIfMatch,
	subjectMapErrorResponse,
	subjectMapGapView,
	subjectMapJson,
	unlinkSubjectSkill,
} from "@/src/server";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function change(request: Request, id: string, mode: "link" | "unlink") {
	const precondition = requireIfMatch(request);
	if (!precondition.ok) return precondition.response;
	const parsed = await readSubjectMapJsonRequest(request);
	if (!parsed.ok) return subjectMapJson({ error: parsed.error }, parsed.status);
	const body = parsed.value;
	if (
		!isRecord(body) ||
		(body.kind !== "proposition" && body.kind !== "topic") ||
		typeof body.skillId !== "string" ||
		typeof body.refId !== "string" ||
		!body.refId ||
		body.refId.length > 1024
	) {
		return subjectMapJson({ error: "Invalid link.", issues: ["kind must be proposition or topic, with string skillId and refId"] }, 400);
	}
	try {
		const input = { kind: body.kind as "proposition" | "topic", skillId: body.skillId, refId: body.refId, expectedRevision: precondition.revision };
		const map = mode === "link" ? linkSubjectSkill(id, input) : unlinkSubjectSkill(id, input);
		return subjectMapJson({ state: "ok", map, view: subjectMapGapView(map) }, 200, map);
	} catch (error) {
		const mapped = subjectMapErrorResponse(error);
		if (mapped) return mapped;
		console.error("[subject maps] link update failed:", error);
		return subjectMapJson({ error: "Unable to update map links." }, 500);
	}
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return change(request, (await params).id, "link");
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return change(request, (await params).id, "unlink");
}
