// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { workingFolder } from "./turn";

/** One chat of an agent, as this extension keeps it across reloads. */
export interface SessionRecord {
	/** The chat's resource in VS Code: `<session type>:/<uuid>`. */
	resource: string;
	label: string;
	/** The folder the agent works in, fixed when the chat starts. */
	cwd: string;
	/** The agent's own session: Pi's session file, opencode's session id. */
	agentSession?: string;
	created: number;
	lastStarted?: number;
	lastEnded?: number;
}

/** One past exchange, for showing a reopened chat. */
export interface HistoryTurn {
	prompt: string;
	response: string;
}

/** A coding agent offered as its own kind of chat in VS Code's chat panel. */
export interface Agent {
	/** The chat session type, declared in package.json `chatSessions`. */
	readonly type: string;
	readonly name: string;
	/** Answers one request; sets record.agentSession when it starts the agent's session. */
	run(record: SessionRecord, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void>;
	/** The exchanges of the agent's session, read from the agent. */
	history(record: SessionRecord): Promise<HistoryTurn[]>;
	dispose(): void;
}

const TITLE_LENGTH = 60;

function title(prompt: string): string {
	const line = prompt.trim().split("\n")[0];
	return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

/** The chats of one agent, kept in the extension's global state. */
class SessionStore {
	private readonly key: string;

	constructor(private readonly state: vscode.Memento, type: string) {
		this.key = `sessions.${type}`;
	}

	all(): SessionRecord[] {
		return this.state.get<SessionRecord[]>(this.key, []);
	}

	get(resource: vscode.Uri): SessionRecord | undefined {
		const id = resource.toString();
		return this.all().find((r) => r.resource === id);
	}

	save(record: SessionRecord): Thenable<void> {
		return this.state.update(this.key, [...this.all().filter((r) => r.resource !== record.resource), record]);
	}
}

/**
 * Registers an agent as a chat session type: VS Code lists it beside "Local"
 * in the chat panel, lists its chats, and sends what the user types in one of
 * its chats to the agent. The agent gets one model entry that only its own
 * chats show; VS Code passes a request on only with a model it can resolve,
 * and the agent's own configuration chooses the model it calls.
 */
export function registerAgent(context: vscode.ExtensionContext, agent: Agent): void {
	const store = new SessionStore(context.globalState, agent.type);
	const icon = new vscode.ThemeIcon("hubot");

	const controller = vscode.chat.createChatSessionItemController(agent.type, async () => {
		controller.items.replace(store.all().map(toItem));
	});

	function toItem(record: SessionRecord): vscode.ChatSessionItem {
		const item = controller.createChatSessionItem(vscode.Uri.parse(record.resource), record.label);
		item.iconPath = icon;
		item.timing = { created: record.created, lastRequestStarted: record.lastStarted, lastRequestEnded: record.lastEnded };
		return item;
	}

	controller.newChatSessionItemHandler = async ({ request }) => {
		const record: SessionRecord = {
			resource: vscode.Uri.from({ scheme: agent.type, path: `/${randomUUID()}` }).toString(),
			label: title(request.prompt || agent.name),
			cwd: workingFolder(),
			created: Date.now(),
		};
		await store.save(record);
		return toItem(record);
	};

	const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
		const resource = chatContext.chatSessionContext?.chatSessionItem.resource;
		if (!resource) {
			throw new Error(`${agent.name} answers only in its own chats: start one with "${agent.name}" in the chat's session picker.`);
		}
		const record = store.get(resource);
		if (!record) {
			throw new Error(`${agent.name} has no record of the chat ${resource.toString()}`);
		}
		record.lastStarted = Date.now();
		record.lastEnded = undefined;
		await store.save(record);
		controller.items.add(toItem(record));
		try {
			await agent.run(record, request, stream, token);
		} finally {
			record.lastEnded = Date.now();
			await store.save(record);
			controller.items.add(toItem(record));
		}
		return {};
	};

	const participant = vscode.chat.createChatParticipant(agent.type, handler);
	participant.iconPath = icon;

	const content: vscode.ChatSessionContentProvider = {
		async provideChatSessionContent(resource) {
			const record = store.get(resource);
			const turns = record?.agentSession ? await agent.history(record) : [];
			const history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
			for (const turn of turns) {
				history.push(new vscode.ChatRequestTurn2(turn.prompt, undefined, [], agent.type, [], undefined, undefined, undefined, undefined) as unknown as vscode.ChatRequestTurn);
				history.push(new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(turn.response)], {}, agent.type));
			}
			return { title: record?.label, history, requestHandler: handler };
		},
	};

	const model: vscode.LanguageModelChatInformation = {
		id: agent.type,
		name: agent.name,
		family: agent.type,
		version: "1",
		tooltip: `${agent.name} calls the model set in its own configuration.`,
		maxInputTokens: 0,
		maxOutputTokens: 0,
		capabilities: { toolCalling: true, imageInput: true },
		targetChatSessionType: agent.type,
		isUserSelectable: true,
		isDefault: true,
	};
	// VS Code reads a vendor's models when the vendor reports a change (or when
	// something asks for every vendor's models, which the Copilot extension
	// does; without it, nothing would). Firing once after registration makes
	// the entry known as soon as the extension starts.
	const modelsChanged = new vscode.EventEmitter<void>();
	const models: vscode.LanguageModelChatProvider = {
		onDidChangeLanguageModelChatInformation: modelsChanged.event,
		provideLanguageModelChatInformation: () => [model],
		provideLanguageModelChatResponse: () => {
			throw new Error(`${agent.name} is an agent, not a model: talk to it in its own chats.`);
		},
		provideTokenCount: async () => 0,
	};

	context.subscriptions.push(
		controller,
		participant,
		vscode.chat.registerChatSessionContentProvider(agent.type, content, participant),
		vscode.lm.registerLanguageModelChatProvider(agent.type, models),
		modelsChanged,
		agent,
	);
	modelsChanged.fire();
}
