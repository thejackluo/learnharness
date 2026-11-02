import {
	createSubjectMap,
	importSubjectMap,
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

/** Creates a map from `{definition}` (manual authoring) or `{curriculum}` (a previewed import). */
export async function POST(request: Request) {
	const parsed = await readSubjectMapJsonRequest(request);
	if (!parsed.ok) return subjectMapJson({ error: parsed.error }, parsed.status);
	const body = parsed.value;
	if (!isRecord(body) || (body.definition === undefined) === (body.curriculum === undefined)) {
		return subjectMapJson({ error: "Invalid subject map.", issues: ["send exactly one of definition or curriculum"] }, 400);
	}
	try {
		const map = body.curriculum !== undefined ? importSubjectMap(body.curriculum) : createSubjectMap(body.definition);
		return subjectMapJson({ state: "ok", map }, 201, map);
	} catch (error) {
		const mapped = subjectMapErrorResponse(error);
		if (mapped) return mapped;
		console.error("[subject maps] create failed:", error);
		return subjectMapJson({ error: "Unable to create subject map." }, 500);
	}
}
