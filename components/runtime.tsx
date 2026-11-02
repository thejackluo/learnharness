"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { PublicRuntime } from "@/src/core";
import { installUnauthorizedRedirect } from "@/components/auth-response";

const RuntimeContext = createContext<PublicRuntime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: PublicRuntime; children: ReactNode }) {
	useEffect(() => installUnauthorizedRedirect(runtime.mode), [runtime.mode]);
	return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntimeOptional(): PublicRuntime | null {
	return useContext(RuntimeContext);
}

export function useRuntime(): PublicRuntime {
	const runtime = useRuntimeOptional();
	if (!runtime) throw new Error("useRuntime requires <RuntimeProvider>");
	return runtime;
}
