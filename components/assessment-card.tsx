"use client";

import type { ArtifactPartProps, AssessmentEvaluationV1, AssessmentSpecV1 } from "@/src/core";
import { sumAssessmentPoints } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";

export function AssessmentCommitment({ spec }: { spec: AssessmentSpecV1 }) {
	return <div className="space-y-3 text-sm" data-testid="assessment-commitment">{spec.parts.map(p => <section key={p.id}>
		<strong>{p.label ?? p.id}</strong>
		<ToolContentResponse>{p.prompt}</ToolContentResponse>
		{p.kind === "structured" && <div className="text-xs text-muted-foreground">Fields: {p.fields.map(field => field.label).join(", ")}</div>}
		{p.kind === "code" && <div className="text-xs text-muted-foreground">Python · {p.tests.length} test{p.tests.length === 1 ? "" : "s"}</div>}
		{p.criteria.map(c => <div key={c.id} className="my-2 border-l pl-3">
			<div>{c.description} · {c.maxPoints} pts</div>
			<ToolContentResponse>{c.expectedEvidence}</ToolContentResponse>
		</div>)}
	</section>)}</div>;
}

export function AssessmentFeedback({ evaluation: e }: { evaluation: AssessmentEvaluationV1 }) {
	return <div className="space-y-3 rounded-xl border bg-card p-4 text-sm" data-testid="assessment-feedback">
		<strong>{e.provenance === "modelJudged" ? "AI-evaluated" : e.provenance === "clientExecuted" ? "Ran your code in the browser." : "Auto-graded"}</strong>
		{e.spec.parts.map(p => <section key={p.id}>
			<strong>{p.label ?? p.id}</strong>
			{p.criteria.map(c => {
				const a = e.criteria.find(a => a.criterionId === c.id)!;
				return <div key={c.id} className="my-2 border-l pl-3">
					<div>{c.description}: {a.award ?? "Unassessed"}/{a.maxPoints} · {a.outcome}</div>
					<ToolContentResponse>{a.feedback}</ToolContentResponse>
				</div>;
			})}
		</section>)}
		<div className="font-semibold">{e.totals.complete ? `${e.totals.awarded}/${e.totals.max}` : `${e.totals.awarded}/${e.totals.assessedMax} assessed, ${sumAssessmentPoints([e.totals.max, -e.totals.assessedMax])} pts unassessed, incomplete (${e.totals.assessedCount}/${e.totals.criterionCount} criteria)`}</div>
		{e.summary && <ToolContentResponse>{e.summary}</ToolContentResponse>}
	</div>;
}

export function EvaluationCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const e = part.output as AssessmentEvaluationV1 | undefined;
	if (e?.version !== 1 || !e.spec || !e.totals) return null;
	return <AssessmentFeedback evaluation={e} />;
}
