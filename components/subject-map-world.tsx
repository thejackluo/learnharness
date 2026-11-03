"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SkillSourceBadge } from "@/components/skill-source-badge";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import {
	WORLD_NODE,
	routeToGoal,
	skillEvidenceStatusLabel,
	skillPathStates,
	worldLayout,
	type SkillEvidenceStatus,
	type SkillPathState,
	type SubjectMapGapView,
	type SubjectMapV1,
	type SubjectSkill,
} from "@/src/core";

const STATE_GLYPH: Record<SkillPathState, string> = {
	cleared: "✓",
	open: "●",
	reachable: "◐",
	locked: "■",
};

const STATE_LABEL: Record<SkillPathState, string> = {
	cleared: "Cleared",
	open: "Open",
	reachable: "Reachable",
	locked: "Locked",
};

function nodeAppearance(state: SkillPathState): { fill: string; strokeDasharray?: string; opacity: number } {
	switch (state) {
		case "cleared": return { fill: "currentColor", opacity: 0.16 };
		case "open": return { fill: "none", opacity: 0.95 };
		case "reachable": return { fill: "none", strokeDasharray: "7 4", opacity: 0.9 };
		case "locked": return { fill: "none", strokeDasharray: "1 4", opacity: 0.35 };
	}
}

function evidenceBadge(status: SkillEvidenceStatus): string | null {
	if (status === "needsPractice") return "!";
	if (status === "mixed") return "±";
	return null;
}

export function SubjectMapWorld({
	map,
	view,
	onStart,
	startBusy,
	startError,
}: {
	map: SubjectMapV1;
	view: SubjectMapGapView;
	onStart: (skill: SubjectSkill) => void;
	startBusy: boolean;
	startError: string | null;
}) {
	const layout = useMemo(() => worldLayout(map), [map]);
	const statuses = useMemo(() => new Map(view.skills.map((skill) => [skill.skill.id, skill.evidence.status])), [view]);
	const states = useMemo(() => skillPathStates(map, statuses), [map, statuses]);
	const [goalId, setGoalId] = useState(map.goals[0] ?? "");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [viewport, setViewport] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
	const surface = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
	useEffect(() => {
		if (!map.goals.includes(goalId)) setGoalId(map.goals[0] ?? "");
	}, [goalId, map.goals]);
	const goalTitle = map.skills.find((skill) => skill.id === goalId)?.title ?? "";
	const route = useMemo(() => goalId ? routeToGoal(map, statuses, goalId) : null, [goalId, map, statuses]);
	const routeMembers = useMemo(() => new Set(route?.route ?? []), [route]);
	const chosenAlternatives = useMemo(
		() => new Set((route?.choices ?? []).map(({ dependent, option }) => `${option}\u0000${dependent}`)),
		[route],
	);
	const nodePositions = useMemo(() => new Map(layout.nodes.map((node) => [node.skillId, node])), [layout]);
	const selected = selectedId ? map.skills.find((skill) => skill.id === selectedId) ?? null : null;

	const viewportSize = () => ({
		w: surface.current?.clientWidth || layout.width,
		h: surface.current?.clientHeight || layout.height,
	});
	const fitFloor = () => fitZoomFor({ w: layout.width, h: layout.height }, viewportSize());
	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		const box = { w: layout.width, h: layout.height };
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = element.getBoundingClientRect();
			const size = { w: element.clientWidth || box.w, h: element.clientHeight || box.h };
			const delta = event.deltaMode === 1
				? event.deltaY * 16
				: event.deltaMode === 2
					? event.deltaY * (element.clientHeight || box.h)
					: event.deltaY;
			const factor = Math.exp(-delta * 0.0015);
			setViewport((current) => zoomedGraphView(
				current,
				factor,
				fitZoomFor(box, size),
				{ x: event.clientX - rect.left, y: event.clientY - rect.top },
				box,
				size,
			));
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [layout.height, layout.width]);
	const zoomAtCenter = (factor: number) => {
		const size = viewportSize();
		setViewport((current) => zoomedGraphView(current, factor, fitFloor(), { x: size.w / 2, y: size.h / 2 }, { w: layout.width, h: layout.height }, size));
	};
	const resetView = () => {
		const size = viewportSize();
		if (surface.current?.clientWidth && surface.current.clientHeight) {
			const zoom = fitZoomFor({ w: layout.width, h: layout.height }, size);
			setViewport(fitGraphView({ w: layout.width, h: layout.height }, size, zoom));
		} else {
			setViewport({ zoom: 1, x: 0, y: 0 });
		}
	};
	const pan = (dx: number, dy: number) => setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
	const selectedState = selected ? states.get(selected.id) ?? "locked" : null;
	const selectedEvidence = selected ? statuses.get(selected.id) ?? "notChecked" : null;
	return (
		<section aria-label="Subject map world" className="flex flex-col gap-4">
			{map.goals.length > 0 ? (
				<label className="flex items-center gap-2 text-sm">
					<span>Goal</span>
					<select aria-label="Goal" value={goalId} onChange={(event) => setGoalId(event.currentTarget.value)} className="rounded-sm border border-border bg-background px-2 py-1.5">
						{map.goals.map((id) => <option key={id} value={id}>{map.skills.find((skill) => skill.id === id)?.title ?? id}</option>)}
					</select>
				</label>
			) : <p className="text-sm text-muted-foreground">Mark goal skills in the list view to plan a route.</p>}

			<div className="flex flex-wrap gap-2">
				<button type="button" className="rounded-sm border border-border px-2 py-1 text-xs" onClick={() => zoomAtCenter(1.2)}>Zoom in</button>
				<button type="button" className="rounded-sm border border-border px-2 py-1 text-xs" onClick={() => zoomAtCenter(1 / 1.2)}>Zoom out</button>
				<button type="button" className="rounded-sm border border-border px-2 py-1 text-xs" onClick={resetView}>Reset view</button>
			</div>

			<div
				ref={surface}
				tabIndex={0}
				role="group"
				aria-label="Pan and zoom world map"
				className="h-[min(70vh,720px)] min-h-[420px] overflow-hidden rounded-sm border border-border/60 focus-visible:outline focus-visible:outline-2"
				onKeyDown={(event) => {
					switch (event.key) {
						case "ArrowLeft": event.preventDefault(); pan(40, 0); break;
						case "ArrowRight": event.preventDefault(); pan(-40, 0); break;
						case "ArrowUp": event.preventDefault(); pan(0, 40); break;
						case "ArrowDown": event.preventDefault(); pan(0, -40); break;
						case "+": case "=": event.preventDefault(); zoomAtCenter(1.2); break;
						case "-": event.preventDefault(); zoomAtCenter(1 / 1.2); break;
						case "0": event.preventDefault(); resetView(); break;
					}
				}}
				onPointerDown={(event) => {
					if (event.target instanceof Element && event.target.closest("[data-skill]")) return;
					drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: viewport.x, originY: viewport.y };
					try { event.currentTarget.setPointerCapture(event.pointerId); } catch { drag.current = null; }
				}}
				onPointerMove={(event) => {
					if (!drag.current || drag.current.pointerId !== event.pointerId) return;
					const currentDrag = drag.current;
					setViewport((current) => ({ ...current, x: currentDrag.originX + event.clientX - currentDrag.x, y: currentDrag.originY + event.clientY - currentDrag.y }));
				}}
				onPointerUp={(event) => {
					if (drag.current?.pointerId !== event.pointerId) return;
					drag.current = null;
					try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { return; }
				}}
				onPointerCancel={() => { drag.current = null; }}
			>
				<svg
					role="group"
					aria-label={`World map of ${map.title}`}
					width="100%"
					height="100%"
					className="select-none"
				>
					<g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
						{layout.regions.map((region) => <g key={region.id === null ? "__ungrouped" : region.id}>
							<rect x={region.x} y={region.y} width={region.width} height={region.height} rx={8} fill="none" stroke="currentColor" strokeOpacity={0.16} />
							<text x={region.x + 12} y={region.y + 22} fontSize={12} fill="currentColor" opacity={0.65}>{region.title}</text>
						</g>)}
						{map.edges.map((edge) => {
							const from = nodePositions.get(edge.prerequisite);
							const to = nodePositions.get(edge.dependent);
							if (!from || !to) return null;
							const highlighted = routeMembers.has(edge.prerequisite) && routeMembers.has(edge.dependent);
							return <line key={`required-${edge.prerequisite}-${edge.dependent}`} x1={from.x + WORLD_NODE.width} y1={from.y + WORLD_NODE.height / 2} x2={to.x} y2={to.y + WORLD_NODE.height / 2} stroke="currentColor" strokeWidth={highlighted ? 3 : 1.5} strokeOpacity={highlighted ? 0.9 : 0.18} />;
						})}
						{(map.alternatives ?? []).flatMap((group) => group.options.map((option) => {
							const from = nodePositions.get(option);
							const to = nodePositions.get(group.dependent);
							if (!from || !to) return null;
							const chosen = chosenAlternatives.has(`${option}\u0000${group.dependent}`);
							return <line key={`alternative-${option}-${group.dependent}`} data-highlighted={chosen ? "true" : "false"} x1={from.x + WORLD_NODE.width} y1={from.y + WORLD_NODE.height / 2} x2={to.x} y2={to.y + WORLD_NODE.height / 2} stroke="currentColor" strokeWidth={chosen ? 3 : 1.5} strokeOpacity={chosen ? 0.9 : 0.18} strokeDasharray="5 4" />;
						}))}
						{layout.nodes.map((node) => {
							const skill = map.skills.find((item) => item.id === node.skillId)!;
							const state = states.get(skill.id) ?? "locked";
							const evidence = statuses.get(skill.id) ?? "notChecked";
							const appearance = nodeAppearance(state);
							const evidenceMark = evidenceBadge(evidence);
							const onRoute = routeMembers.has(skill.id);
							const label = `${skill.title}: ${STATE_LABEL[state]}${skill.keystone ? ", keystone" : ""}${evidence === "needsPractice" || evidence === "mixed" ? `, ${skillEvidenceStatusLabel(evidence)}` : ""}${onRoute ? ", on route" : ""}`;
							const title = skill.title.length > 22 ? `${skill.title.slice(0, 22)}…` : skill.title;
							return <g
								key={skill.id}
								tabIndex={0}
								role="button"
								aria-label={label}
								data-state={state}
								data-skill={skill.id}
								className="cursor-pointer focus-visible:outline-none"
								onClick={() => setSelectedId(skill.id)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										setSelectedId(skill.id);
									}
								}}
							>
								<title>{label}</title>
								<rect x={node.x} y={node.y} width={WORLD_NODE.width} height={WORLD_NODE.height} rx={6} fill={appearance.fill} stroke="currentColor" strokeWidth={onRoute ? 3 : 1.5} strokeOpacity={appearance.opacity} strokeDasharray={appearance.strokeDasharray} />
								<text x={node.x + 8} y={node.y + 19} fontSize={11} fill="currentColor">
									<tspan>{STATE_GLYPH[state]} {title}{skill.keystone ? " ◆" : ""}</tspan>
									{evidenceMark && <tspan dx={5} aria-label={skillEvidenceStatusLabel(evidence)}>{evidenceMark}</tspan>}
								</text>
							</g>;
						})}
					</g>
				</svg>
			</div>

			<p className="text-xs text-muted-foreground">✓ cleared · ● open · ◐ reachable · ■ locked · ◆ keystone · dashed line = one of several alternative routes</p>

			<div className="grid gap-4 md:grid-cols-2">
				<div>
					<h2 className="text-sm font-medium">Route</h2>
					<ol aria-label={`Route to ${goalTitle || "goal"}`} className="list-decimal pl-5 text-sm">
						{route && route.route.length > 0 && route.route.map((id) => <li key={id}>{map.skills.find((skill) => skill.id === id)?.title ?? id} — {STATE_LABEL[states.get(id) ?? "locked"]}</li>)}
						{route && route.route.length === 0 && <li>Goal already has supporting evidence. This is not a mastery score.</li>}
					</ol>
				</div>
				{route && route.skipAhead.length > 0 && <div>
					<h2 className="text-sm font-medium">Skip-ahead checks</h2>
					<ul aria-label="Skip-ahead checks" className="flex flex-col gap-1 text-sm">
						{route.skipAhead.map((item) => <li key={item.skillId} className="flex items-center justify-between gap-2">
							<span>◆ {map.skills.find((skill) => skill.id === item.skillId)?.title ?? item.skillId} — covers {item.beneath} skills on the route</span>
							<button type="button" aria-label={`Select ${map.skills.find((skill) => skill.id === item.skillId)?.title ?? item.skillId}`} className="shrink-0 underline" onClick={() => setSelectedId(item.skillId)}>Select</button>
						</li>)}
					</ul>
				</div>}
			</div>

			{selected && selectedState && selectedEvidence && <section aria-label="Selected skill" className="flex flex-col gap-2 rounded-sm border border-border/60 p-3">
				<h2 className="text-base font-medium">{selected.title}</h2>
				<p className="text-sm">{selected.objective}</p>
				<dl className="grid gap-2 text-xs sm:grid-cols-3">
					<div><dt className="text-muted-foreground">Source</dt><dd><SkillSourceBadge skill={selected} /></dd></div>
					<div><dt className="text-muted-foreground">Path state</dt><dd>{STATE_GLYPH[selectedState]} {STATE_LABEL[selectedState]}</dd></div>
					<div><dt className="text-muted-foreground">Evidence</dt><dd>{skillEvidenceStatusLabel(selectedEvidence)}</dd></div>
				</dl>
				{selected.keystone === true && <p className="text-sm">◆ Keystone skill — demonstrating this can support a skip-ahead check.</p>}
				{startError && <p role="alert" className="text-sm text-destructive">{startError}</p>}
				<button type="button" disabled={startBusy} className="self-start rounded-sm border border-border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => onStart(selected)}>Start session</button>
			</section>}
		</section>
	);
}
