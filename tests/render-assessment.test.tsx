import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssessmentFeedback, EvaluationCard } from "../components/assessment-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ProblemCard } from "../components/practice-cards.tsx";
import { assessmentSpecOf, scoreEvaluation } from "../src/core/assessment.ts";
import { buildAnswer } from "../src/core/question-core.ts";
import { deterministicAnswer, questionDataOf } from "../src/core/canonical-question.ts";
import type { AssessmentEvaluationV1 } from "../src/core/contracts/assessment.ts";

const parts = [
	{ id: "a", label: "Part A", prompt: "First visible prompt", criteria: [{ id: "c1", description: "Reasoning criterion", maxPoints: 2, expectedEvidence: "SECRET EVIDENCE" }] },
	{ id: "b", label: "Part B", prompt: "Second visible prompt", criteria: [{ id: "c2", description: "Application criterion", maxPoints: 2, expectedEvidence: "SECRET APPLICATION" }] },
];
const input = { question: "Shared question", correctAnswer: "SECRET COMMITMENT", parts };
const spec = assessmentSpecOf(input)!;
const awards = [{ criterionId: "c1", award: 2, feedback: "Reason credited" }, { criterionId: "c2", award: 1, feedback: "Application partly credited" }];
const evaluation: AssessmentEvaluationV1 = { version: 1, sourceCallId: "source", responseId: "response", evaluationId: "evaluation", provenance: "modelJudged", spec, ...scoreEvaluation(spec, awards) };

test("multipart dock exposes labels and maxima but only one answer textarea and no criteria or solutions", () => {
	const markup = renderToStaticMarkup(<QuestionDock toolName="recall" toolCallId="source" input={input} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.equal((markup.match(/<textarea/g) ?? []).length, 1);
	assert.match(markup, /Part A/);
	assert.match(markup, /Part B/);
	assert.match(markup, /2 pts/);
	assert.doesNotMatch(markup, /SECRET|Reasoning criterion|Application criterion/);
	const answer = buildAnswer(questionDataOf("recall", "source", input)!, { text: "My explicit submission" });
	const answered = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
	assert.match(answered, /SECRET EVIDENCE/);
	assert.match(answered, /SECRET COMMITMENT/);
	assert.doesNotMatch(answered, /Auto-graded/);
});

test("typed explain dock renders only safe controls and answered cards show typed responses and auto-feedback", () => {
	const typedInput = {
		question: "Answer each part",
		correctAnswer: "Secret commitment",
		parts: [
			{ id: "distance", kind: "numeric", prompt: "Distance", answer: 1000, units: [{ symbol: "m", factor: 1 }, { symbol: "km", factor: 1000 }], tolerance: { kind: "absolute", value: 0.1 }, points: 1 },
			{ id: "word", kind: "exact", prompt: "Word", accepted: ["SECRET ACCEPTED"], normalize: "nfkc-trim-casefold", points: 1 },
			{ id: "reason", kind: "structured", prompt: "Explain", fields: [{ id: "why", label: "Why", kind: "paragraph" }], criteria: [{ id: "logic", description: "Logic", maxPoints: 1, expectedEvidence: "Secret criterion" }] },
		],
	};
	const markup = renderToStaticMarkup(<QuestionDock toolName="explain" toolCallId="typed" input={typedInput} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.match(markup, /inputMode="decimal"/);
	assert.match(markup, /<datalist/);
	assert.match(markup, /for="question-typed-distance-value"/);
	assert.match(markup, /for="question-typed-word-text"/);
	assert.match(markup, /for="question-typed-reason-why"/);
	assert.doesNotMatch(markup, /Secret commitment|SECRET ACCEPTED|Secret criterion|expectedEvidence|tolerance/);
	assert.doesNotMatch(markup, /data-testid="answer-field"/);

	const spec = assessmentSpecOf(typedInput)!;
	const response = buildAnswer(questionDataOf("explain", "typed", typedInput)!, {
		partResponses: [
			{ partId: "distance", kind: "numeric", value: 1, unit: "km" },
			{ partId: "word", kind: "exact", text: "secret accepted" },
			{ partId: "reason", kind: "structured", fields: [{ id: "why", text: "Because it follows." }] },
		],
	});
	const autoEvaluation = {
		version: 1 as const, sourceCallId: "typed", responseId: "typed-result", evaluationId: "auto:typed-result",
		provenance: "deterministic" as const,
		spec: { version: 1 as const, parts: spec.parts.filter(part => part.kind === "numeric" || part.kind === "exact") },
		...scoreEvaluation({ version: 1, parts: spec.parts.filter(part => part.kind === "numeric" || part.kind === "exact") }, [
			{ criterionId: "distance", award: 1, feedback: "Correct." },
			{ criterionId: "word", award: 1, feedback: "Correct." },
		]),
	};
	const answered = renderToStaticMarkup(<AnsweredCard answer={{ ...response, autoEvaluation }} input={typedInput} />);
	assert.match(answered, /Your answers/);
	assert.match(answered, /1 km/);
	assert.match(answered, /secret accepted/);
	assert.match(answered, /Because it follows/);
	assert.match(answered, /Auto-graded/);
});

test("evaluation feedback renders actual partial credit and null coverage, not invented totals", () => {
	assert.equal(evaluation.totals.awarded, 3);
	const markup = renderToStaticMarkup(<AssessmentFeedback evaluation={evaluation} />);
	assert.match(markup, /3\/4/);
	assert.match(markup, /AI-evaluated/);
	assert.match(markup, /partial/);
	assert.match(markup, /Application partly credited/);
	const incomplete = { ...evaluation, ...scoreEvaluation(spec, [awards[0]!, { ...awards[1]!, award: null }]) };
	assert.equal(incomplete.totals.complete, false);
	const partial = renderToStaticMarkup(<AssessmentFeedback evaluation={incomplete} />);
	assert.match(partial, /2\/2 assessed, 2 pts unassessed, incomplete/);
	assert.doesNotMatch(partial, /3\/4|4\/4|0\/4/);
	assert.equal(renderToStaticMarkup(<EvaluationCard part={{ type: "tool-evaluate", toolCallId: "evaluation", state: "input-available" }} />), "");
	assert.equal(renderToStaticMarkup(<EvaluationCard part={{ type: "tool-evaluate", toolCallId: "evaluation", state: "output-available", output: evaluation }} />), markup);
});

test("fractional maxima and incomplete feedback render without floating-point artifacts", () => {
	const fractional = { ...input, parts: [{ ...parts[0]!, criteria: parts.map((p, i) => ({ ...p.criteria[0]!, maxPoints: i === 0 ? 0.1 : 0.2 })) }] };
	const fractionalSpec = assessmentSpecOf(fractional)!;
	const scored = scoreEvaluation(fractionalSpec, [{ ...awards[0]!, award: 0.1 }, { ...awards[1]!, award: null }]);
	const feedback = renderToStaticMarkup(<AssessmentFeedback evaluation={{ ...evaluation, spec: fractionalSpec, ...scored }} />);
	assert.match(feedback, /0.1\/0.1 assessed, 0.2 pts unassessed/);
	const dock = renderToStaticMarkup(<QuestionDock toolName="recall" toolCallId="fractional" input={fractional} expanded onExpand={() => {}} onSubmit={() => {}} />);
	const practice = renderToStaticMarkup(<ProblemCard part={{ type: "tool-problem", toolCallId: "fractional", state: "output-available", input: { statement: "p", parts: fractional.parts }, output: null }} />);
	for (const markup of [dock, practice]) {
		assert.match(markup, /0.3 pts/);
		assert.doesNotMatch(markup, /0.30000000000000004/);
	}
});

test("hundredth coverage stays visible while odd legacy maxima still render", () => {
	const bounded = structuredClone(parts);
	bounded[0]!.criteria[0]!.maxPoints = 100;
	bounded[1]!.criteria[0]!.maxPoints = 0.01;
	const boundedSpec = assessmentSpecOf({ parts: bounded })!;
	const scored = scoreEvaluation(boundedSpec, [{ ...awards[0]!, award: 100 }, { ...awards[1]!, award: null }]);
	const feedback = renderToStaticMarkup(<AssessmentFeedback evaluation={{ ...evaluation, spec: boundedSpec, ...scored }} />);
	assert.match(feedback, /100\/100 assessed, 0.01 pts unassessed/);
	bounded[1]!.criteria[0]!.maxPoints = 0.0000000001;
	assert.doesNotThrow(() => renderToStaticMarkup(<QuestionDock toolName="recall" toolCallId="legacy-odd" input={{ ...input, parts: bounded }} expanded onExpand={() => {}} onSubmit={() => {}} />));
});

test("practice prompt keeps hidden solution and evidence private; legacy answers gain no badges or rubric", () => {
	const problem = { statement: "Visible problem", modelSolution: "SECRET SOLUTION", parts };
	const markup = renderToStaticMarkup(<ProblemCard part={{ type: "tool-problem", toolCallId: "source", state: "output-available", input: problem, output: null }} />);
	assert.match(markup, /First visible prompt/);
	assert.doesNotMatch(markup, /SECRET/);
	const legacy = { question: "Legacy question", correctAnswer: "Old answer" };
	assert.equal(assessmentSpecOf(legacy), undefined);
	const answer = buildAnswer(questionDataOf("recall", "legacy", legacy)!, { text: "Legacy response" });
	const old = renderToStaticMarkup(<AnsweredCard answer={answer} input={legacy} />);
	assert.doesNotMatch(old, /Auto-graded|AI-evaluated|assessment-commitment/);
	const quiz = { question: "Pick A", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A is right" };
	const auto = deterministicAnswer(questionDataOf("probe", "auto", quiz)!, { values: ["A"] }, "probe");
	assert.equal(auto.correct, true);
	assert.match(renderToStaticMarkup(<AnsweredCard answer={auto} input={quiz} />), /Auto-graded/);
});
