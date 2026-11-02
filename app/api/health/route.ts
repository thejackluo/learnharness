import { isWriterLockHeld, runtimeMode } from "@/src/server";

export function GET(): Response {
	const mode = runtimeMode();
	if (mode === "hosted" && !isWriterLockHeld()) {
		return Response.json({ ok: false, mode }, { status: 503, headers: { "Cache-Control": "no-store" } });
	}
	return Response.json(
		{ ok: true, mode, version: process.env.LH_VERSION },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
