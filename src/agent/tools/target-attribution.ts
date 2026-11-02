import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";

/** Where the session's chosen target stands this turn: absent, current, or no longer current. */
export type SessionTargetState = "none" | "current" | "unavailable";

const REJECTION: Record<Exclude<SessionTargetState, "current">, string> = {
	none: "onTarget is only valid in a session started from a subject-map skill; this session has none — omit onTarget",
	unavailable: "this session's target skill is no longer current (its objective changed, or the skill or map is gone) — omit onTarget",
};

/** Rejects an `onTarget` claim before the wrapped pose runs unless the session target is current. */
export function withTargetAttribution<T extends AgentTool<any, any>>(tool: T, state: SessionTargetState = "none"): T {
	return {
		...tool,
		execute: async (toolCallId, input, ...rest) => {
			if ((input as { onTarget?: unknown } | undefined)?.onTarget === true && state !== "current") {
				return invalidInputResult(tool.name, [REJECTION[state]]);
			}
			return tool.execute(toolCallId, input, ...rest);
		},
	};
}
