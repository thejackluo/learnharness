import { assessmentSpecOf } from "./assessment.ts";
import { questionDataOf } from "./canonical-question.ts";
import { failedOutputCallIds, userFacingTextOf, type LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";

function inlineSpeechText(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, alt: string) => alt.trim() ? `(image: ${alt})` : "(image omitted)")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/(?:https?:\/\/|www\.)[^\s<>()]+/gi, (url) => {
			const punctuation = url.match(/[.,!?;:]+$/)?.[0] ?? "";
			return `(link)${punctuation}`;
		})
		.replace(/(`+)([^`\n]+?)\1/g, "(code)")
		.replace(/\\\(([\s\S]*?)\\\)/g, "(math)")
		.replace(/\$(?=\S)([^$\n]*?\S)\$/g, "(math)")
		.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/(?<!\w)([*_])(?=\S)(.*?\S)\1(?!\w)/g, "$2")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<\/?[A-Za-z][^>]*>/g, "")
		.replace(/[ \t]+/g, " ")
		.trim();
}

function isTableSeparator(line: string): boolean {
	const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	return cells.length > 1 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function stripBlockMarkers(line: string): string {
	let result = line;
	let previous = "";
	while (result !== previous) {
		previous = result;
		result = result
			.replace(/^\s{0,3}(?:>\s*)+/, "")
			.replace(/^\s{0,3}#{1,6}\s+/, "")
			.replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "");
	}
	return result;
}

function partLabel(label: string | undefined, index: number): string {
	return label?.replace(/^part\s+/i, "").trim() || String(index + 1);
}

/** Project visible Markdown prose to speech without reading code or hidden structure. */
export function speechTextOfMarkdown(md: string): string {
	const lines = md
		.replace(/\r\n?/g, "\n")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
		.replace(/\$\$[\s\S]*?\$\$/g, "\n(math omitted)\n")
		.replace(/\\\[[\s\S]*?\\\]/g, "\n(math omitted)\n")
		.split("\n");
	const paragraphs: string[] = [];
	let paragraph: string[] = [];
	let paragraphHasList = false;
	let previousBlockWasList = false;
	const flush = () => {
		if (paragraph.length) {
			const prose = inlineSpeechText(paragraph.join(" ").replace(/^\s{0,3}(?:>\s*)+/, ""));
			if (prose) paragraphs.push(prose);
			previousBlockWasList = paragraphHasList;
		}
		paragraph = [];
		paragraphHasList = false;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fence) {
			flush();
			previousBlockWasList = false;
			const marker = fence[1]!;
			const language = fence[2]!.trim().split(/\s+/, 1)[0]?.toLowerCase();
			paragraphs.push(language === "mermaid" ? "(diagram omitted)" : "(code block omitted)");
			const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
			while (i + 1 < lines.length && !closing.test(lines[i + 1]!)) i++;
			if (i + 1 < lines.length) i++;
			continue;
		}

		if (/^(?: {4}|\t)/.test(line)) {
			const unindented = line.replace(/^(?: {4}|\t)/, "");
			const isListItem = /^(?:[-+*]|\d+[.)])\s+/.test(unindented);
			const continuesList: boolean = previousBlockWasList || paragraphHasList;
			if (isListItem || continuesList || paragraph.length > 0) {
				paragraph.push(stripBlockMarkers(unindented));
				paragraphHasList ||= isListItem || continuesList;
				previousBlockWasList = paragraphHasList;
				continue;
			}
			flush();
			while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]!) || (lines[i]!.trim() === "" && /^(?: {4}|\t)/.test(lines[i + 1] ?? "")))) i++;
			i--;
			paragraphs.push("(code block omitted)");
			previousBlockWasList = false;
			continue;
		}

		if (line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
			flush();
			previousBlockWasList = false;
			paragraphs.push("(table omitted)");
			i++;
			while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim()) i++;
			continue;
		}

		if (line.trim() === "") {
			flush();
			continue;
		}

		if (paragraph.length === 0) previousBlockWasList = false;
		const listLine = line.replace(/^(?: {0,3}>\s*)+/, "");
		paragraphHasList ||= /^(?: {0,3})(?:[-+*]|\d+[.)])\s+/.test(listLine);
		paragraph.push(stripBlockMarkers(line));
	}
	flush();

	return paragraphs.join("\n");
}

/** Break prepared speech into sentence/newline chunks, bounded by max characters. */
export function speechChunks(text: string, max = 220): string[] {
	const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 220;
	const sentences = text.split(/(?<=[.!?])\s+|\r?\n+/).map((part) => part.trim()).filter(Boolean);
	const chunks: string[] = [];

	for (const sentence of sentences) {
		if (sentence.length <= limit) {
			chunks.push(sentence);
			continue;
		}

		let remainder = sentence;
		while (remainder.length > limit) {
			let boundary = remainder.lastIndexOf(" ", limit);
			if (boundary <= 0) boundary = limit;
			const chunk = remainder.slice(0, boundary).trim();
			if (chunk) chunks.push(chunk);
			remainder = remainder.slice(boundary).trim();
		}
		if (remainder) chunks.push(remainder);
	}
	return chunks;
}

/** Read only settled assistant prose in the latest user turn. */
export function replySpeech(messages: readonly LhMessage[]): { key: string; text: string } | null {
	let lastLearnerInputIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (
			message.role === "user" ||
			(message.role === "toolResult" && (QUESTION_TOOLS as readonly string[]).includes(message.toolName)) ||
			(message.role === "custom" && ["practice-thinking", "practice-next"].includes(message.customType))
		) lastLearnerInputIndex = i;
	}
	const turn = messages.slice(lastLearnerInputIndex + 1);
	if (!turn.length || turn.some((message) => message.id.startsWith("c_"))) return null;

	const assistants = turn.filter((message) => message.role === "assistant");
	const lastAssistant = assistants.at(-1);
	if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") return null;

	const failedOutputCalls = failedOutputCallIds(turn);
	const text = assistants
		.filter((message) => message.stopReason !== "error" && message.stopReason !== "aborted")
		.flatMap((message) => userFacingTextOf(message.content, failedOutputCalls))
		.map(speechTextOfMarkdown)
		.filter(Boolean)
		.join("\n")
		.trim();
	return text ? { key: `reply:${lastAssistant.id}`, text } : null;
}

export function replyReadable(state: {
	status: string;
	busy: boolean;
	compacting: boolean;
	error: unknown;
	retryable: boolean;
}): boolean {
	return state.status === "ready" && !state.busy && !state.compacting && !state.error && !state.retryable;
}

/** Canonical prompt projection matching the expanded question dock's displayed content. */
export function questionSpeech(toolName: string, toolCallId: string, input: unknown): { key: string; text: string } | null {
	const question = questionDataOf(toolName, toolCallId, input);
	if (!question) return null;
	const kind = toolQuestionKind(toolName);
	const lines = [question.question, question.context]
		.filter((value): value is string => typeof value === "string" && !!value.trim());
	for (const [index, part] of (assessmentSpecOf(input)?.parts ?? []).entries()) {
		lines.push(`Part ${partLabel(part.label, index)}: ${part.prompt}`);
	}
	for (const [index, option] of question.options.entries()) {
		const description = kind !== "quiz" && option.description ? ` ${option.description}` : "";
		lines.push(`Option ${index + 1}: ${option.label}${description}`);
	}
	if (kind === "quiz" && question.mode !== "text") lines.push("Or: I don't know");

	const text = lines.map(speechTextOfMarkdown).filter(Boolean).join("\n");
	return text ? { key: `prompt:${toolCallId}`, text } : null;
}

/** Visible practice statement and prompts only; commitments and rubrics stay private. */
export function practiceSpeech(
	problemCallId: string,
	input: { statement: unknown; parts?: unknown },
): { key: string; text: string } | null {
	const statement = typeof input.statement === "string" || typeof input.statement === "number"
		? String(input.statement)
		: "";
	const lines = statement ? [statement] : [];
	for (const [index, part] of (assessmentSpecOf(input)?.parts ?? []).entries()) {
		lines.push(`Part ${partLabel(part.label, index)}: ${part.prompt}`);
	}
	const text = lines.map(speechTextOfMarkdown).filter(Boolean).join("\n");
	return text ? { key: `prompt:${problemCallId}`, text } : null;
}
