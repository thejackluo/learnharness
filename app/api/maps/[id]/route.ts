import {
	deleteSubjectMap,
	readSubjectMap,
	readSubjectMapJsonRequest,
	requireIfMatch,
	subjectMapErrorResponse,
	subjectMapGapView,
	subjectMapJson,
	updateSubjectMap,
} from "@/src/server";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const read = readSubjectMap(id);
		if (read.state === "absent") return subjectMapJson({ error: "Map not found.", code: "map_not_found" }, 404);
		if (read.state !== "ok") return subjectMapJson({ state: read.state, map: null, view: null });
		return subjectMapJson({ state: "ok", map: read.map, view: subjectMapGapView(read.map) }, 200, read.map);
	} catch (error) {
		console.error("[subject maps] read failed:", error);
		return subjectMapJson({ error: "Unable to read subject map." }, 500);
	}
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const precondition = requireIfMatch(request);
	if (!precondition.ok) return precondition.response;
	const parsed = await readSubjectMapJsonRequest(request);
	if (!parsed.ok) return subjectMapJson({ error: parsed.error }, parsed.status);
	if (!isRecord(parsed.value) || !isRecord(parsed.value.definition)) {
		return subjectMapJson({ error: "Invalid subject map.", issues: ["definition must be an object"] }, 400);
	}
	try {
		const map = updateSubjectMap(id, parsed.value.definition, precondition.revision);
		return subjectMapJson({ state: "ok", map, view: subjectMapGapView(map) }, 200, map);
	} catch (error) {
		const mapped = subjectMapErrorResponse(error);
		if (mapped) return mapped;
		console.error("[subject maps] update failed:", error);
		return subjectMapJson({ error: "Unable to update subject map." }, 500);
	}
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const precondition = requireIfMatch(request);
	if (!precondition.ok) return precondition.response;
	try {
		deleteSubjectMap(id, precondition.revision);
		return subjectMapJson({ deleted: id });
	} catch (error) {
		const mapped = subjectMapErrorResponse(error);
		if (mapped) return mapped;
		console.error("[subject maps] delete failed:", error);
		return subjectMapJson({ error: "Unable to delete subject map." }, 500);
	}
}
