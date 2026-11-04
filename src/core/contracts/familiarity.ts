export const PLACEMENT_MAX_PROBES = 15;

export interface PlacementProbe {
	skillId: string;
	revision: number;
	result?: "supports" | "against" | "inconclusive";
	observationId?: string;
	/** onTarget tool-call ids issued while this probe was current. */
	callIds?: string[];
}

export interface PlacementRun {
	mapId: string;
	maxProbes: number;
	probes: PlacementProbe[];
	completedAt?: string;
}
