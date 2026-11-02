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
