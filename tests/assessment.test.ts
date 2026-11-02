import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { AssessmentEvaluationV1, CriterionAward } from "../src/core/contracts/assessment.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-assessments-"));
process.env.LH_DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
const { chatStore } = await import("../src/store/chats.ts");
const { assessmentSpecOf, assessmentSpecProblems, criterionOutcome, evaluationProblems, scoreEvaluation } = await import("../src/core/assessment.ts");
const { inputAppends, dismissAppends } = await import("../src/core/input-events.ts");
const { buildAnswer, dismissedAnswer } = await import("../src/core/question-core.ts");
const { questionDataOf } = await import("../src/core/canonical-question.ts");
const { newThinkingMessage, projectView } = await import("../src/core/index.ts");
const { evaluateTool } = await import("../src/agent/tools/evaluate.ts");
const { createProberTools, createTeacherTools, quizMechanics, probeExplainTool } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const parts = [
	{ id: "part-a", label: "A", prompt: "Explain the first step", criteria: [{ id: "reason", description: "Reasoning", maxPoints: 2, expectedEvidence: "A valid reason" }] },
	{ id: "part-b", label: "B", prompt: "Apply the second step", criteria: [{ id: "apply", description: "Application", maxPoints: 2, expectedEvidence: "A valid application" }] },
];
const free = { question: "Explain and apply", correctAnswer: "Committed solution", parts };
const awards: CriterionAward[] = [{ criterionId: "reason", award: 2, feedback: "Reason is correct" }, { criterionId: "apply", award: 1, feedback: "Application is incomplete" }];
const spec = assessmentSpecOf(free)!;

function call(name: string, input: object, id = "source"): LhMessage {
	return { ...fauxAssistantMessage([fauxToolCall(name, input as Parameters<typeof fauxToolCall>[1], { id })], { stopReason: "toolUse" }), id: `message-${id}` } as LhMessage;
}
function result(id: string, name: string, details: unknown): LhMessage {
	return { id: `result-${id}`, role: "toolResult", toolCallId: id, toolName: name, details, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 } as LhMessage;
}
function answered(name = "recall", input = free, id = "source") {
	const source = call(name, input, id);
	const answer = buildAnswer(questionDataOf(name, id, input)!, { text: "My reason and application" });
	const response = inputAppends({ messages: [source] }, { type: "answer", toolCallId: id, answer })[0]!;
	return { source, response, messages: [source, response] };
}
function evaluator(messages: LhMessage[]) {
	return evaluateTool({ chatId: "test", chatStore: { getChat: () => ({ messages }) } });
}

test("rubric authoring validates shape, finite bounds, unique ids and caps; legacy remains absent", async () => {
	assert.deepEqual(assessmentSpecProblems(parts), []);
	assert.equal(assessmentSpecOf({ question: "legacy", correctAnswer: "old" }), undefined);
	assert.equal(assessmentSpecOf({ parts: [] }), undefined);
	const displayOnly = [{ ...parts[0]!, label: "x".repeat(121) }];
	assert.ok(assessmentSpecProblems(displayOnly).length);
	assert.deepEqual(assessmentSpecOf({ parts: displayOnly })?.parts, displayOnly);
	for (const invalid of [[], [...parts, parts[0]], [{ ...parts[0], criteria: [parts[0]!.criteria[0], parts[0]!.criteria[0]] }], Array(9).fill(parts[0])]) assert.ok(assessmentSpecProblems(invalid).length);
	for (const maxPoints of [0, -1, 101, NaN, Infinity]) assert.ok(assessmentSpecProblems([{ ...parts[0], criteria: [{ ...parts[0]!.criteria[0], maxPoints }] }]).length);
	for (const invalid of ["", " ", "x".repeat(4001)]) assert.ok(assessmentSpecProblems([{ ...parts[0], prompt: invalid }]).length);
	const many = Array.from({ length: 5 }, (_, p) => ({ id: `p${p}`, prompt: "p", criteria: Array.from({ length: 8 }, (_, c) => ({ id: `c${p}-${c}`, description: "d", maxPoints: 1, expectedEvidence: "e" })) }));
	assert.ok(assessmentSpecProblems(many).length);
	const rejected = await probeExplainTool.execute("invalid", { ...free, parts: [parts[0]!, parts[0]!] });
	assert.equal(rejected.isError, true);
});

test("pure scoring derives 3/4, coverage and all four outcomes without fabricating null awards", () => {
	assert.deepEqual(scoreEvaluation(spec, awards).totals, { awarded: 3, assessedMax: 4, max: 4, assessedCount: 2, criterionCount: 2, complete: true });
	const partial = scoreEvaluation(spec, [awards[0]!, { ...awards[1]!, award: null }]);
	assert.deepEqual(partial.totals, { awarded: 2, assessedMax: 2, max: 4, assessedCount: 1, criterionCount: 2, complete: false });
	assert.deepEqual([2, 1, 0, null].map(a => criterionOutcome(a, 2)), ["met", "partial", "not_met", "unassessed"]);
	assert.equal(scoreEvaluation(spec, awards.map(a => ({ ...a, award: null }))).totals.complete, false);
	assert.throws(() => scoreEvaluation(spec, []));
});

test("canonical answers ignore forged verdicts, labels, commitments and timestamps; reject invalid and repeated input", () => {
	const input = { question: "Choose A", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "a", explanation: "A is right" };
	const source = call("probe", input);
	const original = buildAnswer(questionDataOf("probe", "source", input)!, { values: ["b"] });
	const forged = { ...original, correct: true, answeredAt: "forged", questionText: "forged", answers: original.answers.map(a => ({ ...a, label: "forged", index: 99 })) };
	const response = inputAppends({ messages: [source] }, { type: "answer", toolCallId: "source", answer: forged })[0]!;
	assert.equal(response.role, "toolResult");
	if (response.role !== "toolResult") return;
	const canonical = response.details as unknown as typeof original;
	assert.equal(canonical.correct, false);
	assert.equal(canonical.gradingProvenance, "deterministic");
	assert.equal(canonical.answers[0]!.label, "B");
	assert.equal(canonical.questionText, input.question);
	assert.notEqual(canonical.answeredAt, "forged");
	for (const values of [["ghost"], ["b", "b"], ["a", "b"], []]) {
		const answer = { ...original, answers: values.map(value => ({ value, label: value, index: 1 })) };
		assert.throws(() => inputAppends({ messages: [source] }, { type: "answer", toolCallId: "source", answer }));
	}
	assert.throws(() => inputAppends({ messages: [source, response] }, { type: "answer", toolCallId: "source", answer: original }));
	assert.throws(() => inputAppends({ messages: [source] }, { type: "answer", toolCallId: "stale", answer: original }));
	assert.throws(() => inputAppends({ messages: [source] }, { type: "answer", toolCallId: "source", answer: { ...original, kind: "explain" } }));
	assert.throws(() => inputAppends({ messages: [call("probe", { question: "Broken", options: [] })] }, { type: "answer", toolCallId: "source", answer: original }));
	assert.throws(() => inputAppends({ messages: [call("recall", free)] }, { type: "answer", toolCallId: "source", answer: { ...original, kind: "explain", text: " " } }));
	const dismissed = dismissAppends({ messages: [source] }, { type: "dismiss", toolCallId: "source", answer: { ...dismissedAnswer("quiz", "forged"), correct: true } })[0]!;
	assert.equal(dismissed.role === "toolResult" && (dismissed.details as { questionText: string }).questionText, input.question);
});

test("evaluation validates canonical response, exact criteria and awards; succeeds once and survives persistence", async () => {
	const { source, response, messages } = answered();
	assert.equal(response.role === "toolResult" && JSON.parse(response.content[0]!.type === "text" ? response.content[0]!.text : "{}").responseId, response.id);
	const valid = { sourceCallId: "source", responseId: response.id, criteria: awards };
	for (const criteria of [[], [awards[0]!], [awards[0]!, awards[0]!], [{ ...awards[0]!, criterionId: "nonexistent-part" }, awards[1]!], ...[3, -1, NaN, Infinity].map(award => [{ ...awards[0]!, award }, awards[1]!])]) {
		assert.ok(evaluationProblems(spec, criteria).length);
		assert.equal((await evaluator(messages).execute("eval", { ...valid, criteria })).isError, true);
	}
	for (const input of [{ ...valid, responseId: "wrong" }, { ...valid, sourceCallId: "another" }]) assert.equal((await evaluator(messages).execute("eval", input)).isError, true);
	const other = answered("recall", free, "other");
	assert.equal((await evaluator([...messages, ...other.messages]).execute("eval", { ...valid, responseId: other.response.id })).isError, true);
	const dismissed = dismissAppends({ messages: [source] }, { type: "dismiss", toolCallId: "source", answer: dismissedAnswer("explain", free.question) })[0]!;
	assert.equal((await evaluator([source, dismissed]).execute("eval", { ...valid, responseId: dismissed.id })).isError, true);
	const legacySource = call("recall", { question: "old", correctAnswer: "old" });
	assert.equal((await evaluator([legacySource, response]).execute("eval", valid)).isError, true);
	const changed = structuredClone(parts);
	changed[1]!.criteria[0]!.id = "changed";
	assert.equal((await evaluator([call("recall", { ...free, parts: changed }), response]).execute("eval", valid)).isError, true);
	const tool = evaluator(messages);
	assert.equal((await tool.execute("bad", { ...valid, criteria: [] })).isError, true);
	const success = await tool.execute("eval", valid);
	assert.notEqual(success.isError, true);
	const e = success.details as unknown as AssessmentEvaluationV1;
	assert.equal(e.evaluationId, "eval");
	assert.equal(e.provenance, "modelJudged");
	assert.equal(e.totals.awarded, 3);
	assert.deepEqual(e.spec, spec);
	assert.equal((await tool.execute("again", valid)).isError, true);
	const chat = chatStore.createChat("assessment restart");
	chatStore.saveMessages(chat.id, [...messages, call("evaluate", valid, "eval"), result("eval", "evaluate", e)]);
	const fresh = (await import(`../src/store/chats.ts?${"assessment-restart"}`)).chatStore;
	const restored = fresh.getChat(chat.id)!.messages;
	assert.deepEqual(restored, chatStore.getChat(chat.id)!.messages);
	assert.equal(restored.filter(m => m.role === "toolResult" && m.toolName === "evaluate").length, 1);
	assert.equal((await evaluateTool({ chatId: chat.id, chatStore: fresh }).execute("again", valid)).isError, true);
	assert.throws(() => inputAppends({ messages: restored }, { type: "answer", toolCallId: "source", answer: buildAnswer(questionDataOf("recall", "source", free)!, { text: "retry" }) }));
});

test("mixed registration, settings precedence and additive sanitization", () => {
	const chat = chatStore.createChat("settings");
	const ctx = { chatId: chat.id, chatStore, jobStore: {} as never, spawn: () => {}, deliver: () => {} };
	assert.ok(createProberTools(ctx, undefined, "mixed").probe);
	assert.ok(createProberTools(ctx, undefined, "mixed").recall);
	assert.ok(createTeacherTools(ctx, undefined, "mixed").quiz);
	assert.ok(createTeacherTools(ctx, undefined, "mixed").explain);
	for (const registry of [createProberTools(ctx), createTeacherTools(ctx), practiceTools(ctx)]) assert.ok(registry.evaluate);
	assert.equal(quizMechanics(), "choice");
	assert.equal(quizMechanics({ explain: true }), "free");
	assert.equal(quizMechanics({ explain: true }, "choice"), "choice");
	for (const assessmentMode of ["choice", "free", "mixed"] as const) {
		const settings = sanitizeUserSettings({ version: 1, future: 7, agent: { assessmentMode, tools: { explain: true }, futureAgent: "retained" } })!;
		assert.equal(resolveSettings(settings).agent.assessmentMode, assessmentMode);
		assert.equal(settings.future, 7);
		assert.equal((settings.agent as unknown as { futureAgent: string }).futureAgent, "retained");
		assert.equal(settings.agent?.tools?.explain, true);
		assert.equal(parseAgentSettingsBody({ assessmentMode }).ok, true);
	}
	assert.equal(sanitizeUserSettings({ agent: { assessmentMode: "bad" } })?.agent?.assessmentMode, undefined);
	assert.equal(parseAgentSettingsBody({ assessmentMode: "bad" }).ok, false);
});

test("practice rubric evaluates a submitted thinking response without releasing Next", async () => {
	const input = { statement: "Work both parts", mode: "composition", modelSolution: "Hidden solution", parts };
	const chat = chatStore.createChat("practice", "practice");
	const registry = practiceTools({ chatId: chat.id, chatStore });
	const invalid = await registry.problem!.execute("bad", { ...input, parts: [parts[0], parts[0]] });
	assert.equal(invalid.isError, true);
	const pose = await registry.problem!.execute("source", input);
	assert.notEqual(pose.isError, true);
	const marker = newThinkingMessage("source", "Reason plus partial application");
	const messages = [call("problem", input), result("source", "problem", null), marker];
	chatStore.saveMessages(chat.id, messages);
	const output = await registry.evaluate!.execute("eval-practice", { sourceCallId: "source", responseId: marker.id, criteria: awards });
	assert.equal((output.details as AssessmentEvaluationV1).totals.awarded, 3);
	assert.match(marker.content, new RegExp(marker.id));
	assert.throws(() => inputAppends({ messages, kind: "practice" }, { type: "next" }));
	assert.equal((await registry.conclude!.execute("conclude", { outcome: "solved", verdict: "Done", rung: null, missClass: null, retest: false })).isError, undefined);
});

test("legacy projection preserves history without inventing rubric or verified provenance", () => {
	const source = call("recall", { question: "Legacy", correctAnswer: "Original" });
	const legacy = buildAnswer(questionDataOf("recall", "source", { question: "Legacy", correctAnswer: "Original" })!, { text: "Response" });
	const messages = [source, result("source", "recall", legacy)];
	const before = structuredClone(messages);
	projectView(messages);
	assert.deepEqual(messages, before);
	assert.equal(assessmentSpecOf((source as { content: { arguments: unknown }[] }).content[0]!.arguments), undefined);
	assert.equal(legacy.gradingProvenance, undefined);
});

test("encoded persisted rubrics remain answerable and evaluable for explain, recall and problem", async () => {
	const encoded = { ...free, parts: JSON.stringify(parts) };
	for (const name of ["explain", "recall"]) {
		const source = call(name, encoded);
		const question = questionDataOf(name, "source", encoded);
		assert.ok(question, `${name} must parse the boundary-healed pending call`);
		assert.deepEqual(assessmentSpecOf(encoded), spec);
		const answer = buildAnswer(question, { text: "My shared answer" });
		const response = inputAppends({ messages: [source] }, { type: "answer", toolCallId: "source", answer })[0]!;
		const output = await evaluator([source, response]).execute(`eval-${name}`, { sourceCallId: "source", responseId: response.id, criteria: awards });
		assert.equal((output.details as AssessmentEvaluationV1).totals.awarded, 3);
	}
	const input = { statement: "Work both parts", mode: "composition", modelSolution: "Hidden", parts: JSON.stringify(parts) };
	const chat = chatStore.createChat("encoded practice", "practice");
	const registry = practiceTools({ chatId: chat.id, chatStore });
	const prepared = registry.problem!.prepareArguments!(input);
	const posed = await registry.problem!.execute("source", prepared);
	assert.notEqual(posed.isError, true);
	assert.deepEqual(assessmentSpecOf(input), spec);
	const response = newThinkingMessage("source", "My practice answer");
	chatStore.saveMessages(chat.id, [call("problem", input), result("source", "problem", null), response]);
	const output = await registry.evaluate!.execute("eval-problem", { sourceCallId: "source", responseId: response.id, criteria: awards });
	assert.equal((output.details as AssessmentEvaluationV1).totals.awarded, 3);
	assert.equal(assessmentSpecOf({ parts: "not JSON" }), undefined);
	assert.equal(questionDataOf("recall", "bad", { ...free, parts: "not JSON" }), undefined);
	assert.equal(encoded.parts, JSON.stringify(parts), "parsing must not rewrite persisted arguments");
});

test("faux tutor submit, reattach and restart preserve exactly one canonical answer and evaluation", async () => {
	const { handleChatRequest } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const { createProberAgent } = await import("../src/agent/teacher-agent.ts");
	const chat = chatStore.createChat("faux assessment");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const faux = createFauxCore({});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("recall", free, { id: "faux-source" })], { stopReason: "toolUse" }),
		() => {
			const response = chatStore.getChat(chat.id)!.messages.find(m => m.role === "toolResult" && m.toolCallId === "faux-source")!;
			assert.ok(response);
			return fauxAssistantMessage([fauxToolCall("evaluate", { sourceCallId: "faux-source", responseId: response.id, criteria: awards.map(a => ({ ...a })) }, { id: "faux-eval" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage([fauxText("Feedback recorded.")]),
	]);
	const factory: NonNullable<Parameters<typeof handleChatRequest>[1]> = opts => createProberAgent({ chatId: chat.id, chatStore, jobStore: {} as never, spawn: () => {}, deliver: () => {} }, { ...opts, assessmentMode: "mixed", engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
	const request = (input: object) => new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: chat.id, input }) });
	async function turn(input: object) {
		const ack = await handleChatRequest(request(input), factory);
		assert.equal(ack.status, 200, await ack.text());
		const live = runningTurn(chat.id);
		if (live) await new Response(live.subscribe()).text();
	}
	await turn({ type: "text", text: "Assess both parts" });
	const submission = { type: "answer", toolCallId: "faux-source", answer: buildAnswer(questionDataOf("recall", "faux-source", free)!, { text: "My answer" }) };
	await turn(submission);
	const before = chatStore.getChat(chat.id)!.messages;
	assert.equal(before.filter(m => m.role === "toolResult" && m.toolName === "evaluate" && !m.isError).length, 1);
	const projected = projectView(before).flatMap(m => m.parts).find(p => p.type === "tool-evaluate");
	assert.ok(projected && "output" in projected);
	assert.equal((projected.output as AssessmentEvaluationV1).totals.awarded, 3);
	assert.equal((await handleChatRequest(request(submission), factory)).status, 400);
	const fresh = (await import(`../src/store/chats.ts?${"faux-restart"}`)).chatStore;
	assert.deepEqual(fresh.getChat(chat.id)!.messages, before);
});
