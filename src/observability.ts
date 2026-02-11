import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentId, EventStreamMode, ObservabilitySummary } from "./types.js";

export interface SessionObserverOptions {
	cwd: string;
	logFile?: string;
	eventLogFile?: string;
	disableEventStream?: boolean;
	eventStreamMode?: EventStreamMode;
}

export interface LogEvent {
	index: number;
	timestamp: number;
	category: "session" | "prompt" | "agent_event" | "orchestrator";
	name: string;
	actor?: AgentId | "system";
	round?: number;
	phase?: string;
	details?: Record<string, unknown>;
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function defaultEventLogFile(logFile: string): string {
	if (logFile.endsWith(".json")) {
		return `${logFile.slice(0, -".json".length)}.events.jsonl`;
	}
	return `${logFile}.events.jsonl`;
}

function summarizeToolArgs(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") {
		return {};
	}
	const record = args as Record<string, unknown>;
	const summary: Record<string, unknown> = {};

	if (typeof record.path === "string") {
		summary.path = record.path;
	}
	if (typeof record.command === "string") {
		summary.commandLength = record.command.length;
		summary.commandHash = shortHash(record.command);
	}
	if (typeof record.content === "string") {
		summary.contentLength = record.content.length;
		summary.contentHash = shortHash(record.content);
	}
	if (typeof record.oldText === "string") {
		summary.oldTextLength = record.oldText.length;
		summary.oldTextHash = shortHash(record.oldText);
	}
	if (typeof record.newText === "string") {
		summary.newTextLength = record.newText.length;
		summary.newTextHash = shortHash(record.newText);
	}

	return summary;
}

function summarizeToolResult(result: unknown): Record<string, unknown> {
	if (!result || typeof result !== "object") {
		return {};
	}
	const record = result as Record<string, unknown>;
	const summary: Record<string, unknown> = {};

	const content = record.content;
	if (Array.isArray(content)) {
		summary.contentBlocks = content.length;
		const text = content.find((item) => item && typeof item === "object" && (item as any).type === "text") as
			| { text?: unknown }
			| undefined;
		if (text && typeof text.text === "string") {
			summary.firstTextLength = text.text.length;
		}
	}

	return summary;
}

export class SessionObserver {
	readonly logFile: string;
	readonly eventLogFile: string | undefined;

	private readonly startedAt: number;
	private readonly events: LogEvent[] = [];
	private readonly eventStreamMode: EventStreamMode;
	private eventIndex = 0;
	private flushedSummary: ObservabilitySummary | undefined;

	private eventStreamInitialized = false;
	private eventStreamWriteQueue: Promise<void> = Promise.resolve();
	private eventStreamWriteError: string | undefined;

	constructor(options: SessionObserverOptions) {
		this.startedAt = Date.now();
		const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-");
		this.logFile = options.logFile ?? join(options.cwd, ".pairing-bots", "logs", `session-${stamp}.json`);
		this.eventLogFile = options.disableEventStream ? undefined : options.eventLogFile ?? defaultEventLogFile(this.logFile);
		this.eventStreamMode = options.eventStreamMode ?? "compact";

		this.queueEventStreamLine({
			type: "meta",
			name: "event_stream_start",
			timestamp: this.startedAt,
			logFile: this.logFile,
			eventStreamMode: this.eventStreamMode,
		});
	}

	private shouldStreamEvent(event: LogEvent): boolean {
		if (this.eventStreamMode === "full") {
			return true;
		}
		if (event.category === "agent_event" && event.name === "message_update") {
			return false;
		}
		return true;
	}

	private queueEventStreamLine(entry: Record<string, unknown>): void {
		if (!this.eventLogFile || this.eventStreamWriteError) {
			return;
		}
		const line = `${JSON.stringify(entry)}\n`;
		this.eventStreamWriteQueue = this.eventStreamWriteQueue
			.then(async () => {
				if (!this.eventLogFile) {
					return;
				}
				if (!this.eventStreamInitialized) {
					await mkdir(dirname(this.eventLogFile), { recursive: true });
					await writeFile(this.eventLogFile, "", "utf-8");
					this.eventStreamInitialized = true;
				}
				await appendFile(this.eventLogFile, line, "utf-8");
			})
			.catch((error) => {
				this.eventStreamWriteError = error instanceof Error ? error.message : String(error);
			});
	}

	record(event: Omit<LogEvent, "index" | "timestamp">): void {
		if (this.flushedSummary) {
			return;
		}
		const renderedEvent: LogEvent = {
			index: this.eventIndex,
			timestamp: Date.now(),
			...event,
		};
		this.events.push(renderedEvent);
		this.eventIndex += 1;
		if (this.shouldStreamEvent(renderedEvent)) {
			this.queueEventStreamLine({
				type: "event",
				...renderedEvent,
			});
		}
	}

	recordPromptStart(params: {
		actor: AgentId;
		round?: number;
		phase: string;
		promptKind: string;
		prompt: string;
	}): void {
		this.record({
			category: "prompt",
			name: "prompt_start",
			actor: params.actor,
			phase: params.phase,
			...(params.round !== undefined ? { round: params.round } : {}),
			details: {
				promptKind: params.promptKind,
				promptLength: params.prompt.length,
				promptHash: shortHash(params.prompt),
			},
		});
	}

	recordPromptEnd(params: {
		actor: AgentId;
		round?: number;
		phase: string;
		promptKind: string;
		response: string;
	}): void {
		this.record({
			category: "prompt",
			name: "prompt_end",
			actor: params.actor,
			phase: params.phase,
			...(params.round !== undefined ? { round: params.round } : {}),
			details: {
				promptKind: params.promptKind,
				responseLength: params.response.length,
				responseHash: shortHash(params.response),
			},
		});
	}

	recordAgentEvent(params: {
		actor: AgentId;
		round?: number;
		phase: string;
		event: AgentEvent;
	}): void {
		const event = params.event;

		if (event.type === "message_update") {
			this.record({
				category: "agent_event",
				name: "message_update",
				actor: params.actor,
				phase: params.phase,
				...(params.round !== undefined ? { round: params.round } : {}),
				details: {
					assistantEventType: event.assistantMessageEvent.type,
				},
			});
			return;
		}

		if (event.type === "tool_execution_start") {
			this.record({
				category: "agent_event",
				name: "tool_execution_start",
				actor: params.actor,
				phase: params.phase,
				...(params.round !== undefined ? { round: params.round } : {}),
				details: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: summarizeToolArgs(event.args),
				},
			});
			return;
		}

		if (event.type === "tool_execution_end") {
			this.record({
				category: "agent_event",
				name: "tool_execution_end",
				actor: params.actor,
				phase: params.phase,
				...(params.round !== undefined ? { round: params.round } : {}),
				details: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					result: summarizeToolResult(event.result),
				},
			});
			return;
		}

		if (event.type === "message_start" || event.type === "message_end") {
			const details: Record<string, unknown> = {
				role: event.message.role,
			};
			if (event.message.role === "assistant") {
				const assistant = event.message as AssistantMessage;
				details.stopReason = assistant.stopReason;
				if (assistant.errorMessage) {
					details.errorMessage = assistant.errorMessage;
				}
			}
			this.record({
				category: "agent_event",
				name: event.type,
				actor: params.actor,
				phase: params.phase,
				...(params.round !== undefined ? { round: params.round } : {}),
				details,
			});
			return;
		}

		if (event.type === "turn_end") {
			const details: Record<string, unknown> = {
				toolResults: event.toolResults.length,
			};
			if (event.message.role === "assistant") {
				const assistant = event.message as AssistantMessage;
				details.stopReason = assistant.stopReason;
				if (assistant.errorMessage) {
					details.errorMessage = assistant.errorMessage;
				}
			}
			this.record({
				category: "agent_event",
				name: "turn_end",
				actor: params.actor,
				phase: params.phase,
				...(params.round !== undefined ? { round: params.round } : {}),
				details,
			});
			return;
		}

		this.record({
			category: "agent_event",
			name: event.type,
			actor: params.actor,
			phase: params.phase,
			...(params.round !== undefined ? { round: params.round } : {}),
		});
	}

	async flush(status: "completed" | "failed", errorMessage?: string): Promise<ObservabilitySummary> {
		if (this.flushedSummary) {
			return this.flushedSummary;
		}

		const endedAt = Date.now();
		const durationMs = endedAt - this.startedAt;
		const promptCount = this.events.filter((event) => event.category === "prompt" && event.name === "prompt_start").length;
		const toolEnds = this.events.filter((event) => event.category === "agent_event" && event.name === "tool_execution_end");
		const toolExecutionCount = toolEnds.length;
		const toolExecutionErrorCount = toolEnds.filter((event) => Boolean(event.details?.isError)).length;

		this.queueEventStreamLine({
			type: "meta",
			name: "event_stream_end",
			timestamp: endedAt,
			status,
			...(errorMessage ? { errorMessage } : {}),
			summary: {
				eventCount: this.events.length,
				promptCount,
				toolExecutionCount,
				toolExecutionErrorCount,
				durationMs,
				eventStreamMode: this.eventStreamMode,
			},
		});

		await this.eventStreamWriteQueue;

		const summary: ObservabilitySummary = {
			logFile: this.logFile,
			...(this.eventLogFile ? { eventStreamFile: this.eventLogFile } : {}),
			eventStreamMode: this.eventStreamMode,
			...(this.eventStreamWriteError ? { eventStreamWriteError: this.eventStreamWriteError } : {}),
			eventCount: this.events.length,
			promptCount,
			toolExecutionCount,
			toolExecutionErrorCount,
			durationMs,
		};

		const payload = {
			meta: {
				startedAt: this.startedAt,
				endedAt,
				durationMs,
				status,
				errorMessage,
				eventLogFile: this.eventLogFile,
				eventStreamMode: this.eventStreamMode,
				eventLogWriteError: this.eventStreamWriteError,
			},
			summary,
			events: this.events,
		};

		await mkdir(dirname(this.logFile), { recursive: true });
		await writeFile(this.logFile, JSON.stringify(payload, null, 2), "utf-8");
		this.flushedSummary = summary;

		return this.flushedSummary;
	}
}
