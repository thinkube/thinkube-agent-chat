// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { readJsonl } from "./jsonl";
import { Agent, HistoryTurn, SessionRecord } from "./sessions";
import { Turn, errorText, promptImages, promptText } from "./turn";

const ALLOW = "allow";
const DENY = "deny";

/** Tools whose path argument names the file they change. */
/**
 * The title of the confirm dialog pi/before-edit.ts sends before Pi's edit or
 * write tool changes a file; answering it lets the tool run.
 */
const BEFORE_EDIT = "thinkube-agent-chat:before-edit";

/**
 * One `pi --mode rpc` process, holding one Pi session. Commands go to its
 * stdin as JSONL; responses, session events and extension dialogs come back
 * on stdout (Pi docs: rpc.md, json.md, rpc-extension-ui.md).
 */
class PiProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void }>();
	private listeners = new Set<(record: any) => void>();
	private nextId = 0;
	private stderr = "";
	exited: string | undefined;

	constructor(readonly cwd: string, beforeEdit: string) {
		this.child = spawn("pi", ["--mode", "rpc", "--extension", beforeEdit], { cwd, env: process.env });
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)));
		readJsonl(
			this.child.stdout,
			(record) => this.onRecord(record),
			(line) => (this.stderr = (this.stderr + `\nunparsable output: ${line}`).slice(-4000)),
		);
		const fail = (reason: string) => {
			this.exited = reason;
			for (const { reject } of this.pending.values()) {
				reject(new Error(reason));
			}
			this.pending.clear();
			for (const listener of this.listeners) {
				listener({ type: "process_exit", reason });
			}
		};
		this.child.on("error", (error) => fail(`pi could not start: ${error.message}`));
		this.child.on("exit", (code, signal) => fail(`pi exited (${signal ?? `code ${code}`}): ${this.stderr.trim() || "no output on stderr"}`));
	}

	private onRecord(record: any): void {
		if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
			const { resolve, reject } = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			if (record.success) {
				resolve(record.data);
			} else {
				reject(new Error(`pi ${record.command}: ${record.error}`));
			}
			return;
		}
		for (const listener of this.listeners) {
			listener(record);
		}
	}

	send(record: object): void {
		if (this.exited) {
			throw new Error(this.exited);
		}
		this.child.stdin.write(JSON.stringify(record) + "\n");
	}

	command(type: string, fields: object = {}): Promise<any> {
		const id = `c${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.send({ id, type, ...fields });
			} catch (error) {
				this.pending.delete(id);
				reject(error as Error);
			}
		});
	}

	listen(listener: (record: any) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	stop(): void {
		this.child.stdin.end();
	}
}

/** Pi processes by chat, so a chat keeps its Pi session across requests. */
const processes = new Map<string, PiProcess>();

/** The Pi process of a chat; starts one, reopening the chat's Pi session if it has one. */
async function processFor(record: SessionRecord, beforeEdit: string): Promise<PiProcess> {
	const running = processes.get(record.resource);
	if (running && !running.exited) {
		return running;
	}
	const pi = new PiProcess(record.cwd, beforeEdit);
	if (record.agentSession) {
		const switched = await pi.command("switch_session", { sessionPath: record.agentSession });
		if (switched?.cancelled) {
			pi.stop();
			throw new Error(`Pi did not reopen the session ${record.agentSession}: an extension cancelled the switch`);
		}
	} else {
		const state = await pi.command("get_state");
		if (!state?.sessionFile) {
			pi.stop();
			throw new Error("Pi reported no session file; check that sessions are not disabled in ~/.pi/agent/settings.json");
		}
		record.agentSession = state.sessionFile as string;
	}
	processes.set(record.resource, pi);
	return pi;
}

function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

/** The exchanges of a Pi session: each user message with the assistant text that follows it. */
function exchanges(messages: any[]): HistoryTurn[] {
	const turns: HistoryTurn[] = [];
	for (const message of messages) {
		if (message?.role === "user") {
			turns.push({ prompt: messageText(message.content), response: "" });
		} else if (message?.role === "assistant" && turns.length) {
			const text = messageText(message.content);
			if (text) {
				const last = turns[turns.length - 1];
				last.response = last.response ? `${last.response}\n\n${text}` : text;
			}
		}
	}
	return turns;
}

/** Answers one Pi extension dialog with the user's choice in the chat. */
async function answerDialog(pi: PiProcess, turn: Turn, request: any): Promise<void> {
	const reply = (fields: object) => pi.send({ type: "extension_ui_response", id: request.id, ...fields });
	switch (request.method) {
		case "confirm": {
			if (request.title === BEFORE_EDIT) {
				const { toolCallId, path: file } = JSON.parse(request.message);
				try {
					await turn.beginEdit(toolCallId, file);
					return reply({ confirmed: true });
				} catch (error) {
					turn.progress(`VS Code could not record ${file} before the edit: ${errorText(error)}`);
					return reply({ confirmed: false });
				}
			}
			const choice = await turn.choose(request.title, request.message, [
				{ id: ALLOW, label: "Allow" },
				{ id: DENY, label: "Deny" },
			]);
			return choice === undefined ? reply({ cancelled: true }) : reply({ confirmed: choice === ALLOW });
		}
		case "select": {
			const options: string[] = request.options ?? [];
			const choice = await turn.choose(request.title, undefined, options.map((o) => ({ id: o, label: o })));
			return choice === undefined ? reply({ cancelled: true }) : reply({ value: choice });
		}
		case "input":
		case "editor": {
			const value = await turn.enterText(request.title, request.placeholder, request.prefill);
			return value === undefined ? reply({ cancelled: true }) : reply({ value });
		}
		case "notify":
			turn.progress(request.message);
			return;
		default:
			return;
	}
}

async function run(
	beforeEdit: string,
	record: SessionRecord,
	request: vscode.ChatRequest,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<void> {
	const pi = await processFor(record, beforeEdit);
	const turn = new Turn(stream, record.cwd);
	let failure: string | undefined;
	let stopListening = () => {};

	const settled = new Promise<void>((resolve, reject) => {
		stopListening = pi.listen((record) => {
			switch (record.type) {
				case "message_update": {
					const event = record.assistantMessageEvent;
					if (event?.type === "text_delta") {
						turn.text(event.delta);
					}
					break;
				}
				case "message_end":
					if (record.message?.role === "assistant") {
						failure = record.message.stopReason === "error" ? record.message.errorMessage ?? "the model call failed" : undefined;
					}
					break;
				case "tool_execution_start":
					turn.progress(`Running ${record.toolName}`);
					break;
				case "tool_execution_end":
					turn.endEdit(record.toolCallId);
					break;
				case "auto_retry_start":
					turn.progress(`Retrying (${record.attempt}/${record.maxAttempts}): ${record.errorMessage}`);
					break;
				case "extension_ui_request":
					answerDialog(pi, turn, record).catch((error) => turn.progress(`Could not answer Pi's question: ${errorText(error)}`));
					break;
				case "agent_settled":
					stopListening();
					resolve();
					break;
				case "process_exit":
					stopListening();
					reject(new Error(record.reason));
					break;
			}
		});
	});
	const cancellation = token.onCancellationRequested(() => {
		pi.command("abort").catch(() => undefined);
	});

	// A prompt Pi rejects or handles without a run never settles; its
	// rejection is not awaited, and must not surface as unhandled.
	settled.catch(() => undefined);
	try {
		const images = await promptImages(request);
		const accepted = await pi.command("prompt", { message: promptText(request), ...(images.length ? { images } : {}) });
		if (accepted?.disposition !== "handled") {
			await settled;
		}
	} finally {
		stopListening();
		cancellation.dispose();
		turn.finish();
	}
	if (failure && !token.isCancellationRequested) {
		throw new Error(`Pi: ${failure}`);
	}
}

/** Pi as a chat session type; extensionPath is this extension's folder. */
export function createPi(extensionPath: string): Agent {
	const beforeEdit = path.join(extensionPath, "pi", "before-edit.ts");
	return {
		type: "thinkube-pi",
		name: "Tandem (powered by Pi)",
		run: (record, request, stream, token) => run(beforeEdit, record, request, stream, token),
		async history(record) {
			const data = await (await processFor(record, beforeEdit)).command("get_messages");
			return exchanges(data?.messages ?? []);
		},
		dispose() {
			for (const process of processes.values()) {
				process.stop();
			}
		},
	};
}
