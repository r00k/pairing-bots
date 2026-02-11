import { resolve } from "node:path";
import type { ThinkingLevel as AgentThinkingLevel } from "@mariozechner/pi-agent-core";
import type { KnownProvider } from "@mariozechner/pi-ai";
import type { AgentId, EventStreamMode, PairAgentConfig, PauseStrategy, TurnPolicy, WorkspaceMode } from "./types.js";

export interface CliConfig {
	task: string;
	outputPath?: string;
	logFile?: string;
	eventLogFile?: string;
	eventStreamMode: EventStreamMode;
	workspaceMode: WorkspaceMode;
	keepWorkspace: boolean;
	pair: PairAgentConfig;
}

const ALLOWED_THINKING: Set<AgentThinkingLevel> = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parseThinking(value: string): AgentThinkingLevel {
	if (ALLOWED_THINKING.has(value as AgentThinkingLevel)) {
		return value as AgentThinkingLevel;
	}
	throw new Error(`Invalid thinking level: ${value}`);
}

function parseAgentId(value: string): AgentId {
	if (value === "A" || value === "B") {
		return value;
	}
	throw new Error(`Invalid agent id: ${value}. Use A or B.`);
}

function parsePositiveInteger(name: string, value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer. Received: ${value}`);
	}
	return parsed;
}

function parseWorkspaceMode(value: string): WorkspaceMode {
	if (value === "direct" || value === "ephemeral_copy") {
		return value;
	}
	throw new Error(`Invalid --workspace-mode: ${value}`);
}

function parseEventStreamMode(value: string): EventStreamMode {
	if (value === "compact" || value === "full") {
		return value;
	}
	throw new Error(`Invalid --event-stream-mode: ${value}`);
}

function defaultPauseStrategy(): PauseStrategy {
	return {
		mode: "every_n_file_edits",
		editsPerPause: 3,
		countedTools: ["edit", "write"],
	};
}

function defaultEveryNFileEditsPause(): Extract<PauseStrategy, { mode: "every_n_file_edits" }> {
	return {
		mode: "every_n_file_edits",
		editsPerPause: 3,
		countedTools: ["edit", "write"],
	};
}

function defaultTurnPolicy(): TurnPolicy {
	return {
		mode: "same_driver_until_navigator_signoff",
		maxConsecutiveRounds: 3,
		maxConsecutiveCheckpoints: 4,
	};
}

function defaultStickyTurnPolicy(): Extract<TurnPolicy, { mode: "same_driver_until_navigator_signoff" }> {
	return {
		mode: "same_driver_until_navigator_signoff",
		maxConsecutiveRounds: 3,
		maxConsecutiveCheckpoints: 4,
	};
}

export function defaultPairConfig(cwd: string): PairAgentConfig {
	return {
		cwd,
		maxRounds: 8,
		driverStartsAs: "A",
		pauseStrategy: defaultPauseStrategy(),
		turnPolicy: defaultTurnPolicy(),
		modelA: {
			provider: "anthropic",
			modelId: "claude-opus-4-6",
			thinkingLevel: "high",
		},
		modelB: {
			provider: "openai",
			modelId: "gpt-5.2-codex",
			thinkingLevel: "high",
		},
	};
}

export function helpText(): string {
	return [
		"Pairing Bots CLI",
		"",
		"Required:",
		"  --task \"<task description>\"",
		"",
		"Optional:",
		"  --cwd <path>",
		"  --max-rounds <n>",
		"  --driver-start A|B",
		"  --turn-policy alternate_each_round|same_driver_until_navigator_signoff",
		"  --max-consecutive-rounds <n>",
		"  --max-consecutive-checkpoints <n>",
		"  --pause-mode none|every_n_file_edits",
		"  --edits-per-pause <n>",
		"  --model-a-provider <provider>",
		"  --model-a-id <model-id>",
		"  --model-a-thinking off|minimal|low|medium|high|xhigh",
		"  --model-b-provider <provider>",
		"  --model-b-id <model-id>",
		"  --model-b-thinking off|minimal|low|medium|high|xhigh",
		"  --output <json-path>",
		"  --log-file <json-path>",
		"  --event-log-file <jsonl-path>",
		"  --event-stream-mode compact|full",
		"  --workspace-mode direct|ephemeral_copy",
		"  --keep-workspace",
		"  --help",
	].join("\n");
}

export function parseCli(argv: string[], processCwd = process.cwd()): CliConfig {
	const pair = defaultPairConfig(resolve(processCwd));
	let task = "";
	let outputPath: string | undefined;
	let logFile: string | undefined;
	let eventLogFile: string | undefined;
	let eventStreamMode: EventStreamMode = "compact";
	let workspaceMode: WorkspaceMode = "direct";
	let keepWorkspace = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg) {
			continue;
		}
		const next = argv[i + 1];
		if (arg === "--help" || arg === "-h") {
			throw new Error(helpText());
		}
		if (arg === "--keep-workspace") {
			keepWorkspace = true;
			continue;
		}
		if (!arg.startsWith("--")) {
			continue;
		}
		if (!next) {
			throw new Error(`Missing value for ${arg}`);
		}

		switch (arg) {
			case "--task":
				task = next.trim();
				i += 1;
				break;
			case "--cwd":
				pair.cwd = resolve(next);
				i += 1;
				break;
			case "--max-rounds":
				pair.maxRounds = parsePositiveInteger("--max-rounds", next);
				i += 1;
				break;
			case "--driver-start":
				pair.driverStartsAs = parseAgentId(next);
				i += 1;
				break;
			case "--turn-policy":
				if (next === "alternate_each_round") {
					pair.turnPolicy = { mode: "alternate_each_round" };
				} else if (next === "same_driver_until_navigator_signoff") {
					const previous =
						pair.turnPolicy.mode === "same_driver_until_navigator_signoff"
							? pair.turnPolicy
							: defaultStickyTurnPolicy();
					pair.turnPolicy = {
						mode: "same_driver_until_navigator_signoff",
						maxConsecutiveRounds: previous.maxConsecutiveRounds,
						maxConsecutiveCheckpoints: previous.maxConsecutiveCheckpoints,
					};
				} else {
					throw new Error(`Invalid --turn-policy: ${next}`);
				}
				i += 1;
				break;
			case "--max-consecutive-rounds":
				if (pair.turnPolicy.mode === "alternate_each_round") {
					pair.turnPolicy = defaultStickyTurnPolicy();
				}
				if (pair.turnPolicy.mode === "same_driver_until_navigator_signoff") {
					pair.turnPolicy.maxConsecutiveRounds = parsePositiveInteger("--max-consecutive-rounds", next);
				}
				i += 1;
				break;
			case "--max-consecutive-checkpoints":
				if (pair.turnPolicy.mode === "alternate_each_round") {
					pair.turnPolicy = defaultStickyTurnPolicy();
				}
				if (pair.turnPolicy.mode === "same_driver_until_navigator_signoff") {
					pair.turnPolicy.maxConsecutiveCheckpoints = parsePositiveInteger("--max-consecutive-checkpoints", next);
				}
				i += 1;
				break;
			case "--pause-mode": {
				if (next === "none") {
					pair.pauseStrategy = { mode: "none" };
				} else if (next === "every_n_file_edits") {
					const previous =
						pair.pauseStrategy.mode === "every_n_file_edits" ? pair.pauseStrategy : defaultEveryNFileEditsPause();
					pair.pauseStrategy = {
						mode: "every_n_file_edits",
						editsPerPause: previous.editsPerPause,
						countedTools: previous.countedTools,
					};
				} else {
					throw new Error(`Invalid --pause-mode: ${next}`);
				}
				i += 1;
				break;
			}
			case "--edits-per-pause":
				if (pair.pauseStrategy.mode === "none") {
					pair.pauseStrategy = defaultEveryNFileEditsPause();
				}
				if (pair.pauseStrategy.mode === "every_n_file_edits") {
					pair.pauseStrategy.editsPerPause = parsePositiveInteger("--edits-per-pause", next);
				}
				i += 1;
				break;
			case "--model-a-provider":
				pair.modelA.provider = next as KnownProvider;
				i += 1;
				break;
			case "--model-a-id":
				pair.modelA.modelId = next;
				i += 1;
				break;
			case "--model-a-thinking":
				pair.modelA.thinkingLevel = parseThinking(next);
				i += 1;
				break;
			case "--model-b-provider":
				pair.modelB.provider = next as KnownProvider;
				i += 1;
				break;
			case "--model-b-id":
				pair.modelB.modelId = next;
				i += 1;
				break;
			case "--model-b-thinking":
				pair.modelB.thinkingLevel = parseThinking(next);
				i += 1;
				break;
			case "--output":
				outputPath = resolve(next);
				i += 1;
				break;
			case "--log-file":
				logFile = resolve(next);
				i += 1;
				break;
			case "--event-log-file":
				eventLogFile = resolve(next);
				i += 1;
				break;
			case "--event-stream-mode":
				eventStreamMode = parseEventStreamMode(next);
				i += 1;
				break;
			case "--workspace-mode":
				workspaceMode = parseWorkspaceMode(next);
				i += 1;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!task) {
		throw new Error(`Missing required --task argument.\n\n${helpText()}`);
	}

	pair.cwd = resolve(pair.cwd);
	return {
		task,
		pair,
		eventStreamMode,
		workspaceMode,
		keepWorkspace,
		...(outputPath ? { outputPath } : {}),
		...(logFile ? { logFile } : {}),
		...(eventLogFile ? { eventLogFile } : {}),
	};
}
