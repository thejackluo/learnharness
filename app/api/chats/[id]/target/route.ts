import { getChat, targetAdaptationFor } from "@/src/server";

/** The session target's inspectable advice: the same projection the tutor receives. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	const headers = { "Cache-Control": "private, no-store" };
	if (!chat) return Response.json({ error: "Not found" }, { status: 404, headers });
	return Response.json({ view: targetAdaptationFor(chat) }, { headers });
}
