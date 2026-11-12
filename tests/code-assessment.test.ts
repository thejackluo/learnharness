import assert from "node:assert/strict";
import test from "node:test";
import { assessmentSpecOf, assessmentSpecProblems, autoEvaluate, partResponseProblems, partResponsesFromDraft } from "../src/core/assessment.ts";
import type { AssessmentPartResponse, AssessmentSpecV1, CodeTestResult } from "../src/core/contracts/assessment.ts";
import { compactAnswerForModel } from "../src/core/question-core.ts";

const codePart = {
	id: "sum",
	kind: "code",
	language: "python",
	prompt: "Write a sum function.",
	starter: "def add(a, b):\n    return a + b",
	tests: [
		{ id: "positive", name: "Positive values", call: "add(2, 3)", expected: "5" },
		{ id: "negative", name: "Negative values", call: "add(-2, -3)", expected: "-5" },
	],
	points: 3,
};

test("Python code parts validate bounds and normalize the default time limit", () => {
	assert.deepEqual(assessmentSpecProblems([codePart]), []);
	const spec = assessmentSpecOf({ parts: [codePart] })!;
	const part = spec.parts[0]!;
	assert.equal(part.kind, "code");
	if (part.kind !== "code") return;
	assert.equal(part.timeLimitMs, 3000);
	assert.equal(part.criteria[0]?.id, part.id);

	for (const invalid of [
		{ ...codePart, language: "javascript" },
		{ ...codePart, tests: [] },
		{ ...codePart, tests: Array(21).fill(codePart.tests[0]) },
		{ ...codePart, starter: "x".repeat(8001) },
		{ ...codePart, tests: [{ ...codePart.tests[0], name: "x".repeat(121) }] },
		{ ...codePart, tests: [{ ...codePart.tests[0], call: "x".repeat(501) }] },
		{ ...codePart, tests: [{ ...codePart.tests[0], expected: "x".repeat(501) }] },
		{ ...codePart, timeLimitMs: 499 },
		{ ...codePart, timeLimitMs: 10001 },
		{ ...codePart, points: 0 },
		{ ...codePart, tests: [codePart.tests[0]!, { ...codePart.tests[1]!, id: codePart.tests[0]!.id }] },
	]) assert.ok(assessmentSpecProblems([invalid]).length, JSON.stringify(invalid));
	assert.equal(assessmentSpecOf({ parts: [{ ...codePart, timeLimitMs: 10001 }] }), undefined);
	assert.equal(assessmentSpecOf({ parts: [{ ...codePart, tests: [{ ...codePart.tests[0], expected: "x".repeat(501) }] }] }), undefined);
});

test("Python responses are bounded, require each declared test id exactly once, and grade by pass count", () => {
	const spec = assessmentSpecOf({ parts: [codePart] }) as AssessmentSpecV1;
	const results: CodeTestResult[] = [
		{ testId: "positive", status: "pass", actual: "5", stdout: "" },
		{ testId: "negative", status: "fail", actual: "0", error: "AssertionError: expected -5", stdout: "" },
	];
	const responses: AssessmentPartResponse[] = [{ partId: "sum", kind: "code", source: codePart.starter, results }];
	assert.deepEqual(partResponseProblems(spec, responses), []);
	const evaluation = autoEvaluate(spec, responses, { sourceCallId: "call-1", responseId: "result-1" })!;
	assert.equal(evaluation.provenance, "clientExecuted");
	assert.equal(evaluation.criteria[0]?.award, 1.5);
	assert.equal(evaluation.totals.awarded, 1.5);
	const modelAnswer = compactAnswerForModel({
		kind: "explain",
		questionText: "Write a sum function.",
		answers: [],
		dontKnow: false,
		answeredAt: "2026-10-28T00:00:00.000Z",
		partResponses: responses,
		autoEvaluation: evaluation,
	});
	const evaluationText = (modelAnswer.parts as Array<{ evaluationText: string }>)[0]!.evaluationText;
	const failingModelPart = (modelAnswer.parts as Array<{ evaluationText: string; notePatternReminder?: string }>)[0]!;
	assert.equal(
		failingModelPart.notePatternReminder,
		"Some tests did not pass. If the submitted source shows a specific, nameable mistake, call note_pattern with a short verbatim quote from the source. Skip it for a one-off typo.",
	);
	for (const detail of [
		"Submitted source:", "def add(a, b):", "Call: add(-2, -3)", "Expected: -5", "Actual: 0",
		"Error: AssertionError: expected -5",
	]) assert.ok(evaluationText.includes(detail), detail);

	const passingResponses: AssessmentPartResponse[] = [{
		partId: "sum",
		kind: "code",
		source: codePart.starter,
		results: results.map(result => ({ ...result, status: "pass" })),
	}];
	const passingEvaluation = autoEvaluate(spec, passingResponses, { sourceCallId: "call-2", responseId: "result-2" })!;
	const passingAnswer = compactAnswerForModel({
		kind: "explain",
		questionText: "Write a sum function.",
		answers: [],
		dontKnow: false,
		answeredAt: "2026-10-28T00:00:00.000Z",
		partResponses: passingResponses,
		autoEvaluation: passingEvaluation,
	});
	assert.equal("notePatternReminder" in (passingAnswer.parts as Array<Record<string, unknown>>)[0]!, false);

	const structuredSpec = assessmentSpecOf({
		parts: [{
			id: "steps",
			kind: "structured",
			prompt: "Explain.",
			fields: [{ id: "reason", label: "Reason", kind: "paragraph" }],
			criteria: [{ id: "reasoning", description: "Explains the result", maxPoints: 1, expectedEvidence: "A reason." }],
		}],
	})!;
	const structuredAnswer = compactAnswerForModel({
		kind: "explain",
		questionText: "Explain.",
		answers: [],
		dontKnow: false,
		answeredAt: "2026-10-28T00:00:00.000Z",
		partResponses: [{ partId: "steps", kind: "structured", fields: [{ id: "reason", text: "Because." }] }],
		autoEvaluation: { ...passingEvaluation, spec: structuredSpec },
	});
	assert.equal("notePatternReminder" in (structuredAnswer.parts as Array<Record<string, unknown>>)[0]!, false);

	for (const malformed of [
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [results[0]] }],
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [results[0], { ...results[1], testId: "extra" }] }],
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [results[0], { ...results[1], testId: "positive" }] }],
		[{ partId: "sum", kind: "code", source: "x".repeat(20001), results }],
		[{ partId: "sum", kind: "code", source: codePart.starter, extra: true, results }],
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [{ ...results[0], unknown: true }, results[1]] }],
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [{ ...results[0], status: "unknown" }, results[1]] }],
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [{ ...results[0], actual: "x".repeat(501) }, results[1]] }],
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [{ ...results[0], error: "x".repeat(501) }, results[1]] }],
		[{ partId: "sum", kind: "code", source: codePart.starter, results: [{ ...results[0], stdout: "x".repeat(2001) }, results[1]] }],
	]) {
		assert.ok(partResponseProblems(spec, malformed).length);
		assert.equal(autoEvaluate(spec, malformed, { sourceCallId: "call-1", responseId: "result-1" }), undefined);
	}

	const draft = partResponsesFromDraft(spec, { sum: { source: codePart.starter } }, { sum: results });
	assert.equal(draft.complete, true);
	assert.deepEqual(draft.responses, responses);
	assert.equal(partResponsesFromDraft(spec, { sum: { source: codePart.starter } }).complete, false);
});

test("Python code awards use hundredths and preserve exact full credit", () => {
	const tests = [
		{ id: "first", name: "First", call: "1", expected: "1" },
		{ id: "second", name: "Second", call: "2", expected: "2" },
		{ id: "third", name: "Third", call: "3", expected: "3" },
	];
	for (const { points, statuses, expected, outcome } of [
		{ points: 1.6, statuses: ["pass", "pass", "pass"], expected: 1.6, outcome: "met" },
		{ points: 1.6, statuses: ["pass", "fail", "fail"], expected: 0.53, outcome: "partial" },
		{ points: 1, statuses: ["pass", "pass", "fail"], expected: 0.66, outcome: "partial" },
	] as const) {
		const spec = assessmentSpecOf({ parts: [{ ...codePart, tests, points }] }) as AssessmentSpecV1;
		const results = tests.map((test, index) => ({ testId: test.id, status: statuses[index]! })) as CodeTestResult[];
		const evaluation = autoEvaluate(spec, [{ partId: "sum", kind: "code", source: "", results }], { sourceCallId: "call-1", responseId: "result-1" })!;
		assert.equal(evaluation.criteria[0]?.award, expected);
		assert.equal(evaluation.criteria[0]?.outcome, outcome);
		assert.equal(evaluation.totals.awarded, expected);
	}
});
