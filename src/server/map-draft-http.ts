import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pdfInfo, pdfExtract } from "../agent/subagents/pdf-ops.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { draftSubjectMap, refineSubjectMap, MapDraftNotFoundError, MapDraftValidationError, type MapDraftDeps, type MapDraftInput, type MapRefineInput } from "./map-drafts.ts";
import { readHostedImportRequest } from "./hosted-import.ts";
import { runtimeMode } from "./runtime.ts";
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
		let uploaded: { name: string; text: string } | undefined;
		if (runtimeMode() === "hosted") {
			const result = await readHostedImportRequest(replay());
			if (!result.ok) throw new InputError(result.error, result.status);
			if (result.files.length > 1) throw new InputError("Upload one syllabus file.");
			uploaded = result.files[0];
		}
		let form: FormData;
		try { form = await replay().formData(); } catch { throw new InputError("Invalid multipart body."); }
		const files = form.getAll("files").filter((part): part is File => part instanceof File);
		if (files.length > 1) throw new InputError("Upload one syllabus file.");
		if (runtimeMode() !== "hosted" && files[0]) {
			const file = files[0];
			if (file.size > 1024 * 1024) throw new InputError("Syllabus file too large.", 413);
			if (/\.pdf$/i.test(file.name)) {
				const dir = await mkdtemp(path.join(tmpdir(), "lh-map-syllabus-"));
				try {
					const filename = path.join(dir, "syllabus.pdf");
					await writeFile(filename, new Uint8Array(await file.arrayBuffer()));
					await pdfInfo(filename);
					uploaded = { name: file.name, text: await pdfExtract(filename, "all") };
				} catch { throw new InputError("Unable to read syllabus PDF."); }
				finally { await rm(dir, { recursive: true, force: true }); }
			} else {
				const result = await readHostedImportRequest(replay());
				if (!result.ok) throw new InputError(result.error, result.status);
				uploaded = result.files[0];
			}
		}
		const pasted = form.get("syllabusText");
		value = { goal: form.get("goal") ?? undefined, framework: form.get("framework") ?? undefined, instruction: form.get("instruction") ?? undefined,
			syllabus: uploaded ?? (typeof pasted === "string" && pasted.trim() ? { name: form.get("syllabusName") || "Pasted syllabus", text: pasted } : undefined) };
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
