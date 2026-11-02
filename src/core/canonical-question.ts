import { parseAskInput, parseExplainInput, parseQuizInput } from "./tool-parts.ts";
import { buildAnswer, normalizeOptions, normalizeQuizType, resolveCorrect, seededRandom, shuffleOptions, type AnswerRequest, type QuestionData } from "./question-core.ts";
import { toolQuestionKind } from "./pending.ts";

export function deterministicAnswer(q: QuestionData, request: AnswerRequest, tool: string) {
	const answer = buildAnswer(q, request, tool);
	return q.kind === "quiz" ? { ...answer, gradingProvenance: "deterministic" as const } : answer;
}

export function questionDataOf(tool: string, toolCallId: string, input: unknown): QuestionData | undefined {
	const kind = toolQuestionKind(tool);
	const quiz = kind === "quiz" ? parseQuizInput(input) : undefined;
	const explain = kind === "explain" ? parseExplainInput(input) : undefined;
	const ask = kind === "ask" ? parseAskInput(input) : undefined;
	const parsed = quiz ?? explain ?? ask;
	if (!parsed) return undefined;
	const multi = "multiSelect" in parsed && parsed.multiSelect === true;
	const options = normalizeOptions(quiz?.options ?? ask?.options ?? []);
	const ordered = quiz ? shuffleOptions(options, seededRandom(toolCallId)) : options;
	const resolved = quiz ? resolveCorrect(quiz.correctAnswer, ordered) : undefined;
	if (resolved?.error) return undefined;
	return {
		id: toolCallId, kind, question: parsed.question, context: parsed.details,
		questionType: quiz ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
		mode: quiz || ask?.options?.length ? multi ? "multi-select" : "single-select" : "text",
		options: ordered, correctIndices: resolved?.indices, explanation: quiz?.explanation,
		committedAnswer: explain?.correctAnswer, createdAt: new Date().toISOString(),
	};
}
