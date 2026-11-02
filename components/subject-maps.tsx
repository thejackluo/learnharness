"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SUBJECT_MAP_LIMITS, type LearningTargetRef, type SubjectMapSummary } from "@/src/core";

type TargetLink = {
	evidenceId: string;
	target: LearningTargetRef;
	attachedAt: string;
	sourceStatus: "available" | "unavailable";
	targetStatus: "current" | "historical" | "retired" | "missingSkill" | "missingMap" | "mapUnavailable";
	mapTitle: string | null;
	skillTitle: string | null;
};

const TARGET_STATUS_LABEL: Record<TargetLink["targetStatus"], string> = {
	current: "current objective",
	historical: "objective changed since linking (review needed)",
	retired: "skill retired",
	missingSkill: "skill no longer in map",
	missingMap: "map deleted",
	mapUnavailable: "map unreadable",
};

type ImportPreview = { title: string; skills: number; edges: number; goals: number; retired: number };

const BUTTON = "rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

async function readJson(response: Response): Promise<Record<string, unknown>> {
	try {
		return await response.json() as Record<string, unknown>;
	} catch {
		return {};
	}
}

function issueList(body: Record<string, unknown>): string[] {
	return Array.isArray(body.issues) ? body.issues.map(String) : [];
}

/** The maps index: list, create an empty map, or preview → confirm a curriculum import. */
export function SubjectMapsHome() {
	const [maps, setMaps] = useState<SubjectMapSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [issues, setIssues] = useState<string[]>([]);
	const [title, setTitle] = useState("");
	const [creating, setCreating] = useState(false);
	const [curriculum, setCurriculum] = useState<unknown>(undefined);
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [fileName, setFileName] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [inputKey, setInputKey] = useState(0);
	const mounted = useRef(true);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/maps", { cache: "no-store" });
			const body = await readJson(response);
			if (!mounted.current) return;
			if (!response.ok) throw new Error(String(body.error ?? "Unable to load maps."));
			setMaps(body.maps as SubjectMapSummary[]);
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to load maps.");
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [load]);

	const created = (id: string) => {
		window.location.assign(`/maps/${encodeURIComponent(id)}`);
	};

	const create = async () => {
		setCreating(true);
		setError(null);
		setIssues([]);
		try {
			const response = await fetch("/api/maps", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ definition: { title, description: "", skills: [], edges: [], goals: [] } }),
			});
			const body = await readJson(response);
			if (!response.ok) {
				setError(String(body.error ?? "Unable to create map."));
				setIssues(issueList(body));
				return;
			}
			created((body.map as { id: string }).id);
		} finally {
			if (mounted.current) setCreating(false);
		}
	};

	const cancelImport = () => {
		setCurriculum(undefined);
		setPreview(null);
		setFileName(null);
		setIssues([]);
		setInputKey((key) => key + 1);
	};

	const chooseFile = async (files: FileList | null) => {
		const file = files?.[0];
		setPreview(null);
		setIssues([]);
		setError(null);
		setCurriculum(undefined);
		setFileName(file?.name ?? null);
		if (!file) return;
		if (file.size > SUBJECT_MAP_LIMITS.bodyBytes) {
			setError(`Curriculum files are limited to ${SUBJECT_MAP_LIMITS.bodyBytes.toLocaleString()} bytes.`);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await file.text());
		} catch {
			setError("That file is not valid JSON.");
			return;
		}
		setImporting(true);
		try {
			const response = await fetch("/api/maps/import/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(parsed),
			});
			const body = await readJson(response);
			if (!mounted.current) return;
			if (!response.ok) {
				setError(String(body.error ?? "Invalid curriculum."));
				setIssues(issueList(body));
				return;
			}
			setCurriculum(parsed);
			setPreview(body.preview as ImportPreview);
		} finally {
			if (mounted.current) setImporting(false);
		}
	};

	const confirmImport = async () => {
		setImporting(true);
		setError(null);
		try {
			const response = await fetch("/api/maps/import", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(curriculum),
			});
			const body = await readJson(response);
			if (!response.ok) {
				setError(String(body.error ?? "Unable to import map."));
				setIssues(issueList(body));
				return;
			}
			created((body.map as { id: string }).id);
		} finally {
			if (mounted.current) setImporting(false);
		}
	};

	return (
		<main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
			<header className="flex flex-col gap-1">
				<h1 className="text-lg font-medium">Subject maps</h1>
				<p className="text-sm text-muted-foreground">
					Prerequisite maps you write or import. A map describes a subject, not what you know; evidence stays linked to your sessions.
				</p>
			</header>

			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			{issues.length > 0 && (
				<ul aria-label="Problems" className="list-disc pl-5 text-xs text-destructive">
					{issues.map((issue) => <li key={issue}>{issue}</li>)}
				</ul>
			)}

			<section aria-labelledby="maps-list-heading" className="flex flex-col gap-2">
				<h2 id="maps-list-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Your maps</h2>
				{maps === null && !error && <p className="text-xs text-muted-foreground">Loading maps…</p>}
				{maps?.length === 0 && <p className="text-xs text-muted-foreground">No maps yet. No curriculum is bundled; create or import one.</p>}
				<ul className="flex flex-col gap-1">
					{maps?.map((map) => (
						<li key={map.id} className="rounded-sm border border-border/60 px-3 py-2 text-sm">
							{map.state === "ok" ? (
								<Link href={`/maps/${encodeURIComponent(map.id)}`} className="underline-offset-2 hover:underline">
									{map.title}
									<span className="ml-2 text-xs text-muted-foreground">{map.skills} skills · {map.goals} goals · revision {map.revision}</span>
								</Link>
							) : (
								<span className="text-muted-foreground">
									{map.id} · {map.state === "future" ? "saved by a newer app version (read-only)" : "unreadable file (left untouched)"}
								</span>
							)}
						</li>
					))}
				</ul>
			</section>

			<section aria-labelledby="maps-create-heading" className="flex flex-col gap-2 border-t border-border/60 pt-4">
				<h2 id="maps-create-heading" className="text-xs uppercase tracking-widest text-muted-foreground">New map</h2>
				<label htmlFor="map-new-title" className="text-xs text-muted-foreground">Title</label>
				<input
					id="map-new-title"
					value={title}
					maxLength={SUBJECT_MAP_LIMITS.titleChars}
					onChange={(event) => setTitle(event.currentTarget.value)}
					className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
				/>
				<button type="button" onClick={() => void create()} disabled={creating || !title.trim()} className={`self-start ${BUTTON}`}>
					{creating ? "Creating…" : "Create map"}
				</button>
			</section>

			<section aria-labelledby="maps-import-heading" className="flex flex-col gap-2 border-t border-border/60 pt-4">
				<h2 id="maps-import-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Import curriculum JSON</h2>
				<label htmlFor="map-import-file" className="text-xs text-muted-foreground">
					A learnharness.subject-map version 1 file. Nothing is saved until you confirm.
				</label>
				<input
					key={inputKey}
					id="map-import-file"
					type="file"
					accept=".json,application/json"
					onChange={(event) => void chooseFile(event.currentTarget.files)}
					className="text-xs file:mr-3 file:rounded-sm file:border file:border-border file:bg-background file:px-2 file:py-1"
				/>
				{importing && <p className="text-xs text-muted-foreground">Checking…</p>}
				{preview && (
					<div className="flex flex-col gap-2 rounded-sm border border-border/60 p-3 text-sm" aria-label="Import preview">
						<p>
							<strong>{preview.title}</strong> from {fileName}: {preview.skills} skills, {preview.edges} prerequisite links, {preview.goals} goals, {preview.retired} retired ids.
						</p>
						<div className="flex gap-2">
							<button type="button" onClick={() => void confirmImport()} disabled={importing} className={BUTTON}>Confirm import</button>
							<button type="button" onClick={cancelImport} disabled={importing} className={BUTTON}>Cancel import</button>
						</div>
					</div>
				)}
				{!preview && fileName && !importing && (
					<button type="button" onClick={cancelImport} className={`self-start ${BUTTON}`}>Cancel import</button>
				)}
			</section>

			<LearnerMapLinks />
		</main>
	);
}

/** Every explicit evidence → skill link, including links whose map or source is gone, with Unlink. */
export function LearnerMapLinks() {
	const [data, setData] = useState<{ availability: "available"; profileRevision: number; links: TargetLink[] } | { availability: "unavailable" } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await fetch("/api/learner/targets", { cache: "no-store" });
		const body = await readJson(response);
		if (!response.ok) {
			setError(String(body.error ?? "Unable to load evidence links."));
			return;
		}
		setData(body as typeof data);
	}, []);

	useEffect(() => {
		void load().catch(() => setError("Unable to load evidence links."));
	}, [load]);

	const unlink = async (link: TargetLink) => {
		if (data?.availability !== "available") return;
		setError(null);
		const response = await fetch(`/api/learner/evidence/${encodeURIComponent(link.evidenceId)}/targets`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target: link.target, expectedRevision: data.profileRevision }),
		});
		const body = await readJson(response);
		if (!response.ok) setError(body.code === "revision_conflict" ? "Your learner profile changed elsewhere; reloaded it. Try again." : String(body.error ?? "Unable to unlink."));
		await load();
	};

	return (
		<section aria-labelledby="maps-links-heading" className="flex flex-col gap-2 border-t border-border/60 pt-4">
			<h2 id="maps-links-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Evidence linked to skills</h2>
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			{data?.availability === "unavailable" && <p role="status" className="text-xs">⚠ The learner profile is unreadable, so evidence links are unavailable.</p>}
			{data?.availability === "available" && data.links.length === 0 && <p className="text-xs text-muted-foreground">No evidence is linked to a skill yet.</p>}
			{data?.availability === "available" && data.links.length > 0 && (
				<ul className="flex flex-col gap-1 text-xs">
					{data.links.map((link) => (
						<li key={`${link.evidenceId}-${link.target.mapId}-${link.target.skillId}-${link.target.skillRevision}`} className="flex flex-wrap items-center gap-2 rounded-sm border border-border/60 px-2 py-1">
							<span>{link.mapTitle ?? link.target.mapId} · {link.skillTitle ?? link.target.skillId} (objective revision {link.target.skillRevision})</span>
							<span className="text-muted-foreground">{TARGET_STATUS_LABEL[link.targetStatus]}{link.sourceStatus === "unavailable" ? " · ⚠ source session unavailable" : ""}</span>
							<button type="button" onClick={() => void unlink(link)} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Unlink</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
