import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pdfExtract, pdfInfo } from "../agent/subagents/pdf-ops.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { inferFamiliarity } from "./familiarity.ts";
import { learnerJsonResponse, readLearnerJsonRequest } from "./learner.ts";
import { runtimeMode } from "./runtime.ts";

class FamiliarityInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function requestInput(request: Request): Promise<{ mapId: string; source: { name: string; text: string } }> {
	let body: unknown;
	if (request.headers.get("content-type")?.includes("multipart/form-data")) {
		let form: FormData;
		try { form = await request.formData(); } catch { throw new FamiliarityInputError("Invalid multipart body."); }
		const mapId = form.get("mapId");
		let name = form.get("sourceName");
		let text = form.get("sourceText");
		const files = form.getAll("files").filter((part): part is File => part instanceof File);
		if (files.length > 1) throw new FamiliarityInputError("Upload one file.");
		if (files[0]) {
			const file = files[0];
			if (/\.pdf$/i.test(file.name)) {
				if (runtimeMode() === "hosted") throw new FamiliarityInputError("PDF uploads are available only in local mode.");
				if (file.size > 1024 * 1024) throw new FamiliarityInputError("PDF file exceeds the upload limit.");
				const dir = await mkdtemp(path.join(tmpdir(), "lh-familiarity-"));
				try {
					const filename = path.join(dir, "source.pdf");
					await writeFile(filename, new Uint8Array(await file.arrayBuffer()));
					await pdfInfo(filename);
					text = await pdfExtract(filename, "all");
				} catch {
					throw new FamiliarityInputError("Unable to read familiarity PDF.");
				} finally { await rm(dir, { recursive: true, force: true }); }
			} else {
				if (!/\.(?:txt|md|markdown)$/i.test(file.name) || file.size > 200 * 1024) throw new FamiliarityInputError("Upload one .txt, .md, or .markdown file of at most 200 KB.");
				name = file.name;
				text = await file.text();
			}
		}
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

export async function handleFamiliarityInferenceRequest(request: Request): Promise<Response> {
	try {
		return learnerJsonResponse(await inferFamiliarity(await requestInput(request), { signal: request.signal }));
	} catch (error) {
		if (error instanceof FamiliarityInputError) return learnerJsonResponse({ error: error.message }, 400);
		if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError) return learnerJsonResponse(error.envelope, 503);
		if (error instanceof Error && error.message === "Map not found.") return learnerJsonResponse({ error: error.message }, 404);
		if (error instanceof Error && error.message === "Map unavailable.") return learnerJsonResponse({ error: error.message }, 409);
		console.error("[learner familiarity] inference failed:", error);
		return learnerJsonResponse({ error: "Unable to infer familiarity." }, 500);
	}
}
