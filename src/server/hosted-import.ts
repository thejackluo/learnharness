const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 5;
const MULTIPART_OVERHEAD = 64 * 1024;
const MAX_BODY_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD;

export interface HostedImportFile {
	name: string;
	text: string;
}

export type HostedImportResult =
	| { ok: true; files: HostedImportFile[] }
	| { ok: false; status: 400 | 413; error: string };

function invalid(error: string): HostedImportResult {
	return { ok: false, status: 400, error };
}

export async function validateHostedImportFiles(files: readonly File[]): Promise<HostedImportResult> {
	if (files.length > MAX_FILES) return invalid("Too many files.");
	const total = files.reduce((sum, file) => sum + file.size, 0);
	if (total > MAX_FILE_BYTES) return { ok: false, status: 413, error: "Imported files exceed the 1 MiB limit." };
	const output: HostedImportFile[] = [];
	for (const file of files) {
		if (
			file.name.length > 255 ||
			file.name === "." ||
			file.name === ".." ||
			file.name.startsWith(".") ||
			/[\/\\\u0000-\u001f\u007f]/.test(file.name) ||
			!/\.(?:md|txt)$/i.test(file.name)
		) return invalid("Invalid filename or file type.");
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.includes(0)) return invalid("Files must be UTF-8 text.");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return invalid("Files must be valid UTF-8.");
		}
		output.push({ name: file.name, text });
	}
	return { ok: true, files: output };
}

export async function readHostedImportRequest(request: Request): Promise<HostedImportResult> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
		return { ok: false, status: 413, error: "Request body too large." };
	}
	if (!request.body) return invalid("Invalid multipart request.");
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
		const replay = new Request(request.url, {
			method: "POST",
			headers: request.headers,
			body: Buffer.concat(chunks),
		});
		const form = await replay.formData();
		const files = form.getAll("files").filter((part): part is File => part instanceof File);
		return validateHostedImportFiles(files);
	} catch {
		return invalid("Invalid multipart request.");
	}
}
