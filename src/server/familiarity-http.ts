import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { inferFamiliarity } from "./familiarity.ts";
import { learnerJsonResponse, readLearnerJsonRequest } from "./learner.ts";
import { runtimeMode } from "./runtime.ts";
import { readSyllabusUpload } from "./syllabus-upload.ts";

class FamiliarityInputError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function requestInput(request: Request): Promise<{ mapId: string; source: { name: string; text: string } }> {
	let body: unknown;
	if (request.headers.get("content-type")?.includes("multipart/form-data")) {
		const upload = await readSyllabusUpload(request, runtimeMode() === "hosted");
		if (!upload.ok) throw new FamiliarityInputError(upload.error, upload.status);
		const form = upload.form;
		const mapId = form.get("mapId");
		let name = form.get("sourceName");
		let text = form.get("sourceText");
		if (upload.file) { name = upload.file.name; text = upload.file.text; }
		if (typeof text === "string" && Buffer.byteLength(text, "utf8") > 200 * 1024) throw new FamiliarityInputError("Source text exceeds 200 KB.");
		body = { mapId, source: { name, text } };
	} else {
		const parsed = await readLearnerJsonRequest(request);
		if (!parsed.ok) throw new FamiliarityInputError(parsed.error);
		body = parsed.value;
	}
	if (!isRecord(body) || typeof body.mapId !== "string" || !/^map_[A-Za-z0-9-]{1,64}$/.test(body.mapId)) throw new FamiliarityInputError("mapId is invalid.");
	if (!isRecord(body.source) || typeof body.source.name !== "string" || !body.source.name.trim() || body.source.name.length > 255 || typeof body.source.text !== "string" || !body.source.text.trim()) throw new FamiliarityInputError("source needs a name and non-empty text.");
	if (Buffer.byteLength(body.source.text, "utf8") > 200 * 1024) throw new FamiliarityInputError("Source text exceeds 200 KB.");
	return { mapId: body.mapId, source: { name: body.source.name, text: body.source.text } };
}

export async function handleFamiliarityInferenceRequest(request: Request, infer = inferFamiliarity): Promise<Response> {
	try {
		return learnerJsonResponse(await infer(await requestInput(request), { signal: request.signal }));
	} catch (error) {
		if (error instanceof FamiliarityInputError) return learnerJsonResponse({ error: error.message }, error.status);
		if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError) return learnerJsonResponse(error.envelope, 503);
		if (error instanceof Error && error.message === "Map not found.") return learnerJsonResponse({ error: error.message }, 404);
		if (error instanceof Error && error.message === "Map unavailable.") return learnerJsonResponse({ error: error.message }, 409);
		console.error("[learner familiarity] inference failed:", error);
		return learnerJsonResponse({ error: "Unable to infer familiarity." }, 500);
	}
}
