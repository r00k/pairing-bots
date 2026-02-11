import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	buildDriverDecisionPrompt,
	buildDriverTurnPrompt,
	buildFinalReviewPrompt,
	buildJointSynthesisPrompt,
	buildNavigatorReviewPrompt,
	buildPauseInterruptionPrompt,
	buildPlanCritiquePrompt,
	buildPlanDraftPrompt,
	buildPlanRevisionPrompt,
	buildSoloDriverTurnPrompt,
	buildSoloNavigatorReviewPrompt,
	buildSoloPlanPrompt,
	describePauseStrategy,
	describeTurnPolicy,
} from "./prompts.js";
import { parseDriverDecision, parseDriverReport, parseJointVerdict, parseNavigatorReview } from "./parsing.js";
import { ModelWorker } from "./model-worker.js";
import { SessionObserver } from "./observability.js";
import type {
	AgentId,
	ContributionSummary,
	DriverDecision,
	FinalReview,
	PairAgentConfig,
	PairRunResult,
	PauseStrategy,
	RoundResult,
	RunSummary,
	SharedEntry,
} from "./types.js";

function otherAgent(id: AgentId): AgentId {
	return id === "A" ? "B" : "A";
}

function formatSharedEntry(entry: SharedEntry): string {
	return [`Stage: ${entry.stage}`, `Actor: ${entry.actor}`, `Timestamp: ${new Date(entry.timestamp).toISOString()}`, entry.content].join(
		"\n",
	);
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function estimateWrittenBytes(toolName: string, args: unknown): number {
	if (!args || typeof args !== "object") {
		return 0;
	}

	if (toolName === "write") {
		const content = (args as { content?: unknown }).content;
		return typeof content === "string" ? byteLength(content) : 0;
	}

	if (toolName === "edit") {
		const newText = (args as { newText?: unknown }).newText;
		return typeof newText === "string" ? byteLength(newText) : 0;
	}

	return 0;
}

function contributionTemplate(agent: AgentId): ContributionSummary {
	return {
		agent,
		estimatedWrittenBytes: 0,
		editWriteCallCount: 0,
		roundsDriven: 0,
		checkpointsWhileDriving: 0,
		roughCodeSharePercent: 0,
	};
}

function roundPercent(value: number): number {
	return Math.round(value * 10) / 10;
}

interface DriverExecutionTracker {
	onEvent: (event: AgentEvent) => void;
	setPhase: (phase: "driving" | "feedback_resolution") => void;
	snapshot: () => {
		pauseTriggered: boolean;
		checkpointCount: number;
		editWriteCallCount: number;
		estimatedWrittenBytes: number;
	};
}

function createDriverExecutionTracker(params: {
	pauseStrategy: PauseStrategy;
	onCheckpoint?: (phase: "driving" | "feedback_resolution") => void;
}): DriverExecutionTracker {
	let pauseTriggered = false;
	let countedEdits = 0;
	let nextCheckpointAt = params.pauseStrategy.mode === "every_n_file_edits" ? params.pauseStrategy.editsPerPause : Infinity;
	let checkpointCount = 0;
	let editWriteCallCount = 0;
	let estimatedWrittenBytes = 0;
	const pendingWriteEstimates = new Map<string, number>();
	let currentPhase: "driving" | "feedback_resolution" = "driving";

	const onEvent = (event: AgentEvent): void => {
		if (event.type === "tool_execution_start" && (event.toolName === "edit" || event.toolName === "write")) {
			pendingWriteEstimates.set(event.toolCallId, estimateWrittenBytes(event.toolName, event.args));
			return;
		}

		if (params.pauseStrategy.mode !== "every_n_file_edits") {
			if (event.type === "tool_execution_end" && !event.isError && (event.toolName === "edit" || event.toolName === "write")) {
				editWriteCallCount += 1;
				estimatedWrittenBytes += pendingWriteEstimates.get(event.toolCallId) ?? 0;
				pendingWriteEstimates.delete(event.toolCallId);
			}
			return;
		}

		if (event.type !== "tool_execution_end") {
			return;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			if (!event.isError) {
				editWriteCallCount += 1;
				estimatedWrittenBytes += pendingWriteEstimates.get(event.toolCallId) ?? 0;
			}
			pendingWriteEstimates.delete(event.toolCallId);
		}

		if (event.isError) {
			return;
		}
		if (!params.pauseStrategy.countedTools.includes(event.toolName)) {
			return;
		}

		countedEdits += 1;
		if (countedEdits < nextCheckpointAt) {
			return;
		}

		pauseTriggered = true;
		checkpointCount += 1;
		nextCheckpointAt += params.pauseStrategy.editsPerPause;
		params.onCheckpoint?.(currentPhase);
	};

	return {
		onEvent,
		setPhase: (phase) => {
			currentPhase = phase;
		},
		snapshot: () => ({
			pauseTriggered,
			checkpointCount,
			editWriteCallCount,
			estimatedWrittenBytes,
		}),
	};
}

interface ExecutionResult {
	rounds: RoundResult[];
	checkpointCount: number;
	swapCount: number;
	contributions: Record<AgentId, ContributionSummary>;
	finalReview?: FinalReview;
}

export class PairProgrammingOrchestrator {
	private readonly config: PairAgentConfig;
	private readonly workers: Record<AgentId, ModelWorker>;
	private readonly sharedJournal: SharedEntry[] = [];
	private readonly observer: SessionObserver | undefined;

	constructor(config: PairAgentConfig, options?: { observer?: SessionObserver }) {
		this.config = config;
		this.observer = options?.observer;
		this.workers = {
			A: new ModelWorker("A", config.modelA, config.cwd),
			B: new ModelWorker("B", config.modelB, config.cwd),
		};
	}

	private async runPromptWithObservability(params: {
		actor: AgentId;
		prompt: string;
		promptKind: string;
		phase: string;
		round?: number;
		onEvent?: (event: AgentEvent) => void;
	}): Promise<string> {
		const worker = this.workers[params.actor];

		this.observer?.recordPromptStart({
			actor: params.actor,
			phase: params.phase,
			promptKind: params.promptKind,
			prompt: params.prompt,
			...(params.round !== undefined ? { round: params.round } : {}),
		});

		const response = await worker.runPrompt(params.prompt, {
			onEvent: (event) => {
					this.observer?.recordAgentEvent({
						actor: params.actor,
						phase: params.phase,
						event,
						...(params.round !== undefined ? { round: params.round } : {}),
					});
				params.onEvent?.(event);
			},
		});

		this.observer?.recordPromptEnd({
			actor: params.actor,
			phase: params.phase,
			promptKind: params.promptKind,
			response,
			...(params.round !== undefined ? { round: params.round } : {}),
		});

		return response;
	}

	private broadcastShared(stage: string, actor: AgentId | "system", content: string): void {
		const entry: SharedEntry = {
			stage,
			actor,
			content,
			timestamp: Date.now(),
		};
		this.sharedJournal.push(entry);
		const rendered = formatSharedEntry(entry);
		this.workers.A.appendSharedContext(rendered);
		this.workers.B.appendSharedContext(rendered);
	}

	private async collaborativePlanning(task: string): Promise<string> {
		// Planning is read-only; no model should modify files during plan negotiation.
		this.workers.A.setRole("navigator");
		this.workers.B.setRole("navigator");

		const aDraftRaw = await this.runPromptWithObservability({
			actor: "A",
			prompt: buildPlanDraftPrompt(task),
			promptKind: "plan_draft",
			phase: "planning",
		});
		const aDraft = aDraftRaw.trim();
		this.broadcastShared("plan_draft", "A", aDraft);

		const bFeedbackRaw = await this.runPromptWithObservability({
			actor: "B",
			prompt: buildPlanCritiquePrompt(task, aDraft),
			promptKind: "plan_feedback",
			phase: "planning",
		});
		const bFeedback = bFeedbackRaw.trim();
		this.broadcastShared("plan_feedback", "B", bFeedback);

		const aFinalRaw = await this.runPromptWithObservability({
			actor: "A",
			prompt: buildPlanRevisionPrompt(task, aDraft, bFeedback),
			promptKind: "plan_revision",
			phase: "planning",
		});
		const agreedPlan = aFinalRaw.trim();
		this.broadcastShared("plan_agreed", "A", agreedPlan);

		return agreedPlan;
	}

	private async soloPlanning(task: string): Promise<string> {
		this.workers.A.setRole("navigator");
		this.workers.B.setRole("navigator");

		const aPlanRaw = await this.runPromptWithObservability({
			actor: "A",
			prompt: buildSoloPlanPrompt(task),
			promptKind: "plan_solo",
			phase: "planning",
		});
		const agreedPlan = aPlanRaw.trim();
		this.broadcastShared("plan_agreed", "A", agreedPlan);
		return agreedPlan;
	}

	private synthesizeSoloFinalReview(round: RoundResult): FinalReview {
		const reviewA = parseNavigatorReview(
			[
				"<private_reflection>Skipped extra final review in solo mode.</private_reflection>",
				round.driverDecision
					? `<public_feedback>Driver decision: ${round.driverDecision.decision}. ${round.driverDecision.justification}</public_feedback>`
					: "<public_feedback>NONE</public_feedback>",
				"<driver_recommendation>continue</driver_recommendation>",
			].join("\n"),
		);
		const reviewB = round.navigatorReview;
		const accepted = round.driverDecision?.decision === "accept";
		const jointVerdict = !reviewB.hasFeedback || accepted ? "APPROVED" : "NEEDS_MORE_WORK";
		const rationale =
			jointVerdict === "APPROVED"
				? "Solo mode completed after B's final review and A's integration decision."
				: "B provided final feedback and A did not fully accept it in solo mode.";
		const nextSteps = jointVerdict === "APPROVED" ? "NONE" : reviewB.publicFeedback;

		this.broadcastShared(
			"joint_verdict",
			"system",
			`Verdict: ${jointVerdict}\nRationale: ${rationale}\nNext steps: ${nextSteps}`,
		);

		return {
			reviewA,
			reviewB,
			jointVerdict,
			rationale,
			nextSteps,
			raw: "synthetic_solo_final_review",
		};
	}

	private async runRound(task: string, agreedPlan: string, round: number, driverId: AgentId): Promise<RoundResult> {
		const navigatorId = otherAgent(driverId);
		const driver = this.workers[driverId];
		const navigator = this.workers[navigatorId];

		driver.setRole("driver");
		navigator.setRole("navigator");

		const pauseDescription = describePauseStrategy(this.config.pauseStrategy);
		const turnPolicyDescription = describeTurnPolicy(this.config.turnPolicy);
		const driverPrompt = buildDriverTurnPrompt({
			task,
			agreedPlan,
			round,
			driver: driverId,
			navigator: navigatorId,
			pauseDescription,
			turnPolicyDescription,
		});

		const executionTracker = createDriverExecutionTracker({
			pauseStrategy: this.config.pauseStrategy,
			onCheckpoint: (phase) => {
				driver.agent.steer({
					role: "user",
					content: [{ type: "text", text: buildPauseInterruptionPrompt(navigatorId, phase) }],
					timestamp: Date.now(),
				});
			},
		});

		const driverReportRaw = await this.runPromptWithObservability({
			actor: driverId,
			prompt: driverPrompt,
			promptKind: "driver_turn",
			phase: "driving",
			round,
			onEvent: executionTracker.onEvent,
		});
		const driverReport = parseDriverReport(driverReportRaw);
		this.broadcastShared(
			"driver_report",
			driverId,
			[
				`Round ${round}`,
				`Status: ${driverReport.status}`,
				`Summary: ${driverReport.summary}`,
				`Changes: ${driverReport.changes}`,
				`Navigator questions: ${driverReport.questionsForNavigator}`,
			].join("\n"),
		);
		const drivingStats = executionTracker.snapshot();

		const navigatorReviewRaw = await this.runPromptWithObservability({
			actor: navigatorId,
			prompt: buildNavigatorReviewPrompt({
				task,
				agreedPlan,
				round,
				driver: driverId,
				driverReport: driverReport.raw,
				pauseTriggered: drivingStats.pauseTriggered,
				turnPolicyDescription,
			}),
			promptKind: "navigator_review",
			phase: "navigation",
			round,
		});
		const navigatorReview = parseNavigatorReview(navigatorReviewRaw);
		navigator.appendPrivateMemory(navigatorReview.privateReflection);

		if (navigatorReview.hasFeedback) {
			this.broadcastShared("navigator_feedback", navigatorId, navigatorReview.publicFeedback);
		} else {
			this.broadcastShared("navigator_feedback", navigatorId, "NONE");
		}
		this.broadcastShared("navigator_handoff_signal", navigatorId, navigatorReview.driverRecommendation);

		let driverDecision: DriverDecision | undefined;
		if (navigatorReview.hasFeedback) {
			executionTracker.setPhase("feedback_resolution");
			const driverDecisionRaw = await this.runPromptWithObservability({
				actor: driverId,
				prompt: buildDriverDecisionPrompt(navigatorReview.publicFeedback),
				promptKind: "driver_decision",
				phase: "feedback_resolution",
				round,
				onEvent: executionTracker.onEvent,
			});
			driverDecision = parseDriverDecision(driverDecisionRaw);
			this.broadcastShared(
				"driver_decision",
				driverId,
				`Decision: ${driverDecision.decision}\nJustification: ${driverDecision.justification}`,
			);
		}

		const executionStats = executionTracker.snapshot();

		return {
			round,
			driver: driverId,
			navigator: navigatorId,
			pauseTriggered: executionStats.pauseTriggered,
			checkpointCount: executionStats.checkpointCount,
			editWriteCallCount: executionStats.editWriteCallCount,
			estimatedWrittenBytes: executionStats.estimatedWrittenBytes,
			driverReport,
			navigatorReview,
			...(driverDecision ? { driverDecision } : {}),
		};
	}

	private shouldSwapDriver(
		result: RoundResult,
		consecutiveRoundsWithDriver: number,
		consecutiveCheckpointsWithDriver: number,
	): { swap: boolean; reason: string } {
		if (this.config.turnPolicy.mode === "alternate_each_round") {
			return { swap: true, reason: "alternate_each_round" };
		}

		if (result.navigatorReview.driverRecommendation === "handoff") {
			return { swap: true, reason: "navigator_requested_handoff" };
		}

		if (consecutiveRoundsWithDriver >= this.config.turnPolicy.maxConsecutiveRounds) {
			return {
				swap: true,
				reason: `safety_cap_rounds_${this.config.turnPolicy.maxConsecutiveRounds}`,
			};
		}

		if (consecutiveCheckpointsWithDriver >= this.config.turnPolicy.maxConsecutiveCheckpoints) {
			return {
				swap: true,
				reason: `safety_cap_checkpoints_${this.config.turnPolicy.maxConsecutiveCheckpoints}`,
			};
		}

		return { swap: false, reason: "continue_same_driver" };
	}

	private async runPairedExecution(task: string, agreedPlan: string): Promise<ExecutionResult> {
		const rounds: RoundResult[] = [];
		let driverId = this.config.driverStartsAs;
		let consecutiveRoundsWithDriver = 0;
		let consecutiveCheckpointsWithDriver = 0;
		let swapCount = 0;
		let checkpointCount = 0;
		const contributions: Record<AgentId, ContributionSummary> = {
			A: contributionTemplate("A"),
			B: contributionTemplate("B"),
		};

		for (let round = 1; round <= this.config.maxRounds; round += 1) {
			this.observer?.record({
				category: "orchestrator",
				name: "round_start",
				actor: "system",
				round,
				details: { driver: driverId, navigator: otherAgent(driverId) },
			});

			const result = await this.runRound(task, agreedPlan, round, driverId);
			rounds.push(result);
			checkpointCount += result.checkpointCount;
			consecutiveRoundsWithDriver += 1;
			consecutiveCheckpointsWithDriver += result.checkpointCount;
			contributions[driverId].roundsDriven += 1;
			contributions[driverId].checkpointsWhileDriving += result.checkpointCount;
			contributions[driverId].editWriteCallCount += result.editWriteCallCount;
			contributions[driverId].estimatedWrittenBytes += result.estimatedWrittenBytes;

			this.observer?.record({
				category: "orchestrator",
				name: "round_end",
				actor: "system",
				round,
				details: {
					driverStatus: result.driverReport.status,
					navigatorHasFeedback: result.navigatorReview.hasFeedback,
					navigatorRecommendation: result.navigatorReview.driverRecommendation,
					checkpointCount: result.checkpointCount,
					editWriteCallCount: result.editWriteCallCount,
				},
			});

			const shouldStop = result.driverReport.status === "done" && !result.navigatorReview.hasFeedback;
			if (shouldStop) {
				this.broadcastShared("loop_stop", "system", `Stopped at round ${round} because driver signaled done and navigator had no feedback.`);
				break;
			}

			if (round === this.config.maxRounds) {
				this.broadcastShared("loop_stop", "system", `Reached max rounds (${this.config.maxRounds}).`);
				break;
			}

			const swapDecision = this.shouldSwapDriver(result, consecutiveRoundsWithDriver, consecutiveCheckpointsWithDriver);
			if (swapDecision.swap) {
				const previousDriver = driverId;
				driverId = otherAgent(driverId);
				swapCount += 1;
				consecutiveRoundsWithDriver = 0;
				consecutiveCheckpointsWithDriver = 0;
				this.broadcastShared(
					"driver_swap",
					"system",
					`Swapped driver from ${previousDriver} to ${driverId}. Reason: ${swapDecision.reason}.`,
				);
				this.observer?.record({
					category: "orchestrator",
					name: "driver_swap",
					actor: "system",
					round,
					details: { from: previousDriver, to: driverId, reason: swapDecision.reason },
				});
			}
		}

		return {
			rounds,
			checkpointCount,
			swapCount,
			contributions,
		};
	}

	private async runSoloDriverThenReviewerExecution(task: string, agreedPlan: string): Promise<ExecutionResult> {
		const round = 1;
		const driverId: AgentId = "A";
		const reviewerId: AgentId = "B";
		const driver = this.workers[driverId];
		const reviewer = this.workers[reviewerId];

		driver.setRole("driver");
		reviewer.setRole("navigator");

		this.observer?.record({
			category: "orchestrator",
			name: "round_start",
			actor: "system",
			round,
			details: { driver: driverId, navigator: reviewerId, mode: "solo_driver_then_reviewer" },
		});

		const executionTracker = createDriverExecutionTracker({
			pauseStrategy: this.config.pauseStrategy,
		});

		const driverReportRaw = await this.runPromptWithObservability({
			actor: driverId,
			prompt: buildSoloDriverTurnPrompt({
				task,
				agreedPlan,
				driver: driverId,
				reviewer: reviewerId,
				pauseDescription: describePauseStrategy(this.config.pauseStrategy),
			}),
			promptKind: "driver_turn_solo",
			phase: "driving",
			round,
			onEvent: executionTracker.onEvent,
		});
		const driverReport = parseDriverReport(driverReportRaw);
		this.broadcastShared(
			"driver_report",
			driverId,
			[
				`Round ${round}`,
				`Status: ${driverReport.status}`,
				`Summary: ${driverReport.summary}`,
				`Changes: ${driverReport.changes}`,
				`Navigator questions: ${driverReport.questionsForNavigator}`,
			].join("\n"),
		);

		const drivingStats = executionTracker.snapshot();
		const navigatorReviewRaw = await this.runPromptWithObservability({
			actor: reviewerId,
			prompt: buildSoloNavigatorReviewPrompt({
				task,
				agreedPlan,
				driver: driverId,
				reviewer: reviewerId,
				driverReport: driverReport.raw,
				checkpointCount: drivingStats.checkpointCount,
			}),
			promptKind: "navigator_review_solo",
			phase: "navigation",
			round,
		});
		const navigatorReview = parseNavigatorReview(navigatorReviewRaw);
		reviewer.appendPrivateMemory(navigatorReview.privateReflection);

		if (navigatorReview.hasFeedback) {
			this.broadcastShared("navigator_feedback", reviewerId, navigatorReview.publicFeedback);
		} else {
			this.broadcastShared("navigator_feedback", reviewerId, "NONE");
		}
		this.broadcastShared("navigator_handoff_signal", reviewerId, navigatorReview.driverRecommendation);

		let driverDecision: DriverDecision | undefined;
		if (navigatorReview.hasFeedback) {
			executionTracker.setPhase("feedback_resolution");
			const driverDecisionRaw = await this.runPromptWithObservability({
				actor: driverId,
				prompt: buildDriverDecisionPrompt(navigatorReview.publicFeedback),
				promptKind: "driver_decision",
				phase: "feedback_resolution",
				round,
				onEvent: executionTracker.onEvent,
			});
			driverDecision = parseDriverDecision(driverDecisionRaw);
			this.broadcastShared(
				"driver_decision",
				driverId,
				`Decision: ${driverDecision.decision}\nJustification: ${driverDecision.justification}`,
			);
		}

		const executionStats = executionTracker.snapshot();
		const roundResult: RoundResult = {
			round,
			driver: driverId,
			navigator: reviewerId,
			pauseTriggered: executionStats.pauseTriggered,
			checkpointCount: executionStats.checkpointCount,
			editWriteCallCount: executionStats.editWriteCallCount,
			estimatedWrittenBytes: executionStats.estimatedWrittenBytes,
			driverReport,
			navigatorReview,
			...(driverDecision ? { driverDecision } : {}),
		};

		this.observer?.record({
			category: "orchestrator",
			name: "round_end",
			actor: "system",
			round,
			details: {
				driverStatus: roundResult.driverReport.status,
				navigatorHasFeedback: roundResult.navigatorReview.hasFeedback,
				navigatorRecommendation: roundResult.navigatorReview.driverRecommendation,
				checkpointCount: roundResult.checkpointCount,
				editWriteCallCount: roundResult.editWriteCallCount,
			},
		});
		this.broadcastShared(
			"loop_stop",
			"system",
			"Stopped after solo driver pass plus reviewer feedback/integration cycle.",
		);

		const contributions: Record<AgentId, ContributionSummary> = {
			A: contributionTemplate("A"),
			B: contributionTemplate("B"),
		};
		contributions[driverId].roundsDriven = 1;
		contributions[driverId].checkpointsWhileDriving = roundResult.checkpointCount;
		contributions[driverId].editWriteCallCount = roundResult.editWriteCallCount;
		contributions[driverId].estimatedWrittenBytes = roundResult.estimatedWrittenBytes;

		return {
			rounds: [roundResult],
			checkpointCount: roundResult.checkpointCount,
			swapCount: 0,
			contributions,
			finalReview: this.synthesizeSoloFinalReview(roundResult),
		};
	}

	private buildSummary(
		contributions: Record<AgentId, ContributionSummary>,
		checkpointCount: number,
		swapCount: number,
	): RunSummary {
		const totalEstimatedWrittenBytes = contributions.A.estimatedWrittenBytes + contributions.B.estimatedWrittenBytes;

		if (totalEstimatedWrittenBytes > 0) {
			contributions.A.roughCodeSharePercent = roundPercent((contributions.A.estimatedWrittenBytes / totalEstimatedWrittenBytes) * 100);
			contributions.B.roughCodeSharePercent = roundPercent((contributions.B.estimatedWrittenBytes / totalEstimatedWrittenBytes) * 100);
		} else {
			const totalDrivenRounds = contributions.A.roundsDriven + contributions.B.roundsDriven;
			if (totalDrivenRounds > 0) {
				contributions.A.roughCodeSharePercent = roundPercent((contributions.A.roundsDriven / totalDrivenRounds) * 100);
				contributions.B.roughCodeSharePercent = roundPercent((contributions.B.roundsDriven / totalDrivenRounds) * 100);
			} else {
				contributions.A.roughCodeSharePercent = 0;
				contributions.B.roughCodeSharePercent = 0;
			}
		}

		return {
			checkpointCount,
			swapCount,
			totalEstimatedWrittenBytes,
			contributions,
		};
	}

	private async finalReview(task: string, agreedPlan: string): Promise<FinalReview> {
		this.workers.A.setRole("navigator");
		this.workers.B.setRole("navigator");

		const reviewARaw = await this.runPromptWithObservability({
			actor: "A",
			prompt: buildFinalReviewPrompt(task, agreedPlan),
			promptKind: "final_review",
			phase: "final_review",
		});
		const reviewBRaw = await this.runPromptWithObservability({
			actor: "B",
			prompt: buildFinalReviewPrompt(task, agreedPlan),
			promptKind: "final_review",
			phase: "final_review",
		});

		const reviewA = parseNavigatorReview(reviewARaw);
		const reviewB = parseNavigatorReview(reviewBRaw);
		this.workers.A.appendPrivateMemory(reviewA.privateReflection);
		this.workers.B.appendPrivateMemory(reviewB.privateReflection);

		this.broadcastShared("final_review_A", "A", reviewA.publicFeedback);
		this.broadcastShared("final_review_B", "B", reviewB.publicFeedback);

		const synthesisRaw = await this.runPromptWithObservability({
			actor: "A",
			prompt: buildJointSynthesisPrompt(reviewA.publicFeedback, reviewB.publicFeedback),
			promptKind: "joint_synthesis",
			phase: "final_review",
		});
		const synthesis = parseJointVerdict(synthesisRaw);
		this.broadcastShared(
			"joint_verdict",
			"A",
			`Verdict: ${synthesis.jointVerdict}\nRationale: ${synthesis.rationale}\nNext steps: ${synthesis.nextSteps}`,
		);

		return {
			reviewA,
			reviewB,
			jointVerdict: synthesis.jointVerdict,
			rationale: synthesis.rationale,
			nextSteps: synthesis.nextSteps,
			raw: synthesis.raw,
		};
	}

	async run(task: string): Promise<PairRunResult> {
		let status: "completed" | "failed" = "completed";
		let failureMessage: string | undefined;
		let observabilitySummary: PairRunResult["observability"];
		let resultCore:
			| {
					task: string;
					agreedPlan: string;
					rounds: RoundResult[];
					finalReview: FinalReview;
					summary: RunSummary;
					sharedJournal: SharedEntry[];
			  }
			| undefined;

		try {
			this.observer?.record({
				category: "session",
				name: "session_start",
				actor: "system",
				details: {
					taskLength: task.length,
					maxRounds: this.config.maxRounds,
					executionMode: this.config.executionMode,
					turnPolicy: this.config.turnPolicy.mode,
					pausePolicy: this.config.pauseStrategy.mode,
				},
			});
			this.broadcastShared("task", "system", task);

			const agreedPlan =
				this.config.executionMode === "solo_driver_then_reviewer"
					? await this.soloPlanning(task)
					: await this.collaborativePlanning(task);
			const execution =
				this.config.executionMode === "solo_driver_then_reviewer"
					? await this.runSoloDriverThenReviewerExecution(task, agreedPlan)
					: await this.runPairedExecution(task, agreedPlan);
			const finalReview = execution.finalReview ?? (await this.finalReview(task, agreedPlan));
			const summary = this.buildSummary(execution.contributions, execution.checkpointCount, execution.swapCount);
			resultCore = {
				task,
				agreedPlan,
				rounds: execution.rounds,
				finalReview,
				summary,
				sharedJournal: [...this.sharedJournal],
			};
		} catch (error) {
			status = "failed";
			failureMessage = error instanceof Error ? error.message : String(error);
			this.observer?.record({
				category: "session",
				name: "session_error",
				actor: "system",
				details: { message: failureMessage },
			});
			throw error;
		} finally {
			observabilitySummary = this.observer ? await this.observer.flush(status, failureMessage) : undefined;
		}

		if (!resultCore) {
			throw new Error("Pair run did not produce a result.");
		}

		return {
			...resultCore,
			...(observabilitySummary ? { observability: observabilitySummary } : {}),
		};
	}
}
