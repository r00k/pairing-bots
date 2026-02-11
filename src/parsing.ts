import type { DriverDecision, DriverReport, FinalReview, NavigatorReview } from "./types.js";

export function extractTag(text: string, tag: string): string | undefined {
	const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
	const match = text.match(pattern);
	return match?.[1]?.trim();
}

export function parseDriverReport(raw: string): DriverReport {
	const statusRaw = extractTag(raw, "status")?.toLowerCase();
	const status = statusRaw === "done" ? "done" : "continue";
	const summary = extractTag(raw, "summary") ?? raw.trim();
	const changes = extractTag(raw, "changes") ?? "(driver did not provide a structured changes section)";
	const questionsForNavigator = extractTag(raw, "questions_for_navigator") ?? "NONE";

	return {
		status,
		summary,
		changes,
		questionsForNavigator,
		raw,
	};
}

export function parseNavigatorReview(raw: string): NavigatorReview {
	const privateReflection = extractTag(raw, "private_reflection") ?? "(no private reflection provided)";
	const publicFeedback = extractTag(raw, "public_feedback") ?? "NONE";
	const normalizedFeedback = publicFeedback.trim().toUpperCase().replace(/[.!]+$/, "");
	const hasFeedback = normalizedFeedback !== "NONE";
	const recommendationRaw = extractTag(raw, "driver_recommendation")?.toLowerCase();
	const driverRecommendation = recommendationRaw === "handoff" ? "handoff" : "continue";

	return {
		privateReflection,
		publicFeedback,
		hasFeedback,
		driverRecommendation,
		raw,
	};
}

export function parseDriverDecision(raw: string): DriverDecision {
	const decisionRaw = extractTag(raw, "decision")?.toLowerCase();
	const decision = decisionRaw === "accept" || decisionRaw === "reject" ? decisionRaw : "partial";
	const justification = extractTag(raw, "justification") ?? raw.trim();

	return {
		decision,
		justification,
		raw,
	};
}

export function parseJointVerdict(raw: string): Pick<FinalReview, "jointVerdict" | "rationale" | "nextSteps" | "raw"> {
	const verdictRaw = extractTag(raw, "joint_verdict")?.toUpperCase();
	const jointVerdict = verdictRaw === "APPROVED" ? "APPROVED" : "NEEDS_MORE_WORK";
	const rationale = extractTag(raw, "rationale") ?? raw.trim();
	const nextSteps = extractTag(raw, "next_steps") ?? "NONE";

	return {
		jointVerdict,
		rationale,
		nextSteps,
		raw,
	};
}
