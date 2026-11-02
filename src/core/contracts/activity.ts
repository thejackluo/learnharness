/** A trusted, declarative explore → explain activity (stack slot 6). The
 *  teacher authors finite data only; app-owned React renders the figure,
 *  table and text alternative. Nothing here executes, links or loads. */
export interface ActivityAxis {
	label: string;
	unit?: string;
}
export interface ActivityPoint {
	x: number;
	y: number;
}
export interface ActivitySeries {
	id: string;
	label: string;
	points: ActivityPoint[];
}
export interface ActivityCase {
	id: string;
	label: string;
	description?: string;
	series: ActivitySeries[];
}
export interface CaseComparisonActivityV1 {
	version: 1;
	kind: "case-comparison";
	title: string;
	objective: string;
	instructions: string;
	xAxis: ActivityAxis;
	yAxis: ActivityAxis;
	cases: ActivityCase[];
	textAlternative: string;
}
/** What an explanation check snapshots from its canonical activity source. */
export interface ActivityGuide {
	title: string;
	objective: string;
	instructions: string;
}
/** The resolved teaching stimulus an answer snapshots: the persisted
 *  activity result message + its call, the guide shown, and that the
 *  stimulus was app-rendered from validated data (never generated code). */
export interface TeachingStimulusSnapshot {
	kind: "teaching-stimulus";
	messageId: string;
	toolCallId: string;
	guide: ActivityGuide;
	provenance: "appRenderedActivity";
}
export const ACTIVITY_LIMITS = {
	cases: 8,
	series: 4,
	points: 200,
	label: 120,
	unit: 24,
	text: 2000,
	magnitude: 1e9,
} as const;
