import type { SubjectSkill } from "@/src/core";

export function SkillSourceBadge({ skill }: { skill: SubjectSkill }) {
	const source = skill.source;
	if (source?.kind === "syllabus") return <span title={source.quote}>From your syllabus</span>;
	if (source?.kind === "framework") return <span>Typical of {source.framework} (AI knowledge, not checked against the official document)</span>;
	if (source?.kind === "aiGapFill") return <span title={source.reason}>AI-added</span>;
	return <span>Manual</span>;
}
