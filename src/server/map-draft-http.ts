import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { draftSubjectMap, refineSubjectMap, MapDraftNotFoundError, MapDraftValidationError, type MapDraftDeps, type MapDraftInput, type MapRefineInput } from "./map-drafts.ts";
import { runtimeMode } from "./runtime.ts";
import { readSyllabusUpload } from "./syllabus-upload.ts";
import { subjectMapJson } from "./subject-maps.ts";

class InputError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}

async function boundedBody(request: Request) {
	if (!request.body) throw new InputError("Missing request body.");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > 1024 * 1024 + 65536) { await reader.cancel(); throw new InputError("Request body too large.", 413); }
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

async function parseRequest(request: Request, refine: boolean): Promise<MapDraftInput | MapRefineInput> {
	const bytes = await boundedBody(request);
	let value: unknown;
	if (request.headers.get("content-type")?.includes("multipart/form-data")) {
		const replay = () => new Request(request.url, { method: "POST", headers: request.headers, body: bytes });
		const uploaded = await readSyllabusUpload(replay(), runtimeMode() === "hosted");
		if (!uploaded.ok) throw new InputError(uploaded.error, uploaded.status);
		const pasted = uploaded.form.get("syllabusText");
		value = { goal: uploaded.form.get("goal") ?? undefined, framework: uploaded.form.get("framework") ?? undefined, instruction: uploaded.form.get("instruction") ?? undefined,
			syllabus: uploaded.file ?? (typeof pasted === "string" && pasted.trim() ? { name: uploaded.form.get("syllabusName") || "Pasted syllabus", text: pasted } : undefined) };
	} else {
		try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new InputError("Invalid JSON body."); }
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Body must be an object.");
	const body = value as Record<string, unknown>;
	for (const [field, limit] of [["goal", 500], ["framework", 200], ["instruction", 1000]] as const) {
		if (body[field] !== undefined && (typeof body[field] !== "string" || (body[field] as string).length > limit)) throw new InputError(`${field} must be text of at most ${limit} characters.`);
	}
	if (body.syllabus !== undefined) {
		const syllabus = body.syllabus as Record<string, unknown> | null;
		if (!syllabus || typeof syllabus.name !== "string" || !syllabus.name.trim() || syllabus.name.length > 200 || typeof syllabus.text !== "string" || !syllabus.text.trim()) throw new InputError("Syllabus needs a name and text.");
		if (Buffer.byteLength(syllabus.text, "utf8") > 200 * 1024) throw new InputError("Syllabus text exceeds 200 KB.", 413);
	}
	if (refine && (typeof body.instruction !== "string" || !body.instruction.trim())) throw new InputError("Refinement needs an instruction.");
	if (!refine && !String(body.goal ?? "").trim() && !String(body.framework ?? "").trim() && !body.syllabus) throw new InputError("Provide a goal, framework or syllabus.");
	return body as unknown as MapDraftInput | MapRefineInput;
}

export async function handleMapDraftRequest(request: Request, id?: string, deps: MapDraftDeps = {}): Promise<Response> {
	try {
		const input = await parseRequest(request, id !== undefined);
		const result = id === undefined ? await draftSubjectMap(input, { ...deps, signal: request.signal }) : await refineSubjectMap(id, input as MapRefineInput, { ...deps, signal: request.signal });
		return subjectMapJson(result);
	} catch (error) {
		if (error instanceof InputError) return subjectMapJson({ error: error.message }, error.status);
		if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError) return subjectMapJson(error.envelope, 503);
		if (error instanceof MapDraftValidationError) return subjectMapJson({ error: error.message, issues: error.issues }, 422);
		if (error instanceof MapDraftNotFoundError) return subjectMapJson({ error: error.message }, 404);
		return subjectMapJson({ error: "Unable to draft subject map." }, 500);
	}
}
