/**
 * Subject reference maps — learner-authored prerequisite DAGs of skills.
 *
 * Deliberately separate from the proposition graph (contracts/graph.ts)
 * and session plan trees (contracts/plan.ts): a map states what a subject
 * asks of the learner, never what the learner knows. Learner knowledge
 * stays in canonical chat results (derived observations) and in the
 * learner profile's explicit evidence associations.
 */

export const SUBJECT_MAP_LIMITS = {
	bodyBytes: 1024 * 1024,
	jsonDepth: 8,
	maps: 100,
	skills: 500,
	regions: 50,
	quoteChars: 500,
	reasonChars: 500,
	edges: 2000,
	retired: 2000,
	links: 2000,
	idChars: 128,
	titleChars: 200,
	descriptionChars: 4000,
	objectiveChars: 2000,
} as const;

export const SUBJECT_MAP_FORMAT = "learnharness.subject-map" as const;

export interface SubjectRegion {
	id: string;
	title: string;
	description: string;
}

export type SkillSource =
	| { kind: "syllabus"; sourceName: string; quote: string }
	| { kind: "framework"; framework: string }
	| { kind: "aiGapFill"; reason: string }
	| { kind: "manual" };

export interface SubjectSkill {
	/** Stable author-chosen id; never reused once retired. */
	id: string;
	title: string;
	/** What demonstrating the skill means. Changing it bumps `revision`. */
	objective: string;
	/** Objective revision (≥1). Evidence linked at an older revision is historical. */
	revision: number;
	regionId?: string;
	source?: SkillSource;
}

/** `prerequisite` must be learned before `dependent`. */
export interface SubjectEdge {
	prerequisite: string;
	dependent: string;
}

/** Tombstone for a removed skill id: blocks reuse and keeps old links resolvable as retired. */
export interface RetiredSubjectSkill {
	id: string;
	revision: number;
	title: string;
	retiredAt: string;
}

export interface SubjectPropositionLink {
	skillId: string;
	nodeId: string;
	linkedAt: string;
}

export interface SubjectTopicLink {
	skillId: string;
	topicId: string;
	linkedAt: string;
}

/** Learner-specific links; never part of a portable export. */
export interface SubjectMapLinks {
	propositions: SubjectPropositionLink[];
	topics: SubjectTopicLink[];
}

export interface SubjectMapDefinition {
	regions?: SubjectRegion[];
	title: string;
	description: string;
	skills: SubjectSkill[];
	edges: SubjectEdge[];
	goals: string[];
	retired: RetiredSubjectSkill[];
}

export interface SubjectMapV1 extends SubjectMapDefinition {
	version: 1;
	id: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	links: SubjectMapLinks;
}

export type SubjectMapRead =
	| { state: "absent" }
	| { state: "ok"; map: SubjectMapV1 }
	| { state: "corrupt" }
	| { state: "future"; version: number };

export type SubjectMapSummary =
	| {
			id: string;
			state: "ok";
			title: string;
			revision: number;
			updatedAt: string;
			skills: number;
			goals: number;
	  }
	| { id: string; state: "corrupt" | "future" };

/** The versioned curriculum JSON a map imports from and exports to. */
export interface PortableSubjectMapV1 {
	regions?: SubjectRegion[];
	format: typeof SUBJECT_MAP_FORMAT;
	version: 1;
	title: string;
	description: string;
	skills: SubjectSkill[];
	edges: SubjectEdge[];
	goals: string[];
	retired: { id: string; revision: number; title: string }[];
}

/** The three independent axes are never folded into one score. */
export type SkillEvidenceStatus =
	| "notChecked"
	| "supporting"
	| "needsPractice"
	| "mixed"
	| "inconclusive"
	| "unavailable";

export type EvidencePolarity = "supports" | "against" | "inconclusive";
