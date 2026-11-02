import { listLearnerTargetLinks, subjectMapJson } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return subjectMapJson(listLearnerTargetLinks());
	} catch (error) {
		console.error("[learner targets] read failed:", error);
		return subjectMapJson({ error: "Unable to read evidence links." }, 500);
	}
}
