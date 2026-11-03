import { getChat, targetPanelFor } from "@/src/server";

/** The session target advice and any placement completion state for the panel. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	const headers = { "Cache-Control": "private, no-store" };
	if (!chat) return Response.json({ error: "Not found" }, { status: 404, headers });
	return Response.json(targetPanelFor(chat), { headers });
}
