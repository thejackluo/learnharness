import { exportSubjectMap, subjectMapErrorResponse, subjectMapJson } from "@/src/server";

export const dynamic = "force-dynamic";

/** The portable curriculum JSON; learner links and evidence associations are never included. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const curriculum = exportSubjectMap(id);
		const response = subjectMapJson(curriculum);
		response.headers.set("Content-Disposition", `attachment; filename="${id}.json"`);
		return response;
	} catch (error) {
		const mapped = subjectMapErrorResponse(error);
		if (mapped) return mapped;
		console.error("[subject maps] export failed:", error);
		return subjectMapJson({ error: "Unable to export subject map." }, 500);
	}
}
