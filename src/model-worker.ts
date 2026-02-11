import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModels, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { createCodingTools, createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import { hasApiKeySourceForProvider, resolveApiKeyForProvider } from "./credentials.js";
import { buildSystemPrompt } from "./prompts.js";
import type { AgentId, ModelSpec, PairRole } from "./types.js";

export interface RunPromptOptions {
	onEvent?: (event: AgentEvent) => void;
}

function resolveModel(spec: ModelSpec): Model<any> {
	const model = getModels(spec.provider).find((candidate) => candidate.id === spec.modelId);
	if (model) {
		return model;
	}
	const available = getModels(spec.provider).map((candidate) => candidate.id).slice(0, 20).join(", ");
	throw new Error(
		`Model not found: ${spec.provider}/${spec.modelId}. Available examples for provider: ${available || "(none)"}`,
	);
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export class ModelWorker {
	readonly id: AgentId;
	readonly modelSpec: ModelSpec;
	readonly agent: Agent;

	private readonly codingTools;
	private readonly readOnlyTools;

	constructor(id: AgentId, modelSpec: ModelSpec, cwd: string) {
		this.id = id;
		this.modelSpec = modelSpec;
		this.codingTools = createCodingTools(cwd);
		this.readOnlyTools = createReadOnlyTools(cwd);

		const model = resolveModel(modelSpec);
		if (!hasApiKeySourceForProvider(model.provider)) {
			throw new Error(
				`Missing credentials for provider "${model.provider}". Set an API key env var or configure a 1Password reference.`,
			);
		}
		this.agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt(id),
				model,
				thinkingLevel: modelSpec.thinkingLevel,
				tools: this.codingTools,
			},
			getApiKey: async (provider) => {
				return await resolveApiKeyForProvider(provider);
			},
		});
	}

	setRole(role: PairRole): void {
		if (role === "driver") {
			this.agent.setTools(this.codingTools);
			return;
		}
		this.agent.setTools(this.readOnlyTools);
	}

	appendSharedContext(content: string): void {
		this.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: `[SHARED CONTEXT]\n${content}` }],
			timestamp: Date.now(),
		});
	}

	appendPrivateMemory(content: string): void {
		this.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: `[PRIVATE MEMORY - MODEL ${this.id} ONLY]\n${content}` }],
			timestamp: Date.now(),
		});
	}

	async runPrompt(prompt: string, options?: RunPromptOptions): Promise<string> {
		let unsubscribe: (() => void) | undefined;
		if (options?.onEvent) {
			unsubscribe = this.agent.subscribe(options.onEvent);
		}
		try {
			await this.agent.prompt(prompt);
		} finally {
			unsubscribe?.();
		}

		const message = this.lastAssistantMessage();
		if (!message) {
			return "";
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			const reason = message.errorMessage?.trim() || "unknown provider error";
			throw new Error(`Model ${this.id} (${this.modelSpec.provider}/${this.modelSpec.modelId}) failed: ${reason}`);
		}
		return assistantText(message);
	}

	private lastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.agent.state.messages.length - 1; i >= 0; i -= 1) {
			const message: AgentMessage | undefined = this.agent.state.messages[i];
			if (!message) {
				continue;
			}
			if (message.role === "assistant") {
				return message;
			}
		}
		return undefined;
	}
}
