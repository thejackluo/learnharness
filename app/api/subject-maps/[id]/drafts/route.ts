import { handleMapDraftRequest } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return handleMapDraftRequest(request, (await params).id);
}
