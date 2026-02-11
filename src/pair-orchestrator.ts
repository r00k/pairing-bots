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

		let pauseTriggered = false;
		let countedEdits = 0;
		let nextCheckpointAt = this.config.pauseStrategy.mode === "every_n_file_edits" ? this.config.pauseStrategy.editsPerPause : Infinity;
		let checkpointCount = 0;
		let editWriteCallCount = 0;
		let estimatedWrittenBytes = 0;
		const pendingWriteEstimates = new Map<string, number>();
		let currentDriverPhase: "driving" | "feedback_resolution" = "driving";

		const onDriverEvent = (event: AgentEvent): void => {
			if (event.type === "tool_execution_start" && (event.toolName === "edit" || event.toolName === "write")) {
				pendingWriteEstimates.set(event.toolCallId, estimateWrittenBytes(event.toolName, event.args));
				return;
			}

			if (this.config.pauseStrategy.mode !== "every_n_file_edits") {
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
			if (!this.config.pauseStrategy.countedTools.includes(event.toolName)) {
				return;
			}
			countedEdits += 1;
			if (countedEdits < nextCheckpointAt) {
				return;
			}

			pauseTriggered = true;
			checkpointCount += 1;
			nextCheckpointAt += this.config.pauseStrategy.editsPerPause;
			driver.agent.steer({
				role: "user",
				content: [{ type: "text", text: buildPauseInterruptionPrompt(navigatorId, currentDriverPhase) }],
				timestamp: Date.now(),
			});
		};

		const driverReportRaw = await this.runPromptWithObservability({
			actor: driverId,
			prompt: driverPrompt,
			promptKind: "driver_turn",
			phase: "driving",
			round,
			onEvent: onDriverEvent,
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

		const navigatorReviewRaw = await this.runPromptWithObservability({
			actor: navigatorId,
			prompt: buildNavigatorReviewPrompt({
				task,
				agreedPlan,
				round,
				driver: driverId,
				driverReport: driverReport.raw,
				pauseTriggered,
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
			currentDriverPhase = "feedback_resolution";
			const driverDecisionRaw = await this.runPromptWithObservability({
				actor: driverId,
				prompt: buildDriverDecisionPrompt(navigatorReview.publicFeedback),
				promptKind: "driver_decision",
				phase: "feedback_resolution",
				round,
				onEvent: onDriverEvent,
			});
			driverDecision = parseDriverDecision(driverDecisionRaw);
			this.broadcastShared(
				"driver_decision",
				driverId,
				`Decision: ${driverDecision.decision}\nJustification: ${driverDecision.justification}`,
			);
		}

		return {
			round,
			driver: driverId,
			navigator: navigatorId,
			pauseTriggered,
			checkpointCount,
			editWriteCallCount,
			estimatedWrittenBytes,
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
					turnPolicy: this.config.turnPolicy.mode,
					pausePolicy: this.config.pauseStrategy.mode,
				},
			});
			this.broadcastShared("task", "system", task);

			const agreedPlan = await this.collaborativePlanning(task);
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

			const finalReview = await this.finalReview(task, agreedPlan);
			const summary = this.buildSummary(contributions, checkpointCount, swapCount);
			resultCore = {
				task,
				agreedPlan,
				rounds,
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
