import type { CriterionOutcome } from "./assessment.ts";
import type { LearningTargetRef } from "./learning-target.ts";

export const FAMILIARITY_LEVELS = ["unfamiliar", "seen", "practiced", "confident"] as const;
export type FamiliarityLevel = typeof FAMILIARITY_LEVELS[number];

export const LEARNER_LIMITS = {
	bodyBytes: 1024 * 1024,
	backgroundChars: 8000,
	courseworkChars: 8000,
	topics: 200,
	topicChars: 200,
	topicNoteChars: 1000,
	excerpts: 50,
	excerptBytes: 64 * 1024,
	sourceNameChars: 255,
	associations: 2000,
} as const;

export interface LearnerTopicClaim {
	id: string;
	topic: string;
	familiarity: FamiliarityLevel;
	note?: string;
	updatedAt: string;
}

export interface LearnerProfileExcerpt {
	id: string;
	sourceName: string;
	text: string;
	importedAt: string;
}

export interface LearnerEvidenceAssociation {
	evidenceId: string;
	target: LearningTargetRef;
	attachedAt: string;
}

export interface LearnerProfileV1 {
	version: 1;
	revision: number;
	updatedAt: string;
	background: string;
	coursework: string;
	topics: LearnerTopicClaim[];
	excerpts: LearnerProfileExcerpt[];
	associations: LearnerEvidenceAssociation[];
}

export type LearnerProfileRead =
	| { state: "absent"; profile: LearnerProfileV1 }
	| { state: "ok"; profile: LearnerProfileV1 }
	| { state: "corrupt" }
	| { state: "future"; version: number };

export type ObservationProvenance = "deterministic" | "modelJudged" | "modelAuthored" | "legacyClientGraded";

export type LearnerObservation = {
	id: string;
	chatId: string;
	chatTitle: string;
	chatKind: "teach" | "practice";
	resultMessageId: string;
	sourceCallId: string;
	observedAt: string;
	prompt: string;
	provenance: ObservationProvenance;
	targets: LearningTargetRef[];
	/** The session target, when the tutor marked this check `onTarget` in a
	 *  session started from that target. Distinct from learner-made links. */
	attributedTarget?: LearningTargetRef;
} & (
	| { kind: "choice"; outcome: "correct" | "incorrect" | "dontKnow"; tool: string }
	| {
			kind: "criterion";
			criterionId: string;
			partId: string;
			outcome: CriterionOutcome;
			award: number | null;
			maxPoints: number;
			feedback: string;
			evaluationId: string;
			responseId: string;
	  }
	| {
			kind: "practiceConclusion";
			outcome: "solved" | "solvedWithHints" | "movedOn" | "surrendered";
			rung: string | null;
			missClass: string | null;
			verdict: string;
	  }
);
