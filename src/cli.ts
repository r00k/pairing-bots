#!/usr/bin/env node

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { extname, basename, dirname, join, resolve } from "node:path";
import { parseCli, type CliConfig } from "./config.js";
import { SessionObserver } from "./observability.js";
import { PairProgrammingOrchestrator } from "./pair-orchestrator.js";
import { prepareWorkspaceSession } from "./workspace-session.js";
import type { ExecutionMode, PairAgentConfig, PairRunResult, WorkspaceMode } from "./types.js";

interface StrategyRunArtifacts {
	mode: ExecutionMode;
	result: PairRunResult;
	outputPath?: string;
	logFile: string;
	eventLogFile?: string;
}

interface StrategyComparisonReport {
	task: string;
	generatedAt: string;
	strategies: {
		mode: ExecutionMode;
		outputPath?: string;
		logFile: string;
		eventLogFile?: string;
		summary: PairRunResult["summary"];
		finalVerdict: PairRunResult["finalReview"]["jointVerdict"];
		observability?: PairRunResult["observability"];
	}[];
	comparison: {
		roundDelta: number;
		swapDelta: number;
		checkpointDelta: number;
		promptDelta?: number;
		toolExecutionDelta?: number;
		toolExecutionErrorDelta?: number;
		durationMsDelta?: number;
	};
}

function printSection(title: string, body: string): void {
	console.log(`\n=== ${title} ===`);
	console.log(body);
}

function suffixedPath(path: string | undefined, suffix: string, fallbackExt: string): string | undefined {
	if (!path) {
		return undefined;
	}
	const resolved = resolve(path);
	const ext = extname(resolved) || fallbackExt;
	const stem = basename(resolved, ext);
	return join(dirname(resolved), `${stem}.${suffix}${ext}`);
}

function printRunDetails(result: PairRunResult): void {
	printSection("Agreed Plan", result.agreedPlan);

	for (const round of result.rounds) {
		printSection(
			`Round ${round.round} (${round.driver} driver, ${round.navigator} navigator)`,
			[
				`Pause triggered: ${round.pauseTriggered}`,
				`Checkpoint count in round: ${round.checkpointCount}`,
				`Driver status: ${round.driverReport.status}`,
				`Edit/write calls (successful): ${round.editWriteCallCount}`,
				`Estimated written bytes: ${round.estimatedWrittenBytes}`,
				`Driver summary: ${round.driverReport.summary}`,
				`Navigator feedback: ${round.navigatorReview.hasFeedback ? round.navigatorReview.publicFeedback : "NONE"}`,
				`Navigator recommendation: ${round.navigatorReview.driverRecommendation}`,
				round.driverDecision
					? `Driver decision: ${round.driverDecision.decision} (${round.driverDecision.justification})`
					: "Driver decision: n/a",
			].join("\n"),
		);
	}

	printSection(
		"Final Joint Review",
		[
			`Verdict: ${result.finalReview.jointVerdict}`,
			`Rationale: ${result.finalReview.rationale}`,
			`Next steps: ${result.finalReview.nextSteps}`,
		].join("\n"),
	);

	printSection(
		"Run Summary",
		[
			`Total checkpoints: ${result.summary.checkpointCount}`,
			`Total driver swaps: ${result.summary.swapCount}`,
			`Total estimated written bytes: ${result.summary.totalEstimatedWrittenBytes}`,
			`Model A rough code share: ${result.summary.contributions.A.roughCodeSharePercent}% (${result.summary.contributions.A.estimatedWrittenBytes} bytes, ${result.summary.contributions.A.editWriteCallCount} edit/write calls)`,
			`Model B rough code share: ${result.summary.contributions.B.roughCodeSharePercent}% (${result.summary.contributions.B.estimatedWrittenBytes} bytes, ${result.summary.contributions.B.editWriteCallCount} edit/write calls)`,
		].join("\n"),
	);

	if (result.observability) {
		printSection(
			"Observability",
			[
				`Log file: ${result.observability.logFile}`,
				`Event stream: ${result.observability.eventStreamFile ?? "disabled"}`,
				`Event stream mode: ${result.observability.eventStreamMode ?? "compact"}`,
				result.observability.eventStreamWriteError
					? `Event stream write error: ${result.observability.eventStreamWriteError}`
					: "Event stream write error: NONE",
				`Events: ${result.observability.eventCount}`,
				`Prompts: ${result.observability.promptCount}`,
				`Tool executions: ${result.observability.toolExecutionCount}`,
				`Tool execution errors: ${result.observability.toolExecutionErrorCount}`,
				`Duration: ${result.observability.durationMs} ms`,
			].join("\n"),
		);
	}
}

let activeObserver: SessionObserver | undefined;

async function runStrategy(options: {
	parsed: CliConfig;
	baseCwd: string;
	mode: ExecutionMode;
	workspaceMode: WorkspaceMode;
	logFile?: string;
	eventLogFile?: string;
	outputPath?: string;
	quiet?: boolean;
}): Promise<StrategyRunArtifacts> {
	const pair: PairAgentConfig = {
		...options.parsed.pair,
		executionMode: options.mode,
		cwd: options.baseCwd,
	};
	const workspace = await prepareWorkspaceSession({
		baseCwd: options.baseCwd,
		mode: options.workspaceMode,
		keepWorkspace: options.parsed.keepWorkspace,
	});
	pair.cwd = workspace.runtimeCwd;

	activeObserver = new SessionObserver({
		cwd: options.baseCwd,
		...(options.logFile ? { logFile: options.logFile } : {}),
		...(options.eventLogFile ? { eventLogFile: options.eventLogFile } : {}),
		eventStreamMode: options.parsed.eventStreamMode,
	});
	activeObserver.record({
		category: "session",
		name: "cli_start",
		actor: "system",
		details: {
			taskLength: options.parsed.task.length,
			maxRounds: pair.maxRounds,
			executionMode: options.mode,
			turnPolicy: pair.turnPolicy.mode,
			pausePolicy: pair.pauseStrategy.mode,
			baseCwd: options.baseCwd,
			runtimeCwd: pair.cwd,
			workspaceMode: options.workspaceMode,
			keepWorkspace: options.parsed.keepWorkspace,
		},
	});

	if (!options.quiet) {
		printSection(
			"Run Configuration",
			[
				`Task: ${options.parsed.task}`,
				`Execution mode: ${options.mode}`,
				`Base CWD: ${options.baseCwd}`,
				`Runtime CWD: ${pair.cwd}`,
				`Workspace mode: ${options.workspaceMode}`,
				`Keep workspace: ${options.parsed.keepWorkspace}`,
				`Max rounds: ${pair.maxRounds}`,
				`Driver starts: ${pair.driverStartsAs}`,
				`Turn policy: ${pair.turnPolicy.mode}`,
				pair.turnPolicy.mode === "same_driver_until_navigator_signoff"
					? `Safety cap: ${pair.turnPolicy.maxConsecutiveRounds} rounds or ${pair.turnPolicy.maxConsecutiveCheckpoints} checkpoints`
					: "Safety cap: n/a",
				`Log file: ${activeObserver.logFile}`,
				`Event stream: ${activeObserver.eventLogFile ?? "disabled"}`,
				`Event stream mode: ${options.parsed.eventStreamMode}`,
				`Model A: ${pair.modelA.provider}/${pair.modelA.modelId} (${pair.modelA.thinkingLevel})`,
				`Model B: ${pair.modelB.provider}/${pair.modelB.modelId} (${pair.modelB.thinkingLevel})`,
			].join("\n"),
		);
	}

	let cleanupPrinted = false;
	try {
		const orchestrator = new PairProgrammingOrchestrator(pair, { observer: activeObserver });
		const result = await orchestrator.run(options.parsed.task);

		if (!options.quiet) {
			printRunDetails(result);
		}

		if (options.outputPath) {
			await writeFile(options.outputPath, JSON.stringify(result, null, 2), "utf-8");
			if (!options.quiet) {
				console.log(`\nWrote run artifact: ${options.outputPath}`);
			}
		}

		return {
			mode: options.mode,
			result,
			...(options.outputPath ? { outputPath: options.outputPath } : {}),
			logFile: activeObserver.logFile,
			...(activeObserver.eventLogFile ? { eventLogFile: activeObserver.eventLogFile } : {}),
		};
	} finally {
		try {
			const cleanup = await workspace.cleanup();
			const cleanupSummary =
				cleanup.preservedPath !== undefined
					? `Workspace preserved at: ${cleanup.preservedPath}`
					: workspace.mode === "direct"
						? "Workspace cleanup: n/a (direct mode)"
						: "Workspace cleanup: deleted ephemeral copy";
			if (!options.quiet) {
				printSection("Workspace", cleanupSummary);
			}
			cleanupPrinted = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!cleanupPrinted && !options.quiet) {
				printSection("Workspace", `Cleanup error: ${message}`);
			}
		}
	}
}

function buildComparisonReport(task: string, paired: StrategyRunArtifacts, solo: StrategyRunArtifacts): StrategyComparisonReport {
	const pairedObs = paired.result.observability;
	const soloObs = solo.result.observability;

	return {
		task,
		generatedAt: new Date().toISOString(),
		strategies: [paired, solo].map((artifact) => ({
			mode: artifact.mode,
			...(artifact.outputPath ? { outputPath: artifact.outputPath } : {}),
			logFile: artifact.logFile,
			...(artifact.eventLogFile ? { eventLogFile: artifact.eventLogFile } : {}),
			summary: artifact.result.summary,
			finalVerdict: artifact.result.finalReview.jointVerdict,
			...(artifact.result.observability ? { observability: artifact.result.observability } : {}),
		})),
		comparison: {
			roundDelta: paired.result.rounds.length - solo.result.rounds.length,
			swapDelta: paired.result.summary.swapCount - solo.result.summary.swapCount,
			checkpointDelta: paired.result.summary.checkpointCount - solo.result.summary.checkpointCount,
			...(pairedObs && soloObs ? { promptDelta: pairedObs.promptCount - soloObs.promptCount } : {}),
			...(pairedObs && soloObs ? { toolExecutionDelta: pairedObs.toolExecutionCount - soloObs.toolExecutionCount } : {}),
			...(pairedObs && soloObs ? { toolExecutionErrorDelta: pairedObs.toolExecutionErrorCount - soloObs.toolExecutionErrorCount } : {}),
			...(pairedObs && soloObs ? { durationMsDelta: pairedObs.durationMs - soloObs.durationMs } : {}),
		},
	};
}

async function runComparison(parsed: CliConfig): Promise<void> {
	const baseCwd = parsed.pair.cwd;
	const compareWorkspaceMode: WorkspaceMode = parsed.workspaceMode === "direct" ? "ephemeral_copy" : parsed.workspaceMode;
	const pairedOutputPath = suffixedPath(parsed.outputPath, "paired_turns", ".json");
	const soloOutputPath = suffixedPath(parsed.outputPath, "solo_driver_then_reviewer", ".json");
	const pairedLogFile = suffixedPath(parsed.logFile, "paired_turns", ".json");
	const soloLogFile = suffixedPath(parsed.logFile, "solo_driver_then_reviewer", ".json");
	const pairedEventLogFile = suffixedPath(parsed.eventLogFile, "paired_turns", ".jsonl");
	const soloEventLogFile = suffixedPath(parsed.eventLogFile, "solo_driver_then_reviewer", ".jsonl");

	printSection(
		"Comparison Run",
		[
			`Task: ${parsed.task}`,
			`Base CWD: ${baseCwd}`,
			`Workspace mode (comparison): ${compareWorkspaceMode}`,
			parsed.workspaceMode === "direct"
				? "Input mode was direct; switched to ephemeral_copy to keep both strategies on identical clean baselines."
				: "Each strategy runs in its own isolated workspace copy.",
		].join("\n"),
	);

	printSection("Strategy 1", "paired_turns");
	const paired = await runStrategy({
		parsed,
		baseCwd,
		mode: "paired_turns",
		workspaceMode: compareWorkspaceMode,
		...(pairedLogFile ? { logFile: pairedLogFile } : {}),
		...(pairedEventLogFile ? { eventLogFile: pairedEventLogFile } : {}),
		...(pairedOutputPath ? { outputPath: pairedOutputPath } : {}),
		quiet: true,
	});

	printSection("Strategy 2", "solo_driver_then_reviewer");
	const solo = await runStrategy({
		parsed,
		baseCwd,
		mode: "solo_driver_then_reviewer",
		workspaceMode: compareWorkspaceMode,
		...(soloLogFile ? { logFile: soloLogFile } : {}),
		...(soloEventLogFile ? { eventLogFile: soloEventLogFile } : {}),
		...(soloOutputPath ? { outputPath: soloOutputPath } : {}),
		quiet: true,
	});

	const report = buildComparisonReport(parsed.task, paired, solo);
	printSection(
		"Comparison Summary",
		[
			`paired_turns verdict: ${paired.result.finalReview.jointVerdict}`,
			`solo_driver_then_reviewer verdict: ${solo.result.finalReview.jointVerdict}`,
			`Round delta (paired - solo): ${report.comparison.roundDelta}`,
			`Swap delta (paired - solo): ${report.comparison.swapDelta}`,
			`Checkpoint delta (paired - solo): ${report.comparison.checkpointDelta}`,
			report.comparison.promptDelta !== undefined ? `Prompt delta (paired - solo): ${report.comparison.promptDelta}` : "",
			report.comparison.toolExecutionDelta !== undefined
				? `Tool execution delta (paired - solo): ${report.comparison.toolExecutionDelta}`
				: "",
			report.comparison.toolExecutionErrorDelta !== undefined
				? `Tool execution error delta (paired - solo): ${report.comparison.toolExecutionErrorDelta}`
				: "",
			report.comparison.durationMsDelta !== undefined ? `Duration delta ms (paired - solo): ${report.comparison.durationMsDelta}` : "",
			`paired_turns log: ${paired.logFile}`,
			`solo_driver_then_reviewer log: ${solo.logFile}`,
		]
			.filter((line) => line.length > 0)
			.join("\n"),
	);

	if (parsed.outputPath) {
		await writeFile(parsed.outputPath, JSON.stringify(report, null, 2), "utf-8");
		console.log(`\nWrote comparison artifact: ${parsed.outputPath}`);
		if (pairedOutputPath) {
			console.log(`Wrote paired_turns run artifact: ${pairedOutputPath}`);
		}
		if (soloOutputPath) {
			console.log(`Wrote solo_driver_then_reviewer run artifact: ${soloOutputPath}`);
		}
	}
}

async function main(): Promise<void> {
	const parsed = parseCli(process.argv.slice(2));
	if (parsed.compareStrategies) {
		await runComparison(parsed);
		return;
	}

	await runStrategy({
		parsed,
		baseCwd: parsed.pair.cwd,
		mode: parsed.pair.executionMode,
		workspaceMode: parsed.workspaceMode,
		...(parsed.logFile ? { logFile: parsed.logFile } : {}),
		...(parsed.eventLogFile ? { eventLogFile: parsed.eventLogFile } : {}),
		...(parsed.outputPath ? { outputPath: parsed.outputPath } : {}),
	});
}

main().catch(async (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`\nError: ${message}`);
	if (activeObserver) {
		activeObserver.record({
			category: "session",
			name: "cli_error",
			actor: "system",
			details: { message },
		});
		await activeObserver.flush("failed", message);
		console.error(`Observability log: ${activeObserver.logFile}`);
		if (activeObserver.eventLogFile) {
			console.error(`Observability event stream: ${activeObserver.eventLogFile}`);
		}
	}
	process.exitCode = 1;
});
