"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	FAMILIARITY_LEVELS,
	LEARNER_LIMITS,
	type FamiliarityLevel,
	type LearnerObservation,
	type LearnerProfileExcerpt,
	type LearnerProfileV1,
	type LearnerTopicClaim,
} from "@/src/core";

type EditableTopic = Omit<LearnerTopicClaim, "id" | "note" | "updatedAt"> & { id?: string; note: string };
type EditableExcerpt = LearnerProfileExcerpt;
type ImportDraft = { sourceName: string; text: string; bytes: number };
type Coverage = { scannedChats: number; totalChats: number; unreadableChats: number };

interface LearnerSectionBodyProps {
	background?: string;
	coursework?: string;
	topics?: EditableTopic[];
	excerpts?: EditableExcerpt[];
	drafts?: ImportDraft[];
	observations?: LearnerObservation[];
	coverage?: Coverage;
	availability?: "complete" | "partial";
	nextCursor?: string | null;
	profileRevision?: number | null;
	profileState?: string;
	loading?: boolean;
	saving?: boolean;
	previewing?: boolean;
	confirming?: boolean;
	evidenceLoading?: boolean;
	error?: string | null;
	evidenceError?: string | null;
	conflictProfile?: LearnerProfileV1 | null;
	onBackgroundChange?: (value: string) => void;
	onCourseworkChange?: (value: string) => void;
	onTopicChange?: (index: number, patch: Partial<EditableTopic>) => void;
	onTopicAdd?: () => void;
	onTopicRemove?: (index: number) => void;
	onExcerptChange?: (id: string, text: string) => void;
	onExcerptRemove?: (id: string) => void;
	onFilesChange?: (files: FileList | null) => void;
	onPreview?: () => void;
	onDraftChange?: (index: number, text: string) => void;
	onConfirm?: () => void;
	onSave?: () => void;
	onReload?: () => void;
	onLoadMore?: () => void;
}

const NOOP = () => {};
const NO_COVERAGE: Coverage = { scannedChats: 0, totalChats: 0, unreadableChats: 0 };

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function observationOutcome(observation: LearnerObservation): string {
	switch (observation.kind) {
		case "choice":
			return observation.outcome;
		case "criterion":
			return observation.award === null
				? `${observation.outcome} · unassessed`
				: `${observation.outcome} · ${observation.award}/${observation.maxPoints}`;
		case "practiceConclusion":
			return observation.outcome;
	}
}

function provenanceLabel(observation: LearnerObservation): string {
	switch (observation.provenance) {
		case "deterministic":
			return "auto-graded";
		case "modelJudged":
			return "AI-evaluated";
		case "modelAuthored":
			return "tutor's practice verdict";
		case "legacyClientGraded":
			return "legacy, client-graded (unverified)";
	}
}

export function LearnerSectionBody({
	background = "",
	coursework = "",
	topics = [],
	excerpts = [],
	drafts = [],
	observations = [],
	coverage = NO_COVERAGE,
	availability = "complete",
	nextCursor = null,
	profileRevision = null,
	profileState = "loading",
	loading = false,
	saving = false,
	previewing = false,
	confirming = false,
	evidenceLoading = false,
	error = null,
	evidenceError = null,
	conflictProfile = null,
	onBackgroundChange = NOOP,
	onCourseworkChange = NOOP,
	onTopicChange = NOOP,
	onTopicAdd = NOOP,
	onTopicRemove = NOOP,
	onExcerptChange = NOOP,
	onExcerptRemove = NOOP,
	onFilesChange = NOOP,
	onPreview = NOOP,
	onDraftChange = NOOP,
	onConfirm = NOOP,
	onSave = NOOP,
	onReload = NOOP,
	onLoadMore = NOOP,
}: LearnerSectionBodyProps) {
	const conflictBannerRef = useRef<HTMLDivElement>(null);
	const excerptBytes = excerpts.reduce((total, excerpt) => total + utf8Bytes(excerpt.text), 0) +
		drafts.reduce((total, draft) => total + utf8Bytes(draft.text), 0);
	const editable = profileState === "absent" || profileState === "ok";
	const evidenceAvailability = availability === "complete" && coverage.unreadableChats > 0
		? "partial"
		: availability;

	useEffect(() => {
		if (conflictProfile) conflictBannerRef.current?.focus();
	}, [conflictProfile]);

	return (
		<div className="flex flex-col gap-6" data-testid="learner-section-body">
			{loading && <p className="text-xs text-muted-foreground" role="status">Loading learner profile…</p>}
			{error && <p className="text-xs text-red-500" role="alert">{error}</p>}
			{conflictProfile && (
				<div
					ref={conflictBannerRef}
					tabIndex={-1}
					className="flex items-center justify-between gap-3 rounded-sm border border-amber-500/40 px-3 py-2 text-xs"
					role="alert"
				>
					<span>Profile changed in another tab. Reload the saved profile before editing.</span>
					<button type="button" className="underline" onClick={onReload}>Reload profile</button>
				</div>
			)}
			{profileState === "corrupt" || profileState === "future" || profileState === "profile_unwritable" ? (
				<p className="text-xs text-red-500" role="alert">
					The saved learner profile cannot be edited ({profileState}). Existing data was left unchanged.
				</p>
			) : null}

			<fieldset disabled={!editable || loading || saving} className="flex flex-col gap-5 disabled:opacity-70">
				<legend className="sr-only">Learner profile</legend>
				<div className="flex flex-col gap-2">
					<label htmlFor="learner-background" className="text-xs uppercase tracking-widest text-muted-foreground">Background</label>
					<textarea
						id="learner-background"
						value={background}
						maxLength={LEARNER_LIMITS.backgroundChars}
						onChange={(event) => onBackgroundChange(event.currentTarget.value)}
						rows={4}
						className="w-full rounded-sm border border-border bg-background px-3 py-2 font-prose text-sm"
					/>
					<p className="text-right text-xs text-muted-foreground">{background.length}/{LEARNER_LIMITS.backgroundChars} characters</p>
				</div>

				<div className="flex flex-col gap-2">
					<label htmlFor="learner-coursework" className="text-xs uppercase tracking-widest text-muted-foreground">Current coursework</label>
					<textarea
						id="learner-coursework"
						value={coursework}
						maxLength={LEARNER_LIMITS.courseworkChars}
						onChange={(event) => onCourseworkChange(event.currentTarget.value)}
						rows={3}
						className="w-full rounded-sm border border-border bg-background px-3 py-2 font-prose text-sm"
					/>
					<p className="text-right text-xs text-muted-foreground">{coursework.length}/{LEARNER_LIMITS.courseworkChars} characters</p>
				</div>

				<section aria-labelledby="learner-topics-heading" className="flex flex-col gap-3 border-t border-border/60 pt-4">
					<div className="flex items-center justify-between gap-3">
						<h3 id="learner-topics-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Topic familiarity</h3>
						<span className="text-xs text-muted-foreground">{topics.length}/{LEARNER_LIMITS.topics}</span>
					</div>
					{topics.map((topic, index) => (
						<div key={topic.id ?? `new-topic-${index}`} className="flex flex-col gap-2 rounded-sm border border-border/60 p-3">
							<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
								<div className="flex flex-col gap-1">
									<label htmlFor={`learner-topic-${index}`} className="text-xs text-muted-foreground">Topic</label>
									<input
										id={`learner-topic-${index}`}
										value={topic.topic}
										maxLength={LEARNER_LIMITS.topicChars}
										onChange={(event) => onTopicChange(index, { topic: event.currentTarget.value })}
										className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<label htmlFor={`learner-familiarity-${index}`} className="text-xs text-muted-foreground">Familiarity</label>
									<select
										id={`learner-familiarity-${index}`}
										value={topic.familiarity}
										onChange={(event) => onTopicChange(index, { familiarity: event.currentTarget.value as FamiliarityLevel })}
										className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
									>
										{FAMILIARITY_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
									</select>
								</div>
							</div>
							<div className="flex flex-col gap-1">
								<label htmlFor={`learner-topic-note-${index}`} className="text-xs text-muted-foreground">Notes</label>
								<textarea
									id={`learner-topic-note-${index}`}
									value={topic.note}
									maxLength={LEARNER_LIMITS.topicNoteChars}
									onChange={(event) => onTopicChange(index, { note: event.currentTarget.value })}
									rows={2}
									className="rounded-sm border border-border bg-background px-2 py-1.5 font-prose text-sm"
								/>
							</div>
							<button type="button" onClick={() => onTopicRemove(index)} className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
								Remove topic
							</button>
						</div>
					))}
					<button
						type="button"
						onClick={onTopicAdd}
						disabled={topics.length >= LEARNER_LIMITS.topics}
						className="self-start rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
					>
						Add topic
					</button>
				</section>

				<section aria-labelledby="learner-excerpts-heading" className="flex flex-col gap-3 border-t border-border/60 pt-4">
					<div className="flex items-center justify-between gap-3">
						<h3 id="learner-excerpts-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Saved excerpts</h3>
						<span className="text-xs text-muted-foreground">{excerpts.length + drafts.length}/{LEARNER_LIMITS.excerpts}</span>
					</div>
					{excerpts.length === 0 && drafts.length === 0 && <p className="text-xs text-muted-foreground">No saved excerpts.</p>}
					{excerpts.map((excerpt) => (
						<div key={excerpt.id} className="flex flex-col gap-2 rounded-sm border border-border/60 p-3">
							<div className="flex items-center justify-between gap-3">
								<p className="min-w-0 truncate text-xs text-muted-foreground">{excerpt.sourceName}</p>
								<button type="button" onClick={() => onExcerptRemove(excerpt.id)} className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
									Remove excerpt
								</button>
							</div>
							<label htmlFor={`learner-excerpt-${excerpt.id}`} className="sr-only">Excerpt from {excerpt.sourceName}</label>
							<textarea
								id={`learner-excerpt-${excerpt.id}`}
								value={excerpt.text}
								onChange={(event) => onExcerptChange(excerpt.id, event.currentTarget.value)}
								rows={4}
								className="w-full rounded-sm border border-border bg-background px-2 py-1.5 font-prose text-sm"
							/>
						</div>
					))}
					<div className="flex flex-col gap-2 rounded-sm border border-border/60 p-3">
						<label htmlFor="learner-import-files" className="text-xs text-muted-foreground">Review text or Markdown files before saving</label>
						<input
							id="learner-import-files"
							type="file"
							accept=".txt,.md,text/plain,text/markdown"
							multiple
							onChange={(event) => onFilesChange(event.currentTarget.files)}
							className="text-xs file:mr-3 file:rounded-sm file:border file:border-border file:bg-background file:px-2 file:py-1"
						/>
						<button type="button" onClick={onPreview} disabled={previewing || !editable} className="self-start rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
							{previewing ? "Preparing preview…" : "Preview selected files"}
						</button>
						{drafts.map((draft, index) => (
							<div key={`${draft.sourceName}-${index}`} className="flex flex-col gap-2 border-t border-border/60 pt-3">
								<label htmlFor={`learner-import-draft-${index}`} className="text-xs text-muted-foreground">{draft.sourceName} · {utf8Bytes(draft.text)} bytes</label>
								<textarea
									id={`learner-import-draft-${index}`}
									value={draft.text}
									onChange={(event) => onDraftChange(index, event.currentTarget.value)}
									rows={5}
									className="w-full rounded-sm border border-border bg-background px-2 py-1.5 font-prose text-sm"
								/>
							</div>
						))}
						{drafts.length > 0 && (
							<button type="button" onClick={onConfirm} disabled={confirming || !editable} className="self-start rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
								{confirming ? "Saving excerpts…" : "Confirm reviewed excerpts"}
							</button>
						)}
					</div>
					<p className="text-right text-xs text-muted-foreground">{excerptBytes.toLocaleString()} / {LEARNER_LIMITS.excerptBytes.toLocaleString()} UTF-8 bytes</p>
				</section>
			</fieldset>

			<div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
				<p className="text-xs text-muted-foreground">
					{profileRevision === null ? "Profile not loaded" : `Profile revision ${profileRevision}`}
				</p>
				<button type="button" onClick={onSave} disabled={!editable || loading || saving} className="rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
					{saving ? "Saving…" : "Save profile"}
				</button>
			</div>

			<section aria-labelledby="learner-evidence-heading" className="flex flex-col gap-3 border-t border-border/60 pt-4">
				<div className="flex items-center justify-between gap-3">
					<h3 id="learner-evidence-heading" className="text-xs uppercase tracking-widest text-muted-foreground">Assessment and practice observations</h3>
					<span className="text-xs text-muted-foreground">{coverage.scannedChats}/{coverage.totalChats} sessions scanned</span>
				</div>
				{coverage.unreadableChats > 0 && (
					<p className="text-xs text-amber-600" role="status">
						{coverage.unreadableChats} session record{coverage.unreadableChats === 1 ? "" : "s"} could not be read; evidence coverage is partial.
					</p>
				)}
				{evidenceError && <p className="text-xs text-red-500" role="alert">{evidenceError}</p>}
				{observations.length === 0 && availability === "complete" ? (
					<p className="text-sm text-muted-foreground">No assessed work yet.</p>
				) : observations.length === 0 ? (
					<p className="text-sm text-muted-foreground">No assessed work found in the scanned sessions.</p>
				) : (
					<ul className="flex flex-col gap-3">
						{observations.map((observation) => (
							<li key={observation.id} className="flex flex-col gap-1 rounded-sm border border-border/60 p-3">
								<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
									<p className="text-xs font-medium">{observation.kind} · {observationOutcome(observation)}</p>
									<time dateTime={observation.observedAt} className="text-xs text-muted-foreground">{observation.observedAt}</time>
								</div>
								<p className="font-prose text-sm">{observation.prompt}</p>
								<p className="text-xs text-muted-foreground">{provenanceLabel(observation)}</p>
								<div className="flex items-center justify-between gap-3 text-xs">
									<span className="truncate text-muted-foreground">{observation.chatTitle}</span>
									<a href={`/chat/${encodeURIComponent(observation.chatId)}`} className="shrink-0 underline underline-offset-2">
										View source
									</a>
								</div>
							</li>
						))}
					</ul>
				)}
				{availability === "partial" && coverage.unreadableChats === 0 && (
					<p className="text-xs text-muted-foreground">More session records remain to scan.</p>
				)}
				{nextCursor && (
					<button type="button" onClick={onLoadMore} disabled={evidenceLoading} className="self-start rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
						{evidenceLoading ? "Loading…" : "Load more observations"}
					</button>
				)}
			</section>
		</div>
	);
}

function profileDraft(profile: LearnerProfileV1) {
	return {
		background: profile.background,
		coursework: profile.coursework,
		topics: profile.topics.map((topic) => ({ ...topic, note: topic.note ?? "" })),
		excerpts: profile.excerpts.map((excerpt) => ({ ...excerpt })),
	};
}

export function LearnerSection() {
	const [profile, setProfile] = useState<LearnerProfileV1 | null>(null);
	const [profileState, setProfileState] = useState("loading");
	const [background, setBackground] = useState("");
	const [coursework, setCoursework] = useState("");
	const [topics, setTopics] = useState<EditableTopic[]>([]);
	const [excerpts, setExcerpts] = useState<EditableExcerpt[]>([]);
	const [drafts, setDrafts] = useState<ImportDraft[]>([]);
	const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
	const [observations, setObservations] = useState<LearnerObservation[]>([]);
	const [coverage, setCoverage] = useState<Coverage>(NO_COVERAGE);
	const [availability, setAvailability] = useState<"complete" | "partial">("partial");
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [evidenceLoading, setEvidenceLoading] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [previewing, setPreviewing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [evidenceError, setEvidenceError] = useState<string | null>(null);
	const [conflictProfile, setConflictProfile] = useState<LearnerProfileV1 | null>(null);

	function applyProfile(next: LearnerProfileV1) {
		setProfile(next);
		setProfileState("ok");
		setBackground(next.background);
		setCoursework(next.coursework);
		const draft = profileDraft(next);
		setTopics(draft.topics);
		setExcerpts(draft.excerpts);
		setConflictProfile(null);
	}

	function applyConfirmedExcerpts(next: LearnerProfileV1) {
		setProfile((current) => current
			? { ...current, revision: next.revision, excerpts: next.excerpts }
			: next);
		setProfileState("ok");
		setExcerpts(next.excerpts.map((excerpt) => ({ ...excerpt })));
		setConflictProfile(null);
	}

	const reloadProfile = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const response = await fetch("/api/learner/profile", { cache: "no-store" });
			const body = await response.json() as { state: string; profile: LearnerProfileV1 | null; error?: string };
			if (!response.ok) throw new Error(body.error ?? `Profile request failed (${response.status}).`);
			setProfileState(body.state);
			if (body.profile) applyProfile(body.profile);
			else setProfile(null);
		} catch (loadError) {
			setProfileState("error");
			setProfile(null);
			setError(loadError instanceof Error ? loadError.message : "Unable to load learner profile.");
		} finally {
			setLoading(false);
		}
	}, []);

	const loadEvidence = useCallback(async (cursor: string | null) => {
		const append = cursor !== null;
		setEvidenceLoading(true);
		setEvidenceError(null);
		try {
			const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
			const response = await fetch(`/api/learner/evidence${query}`, { cache: "no-store" });
			const page = await response.json() as {
				availability: "complete" | "partial";
				observations: LearnerObservation[];
				nextCursor: string | null;
				coverage: Coverage;
				error?: string;
			};
			if (!response.ok) throw new Error(page.error ?? `Evidence request failed (${response.status}).`);
			setObservations((previous) => append ? [...previous, ...page.observations] : page.observations);
			setCoverage(page.coverage);
			setAvailability(page.availability);
			setNextCursor(page.nextCursor);
		} catch (loadError) {
			setEvidenceError(loadError instanceof Error ? loadError.message : "Unable to load learner evidence.");
		} finally {
			setEvidenceLoading(false);
		}
	}, []);

	useEffect(() => {
		void reloadProfile();
		void loadEvidence(null);
	}, [loadEvidence, reloadProfile]);

	async function saveProfile() {
		if (!profile) return;
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/learner/profile", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: profile.revision,
					background,
					coursework,
					topics: topics.map(({ id, topic, familiarity, note }) => ({
						...(id ? { id } : {}),
						topic,
						familiarity,
						...(note ? { note } : {}),
					})),
					excerpts: excerpts.map(({ id, text }) => ({ id, text })),
				}),
			});
			const body = await response.json() as {
				profile?: LearnerProfileV1;
				current?: { profile?: LearnerProfileV1 };
				code?: string;
				error?: string;
			};
			if (body.code === "profile_unwritable") {
				setProfileState("profile_unwritable");
				setConflictProfile(null);
				throw new Error(body.error ?? "Learner profile cannot be updated.");
			}
			if (response.status === 409) {
				setConflictProfile(body.current?.profile ?? null);
				throw new Error(body.error ?? "Profile changed in another tab.");
			}
			if (!response.ok || !body.profile) throw new Error(body.error ?? `Profile save failed (${response.status}).`);
			applyProfile(body.profile);
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : "Unable to save learner profile.");
		} finally {
			setSaving(false);
		}
	}

	async function previewFiles() {
		if (!selectedFiles.length) return;
		setPreviewing(true);
		setError(null);
		try {
			const form = new FormData();
			for (const file of selectedFiles) form.append("files", file, file.name);
			const response = await fetch("/api/learner/import/preview", { method: "POST", body: form });
			const body = await response.json() as { drafts?: ImportDraft[]; error?: string };
			if (!response.ok || !body.drafts) throw new Error(body.error ?? `Import preview failed (${response.status}).`);
			setDrafts(body.drafts);
		} catch (previewError) {
			setError(previewError instanceof Error ? previewError.message : "Unable to preview selected files.");
		} finally {
			setPreviewing(false);
		}
	}

	async function confirmDrafts() {
		if (!profile || !drafts.length) return;
		setConfirming(true);
		setError(null);
		try {
			const response = await fetch("/api/learner/import/confirm", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: profile.revision,
					excerpts: drafts.map(({ sourceName, text }) => ({ sourceName, text })),
				}),
			});
			const body = await response.json() as {
				profile?: LearnerProfileV1;
				current?: { profile?: LearnerProfileV1 };
				code?: string;
				error?: string;
			};
			if (body.code === "profile_unwritable") {
				setProfileState("profile_unwritable");
				setConflictProfile(null);
				throw new Error(body.error ?? "Learner profile cannot be updated.");
			}
			if (response.status === 409) {
				setConflictProfile(body.current?.profile ?? null);
				throw new Error(body.error ?? "Profile changed in another tab.");
			}
			if (!response.ok || !body.profile) throw new Error(body.error ?? `Import confirmation failed (${response.status}).`);
			applyConfirmedExcerpts(body.profile);
			setDrafts([]);
			setSelectedFiles([]);
		} catch (confirmError) {
			setError(confirmError instanceof Error ? confirmError.message : "Unable to confirm learner import.");
		} finally {
			setConfirming(false);
		}
	}

	return (
		<LearnerSectionBody
			background={background}
			coursework={coursework}
			topics={topics}
			excerpts={excerpts}
			drafts={drafts}
			observations={observations}
			coverage={coverage}
			availability={availability}
			nextCursor={nextCursor}
			profileRevision={profile?.revision ?? null}
			profileState={profileState}
			loading={loading}
			saving={saving}
			previewing={previewing}
			confirming={confirming}
			evidenceLoading={evidenceLoading}
			error={error}
			evidenceError={evidenceError}
			conflictProfile={conflictProfile}
			onBackgroundChange={setBackground}
			onCourseworkChange={setCoursework}
			onTopicChange={(index, patch) => setTopics((previous) => previous.map((topic, i) => i === index ? { ...topic, ...patch } : topic))}
			onTopicAdd={() => setTopics((previous) => [...previous, { topic: "", familiarity: "unfamiliar", note: "" }])}
			onTopicRemove={(index) => setTopics((previous) => previous.filter((_, i) => i !== index))}
			onExcerptChange={(id, text) => setExcerpts((previous) => previous.map((excerpt) => excerpt.id === id ? { ...excerpt, text } : excerpt))}
			onExcerptRemove={(id) => setExcerpts((previous) => previous.filter((excerpt) => excerpt.id !== id))}
			onFilesChange={(files) => {
				setSelectedFiles(files ? Array.from(files) : []);
				setDrafts([]);
			}}
			onPreview={() => void previewFiles()}
			onDraftChange={(index, text) => setDrafts((previous) => previous.map((draft, i) => i === index ? { ...draft, text, bytes: utf8Bytes(text) } : draft))}
			onConfirm={() => void confirmDrafts()}
			onSave={() => void saveProfile()}
			onReload={() => void reloadProfile()}
			onLoadMore={() => void loadEvidence(nextCursor)}
		/>
	);
}
