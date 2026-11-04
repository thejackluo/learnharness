import {
	importSubjectMap,
	readSubjectMapJsonRequest,
	subjectMapErrorResponse,
	subjectMapJson,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** Confirms a previewed import: the body is the same curriculum JSON the preview accepted. */
export async function POST(request: Request) {
	const parsed = await readSubjectMapJsonRequest(request);
	if (!parsed.ok) return subjectMapJson({ error: parsed.error }, parsed.status);
	try {
		const map = importSubjectMap(parsed.value);
		return subjectMapJson({ state: "ok", map }, 201, map);
	} catch (error) {
		const mapped = subjectMapErrorResponse(error);
		if (mapped) return mapped;
		console.error("[subject maps] import failed:", error);
		return subjectMapJson({ error: "Unable to import subject map." }, 500);
	}
}
