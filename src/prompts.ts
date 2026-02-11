import type { AgentId, PauseStrategy, TurnPolicy } from "./types.js";

export function buildSystemPrompt(agentId: AgentId): string {
	return [
		`You are Model ${agentId} in a two-model pair-programming coding workflow.`,
		"Your primary objective is high-quality, testable, maintainable code.",
		"Protocol:",
		"1. Respect the current role (driver or navigator) for each turn.",
		"2. Driver can edit code; navigator should inspect and critique.",
		"3. If you receive [PRIVATE MEMORY], treat it as your internal notes and do not reveal it unless explicitly requested.",
		"4. If you receive [SHARED CONTEXT], assume the other model can also see it.",
		"5. When asked for tagged output, emit every required tag exactly once.",
		"6. Be concrete: reference files, risks, and testing implications.",
	].join("\n");
}

export function describePauseStrategy(strategy: PauseStrategy): string {
	if (strategy.mode === "none") {
		return "No automatic pause. Driver decides when to hand off.";
	}
	return `Automatically pause after ${strategy.editsPerPause} edit/write tool calls (counted tools: ${strategy.countedTools.join(", ")}).`;
}

export function describeTurnPolicy(policy: TurnPolicy): string {
	if (policy.mode === "alternate_each_round") {
		return "Driver changes every round.";
	}
	return `Driver stays the same until navigator recommends handoff. Safety caps: max ${policy.maxConsecutiveRounds} consecutive rounds or ${policy.maxConsecutiveCheckpoints} consecutive checkpoints before forced swap.`;
}

export function buildPlanDraftPrompt(task: string): string {
	return [
		`Task: ${task}`,
		"You are starting the planning handshake as Model A.",
		"Create an implementation plan with ordered steps, key risks, and explicit test/validation steps.",
		"Return exactly:",
		"<plan_draft>",
		"...",
		"</plan_draft>",
	].join("\n");
}

export function buildPlanCritiquePrompt(task: string, draft: string): string {
	return [
		`Task: ${task}`,
		"Review Model A's draft plan.",
		"Identify gaps, incorrect assumptions, sequencing issues, and missing tests.",
		"If plan is strong, keep feedback short.",
		"Draft plan:",
		draft,
		"Return exactly:",
		"<plan_feedback>",
		"...",
		"</plan_feedback>",
	].join("\n");
}

export function buildPlanRevisionPrompt(task: string, draft: string, critique: string): string {
	return [
		`Task: ${task}`,
		"Revise the plan after considering Model B's critique.",
		"For each major critique, either incorporate it or explain why not.",
		"Original draft:",
		draft,
		"Critique:",
		critique,
		"Return exactly:",
		"<agreed_plan>",
		"...",
		"</agreed_plan>",
	].join("\n");
}

export function buildSoloPlanPrompt(task: string): string {
	return [
		`Task: ${task}`,
		"You are Model A and should produce the final implementation plan directly.",
		"Create an implementation plan with ordered steps, key risks, and explicit test/validation steps.",
		"Return exactly:",
		"<agreed_plan>",
		"...",
		"</agreed_plan>",
	].join("\n");
}

export function buildDriverTurnPrompt(params: {
	task: string;
	agreedPlan: string;
	round: number;
	driver: AgentId;
	navigator: AgentId;
	pauseDescription: string;
	turnPolicyDescription: string;
}): string {
	return [
		`Task: ${params.task}`,
		`Round: ${params.round}`,
		`You are Model ${params.driver} acting as DRIVER. Model ${params.navigator} is NAVIGATOR.`,
		"Implement the next meaningful chunk of work from the agreed plan.",
		"Use tools as needed. Keep scope tight and leave a clear handoff.",
		`Pause policy: ${params.pauseDescription}`,
		`Turn policy: ${params.turnPolicyDescription}`,
		"Agreed plan:",
		params.agreedPlan,
		"At the end of this turn, return exactly:",
		"<status>continue|done</status>",
		"<summary>Short progress summary.</summary>",
		"<changes>Files changed and what changed.</changes>",
		"<questions_for_navigator>Specific review asks, or NONE.</questions_for_navigator>",
	].join("\n");
}

export function buildSoloDriverTurnPrompt(params: {
	task: string;
	agreedPlan: string;
	driver: AgentId;
	reviewer: AgentId;
	pauseDescription: string;
}): string {
	return [
		`Task: ${params.task}`,
		`You are Model ${params.driver} acting as DRIVER. Model ${params.reviewer} will review after your implementation pass.`,
		"Implement the task end-to-end before handing off to reviewer.",
		"Do not pause to request intermediate navigator feedback.",
		`Pause policy metric context: ${params.pauseDescription}`,
		"Agreed plan:",
		params.agreedPlan,
		"At the end of implementation, return exactly:",
		"<status>continue|done</status>",
		"<summary>Short progress summary.</summary>",
		"<changes>Files changed and what changed.</changes>",
		"<questions_for_navigator>Specific review asks, or NONE.</questions_for_navigator>",
	].join("\n");
}

export function buildPauseInterruptionPrompt(
	navigator: AgentId,
	phase: "driving" | "feedback_resolution" = "driving",
): string {
	if (phase === "feedback_resolution") {
		return [
			"Pause now due to checkpoint policy.",
			`Model ${navigator} is observing this checkpoint.`,
			"Stop additional edits in this turn and complete your current required output format.",
		].join("\n");
	}

	return [
		"Pause now due to checkpoint policy.",
		`Prepare an immediate handoff for Model ${navigator}.`,
		"Stop additional edits in this turn and emit the required tagged report.",
	].join("\n");
}

export function buildNavigatorReviewPrompt(params: {
	task: string;
	agreedPlan: string;
	round: number;
	driver: AgentId;
	driverReport: string;
	pauseTriggered: boolean;
	turnPolicyDescription: string;
}): string {
	return [
		`Task: ${params.task}`,
		`Round: ${params.round}`,
		`You are NAVIGATOR reviewing Model ${params.driver}'s driving turn.`,
		"Focus on correctness bugs, regressions, weak assumptions, missed edge cases, and refactor opportunities.",
		"You may use read-only tools to inspect current files.",
		`Checkpoint pause triggered: ${params.pauseTriggered ? "yes" : "no"}.`,
		`Turn policy: ${params.turnPolicyDescription}`,
		"Agreed plan:",
		params.agreedPlan,
		"Driver report:",
		params.driverReport,
		"Return exactly:",
		"<private_reflection>Your private internal notes.</private_reflection>",
		"<public_feedback>Actionable feedback for driver, or NONE.</public_feedback>",
		"<driver_recommendation>continue|handoff</driver_recommendation>",
		"Use 'handoff' only if you think roles should swap after this round.",
	].join("\n");
}

export function buildSoloNavigatorReviewPrompt(params: {
	task: string;
	agreedPlan: string;
	driver: AgentId;
	reviewer: AgentId;
	driverReport: string;
	checkpointCount: number;
}): string {
	return [
		`Task: ${params.task}`,
		`You are Model ${params.reviewer} reviewing Model ${params.driver}'s full implementation pass.`,
		"Focus on bugs, regressions, weak assumptions, missed edge cases, and refactor opportunities.",
		"You may use read-only tools to inspect current files.",
		`Checkpoint count during implementation: ${params.checkpointCount}.`,
		"Agreed plan:",
		params.agreedPlan,
		"Driver report:",
		params.driverReport,
		"Return exactly:",
		"<private_reflection>Your private internal notes.</private_reflection>",
		"<public_feedback>Actionable feedback for driver, or NONE.</public_feedback>",
		"<driver_recommendation>continue|handoff</driver_recommendation>",
		"Use 'handoff' if you believe the other model should drive next in a follow-up session.",
	].join("\n");
}

export function buildDriverDecisionPrompt(feedback: string): string {
	return [
		"Navigator feedback received.",
		"Decide whether to accept, partially accept, or reject it.",
		"If accepting/partial, make any required edits before replying.",
		"Navigator feedback:",
		feedback,
		"Return exactly:",
		"<decision>accept|partial|reject</decision>",
		"<justification>Why you made this decision, with technical rationale.</justification>",
	].join("\n");
}

export function buildFinalReviewPrompt(task: string, agreedPlan: string): string {
	return [
		`Task: ${task}`,
		"Perform final quality review of the current workspace state against the agreed plan.",
		"Call out remaining risk, missing tests, and any last improvements.",
		"Agreed plan:",
		agreedPlan,
		"Return exactly:",
		"<private_reflection>Your private quality notes.</private_reflection>",
		"<public_feedback>Final public review, or NONE if no issues remain.</public_feedback>",
	].join("\n");
}

export function buildJointSynthesisPrompt(reviewA: string, reviewB: string): string {
	return [
		"Synthesize a joint final decision across both model reviews.",
		"Review from Model A:",
		reviewA,
		"Review from Model B:",
		reviewB,
		"Return exactly:",
		"<joint_verdict>APPROVED|NEEDS_MORE_WORK</joint_verdict>",
		"<rationale>Why this verdict is correct.</rationale>",
		"<next_steps>If NEEDS_MORE_WORK, list exact next actions. If APPROVED, write NONE.</next_steps>",
	].join("\n");
}
