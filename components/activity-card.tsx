"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { ArtifactPartProps, CaseComparisonActivityV1 } from "@/src/core";
import { activityOf, activityScales } from "@/src/core";

// Non-color encodings: every series differs by dash pattern AND marker.
const DASHES = ["", "6 4", "2 3", "10 3 2 3"];
const W = 480, H = 280, PAD = { l: 52, r: 16, t: 12, b: 40 };

function fmt(n: number): string {
	return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4)));
}

function Marker({ i, x, y }: { i: number; x: number; y: number }) {
	const s = 3.5;
	switch (i % 4) {
		case 0: return <circle cx={x} cy={y} r={s} />;
		case 1: return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} />;
		case 2: return <polygon points={`${x},${y - s - 1} ${x + s + 1},${y + s} ${x - s - 1},${y + s}`} />;
		default: return <polygon points={`${x},${y - s - 1} ${x + s + 1},${y} ${x},${y + s + 1} ${x - s - 1},${y}`} />;
	}
}

function axisText(a: { label: string; unit?: string }): string {
	return a.unit ? `${a.label} (${a.unit})` : a.label;
}

/** The trusted renderer: app-owned SVG + table + text from validated data.
 *  All activity text renders as plain React text (escaped, never markdown,
 *  so nothing can link or load). No animation, so reduced motion holds. */
export function ActivityView({ activity, toolCallId }: { activity: CaseComparisonActivityV1; toolCallId: string }) {
	const [selected, setSelected] = useState(0);
	const radios = useRef<(HTMLButtonElement | null)[]>([]);
	const uid = useId();
	const scales = activityScales(activity);
	const current = activity.cases[selected]!;
	const sx = (x: number) => PAD.l + ((x - scales.x.min) / (scales.x.max - scales.x.min)) * (W - PAD.l - PAD.r);
	const sy = (y: number) => H - PAD.b - ((y - scales.y.min) / (scales.y.max - scales.y.min)) * (H - PAD.t - PAD.b);
	const choose = (i: number) => {
		const n = activity.cases.length;
		const next = (i + n) % n;
		setSelected(next);
		radios.current[next]?.focus();
	};
	const onKeyDown = (e: KeyboardEvent) => {
		const keys: Record<string, () => void> = {
			ArrowRight: () => choose(selected + 1), ArrowDown: () => choose(selected + 1),
			ArrowLeft: () => choose(selected - 1), ArrowUp: () => choose(selected - 1),
			Home: () => choose(0), End: () => choose(activity.cases.length - 1),
		};
		const run = keys[e.key];
		if (!run) return;
		e.preventDefault();
		run();
	};
	const ticks = (min: number, max: number) => [min, (min + max) / 2, max];
	const captionId = `${uid}-caption`;
	return (
		<section id={`activity-${toolCallId}`} aria-labelledby={`${uid}-title`} className="space-y-3 rounded-xl border bg-card p-4 text-sm text-card-foreground" data-testid="activity-card">
			<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Activity</div>
			<h3 id={`${uid}-title`} className="font-semibold">{activity.title}</h3>
			<p className="whitespace-pre-wrap"><strong>Goal: </strong>{activity.objective}</p>
			<p className="whitespace-pre-wrap text-muted-foreground">{activity.instructions}</p>
			<div role="radiogroup" aria-label="Cases" className="flex flex-wrap gap-2" onKeyDown={onKeyDown} data-testid="activity-cases">
				{activity.cases.map((c, i) => (
					<button
						key={c.id}
						ref={(el) => { radios.current[i] = el; }}
						type="button"
						role="radio"
						aria-checked={i === selected}
						tabIndex={i === selected ? 0 : -1}
						onClick={() => choose(i)}
						data-case={c.id}
						className={i === selected ? "rounded-lg border-2 border-primary bg-accent px-3 py-1 font-semibold" : "rounded-lg border px-3 py-1 hover:bg-accent/50"}
					>
						{i === selected ? "● " : "○ "}{c.label}
					</button>
				))}
			</div>
			<figure className="m-0">
				<svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={captionId} className="h-auto w-full max-w-full" data-testid="activity-plot">
					<line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="currentColor" strokeOpacity={0.5} />
					<line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} stroke="currentColor" strokeOpacity={0.5} />
					{ticks(scales.x.min, scales.x.max).map((t) => <text key={`x${t}`} x={sx(t)} y={H - PAD.b + 14} fontSize={11} textAnchor="middle" fill="currentColor">{fmt(t)}</text>)}
					{ticks(scales.y.min, scales.y.max).map((t) => <text key={`y${t}`} x={PAD.l - 6} y={sy(t) + 4} fontSize={11} textAnchor="end" fill="currentColor">{fmt(t)}</text>)}
					<text x={(PAD.l + W - PAD.r) / 2} y={H - 6} fontSize={12} textAnchor="middle" fill="currentColor">{axisText(activity.xAxis)}</text>
					<text x={12} y={(PAD.t + H - PAD.b) / 2} fontSize={12} textAnchor="middle" fill="currentColor" transform={`rotate(-90 12 ${(PAD.t + H - PAD.b) / 2})`}>{axisText(activity.yAxis)}</text>
					{current.series.map((s, i) => (
						<g key={s.id} data-series={s.id} fill="currentColor">
							<polyline points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray={DASHES[i] || undefined} />
							{s.points.length <= 40 && s.points.map((p, j) => <Marker key={j} i={i} x={sx(p.x)} y={sy(p.y)} />)}
						</g>
					))}
				</svg>
				<figcaption id={captionId} className="mt-1 text-xs text-muted-foreground" aria-live="polite" data-testid="activity-caption">
					Showing {current.label}: {axisText(activity.yAxis)} against {axisText(activity.xAxis)}.
					{current.description ? ` ${current.description}` : ""}
				</figcaption>
			</figure>
			<ul aria-label="Legend" className="flex flex-wrap gap-3 text-xs">
				{current.series.map((s, i) => (
					<li key={s.id} className="flex items-center gap-1">
						<svg width="28" height="10" aria-hidden="true" fill="currentColor">
							<line x1="0" y1="5" x2="28" y2="5" stroke="currentColor" strokeWidth={2} strokeDasharray={DASHES[i] || undefined} />
							<Marker i={i} x={14} y={5} />
						</svg>
						{s.label}
					</li>
				))}
			</ul>
			<details>
				<summary className="cursor-pointer">Data table</summary>
				<table className="mt-2 w-full text-xs" data-testid="activity-table">
					<caption className="text-left text-muted-foreground">{current.label}</caption>
					<thead><tr><th scope="col" className="text-left">Series</th><th scope="col" className="text-left">{axisText(activity.xAxis)}</th><th scope="col" className="text-left">{axisText(activity.yAxis)}</th></tr></thead>
					<tbody>
						{current.series.flatMap((s) => s.points.map((p, j) => (
							<tr key={`${s.id}-${j}`}><td>{s.label}</td><td>{fmt(p.x)}</td><td>{fmt(p.y)}</td></tr>
						)))}
					</tbody>
				</table>
			</details>
			<p className="whitespace-pre-wrap" data-testid="activity-text"><strong>Description: </strong>{activity.textAlternative}</p>
		</section>
	);
}

export function ActivityCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const activity = activityOf(part.output);
	return activity ? <ActivityView activity={activity} toolCallId={part.toolCallId} /> : null;
}

/** The dock/answer reference to the activity an explanation is about. */
export function ActivityStimulusNote({ toolCallId, title, objective }: { toolCallId: string; title?: string; objective?: string }) {
	return (
		<div className="text-xs text-muted-foreground" data-testid="activity-stimulus">
			About the activity{title ? <> “{title}”</> : " above"} ·{" "}
			<a href={`#activity-${toolCallId}`} className="underline">show activity</a>
			{objective !== undefined && <div className="whitespace-pre-wrap">Goal: {objective}</div>}
		</div>
	);
}
