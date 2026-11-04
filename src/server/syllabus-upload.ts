import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pdfExtract, pdfInfo } from "../agent/subagents/pdf-ops.ts";
import { readHostedImportRequest } from "./hosted-import.ts";

const MAX_BODY_BYTES = 1024 * 1024 + 64 * 1024;

export type SyllabusUpload =
	| { ok: true; form: FormData; file?: { name: string; text: string } }
	| { ok: false; status: 400 | 413; error: string };

async function boundedReplay(request: Request): Promise<Request | SyllabusUpload> {
	const contentLength = request.headers.get("content-length");
	if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) return { ok: false, status: 413, error: "Request body too large." };
	if (!request.body) return { ok: false, status: 400, error: "Invalid multipart request." };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				return { ok: false, status: 413, error: "Request body too large." };
			}
			chunks.push(value);
		}
		return new Request(request.url, { method: "POST", headers: request.headers, body: Buffer.concat(chunks) });
	} catch {
		return { ok: false, status: 400, error: "Invalid multipart request." };
	} finally {
		reader.releaseLock();
	}
}

export async function readSyllabusUpload(request: Request, hosted: boolean): Promise<SyllabusUpload> {
	const replay = await boundedReplay(request);
	if (!(replay instanceof Request)) return replay;
	let form: FormData;
	try { form = await replay.clone().formData(); } catch { return { ok: false, status: 400, error: "Invalid multipart request." }; }
	const files = form.getAll("files").filter((part): part is File => part instanceof File);
	if (files.length > 1) return { ok: false, status: 400, error: "Upload one syllabus file." };
	if (hosted || !files[0] || !/\.pdf$/i.test(files[0].name)) {
		const result = await readHostedImportRequest(replay);
		if (!result.ok) return result;
		if (result.files.length > 1) return { ok: false, status: 400, error: "Upload one syllabus file." };
		return { ok: true, form, ...(result.files[0] ? { file: result.files[0] } : {}) };
	}
	const file = files[0]!;
	if (file.size > 1024 * 1024) return { ok: false, status: 413, error: "Syllabus file too large." };
	const dir = await mkdtemp(path.join(tmpdir(), "lh-syllabus-"));
	try {
		const filename = path.join(dir, "syllabus.pdf");
		await writeFile(filename, new Uint8Array(await file.arrayBuffer()));
		await pdfInfo(filename);
		return { ok: true, form, file: { name: file.name, text: await pdfExtract(filename, "all") } };
	} catch {
		return { ok: false, status: 400, error: "Unable to read syllabus PDF." };
	} finally { await rm(dir, { recursive: true, force: true }); }
}
