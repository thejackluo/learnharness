import { learnerJsonResponse, previewLearnerImport } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	try {
		const result = await previewLearnerImport(request);
		if (!result.ok) return learnerJsonResponse({ error: result.error }, result.status);
		return learnerJsonResponse({ drafts: result.drafts, excerptLimitBytes: result.excerptLimitBytes });
	} catch (error) {
		console.error("[learner import] preview failed:", error);
		return learnerJsonResponse({ error: "Unable to preview learner import." }, 500);
	}
}
