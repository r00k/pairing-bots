import type { ThinkingLevel as AgentThinkingLevel } from "@mariozechner/pi-agent-core";
import type { KnownProvider } from "@mariozechner/pi-ai";

export type AgentId = "A" | "B";
export type PairRole = "driver" | "navigator";
export type WorkspaceMode = "direct" | "ephemeral_copy";
export type EventStreamMode = "compact" | "full";

export interface ModelSpec {
	provider: KnownProvider;
	modelId: string;
	thinkingLevel: AgentThinkingLevel;
}

export type PauseStrategy =
	| {
			mode: "none";
	  }
	| {
			mode: "every_n_file_edits";
			editsPerPause: number;
			countedTools: string[];
	  };

export type TurnPolicy =
	| {
			mode: "alternate_each_round";
	  }
	| {
			mode: "same_driver_until_navigator_signoff";
			maxConsecutiveRounds: number;
			maxConsecutiveCheckpoints: number;
	  };

export interface PairAgentConfig {
	modelA: ModelSpec;
	modelB: ModelSpec;
	cwd: string;
	maxRounds: number;
	driverStartsAs: AgentId;
	pauseStrategy: PauseStrategy;
	turnPolicy: TurnPolicy;
}

export interface SharedEntry {
	stage: string;
	actor: AgentId | "system";
	content: string;
	timestamp: number;
}

export interface DriverReport {
	status: "continue" | "done";
	summary: string;
	changes: string;
	questionsForNavigator: string;
	raw: string;
}

export interface NavigatorReview {
	privateReflection: string;
	publicFeedback: string;
	hasFeedback: boolean;
	driverRecommendation: "continue" | "handoff";
	raw: string;
}

export interface DriverDecision {
	decision: "accept" | "partial" | "reject";
	justification: string;
	raw: string;
}

export interface RoundResult {
	round: number;
	driver: AgentId;
	navigator: AgentId;
	pauseTriggered: boolean;
	checkpointCount: number;
	editWriteCallCount: number;
	estimatedWrittenBytes: number;
	driverReport: DriverReport;
	navigatorReview: NavigatorReview;
	driverDecision?: DriverDecision;
}

export interface ContributionSummary {
	agent: AgentId;
	estimatedWrittenBytes: number;
	editWriteCallCount: number;
	roundsDriven: number;
	checkpointsWhileDriving: number;
	roughCodeSharePercent: number;
}

export interface RunSummary {
	checkpointCount: number;
	swapCount: number;
	totalEstimatedWrittenBytes: number;
	contributions: Record<AgentId, ContributionSummary>;
}

export interface ObservabilitySummary {
	logFile: string;
	eventStreamFile?: string;
	eventStreamMode?: EventStreamMode;
	eventStreamWriteError?: string;
	eventCount: number;
	promptCount: number;
	toolExecutionCount: number;
	toolExecutionErrorCount: number;
	durationMs: number;
}

export interface FinalReview {
	reviewA: NavigatorReview;
	reviewB: NavigatorReview;
	jointVerdict: "APPROVED" | "NEEDS_MORE_WORK";
	rationale: string;
	nextSteps: string;
	raw: string;
}

export interface PairRunResult {
	task: string;
	agreedPlan: string;
	rounds: RoundResult[];
	finalReview: FinalReview;
	summary: RunSummary;
	observability?: ObservabilitySummary;
	sharedJournal: SharedEntry[];
}
