"use client";

import { useState } from "react";
import { SubjectMapDraftEditor } from "@/components/subject-map-editor";
import { SetupDialog } from "@/components/setup-dialog";
import { diffSubjectMaps, groupSubjectMapSkills, subjectMapDefinitionProblems, type SubjectMapDefinition, type SubjectMapV1, type SubjectSkill } from "@/src/core";

const suggestions = ["AP Physics 1", "AP Physics C: Mechanics", "AP Calculus BC", "IB Philosophy", "JLPT N5", "JLPT N4", "CEFR A1–B2 Japanese", "CEFR A1–B2 Spanish", "Typical university Operating Systems course"];
const FIELD = "rounded-sm border border-border bg-background px-2 py-1.5 text-sm";
const BUTTON = "rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

function sourceBadge(skill: SubjectSkill) {
	const source = skill.source;
	if (source?.kind === "syllabus") return <span title={source.quote}>From your syllabus</span>;
	if (source?.kind === "framework") return <span>Typical of {source.framework} (AI knowledge, not checked against the official document)</span>;
	if (source?.kind === "aiGapFill") return <span title={source.reason}>AI-added</span>;
	return <span>Manual</span>;
}

export function SubjectMapDraft({ previous, onSaved }: { previous?: SubjectMapV1; onSaved?: (map: SubjectMapV1) => void }) {
	const [open, setOpen] = useState(false);
	const [goal, setGoal] = useState("");
	const [framework, setFramework] = useState("");
	const [instruction, setInstruction] = useState("");
	const [syllabus, setSyllabus] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [draft, setDraft] = useState<SubjectMapDefinition | null>(null);
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refusal, setRefusal] = useState(false);
	const [setupOpen, setSetupOpen] = useState(false);
	const [issues, setIssues] = useState<string[]>([]);
	const [base, setBase] = useState(previous);
	const discard = () => { setDraft(null); setEditing(false); setOpen(false); setError(null); setIssues([]); };
	const generate = async () => {
		setBusy(true); setError(null); setRefusal(false); setIssues([]); setBase(previous);
		try {
			const input = previous ? { instruction } : { goal, framework };
			let body: BodyInit;
			let headers: HeadersInit | undefined;
			if (file) {
				const form = new FormData();
				for (const [name, value] of Object.entries(input)) form.set(name, value);
				form.set("files", file);
				body = form;
			} else {
				body = JSON.stringify({ ...input, ...(syllabus.trim() ? { syllabus: { name: "Pasted syllabus", text: syllabus } } : {}) });
				headers = { "content-type": "application/json" };
			}
			const response = await fetch(previous ? `/api/subject-maps/${encodeURIComponent(previous.id)}/drafts` : "/api/subject-maps/drafts", { method: "POST", headers, body });
			const result = await response.json();
			if (!response.ok) {
				setRefusal(result.code === "models_not_configured" || result.code === "provider_key_missing");
				setIssues(result.issues ?? []);
				throw new Error(result.error ?? "Unable to draft map.");
			}
			setDraft(result.draft);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to draft map."); }
		finally { setBusy(false); }
	};
	const accept = async () => {
		if (!draft) return;
		setBusy(true); setError(null);
		try {
			const response = await fetch(base ? `/api/maps/${encodeURIComponent(base.id)}` : "/api/maps", {
				method: base ? "PUT" : "POST", headers: { "content-type": "application/json", ...(base ? { "if-match": `"${base.revision}"` } : {}) }, body: JSON.stringify({ definition: draft }),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(response.status === 412 ? "This map changed elsewhere. Discard this draft and reload before refining again." : result.error ?? "Unable to save draft.");
			discard();
			if (onSaved) onSaved(result.map); else window.location.assign(`/maps/${encodeURIComponent(result.map.id)}`);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save draft."); }
		finally { setBusy(false); }
	};
	if (!open) return <button type="button" className={BUTTON} onClick={() => setOpen(true)}>{previous ? "Refine with AI" : "Draft with AI"}</button>;
	const validation = draft ? subjectMapDefinitionProblems(draft) : [];
	const diff = draft && base ? diffSubjectMaps(base, draft) : null;
	return <section aria-label="Draft with AI" className="flex flex-col gap-3 rounded-sm border border-border p-3">
		<h2>{previous ? "Refine with AI" : "Draft with AI"}</h2>
		<p className="text-xs text-muted-foreground">AI drafts describe a subject, not what you know. Nothing is saved until you accept.</p>
		{error && <p role="alert">{error} {refusal && <button type="button" className="underline" onClick={() => setSetupOpen(true)}>Set up models and provider keys</button>}</p>}
		<SetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} onDone={() => setSetupOpen(false)} />
		{issues.length > 0 && <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
		{!draft ? <>
			{previous ? <><label htmlFor="map-draft-instruction">Refinement instruction</label><textarea id="map-draft-instruction" className={FIELD} maxLength={1000} value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)} /></> : <>
				<label htmlFor="map-draft-goal">Goal</label><textarea id="map-draft-goal" className={FIELD} maxLength={500} value={goal} onChange={(event) => setGoal(event.currentTarget.value)} />
				<label htmlFor="map-draft-framework">Framework (free text allowed)</label><input id="map-draft-framework" className={FIELD} list="map-framework-suggestions" maxLength={200} value={framework} onChange={(event) => setFramework(event.currentTarget.value)} />
				<datalist id="map-framework-suggestions">{suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}</datalist>
			</>}
			<label htmlFor="map-draft-syllabus">Paste syllabus</label><textarea id="map-draft-syllabus" className={FIELD} value={syllabus} disabled={!!file} onChange={(event) => setSyllabus(event.currentTarget.value)} />
			<label htmlFor="map-draft-file">Or upload syllabus (.txt, .md, .markdown; PDF in local mode only)</label><input id="map-draft-file" type="file" accept=".txt,.md,.markdown,.pdf" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} />
			<button type="button" className={BUTTON} disabled={busy || (previous ? !instruction.trim() : !goal.trim() && !framework.trim() && !syllabus.trim() && !file)} onClick={() => void generate()}>{busy ? "Drafting…" : "Generate draft"}</button>
			<button type="button" className={BUTTON} disabled={busy} onClick={discard}>Discard</button>
		</> : editing ? <SubjectMapDraftEditor definition={draft} onReview={(edited) => { setDraft(edited); setEditing(false); }} onDiscard={discard} /> : <div aria-label="Draft review" className="flex flex-col gap-3">
			<h3>{draft.title}</h3><p>{draft.description}</p>
			<p role="status">{validation.length ? `Validation failed: ${validation.join("; ")}` : "Validation passed. Ready for your review."}</p>
			{groupSubjectMapSkills(draft).map((group) => <section key={group.id ?? "ungrouped"}><h4>{group.title}</h4><ul>{group.skills.map((skill) => <li key={skill.id}><strong>{skill.title}</strong>: {skill.objective} · {sourceBadge(skill)}</li>)}</ul></section>)}
			<h4>Prerequisite edges</h4><ul>{draft.edges.map((edge) => <li key={`${edge.prerequisite}-${edge.dependent}`}>{edge.prerequisite} → {edge.dependent}</li>)}</ul>
			{diff && <section aria-label="Refinement diff"><h4>Changes</h4><p>Added: {diff.added.map((s) => s.id).join(", ") || "none"}</p><p>Removed: {diff.removed.map((s) => s.id).join(", ") || "none"}</p><p>Changed: {diff.changed.map((s) => s.id).join(", ") || "none"}</p><p>Added edges: {diff.addedEdges.map((e) => `${e.prerequisite} → ${e.dependent}`).join(", ") || "none"}</p><p>Removed edges: {diff.removedEdges.map((e) => `${e.prerequisite} → ${e.dependent}`).join(", ") || "none"}</p></section>}
			<button type="button" className={BUTTON} disabled={busy || validation.length > 0} onClick={() => void accept()}>Accept</button>
			<button type="button" className={BUTTON} disabled={busy} onClick={() => setEditing(true)}>Edit before saving</button>
			<button type="button" className={BUTTON} disabled={busy} onClick={discard}>Discard</button>
		</div>}
	</section>;
}
