#!/usr/bin/env node

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { parseCli } from "./config.js";
import { SessionObserver } from "./observability.js";
import { PairProgrammingOrchestrator } from "./pair-orchestrator.js";
import { prepareWorkspaceSession } from "./workspace-session.js";

function printSection(title: string, body: string): void {
	console.log(`\n=== ${title} ===`);
	console.log(body);
}

let activeObserver: SessionObserver | undefined;

async function main(): Promise<void> {
	const parsed = parseCli(process.argv.slice(2));
	const baseCwd = parsed.pair.cwd;
	const workspace = await prepareWorkspaceSession({
		baseCwd,
		mode: parsed.workspaceMode,
		keepWorkspace: parsed.keepWorkspace,
	});
	parsed.pair.cwd = workspace.runtimeCwd;

	activeObserver = new SessionObserver({
		cwd: baseCwd,
		...(parsed.logFile ? { logFile: parsed.logFile } : {}),
		...(parsed.eventLogFile ? { eventLogFile: parsed.eventLogFile } : {}),
		eventStreamMode: parsed.eventStreamMode,
	});
	activeObserver.record({
		category: "session",
		name: "cli_start",
		actor: "system",
		details: {
			taskLength: parsed.task.length,
			maxRounds: parsed.pair.maxRounds,
			turnPolicy: parsed.pair.turnPolicy.mode,
			pausePolicy: parsed.pair.pauseStrategy.mode,
			baseCwd,
			runtimeCwd: parsed.pair.cwd,
			workspaceMode: parsed.workspaceMode,
			keepWorkspace: parsed.keepWorkspace,
		},
	});

	printSection(
		"Run Configuration",
		[
			`Task: ${parsed.task}`,
			`Base CWD: ${baseCwd}`,
			`Runtime CWD: ${parsed.pair.cwd}`,
			`Workspace mode: ${parsed.workspaceMode}`,
			`Keep workspace: ${parsed.keepWorkspace}`,
			`Max rounds: ${parsed.pair.maxRounds}`,
			`Driver starts: ${parsed.pair.driverStartsAs}`,
			`Turn policy: ${parsed.pair.turnPolicy.mode}`,
			parsed.pair.turnPolicy.mode === "same_driver_until_navigator_signoff"
				? `Safety cap: ${parsed.pair.turnPolicy.maxConsecutiveRounds} rounds or ${parsed.pair.turnPolicy.maxConsecutiveCheckpoints} checkpoints`
				: "Safety cap: n/a",
			`Log file: ${activeObserver.logFile}`,
			`Event stream: ${activeObserver.eventLogFile ?? "disabled"}`,
			`Event stream mode: ${parsed.eventStreamMode}`,
			`Model A: ${parsed.pair.modelA.provider}/${parsed.pair.modelA.modelId} (${parsed.pair.modelA.thinkingLevel})`,
			`Model B: ${parsed.pair.modelB.provider}/${parsed.pair.modelB.modelId} (${parsed.pair.modelB.thinkingLevel})`,
		].join("\n"),
	);

	let cleanupPrinted = false;
	try {
		const orchestrator = new PairProgrammingOrchestrator(parsed.pair, { observer: activeObserver });
		const result = await orchestrator.run(parsed.task);

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

		if (parsed.outputPath) {
			await writeFile(parsed.outputPath, JSON.stringify(result, null, 2), "utf-8");
			console.log(`\nWrote run artifact: ${parsed.outputPath}`);
		}
	} finally {
		try {
			const cleanup = await workspace.cleanup();
			const cleanupSummary =
				cleanup.preservedPath !== undefined
					? `Workspace preserved at: ${cleanup.preservedPath}`
					: workspace.mode === "direct"
						? "Workspace cleanup: n/a (direct mode)"
						: "Workspace cleanup: deleted ephemeral copy";
			printSection("Workspace", cleanupSummary);
			cleanupPrinted = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!cleanupPrinted) {
				printSection("Workspace", `Cleanup error: ${message}`);
			}
		}
	}
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
