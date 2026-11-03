"use client";

import { useCallback, useEffect, useState } from "react";

type Suggestion = {
	id: string;
	mapId: string;
	skillId: string;
	status: "pending" | "confirmed" | "rejected";
	reason: { kind: "placement" | "import" | "conversation"; quote?: string; sourceName?: string };
	mapTitle: string;
	skillTitle: string;
	standing: string;
	viaSkillTitle?: string;
};
export type FamiliarityListing = { profileRevision: number; suggestions: Suggestion[]; runtimeMode?: string; likelyKnownSkillIds?: string[]; latestPlacement?: { probes: { skillId: string; result?: string }[]; completed: boolean } | null };
const GROUPS = [
	["placement", "From a placement run"],
	["import", "From your notes"],
	["conversation", "From your conversations"],
] as const;

export function FamiliaritySuggestions({ mapId, sharedListing, sharedError, onRefresh, reviewOnly = false }: { mapId?: string; sharedListing?: FamiliarityListing | null; sharedError?: string | null; onRefresh?: () => Promise<void>; reviewOnly?: boolean }) {
	const [listing, setListing] = useState<FamiliarityListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [sourceText, setSourceText] = useState("");
	const [sourceName, setSourceName] = useState("Pasted notes");

	const load = useCallback(async () => {
		try {
			const response = await fetch(`/api/learner/familiarity${mapId ? `?mapId=${encodeURIComponent(mapId)}` : ""}`, { cache: "no-store" });
			if (!response.ok) throw new Error("Unable to load familiarity suggestions.");
			setListing(await response.json() as FamiliarityListing);
			setError(null);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load familiarity suggestions."); }
	}, [mapId]);

	useEffect(() => { if (sharedListing === undefined) void load(); }, [load, sharedListing]);
	useEffect(() => { if (sharedListing !== undefined) setListing(sharedListing); }, [sharedListing]);

	const decide = async (items: Suggestion[], status: "confirmed" | "rejected") => {
		if (!listing || !items.length) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/learner/familiarity/decisions", {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids: items.map((item) => item.id), status, expectedRevision: listing.profileRevision }),
			});
			if (response.status === 409) { await (onRefresh ?? load)(); setError("Your profile changed. The latest suggestions have been reloaded."); return; }
			const body = await response.json() as { error?: string };
			if (!response.ok) throw new Error(body.error ?? "Unable to update suggestions.");
			await (onRefresh ?? load)();
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update suggestions."); }
		finally { setBusy(false); }
	};

	const infer = async (file?: File) => {
		if (!mapId) return;
		setBusy(true);
		setError(null);
		try {
			let body: BodyInit;
			let headers: HeadersInit | undefined;
			if (file) {
				const form = new FormData();
				form.set("mapId", mapId);
				form.set("files", file);
				body = form;
			} else {
				headers = { "content-type": "application/json" };
				body = JSON.stringify({ mapId, source: { name: sourceName, text: sourceText } });
			}
			const response = await fetch("/api/learner/familiarity/infer", { method: "POST", headers, body });
			const result = await response.json() as { error?: string; message?: string };
			if (!response.ok) throw new Error(response.status === 503
				? `${result.error ?? result.message ?? "Familiarity inference is unavailable."} Configure a strong model and provider key in Settings.`
				: result.error ?? "Unable to infer familiarity.");
			setSourceText("");
			await (onRefresh ?? load)();
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to infer familiarity."); }
		finally { setBusy(false); }
	};

	return <section aria-label="Familiarity suggestions" className="flex flex-col gap-3 border-t border-border/60 pt-4">
		<h2 className="text-sm font-medium">Familiarity suggestions</h2>
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
		{sharedError && <p role="alert" className="text-xs text-destructive">{sharedError}</p>}
		{listing?.suggestions.length === 0 && <p className="text-xs text-muted-foreground">No familiarity suggestions yet.</p>}
		{GROUPS.map(([kind, label]) => {
			const group = listing?.suggestions.filter((item) => item.reason.kind === kind) ?? [];
			if (!group.length) return null;
			const actionable = group.filter((item) => item.standing === "current" && item.status !== "confirmed");
			const pending = group.filter((item) => item.standing === "current" && item.status === "pending");
			return <section key={kind} aria-label={label} className="flex flex-col gap-2">
				<h3 className="text-xs uppercase tracking-wide">{label}</h3>
				<div className="flex gap-2">
					<button type="button" disabled={busy || !pending.length} onClick={() => void decide(pending, "confirmed")} className="text-xs underline">Accept all</button>
					<button type="button" disabled={busy || !pending.length} onClick={() => void decide(pending, "rejected")} className="text-xs underline">Reject all</button>
				</div>
				<ul className="flex flex-col gap-2">
					{group.map((item) => <li key={item.id} className="rounded-sm border border-border/60 p-2 text-sm">
						<p><strong>{item.skillTitle}</strong> · {item.mapTitle}</p>
						{item.reason.quote ? <blockquote className="mt-1 text-xs text-muted-foreground">“{item.reason.quote}”</blockquote> : <p className="text-xs text-muted-foreground">You passed a check on {item.viaSkillTitle ?? "another skill"}. This is not evidence.</p>}
						{item.standing !== "current" ? <p className="mt-1 text-xs">Objective changed — not counted</p> :
							item.status === "confirmed" ? <><p className="mt-1 text-xs">Likely known (you confirmed)</p><button disabled={busy} type="button" onClick={() => void decide([item], "rejected")} className="mt-1 text-xs underline">Revoke</button></> :
							<div className="mt-1 flex gap-3"><button disabled={busy || !actionable.includes(item)} type="button" onClick={() => void decide([item], "confirmed")} className="text-xs underline">Accept</button>
								{item.status === "pending" && <button disabled={busy} type="button" onClick={() => void decide([item], "rejected")} className="text-xs underline">Reject</button>}</div>}
					</li>)}
				</ul>
			</section>;
		})}
		{mapId && !reviewOnly && <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
			<h3 className="text-xs uppercase tracking-wide">Infer from notes</h3>
			<label className="flex flex-col gap-1 text-xs">Paste notes<textarea value={sourceText} onChange={(event) => setSourceText(event.currentTarget.value)} maxLength={200 * 1024} rows={4} className="rounded-sm border border-border bg-background p-2" /></label>
			<label className="text-xs">Source name <input value={sourceName} onChange={(event) => setSourceName(event.currentTarget.value)} maxLength={255} className="ml-2 rounded-sm border border-border bg-background px-2 py-1" /></label>
			<button type="button" disabled={busy || !sourceText.trim()} onClick={() => void infer()} className="self-start rounded-sm border border-border px-2 py-1 text-xs disabled:opacity-50">Infer suggestions</button>
			<label className="self-start text-xs underline">Upload notes (.txt, .md, .markdown){listing?.runtimeMode === "local" ? " or .pdf" : ""}
				<input type="file" accept={listing?.runtimeMode === "local" ? ".txt,.md,.markdown,.pdf" : ".txt,.md,.markdown"} className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void infer(file); event.currentTarget.value = ""; }} />
			</label>
		</div>}
	</section>;
}
