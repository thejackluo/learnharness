import { ownerSessionIsActive } from "./owner-auth.ts";
import { requireOwnerRequest } from "./auth-guards.ts";
import { runtimeMode } from "./runtime.ts";

type CloseStream = () => void;
const STREAMS_KEY = Symbol.for("lh.ownerSessionStreams");

function streams(): Map<string, Set<CloseStream>> {
	const global = globalThis as typeof globalThis & { [STREAMS_KEY]?: Map<string, Set<CloseStream>> };
	return (global[STREAMS_KEY] ??= new Map());
}

export function closeSessionStreams(sessionId: string): void {
	for (const close of [...(streams().get(sessionId) ?? [])]) close();
	streams().delete(sessionId);
}

export function guardStream(
	response: Response,
	sessionId: string,
	isActive: (id: string) => boolean = ownerSessionIsActive,
	intervalMs = 15_000,
): Response {
	const body = response.body;
	if (!body) return response;
	const reader = body.getReader();
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
	const close = () => {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		streams().get(sessionId)?.delete(close);
		void reader.cancel().catch(() => {});
		try { controllerRef?.close(); } catch {}
	};
	const guarded = new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller;
			const listeners = streams().get(sessionId) ?? new Set<CloseStream>();
			listeners.add(close);
			streams().set(sessionId, listeners);
			timer = setInterval(() => {
				if (!isActive(sessionId)) close();
			}, intervalMs);
			timer.unref?.();
			const pump = async () => {
				try {
					const next = await reader.read();
					if (stopped) return;
					if (next.done) {
						close();
						return;
					}
					controller.enqueue(next.value);
					void pump();
				} catch {
					close();
				}
			};
			void pump();
		},
		cancel() {
			close();
		},
	});
	return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function guardOwnerStream(request: Request, response: Response): Response {
	if (runtimeMode() !== "hosted") return response;
	const session = requireOwnerRequest(request);
	if (!session) return Response.json({ error: "Sign in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
	return guardStream(response, session.id);
}
