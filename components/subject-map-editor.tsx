"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionStarter } from "@/components/start-session";
import { SubjectMapDraft } from "@/components/subject-map-draft";
import { FamiliaritySuggestions } from "@/components/familiarity-suggestions";
import type { FamiliarityListing } from "@/components/familiarity-suggestions";
import { SubjectMapWorld } from "@/components/subject-map-world";
import { savedSlotsConfigured, selectedModelUnavailable } from "@/components/setup-cta";
import type { ModelCatalogResponse } from "@/src/core";
import {
	SUBJECT_MAP_LIMITS,
	skillEvidenceStatusLabel,
	subjectMapDefinitionProblems,
	topologicalSkillOrder,
	type LearnerObservation,
	type LearnerTopicClaim,
	type SkillEvidenceStatus,
	type SubjectEdge,
	type SubjectAlternative,
	type SubjectEvidenceItem,
	type SubjectMapGapView,
	type SubjectMapV1,
	type SubjectSkillView,
	type SubjectMapDefinition,
	type SubjectRegion,
	type SkillSource,
} from "@/src/core";

type DraftSkill = { key: string; id: string; title: string; objective: string; isNew: boolean; regionId?: string; source?: SkillSource; keystone?: true };
interface Draft {
	regions?: SubjectRegion[];
	alternatives?: SubjectAlternative[];
	title: string;
	description: string;
	skills: DraftSkill[];
	edges: SubjectEdge[];
	goals: string[];
}

const BUTTON = "rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50";
const LINK_BUTTON = "text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50";
const FIELD = "w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm";

/** Non-color glyphs so every status reads without color. */
const STATUS_GLYPH: Record<SkillEvidenceStatus, string> = {
	notChecked: "○",
	supporting: "✓",
	needsPractice: "!",
	mixed: "±",
	inconclusive: "?",
	unavailable: "⚠",
};

function draftOf(map: SubjectMapDefinition): Draft {
	return {
		...(map.regions === undefined ? {} : { regions: map.regions }),
		...(map.alternatives === undefined ? {} : { alternatives: map.alternatives.map((group) => ({ dependent: group.dependent, options: [...group.options] })) }),
		title: map.title,
		description: map.description,
		skills: map.skills.map((skill) => ({ ...skill, key: skill.id, isNew: false })),
		edges: map.edges.map((edge) => ({ ...edge })),
		goals: [...map.goals],
	};
}

function definitionOf(draft: Draft) {
	return {
		...(draft.regions === undefined ? {} : { regions: draft.regions }),
		...(draft.alternatives === undefined ? {} : { alternatives: draft.alternatives.map((group) => ({ dependent: group.dependent, options: [...group.options] })) }),
		title: draft.title,
		description: draft.description,
		skills: draft.skills.map(({ id, title, objective, regionId, source, keystone }) => ({ id, title, objective, ...(regionId === undefined ? {} : { regionId }), ...(source === undefined ? {} : { source }), ...(keystone === true ? { keystone: true as const } : {}) })),
		edges: draft.edges,
		goals: draft.goals,
	};
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	try {
		return await response.json() as Record<string, unknown>;
	} catch {
		return {};
	}
}

function day(value: string): string {
	return value.slice(0, 10);
}

function provenanceLabel(observation: LearnerObservation): string {
	switch (observation.provenance) {
		case "deterministic": return "auto-graded";
		case "modelJudged": return "AI-evaluated";
		case "modelAuthored": return "tutor's practice verdict";
		case "legacyClientGraded": return "legacy, client-graded (unverified)";
	}
}

function observationSummary(observation: LearnerObservation): string {
	const outcome = observation.kind === "criterion"
		? observation.award === null ? "unassessed" : `${observation.outcome} ${observation.award}/${observation.maxPoints}`
		: observation.outcome;
	return `${day(observation.observedAt)} · ${observation.kind} · ${outcome} · ${provenanceLabel(observation)}`;
}

function polarityLabel(item: SubjectEvidenceItem): string {
	if (!item.observation) return "source unavailable";
	switch (item.polarity) {
		case "supports": return "supports";
		case "against": return "needs practice";
		default: return "inconclusive";
	}
}

/** Longest-path layers for the visual overview (prerequisites to the left). */
function layers(map: SubjectMapV1): string[][] {
	const depth = new Map<string, number>();
	const prerequisites = new Map<string, string[]>(map.skills.map((skill) => [skill.id, []]));
	for (const edge of map.edges) prerequisites.get(edge.dependent)?.push(edge.prerequisite);
	for (const id of topologicalSkillOrder(map)) {
		depth.set(id, Math.max(0, ...(prerequisites.get(id) ?? []).map((p) => (depth.get(p) ?? 0) + 1)));
	}
	const out: string[][] = [];
	for (const [id, level] of depth) (out[level] ??= []).push(id);
	return out;
}

function MapOverview({ map, view }: { map: SubjectMapV1; view: SubjectMapGapView }) {
	const columns = layers(map);
	if (!columns.length) return null;
	const status = new Map(view.skills.map((skill) => [skill.skill.id, skill]));
	const position = new Map<string, { x: number; y: number }>();
	columns.forEach((column, x) => column.forEach((id, y) => position.set(id, { x: 20 + x * 180, y: 20 + y * 48 })));
	const width = 20 + columns.length * 180;
	const height = 20 + Math.max(...columns.map((column) => column.length)) * 48;
	return (
		<figure className="overflow-x-auto rounded-sm border border-border/60 p-2">
			<svg width={width} height={height} aria-hidden="true" className="text-foreground">
				{map.edges.map((edge) => {
					const from = position.get(edge.prerequisite);
					const to = position.get(edge.dependent);
					if (!from || !to) return null;
					return <line key={`${edge.prerequisite}-${edge.dependent}`} x1={from.x + 150} y1={from.y + 14} x2={to.x} y2={to.y + 14} stroke="currentColor" strokeOpacity={0.35} />;
				})}
				{[...position].map(([id, at]) => {
					const skill = status.get(id);
					if (!skill) return null;
					return (
						<g key={id} transform={`translate(${at.x} ${at.y})`}>
							<rect width={150} height={28} rx={3} fill="none" stroke="currentColor" strokeOpacity={skill.inClosure ? 0.9 : 0.3} strokeDasharray={skill.isGoal ? undefined : skill.inClosure ? "4 2" : "1 3"} />
							<text x={6} y={18} fontSize={11} fill="currentColor">
								{STATUS_GLYPH[skill.evidence.status]} {skill.skill.title.slice(0, 20)}{skill.isGoal ? " ★" : ""}
							</text>
						</g>
					);
				})}
			</svg>
			<figcaption className="mt-1 text-xs text-muted-foreground">
				Overview only. The skill list below is the complete, keyboard-accessible view. ★ goal · solid border goal · dashed border required for a goal.
			</figcaption>
		</figure>
	);
}

interface Sources {
	propositions: { id: string; name: string }[] | null;
	topics: LearnerTopicClaim[] | null;
	observations: LearnerObservation[];
	nextCursor: string | null;
	profileRevision: number | null;
	error: string | null;
}

/** One map: definition editor, goals, prerequisite closure and evidence-distinct gaps. */
export function SubjectMapEditor({ mapId }: { mapId: string }) {
	const [map, setMap] = useState<SubjectMapV1 | null>(null);
	const [view, setView] = useState<SubjectMapGapView | null>(null);
	const [state, setState] = useState<"loading" | "ok" | "missing" | "corrupt" | "future" | "error">("loading");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [serverIssues, setServerIssues] = useState<string[]>([]);
	const [conflict, setConflict] = useState<SubjectMapV1 | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [sources, setSources] = useState<Sources>({ propositions: null, topics: null, observations: [], nextCursor: null, profileRevision: null, error: null });
	const [notice, setNotice] = useState<string | null>(null);
	const keySeq = useRef(0);
	const mounted = useRef(true);
	const starter = useRef(new SessionStarter());
	const starting = useRef(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [startBusy, setStartBusy] = useState(false);
	const [surfaceMode, setSurfaceMode] = useState<"world" | "list">("world");
	const [familiarityListing, setFamiliarityListing] = useState<FamiliarityListing | null>(null);
	const [familiarityError, setFamiliarityError] = useState<string | null>(null);
	const refreshFamiliarity = useCallback(async () => {
		try {
			const response = await fetch(`/api/learner/familiarity?mapId=${encodeURIComponent(mapId)}`, { cache: "no-store" });
			if (!response.ok) throw new Error();
			setFamiliarityListing(await response.json() as FamiliarityListing);
			setFamiliarityError(null);
		} catch {
			setFamiliarityError("Unable to load familiarity suggestions.");
		}
	}, [mapId]);

	/** Same no-orphan rule as the home/draft launchers: check models and keys before any chat exists. */
	const startTargetSession = useCallback(async (skill: { id: string; title: string; objective: string; revision: number }, mode: "teach" | "practice") => {
		if (starting.current || !map) return;
		starting.current = true;
		setStartBusy(true);
		setStartError(null);
		const fail = (message: string) => {
			starting.current = false;
			if (!mounted.current) return;
			setStartBusy(false);
			setStartError(message);
		};
		try {
			const response = await fetch("/api/models", { cache: "no-store" });
			const catalog = response.ok ? (await response.json()) as ModelCatalogResponse : undefined;
			if (!catalog) return fail("Could not check your model setup. Try again.");
			const strong = catalog.slots.strong?.model;
			if (!savedSlotsConfigured(catalog.slots) || !catalog.providers.some((provider) => provider.keyPresent) || selectedModelUnavailable(catalog, strong ? `${strong.provider}:${strong.id}` : undefined)) {
				return fail("Set up your models and a provider key in Settings before starting a session.");
			}
			const path = await starter.current.start({
				title: `${mode === "practice" ? "Practice" : "Help me learn"} "${skill.title}": ${skill.objective}`,
				...(mode === "practice" ? { kind: "practice" as const } : {}),
				target: { mapId: map.id, skillId: skill.id, skillRevision: skill.revision },
			}, fetch);
			window.location.assign(path);
		} catch {
			fail("Could not start a session for this skill. Reload the map and try again.");
		}
	}, [map]);

	const accept = useCallback((next: SubjectMapV1, nextView: SubjectMapGapView | null) => {
		setMap(next);
		if (nextView) setView(nextView);
		setDraft(draftOf(next));
		setDirty(false);
		setConflict(null);
		setServerIssues([]);
		setState("ok");
	}, []);

	const load = useCallback(async () => {
		try {
			const response = await fetch(`/api/maps/${encodeURIComponent(mapId)}`, { cache: "no-store" });
			const body = await readJson(response);
			if (!mounted.current) return;
			if (response.status === 404) return setState("missing");
			if (!response.ok) throw new Error(String(body.error ?? "Unable to load map."));
			if (body.state === "corrupt" || body.state === "future") return setState(body.state);
			accept(body.map as SubjectMapV1, body.view as SubjectMapGapView);
		} catch (cause) {
			if (!mounted.current) return;
			setState("error");
			setError(cause instanceof Error ? cause.message : "Unable to load map.");
		}
	}, [accept, mapId]);

	const loadSources = useCallback(async (cursor?: string) => {
		const errors: string[] = [];
		const evidence = fetch(`/api/learner/evidence?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" })
			.then(async (response) => {
				const body = await readJson(response);
				if (!response.ok) throw new Error();
				return body;
			})
			.catch(() => {
				errors.push("evidence");
				return null;
			});
		const extra = cursor ? Promise.resolve([null, null] as const) : Promise.all([
			fetch("/api/graph", { cache: "no-store" }).then(async (response) => {
				if (!response.ok) throw new Error();
				const body = await readJson(response);
				return (Array.isArray(body.propositions) ? body.propositions : []) as { id: string; name: string }[];
			}).catch(() => {
				errors.push("propositions");
				return null;
			}),
			fetch("/api/learner/profile", { cache: "no-store" }).then(async (response) => {
				const body = await readJson(response);
				if (!response.ok || !body.profile) throw new Error();
				return body.profile as { topics: LearnerTopicClaim[]; revision: number };
			}).catch(() => {
				errors.push("profile topics");
				return null;
			}),
		] as const);
		const [page, [propositions, profile]] = await Promise.all([evidence, extra]);
		if (!mounted.current) return;
		setSources((previous) => ({
			propositions: cursor ? previous.propositions : propositions,
			topics: cursor ? previous.topics : profile?.topics ?? null,
			observations: cursor ? [...previous.observations, ...((page?.observations as LearnerObservation[]) ?? [])] : (page?.observations as LearnerObservation[]) ?? [],
			nextCursor: (page?.nextCursor as string | null) ?? null,
			profileRevision: profile?.revision ?? (typeof page?.profileRevision === "number" ? page.profileRevision : previous.profileRevision),
			error: errors.length ? `Could not load ${errors.join(", ")}.` : null,
		}));
	}, []);

	useEffect(() => {
		mounted.current = true;
		void load();
		void loadSources();
		return () => {
			mounted.current = false;
		};
	}, [load, loadSources]);
	useEffect(() => {
		void refreshFamiliarity();
		const focus = () => void refreshFamiliarity();
		window.addEventListener("focus", focus);
		const timer = familiarityListing?.latestPlacement && !familiarityListing.latestPlacement.completed
			? window.setInterval(() => void refreshFamiliarity(), 5000)
			: undefined;
		return () => { window.removeEventListener("focus", focus); if (timer !== undefined) window.clearInterval(timer); };
	}, [refreshFamiliarity, familiarityListing?.latestPlacement?.completed, familiarityListing?.latestPlacement?.probes.length]);

	const edit = (change: (draft: Draft) => Draft) => {
		setDraft((current) => (current ? change(current) : current));
		setDirty(true);
	};

	const localIssues = useMemo(() => {
		if (!draft || !map) return [];
		return subjectMapDefinitionProblems({ ...definitionOf(draft), retired: map.retired }, { requireRevisions: false });
	}, [draft, map]);

	const save = async () => {
		if (!map || !draft) return;
		setSaving(true);
		setError(null);
		setServerIssues([]);
		try {
			const response = await fetch(`/api/maps/${encodeURIComponent(map.id)}`, {
				method: "PUT",
				headers: { "content-type": "application/json", "if-match": `"${map.revision}"` },
				body: JSON.stringify({ definition: definitionOf(draft) }),
			});
			const body = await readJson(response);
			if (!mounted.current) return;
			if (response.status === 412 && body.current) {
				setConflict(body.current as SubjectMapV1);
				return;
			}
			if (!response.ok) {
				setError(String(body.error ?? "Unable to save map."));
				setServerIssues(Array.isArray(body.issues) ? body.issues.map(String) : []);
				return;
			}
			accept(body.map as SubjectMapV1, body.view as SubjectMapGapView);
			setNotice("Map saved.");
		} finally {
			if (mounted.current) setSaving(false);
		}
	};

	const remove = async () => {
		if (!map) return;
		const response = await fetch(`/api/maps/${encodeURIComponent(map.id)}`, {
			method: "DELETE",
			headers: { "if-match": `"${map.revision}"` },
		});
		const body = await readJson(response);
		if (response.ok) {
			window.location.assign("/maps");
			return;
		}
		setConfirmDelete(false);
		if (response.status === 412 && body.current) setConflict(body.current as SubjectMapV1);
		else setError(String(body.error ?? "Unable to delete map."));
	};

	const changeLink = async (method: "POST" | "DELETE", kind: "proposition" | "topic", skillId: string, refId: string) => {
		if (!map) return;
		setError(null);
		const response = await fetch(`/api/maps/${encodeURIComponent(map.id)}/links`, {
			method,
			headers: { "content-type": "application/json", "if-match": `"${map.revision}"` },
			body: JSON.stringify({ kind, skillId, refId }),
		});
		const body = await readJson(response);
		if (!mounted.current) return;
		if (response.ok) return accept(body.map as SubjectMapV1, body.view as SubjectMapGapView);
		if (response.status === 412) {
			setNotice("The map changed elsewhere; reloaded the latest version. Try again.");
			return void load();
		}
		setError(String(body.error ?? "Unable to update link."));
	};

	const changeEvidence = async (method: "POST" | "DELETE", evidenceId: string, payload: Record<string, unknown>) => {
		if (sources.profileRevision === null) {
			setError("The learner profile is unavailable, so evidence links cannot change.");
			return;
		}
		setError(null);
		const response = await fetch(`/api/learner/evidence/${encodeURIComponent(evidenceId)}/targets`, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...payload, expectedRevision: sources.profileRevision }),
		});
		const body = await readJson(response);
		if (!mounted.current) return;
		if (response.ok) {
			const profile = body.profile as { revision: number; topics: LearnerTopicClaim[] };
			setSources((previous) => ({ ...previous, profileRevision: profile.revision, topics: profile.topics }));
			return void load();
		}
		if (response.status === 409 && body.code === "skill_revision_conflict") {
			setNotice("The skill objective changed elsewhere; reloaded the latest version. Review it and try again.");
			return void load();
		}
		if (body.code === "revision_conflict") {
			setNotice("Your learner profile changed elsewhere; reloaded it. Try again.");
			return void loadSources();
		}
		setError(String(body.error ?? "Unable to update evidence link."));
	};

	if (state === "loading") return <main className="px-6 py-8 text-sm text-muted-foreground">Loading map…</main>;
	if (state === "missing") return <main className="px-6 py-8 text-sm">This map does not exist or was deleted. <Link href="/maps" className="underline">All maps</Link></main>;
	if (state === "corrupt" || state === "future") {
		return (
			<main className="px-6 py-8 text-sm">
				{state === "future" ? "This map was saved by a newer app version." : "This map file is unreadable."} It has been left untouched and cannot be edited here.{" "}
				<Link href="/maps" className="underline">All maps</Link>
			</main>
		);
	}
	if (state === "error" || !map || !draft || !view) return <main role="alert" className="px-6 py-8 text-sm text-destructive">{error ?? "Unable to load map."}</main>;

	const titleOf = (id: string) => map.skills.find((skill) => skill.id === id)?.title ?? id;
	const pathText = (path: string[]) => path.map(titleOf).join(" → ");
	const viewById = new Map(view.skills.map((skill) => [skill.skill.id, skill]));
	const linkingBlocked = dirty;

	return (
		<main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex flex-col gap-1">
					<Link href="/maps" className="text-xs text-muted-foreground underline underline-offset-2">All maps</Link>
					<h1 className="text-lg font-medium">{map.title}</h1>
					<p className="text-xs text-muted-foreground">Revision {map.revision} · updated {day(map.updatedAt)}</p>
				</div>
				<div className="flex gap-2">
					<button type="button" disabled={startBusy} onClick={async () => {
						if (!map || starting.current) return;
						starting.current = true;
						setStartBusy(true);
						setStartError(null);
						try {
							const path = await starter.current.start({ title: `Find my level: ${map.title}`, placement: { mapId: map.id } }, fetch);
							window.location.assign(path);
						} catch (cause) {
							setStartError(cause instanceof Error ? cause.message : "Unable to start placement.");
						} finally {
							starting.current = false;
							setStartBusy(false);
						}
					}} className={BUTTON}>Find my level</button>
					<a href={`/api/maps/${encodeURIComponent(map.id)}/export`} download={`${map.id}.json`} className={BUTTON}>Export curriculum JSON</a>
					{confirmDelete ? (
						<>
							<button type="button" onClick={() => void remove()} className={BUTTON}>Confirm delete</button>
							<button type="button" onClick={() => setConfirmDelete(false)} className={BUTTON}>Keep map</button>
						</>
					) : (
						<button type="button" onClick={() => setConfirmDelete(true)} className={BUTTON}>Delete map</button>
					)}
				</div>
			</header>
			{startError && <p role="alert" className="text-xs text-destructive">{startError}</p>}
			<FamiliaritySuggestions mapId={map.id} sharedListing={familiarityListing} sharedError={familiarityError} onRefresh={refreshFamiliarity} />

			{notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
			{dirty ? <div>
				<button type="button" disabled className={BUTTON}>Refine with AI</button>
				<p className="text-xs text-muted-foreground">Save or discard your edits before refining with AI.</p>
			</div> : <SubjectMapDraft previous={map} onSaved={() => void load()} />}
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			{conflict && (
				<div role="alert" className="flex flex-col gap-2 rounded-sm border border-destructive/60 p-3 text-sm">
					<p>This map changed elsewhere (now revision {conflict.revision}). Your edits were not saved.</p>
					<button type="button" onClick={() => void load()} className={`self-start ${BUTTON}`}>Load latest and discard my edits</button>
				</div>
			)}

			<div role="group" aria-label="Map view" className="flex gap-2">
				<button type="button" aria-pressed={surfaceMode === "world"} onClick={() => setSurfaceMode("world")} className={BUTTON}>World map</button>
				<button type="button" aria-pressed={surfaceMode === "list"} onClick={() => setSurfaceMode("list")} className={BUTTON}>List and editor</button>
			</div>

			{surfaceMode === "world" ? (
				<>
					{dirty && <p className="text-xs text-muted-foreground">World map shows the saved map; you have unsaved edits in the list view.</p>}
					<SubjectMapWorld map={map} view={view} likelyKnown={new Set(familiarityListing?.likelyKnownSkillIds ?? [])} latestPlacement={familiarityListing?.latestPlacement ?? null} onStart={(skill) => void startTargetSession(skill, "teach")} startBusy={startBusy} startError={startError} />
				</>
			) : <>
			<section aria-labelledby="map-goals-heading" className="flex flex-col gap-3">
				<h2 id="map-goals-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Goals and gaps</h2>
				{view.evidenceAvailability === "unavailable" && (
					<p role="status" className="text-xs">⚠ The learner profile is unreadable, so evidence links are unavailable — this is not the same as no evidence.</p>
				)}
				{view.evidenceAvailability === "partial" && (
					<p role="status" className="text-xs">⚠ Some linked evidence comes from deleted or unreadable sessions and is shown as unavailable.</p>
				)}
				{view.goals.length === 0 ? (
					<p className="text-xs text-muted-foreground">Choose one or more goal skills below to see what they require.</p>
				) : view.gaps.length === 0 ? (
					<p className="text-sm">Every skill required for your goals has supporting linked evidence. This is not a mastery score.</p>
				) : (
					<ol aria-label="Gaps toward your goals" className="flex flex-col gap-2">
						{view.gaps.map((gap) => (
							<li key={gap.skillId} className="rounded-sm border border-border/60 px-3 py-2 text-sm">
								<p>
									<span aria-hidden="true">{STATUS_GLYPH[gap.status]} </span>
									<strong>{titleOf(gap.skillId)}</strong> — {skillEvidenceStatusLabel(gap.status)}
								</p>
								{gap.paths.map((path) => (
									<p key={path.goalId} className="text-xs text-muted-foreground">
										{path.path.length === 1 ? "This is a goal." : `Needed for ${titleOf(path.goalId)}: ${pathText(path.path)}`}
									</p>
								))}
							</li>
						))}
					</ol>
				)}
				<MapOverview map={map} view={view} />
			</section>

			<section aria-labelledby="map-skills-heading" className="flex flex-col gap-3 border-t border-border/60 pt-4">
				<div className="flex items-center justify-between">
					<h2 id="map-skills-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Skills</h2>
					<span className="text-xs text-muted-foreground">{draft.skills.length}/{SUBJECT_MAP_LIMITS.skills} skills · {draft.edges.length}/{SUBJECT_MAP_LIMITS.edges} prerequisite links</span>
				</div>
				<label htmlFor="map-title" className="text-xs text-muted-foreground">Map title</label>
				<input id="map-title" value={draft.title} maxLength={SUBJECT_MAP_LIMITS.titleChars} onChange={(event) => { const value = event.currentTarget.value; edit((d) => ({ ...d, title: value })); }} className={FIELD} />
				<label htmlFor="map-description" className="text-xs text-muted-foreground">Description</label>
				<textarea id="map-description" value={draft.description} rows={2} maxLength={SUBJECT_MAP_LIMITS.descriptionChars} onChange={(event) => { const value = event.currentTarget.value; edit((d) => ({ ...d, description: value })); }} className={FIELD} />
				{linkingBlocked && <p className="text-xs text-muted-foreground">Save or discard your edits before changing links.</p>}
				<ul className="flex flex-col gap-3">
					{draft.skills.map((skill, index) => (
						<SkillRow
							key={skill.key}
							skill={skill}
							index={index}
							draft={draft}
							saved={viewById.get(skill.id)}
							titleOf={titleOf}
							pathText={pathText}
							sources={sources}
							linkingBlocked={linkingBlocked}
							onEdit={edit}
							onLink={(kind, refId) => void changeLink("POST", kind, skill.id, refId)}
							onUnlink={(kind, refId) => void changeLink("DELETE", kind, skill.id, refId)}
							onAttachEvidence={(evidenceId) => void changeEvidence("POST", evidenceId, { mapId: map.id, skillId: skill.id, skillRevision: map.skills.find((saved) => saved.id === skill.id)?.revision })}
							onDetachEvidence={(item) => void changeEvidence("DELETE", item.evidenceId, {
								target: { kind: "subject-skill", mapId: map.id, skillId: skill.id, skillRevision: item.skillRevision },
							})}
							onStart={dirty || startBusy ? undefined : (() => {
								const savedSkill = map.skills.find((candidate) => candidate.id === skill.id);
								return savedSkill ? (mode: "teach" | "practice") => void startTargetSession(savedSkill, mode) : undefined;
							})()}
						/>
					))}
				</ul>
				{sources.nextCursor && (
					<button type="button" onClick={() => void loadSources(sources.nextCursor ?? undefined)} className={`self-start ${BUTTON}`}>Load more evidence to link</button>
				)}
				{sources.error && <p className="text-xs text-muted-foreground">{sources.error}</p>}
				{startError && <p role="alert" className="text-xs text-destructive">{startError}</p>}
				<button
					type="button"
					disabled={draft.skills.length >= SUBJECT_MAP_LIMITS.skills}
					onClick={() => edit((d) => ({ ...d, skills: [...d.skills, { key: `new-${++keySeq.current}`, id: "", title: "", objective: "", isNew: true }] }))}
					className={`self-start ${BUTTON}`}
				>
					Add skill
				</button>
				{map.retired.length > 0 && (
					<p className="text-xs text-muted-foreground">Retired ids (cannot be reused): {map.retired.map((skill) => skill.id).join(", ")}</p>
				)}
			</section>

			<div className="sticky bottom-0 flex flex-col gap-2 border-t border-border/60 bg-background py-3">
				{[...localIssues, ...serverIssues].length > 0 && (
					<ul aria-label="Problems to fix before saving" className="list-disc pl-5 text-xs text-destructive">
						{[...new Set([...localIssues, ...serverIssues])].map((issue) => <li key={issue}>{issue}</li>)}
					</ul>
				)}
				<div className="flex gap-2">
					<button type="button" onClick={() => void save()} disabled={!dirty || saving || localIssues.length > 0 || !!conflict} className={BUTTON}>
						{saving ? "Saving…" : "Save map"}
					</button>
					<button type="button" onClick={() => accept(map, null)} disabled={!dirty || saving} className={BUTTON}>Discard edits</button>
				</div>
			</div>
			</>}
		</main>
	);
}

export function SubjectMapDraftEditor({ definition, onReview, onDiscard }: { definition: SubjectMapDefinition; onReview: (definition: SubjectMapDefinition) => void; onDiscard: () => void }) {
	const [draft, setDraft] = useState(() => draftOf(definition));
	const sequence = useRef(0);
	const edit = (change: (draft: Draft) => Draft) => setDraft(change);
	const candidate = { ...definitionOf(draft), retired: definition.retired };
	const problems = subjectMapDefinitionProblems(candidate, { requireRevisions: false });
	const sources: Sources = { propositions: [], topics: [], observations: [], nextCursor: null, profileRevision: null, error: null };
	return <section aria-label="Edit draft" className="flex flex-col gap-3">
		<h3>Edit before saving</h3>
		<label htmlFor="draft-map-title">Map title</label>
		<input id="draft-map-title" value={draft.title} className={FIELD} onChange={(event) => { const title = event.currentTarget.value; edit((d) => ({ ...d, title })); }} />
		<label htmlFor="draft-map-description">Description</label>
		<textarea id="draft-map-description" value={draft.description} className={FIELD} onChange={(event) => { const description = event.currentTarget.value; edit((d) => ({ ...d, description })); }} />
		<ul>{draft.skills.map((skill, index) => <SkillRow key={skill.key} skill={skill} index={index} draft={draft} saved={undefined} titleOf={(id) => draft.skills.find((s) => s.id === id)?.title ?? id} pathText={(path) => path.join(" → ")} sources={sources} linkingBlocked onEdit={edit} onLink={() => {}} onUnlink={() => {}} onAttachEvidence={() => {}} onDetachEvidence={() => {}} />)}</ul>
		<button type="button" className={BUTTON} onClick={() => edit((d) => ({ ...d, skills: [...d.skills, { key: `new-${++sequence.current}`, id: "", title: "", objective: "", isNew: true }] }))}>Add skill</button>
		{problems.length > 0 && <ul aria-label="Draft validation problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
		<button type="button" className={BUTTON} disabled={problems.length > 0} onClick={() => onReview({ ...candidate, skills: candidate.skills.map((skill) => ({ ...skill, revision: definition.skills.find((original) => original.id === skill.id)?.revision ?? 1 })) })}>Review edited draft</button>
		<button type="button" className={BUTTON} onClick={onDiscard}>Discard</button>
	</section>;
}

interface SkillRowProps {
	skill: DraftSkill;
	index: number;
	draft: Draft;
	saved: SubjectSkillView | undefined;
	titleOf: (id: string) => string;
	pathText: (path: string[]) => string;
	sources: Sources;
	linkingBlocked: boolean;
	onEdit: (change: (draft: Draft) => Draft) => void;
	onLink: (kind: "proposition" | "topic", refId: string) => void;
	onUnlink: (kind: "proposition" | "topic", refId: string) => void;
	onAttachEvidence: (evidenceId: string) => void;
	onDetachEvidence: (item: SubjectEvidenceItem) => void;
	/** Present only for a saved skill with no unsaved edits. */
	onStart?: (mode: "teach" | "practice") => void;
}

function SkillRow({ skill, index, draft, saved, titleOf, pathText, sources, linkingBlocked, onEdit, onLink, onUnlink, onAttachEvidence, onDetachEvidence, onStart }: SkillRowProps) {
	const [prerequisiteChoice, setPrerequisiteChoice] = useState("");
	const [propositionChoice, setPropositionChoice] = useState("");
	const [topicChoice, setTopicChoice] = useState("");
	const [evidenceChoice, setEvidenceChoice] = useState("");
	const base = `map-skill-${skill.key}`;
	const prerequisites = draft.edges.filter((edge) => edge.dependent === skill.id).map((edge) => edge.prerequisite);
	const candidates = draft.skills.filter((other) => other.id && other.id !== skill.id && !prerequisites.includes(other.id));
	const isGoal = draft.goals.includes(skill.id);
	const alternativeGroups = (draft.alternatives ?? []).map((group, groupIndex) => ({ group, groupIndex })).filter(({ group }) => group.dependent === skill.id);
	const update = (patch: Partial<DraftSkill>) => onEdit((d) => {
		const previousId = d.skills[index]!.id;
		const skills = d.skills.map((item, i) => (i === index ? { ...item, ...patch } : item));
		if (patch.id === undefined || patch.id === previousId) return { ...d, skills };
		const rename = (id: string) => (id === previousId ? patch.id! : id);
		return {
			...d,
			skills,
			edges: d.edges.map((edge) => ({ prerequisite: rename(edge.prerequisite), dependent: rename(edge.dependent) })),
			...(d.alternatives === undefined ? {} : {
				alternatives: d.alternatives.map((group) => ({ dependent: rename(group.dependent), options: group.options.map(rename) })),
			}),
			goals: d.goals.map(rename),
		};
	});
	const removeSkill = () => onEdit((d) => {
		const edges = d.edges.filter((edge) => edge.prerequisite !== skill.id && edge.dependent !== skill.id);
		const alternatives: SubjectAlternative[] = [];
		const alternativeKeys = new Set<string>();
		for (const group of d.alternatives ?? []) {
			if (group.dependent === skill.id) continue;
			const options = group.options.filter((option) => option !== skill.id);
			if (options.length >= SUBJECT_MAP_LIMITS.alternativeOptionsMin) {
				const reduced = { dependent: group.dependent, options };
				const key = JSON.stringify([reduced.dependent, [...reduced.options].sort()]);
				if (!alternativeKeys.has(key)) {
					alternatives.push(reduced);
					alternativeKeys.add(key);
				}
			} else if (options.length === 1 && !edges.some((edge) => edge.prerequisite === options[0] && edge.dependent === group.dependent)) {
				edges.push({ prerequisite: options[0]!, dependent: group.dependent });
			}
		}
		return {
			...d,
			skills: d.skills.filter((_, i) => i !== index),
			edges,
			...(d.alternatives === undefined ? {} : { alternatives }),
			goals: d.goals.filter((goal) => goal !== skill.id),
		};
	});
	const linkedEvidence = new Set([...(saved?.evidence.current ?? []), ...(saved?.evidence.historical ?? [])].map((item) => item.evidenceId));
	const linkedPropositions = new Set(saved?.encounter.propositions.map((item) => item.nodeId) ?? []);
	const linkedTopics = new Set(saved?.selfReport.claims.map((item) => item.topicId) ?? []);

	return (
		<li className="flex flex-col gap-2 rounded-sm border border-border/60 p-3" aria-labelledby={`${base}-heading`}>
			<div className="flex items-center justify-between gap-2">
				<h3 id={`${base}-heading`} className="text-sm font-medium">
					{saved && <span aria-hidden="true">{STATUS_GLYPH[saved.evidence.status]} </span>}
					{skill.title || "Untitled skill"}
					{saved && <span className="ml-2 text-xs font-normal text-muted-foreground">objective revision {saved.skill.revision}</span>}
				</h3>
				<div className="flex items-center gap-3">
					{onStart && (
						<>
							<button type="button" onClick={() => onStart("teach")} className={LINK_BUTTON}>Start a session on this skill</button>
							<button type="button" onClick={() => onStart("practice")} className={LINK_BUTTON}>Practice this skill</button>
						</>
					)}
					<button type="button" onClick={removeSkill} className={LINK_BUTTON}>Remove skill</button>
				</div>
			</div>
			<div className="grid gap-2 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<label htmlFor={`${base}-id`} className="text-xs text-muted-foreground">Skill id {skill.isNew ? "" : "(fixed)"}</label>
					<input id={`${base}-id`} value={skill.id} readOnly={!skill.isNew} maxLength={SUBJECT_MAP_LIMITS.idChars} onChange={(event) => update({ id: event.currentTarget.value })} className={FIELD} />
				</div>
				<div className="flex flex-col gap-1">
					<label htmlFor={`${base}-title`} className="text-xs text-muted-foreground">Title</label>
					<input id={`${base}-title`} value={skill.title} maxLength={SUBJECT_MAP_LIMITS.titleChars} onChange={(event) => update({ title: event.currentTarget.value })} className={FIELD} />
				</div>
			</div>
			<label htmlFor={`${base}-objective`} className="text-xs text-muted-foreground">Objective (changing it marks earlier evidence as historical)</label>
			<textarea id={`${base}-objective`} value={skill.objective} rows={2} maxLength={SUBJECT_MAP_LIMITS.objectiveChars} onChange={(event) => update({ objective: event.currentTarget.value })} className={FIELD} />
			<label className="flex items-center gap-2 text-xs">
				<input type="checkbox" checked={isGoal} disabled={!skill.id} onChange={(event) => {
					const checked = event.currentTarget.checked;
					onEdit((d) => ({ ...d, goals: checked ? [...d.goals, skill.id] : d.goals.filter((goal) => goal !== skill.id) }));
				}} />
				Goal skill
			</label>
			<label htmlFor={`${base}-keystone`} className="flex items-center gap-2 text-xs">
				<input
					id={`${base}-keystone`}
					type="checkbox"
					checked={skill.keystone === true}
					onChange={(event) => {
						const checked = event.currentTarget.checked;
						onEdit((d) => ({
							...d,
							skills: d.skills.map((item, i) => {
								if (i !== index) return item;
								if (checked) return { ...item, keystone: true };
								const { keystone: _keystone, ...withoutKeystone } = item;
								return withoutKeystone;
							}),
						}));
					}}
				/>
				Keystone skill
			</label>
			<div className="flex flex-col gap-1 text-xs">
				<span className="text-muted-foreground">Prerequisites</span>
				{prerequisites.length === 0 && <span className="text-muted-foreground">None</span>}
				<ul className="flex flex-wrap gap-2">
					{prerequisites.map((id) => (
						<li key={id} className="flex items-center gap-1 rounded-sm border border-border/60 px-2 py-0.5">
							{titleOf(id)}
							<button type="button" aria-label={`Remove prerequisite ${titleOf(id)}`} onClick={() => onEdit((d) => ({ ...d, edges: d.edges.filter((edge) => !(edge.prerequisite === id && edge.dependent === skill.id)) }))} className={LINK_BUTTON}>×</button>
						</li>
					))}
				</ul>
				{skill.id && candidates.length > 0 && (
					<div className="flex items-center gap-2">
						<label htmlFor={`${base}-prereq`} className="sr-only">Add a prerequisite to {skill.title || skill.id}</label>
						<select id={`${base}-prereq`} value={prerequisiteChoice} onChange={(event) => setPrerequisiteChoice(event.currentTarget.value)} className="rounded-sm border border-border bg-background px-1 py-1">
							<option value="">Choose a prerequisite…</option>
							{candidates.map((other) => <option key={other.key} value={other.id}>{other.title || other.id}</option>)}
						</select>
						<button type="button" disabled={!prerequisiteChoice || draft.edges.length >= SUBJECT_MAP_LIMITS.edges} onClick={() => {
							onEdit((d) => ({ ...d, edges: [...d.edges, { prerequisite: prerequisiteChoice, dependent: skill.id }] }));
							setPrerequisiteChoice("");
						}} className={BUTTON}>Add prerequisite</button>
					</div>
				)}
			</div>
			<div className="flex flex-col gap-1 text-xs">
				<span className="text-muted-foreground">Alternative routes</span>
				{alternativeGroups.length === 0 && <span className="text-muted-foreground">None</span>}
				<ul className="flex flex-col gap-1">
					{alternativeGroups.map(({ group, groupIndex }) => (
						<li key={`${group.dependent}-${groupIndex}`} className="flex flex-wrap items-center gap-2">
							<span>Requires one of: {group.options.map(titleOf).join(", ")}</span>
							<button
								type="button"
								className={LINK_BUTTON}
								onClick={() => onEdit((d) => ({ ...d, alternatives: (d.alternatives ?? []).filter((_, i) => i !== groupIndex) }))}
							>Remove alternative route</button>
						</li>
					))}
				</ul>
			</div>

			{saved && (
				<dl className="grid gap-2 border-t border-border/60 pt-2 text-xs sm:grid-cols-3">
					<div className="flex flex-col gap-1">
						<dt className="text-muted-foreground">Encountered (came up in sessions; not proof of knowing)</dt>
						<dd>
							{saved.encounter.status === "notLinked" && "No linked propositions"}
							{saved.encounter.status === "unavailable" && saved.encounter.propositions.every((p) => p.status === "unavailable") && "⚠ Linked propositions unavailable"}
							<ul>
								{saved.encounter.propositions.map((item) => (
									<li key={item.nodeId}>
										{item.status === "available" ? item.name : `⚠ unavailable (${item.nodeId})`}{" "}
										<button type="button" disabled={linkingBlocked} onClick={() => onUnlink("proposition", item.nodeId)} className={LINK_BUTTON}>Unlink</button>
									</li>
								))}
							</ul>
							{sources.propositions && sources.propositions.length > 0 && (
								<div className="mt-1 flex items-center gap-1">
									<label htmlFor={`${base}-prop`} className="sr-only">Link a proposition</label>
									<select id={`${base}-prop`} value={propositionChoice} onChange={(event) => setPropositionChoice(event.currentTarget.value)} className="max-w-full rounded-sm border border-border bg-background px-1 py-1">
										<option value="">Link a proposition…</option>
										{sources.propositions.filter((node) => !linkedPropositions.has(node.id)).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
									</select>
									<button type="button" disabled={!propositionChoice || linkingBlocked} onClick={() => { onLink("proposition", propositionChoice); setPropositionChoice(""); }} className={BUTTON}>Link</button>
								</div>
							)}
						</dd>
					</div>
					<div className="flex flex-col gap-1">
						<dt className="text-muted-foreground">Self-report</dt>
						<dd>
							{saved.selfReport.status === "none" && "No linked profile topic"}
							<ul>
								{saved.selfReport.claims.map((item) => (
									<li key={item.topicId}>
										{item.claim ? `${item.claim.topic}: ${item.claim.familiarity} (self-report, ${day(item.claim.updatedAt)})` : "⚠ topic unavailable"}{" "}
										<button type="button" disabled={linkingBlocked} onClick={() => onUnlink("topic", item.topicId)} className={LINK_BUTTON}>Unlink</button>
									</li>
								))}
							</ul>
							{sources.topics && sources.topics.length > 0 && (
								<div className="mt-1 flex items-center gap-1">
									<label htmlFor={`${base}-topic`} className="sr-only">Link a profile topic</label>
									<select id={`${base}-topic`} value={topicChoice} onChange={(event) => setTopicChoice(event.currentTarget.value)} className="max-w-full rounded-sm border border-border bg-background px-1 py-1">
										<option value="">Link a profile topic…</option>
										{sources.topics.filter((topic) => !linkedTopics.has(topic.id)).map((topic) => <option key={topic.id} value={topic.id}>{topic.topic}</option>)}
									</select>
									<button type="button" disabled={!topicChoice || linkingBlocked} onClick={() => { onLink("topic", topicChoice); setTopicChoice(""); }} className={BUTTON}>Link</button>
								</div>
							)}
						</dd>
					</div>
					<div className="flex flex-col gap-1">
						<dt className="text-muted-foreground">Criterion evidence</dt>
						<dd className="flex flex-col gap-1">
							<span>{STATUS_GLYPH[saved.evidence.status]} {skillEvidenceStatusLabel(saved.evidence.status)}</span>
							<ul className="flex flex-col gap-1">
								{saved.evidence.current.map((item) => (
									<li key={item.evidenceId}>
										{item.observation ? (
											<Link href={`/chat/${encodeURIComponent(item.observation.chatId)}`} className="underline underline-offset-2">{observationSummary(item.observation)}</Link>
										) : "⚠ source unavailable (deleted or unreadable session)"}
										{" · "}{polarityLabel(item)}{" "}
										<button type="button" disabled={linkingBlocked} onClick={() => onDetachEvidence(item)} className={LINK_BUTTON}>Unlink</button>
									</li>
								))}
								{saved.evidence.historical.map((item) => (
									<li key={`${item.evidenceId}-${item.skillRevision}`} className="text-muted-foreground">
										Historical (objective revision {item.skillRevision}, review needed): {item.observation ? observationSummary(item.observation) : "source unavailable"}{" "}
										<button type="button" disabled={linkingBlocked} onClick={() => onDetachEvidence(item)} className={LINK_BUTTON}>Unlink</button>
									</li>
								))}
							</ul>
							{sources.observations.length > 0 && (
								<div className="mt-1 flex items-center gap-1">
									<label htmlFor={`${base}-evidence`} className="sr-only">Link evidence</label>
									<select id={`${base}-evidence`} value={evidenceChoice} onChange={(event) => setEvidenceChoice(event.currentTarget.value)} className="max-w-full rounded-sm border border-border bg-background px-1 py-1">
										<option value="">Link evidence…</option>
										{sources.observations.filter((observation) => !linkedEvidence.has(observation.id)).map((observation) => (
											<option key={observation.id} value={observation.id}>{observation.chatTitle.slice(0, 40)} · {observationSummary(observation)}</option>
										))}
									</select>
									<button type="button" disabled={!evidenceChoice || linkingBlocked} onClick={() => { onAttachEvidence(evidenceChoice); setEvidenceChoice(""); }} className={BUTTON}>Link</button>
								</div>
							)}
						</dd>
					</div>
				</dl>
			)}
			{saved?.inClosure && saved.paths.map((path) => (
				<p key={path.goalId} className="text-xs text-muted-foreground">
					{path.path.length === 1 ? "Goal." : `Required for ${titleOf(path.goalId)}: ${pathText(path.path)}`}
				</p>
			))}
		</li>
	);
}
