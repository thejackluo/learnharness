import { previewSubjectMapImport, readSubjectMapJsonRequest, subjectMapJson } from "@/src/server";

export const dynamic = "force-dynamic";

/** Validates curriculum JSON and summarizes it; never writes. */
export async function POST(request: Request) {
	const parsed = await readSubjectMapJsonRequest(request);
	if (!parsed.ok) return subjectMapJson({ error: parsed.error }, parsed.status);
	const result = previewSubjectMapImport(parsed.value);
	if (!result.ok) return subjectMapJson({ error: "Invalid curriculum.", issues: result.issues }, 400);
	return subjectMapJson({ preview: result.preview });
}
