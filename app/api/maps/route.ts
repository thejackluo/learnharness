import {
	createSubjectMap,
	listSubjectMaps,
	readSubjectMapJsonRequest,
	subjectMapErrorResponse,
	subjectMapJson,
} from "@/src/server";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function GET() {
	try {
		return subjectMapJson({ maps: listSubjectMaps() });
	} catch (error) {
		console.error("[subject maps] list failed:", error);
		return subjectMapJson({ error: "Unable to read subject maps." }, 500);
	}
}

/** Creates a map from `{definition}` (manual authoring); curriculum imports use /api/maps/import. */
export async function POST(request: Request) {
	const parsed = await readSubjectMapJsonRequest(request);
	if (!parsed.ok) return subjectMapJson({ error: parsed.error }, parsed.status);
	const body = parsed.value;
	if (!isRecord(body) || !isRecord(body.definition)) {
		return subjectMapJson({ error: "Invalid subject map.", issues: ["definition must be an object"] }, 400);
	}
	try {
		const map = createSubjectMap(body.definition);
		return subjectMapJson({ state: "ok", map }, 201, map);
	} catch (error) {
		const mapped = subjectMapErrorResponse(error);
		if (mapped) return mapped;
		console.error("[subject maps] create failed:", error);
		return subjectMapJson({ error: "Unable to create subject map." }, 500);
	}
}
