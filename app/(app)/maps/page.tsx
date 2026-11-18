import { Suspense } from "react";
import { SubjectMapsHome } from "@/components/subject-maps";

export const dynamic = "force-dynamic";

export default function SubjectMapsPage() {
	return <Suspense fallback={null}><SubjectMapsHome /></Suspense>;
}
