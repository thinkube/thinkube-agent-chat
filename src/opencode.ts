// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

import * as acp from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { Agent, HistoryTurn, SessionRecord } from "./sessions";
import { Turn, promptImages, promptText } from "./turn";

/**
 * One `opencode acp` process speaking the Agent Client Protocol on stdio.
 * This extension is the client: it draws the agent's session updates in the
 * chat, answers its permission requests with the user's choice, and reads
 * and writes files for it.
 */
class OpencodeProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	readonly connection: acp.ClientSideConnection;
	private stderr = "";
	exited: string | undefined;
	canLoadSessions = false;
	/** Whether opencode takes image content in a prompt (ACP promptCapabilities.image). */
	canTakeImages = false;
	/** The turn being answered, by ACP session id. */
	readonly turns = new Map<string, Turn>();
	/** Sessions loaded into this process, by ACP session id. */
	readonly loaded = new Set<string>();
	/** History collected while loadSession replays a session, by ACP session id. */
	readonly replays = new Map<string, { turns: HistoryTurn[]; inPrompt: boolean }>();
	private readonly onExit = new Set<(reason: string) => void>();

	constructor(readonly cwd: string) {
		this.child = spawn("opencode", ["acp"], { cwd, env: process.env });
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)));
		const fail = (reason: string) => {
			this.exited = reason;
			for (const listener of this.onExit) {
				listener(reason);
			}
		};
		this.child.on("error", (error) => fail(`opencode could not start: ${error.message}`));
		this.child.on("exit", (code, signal) => fail(`opencode exited (${signal ?? `code ${code}`}): ${this.stderr.trim() || "no output on stderr"}`));
		const stream = acp.ndJsonStream(
			Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
		);
		this.connection = new acp.ClientSideConnection(() => this.client(), stream);
	}

	/** Rejects with the reason opencode exited, if it exits before work finishes. */
	untilExit(): { promise: Promise<never>; dispose: () => void } {
		let listener!: (reason: string) => void;
		const promise = new Promise<never>((_, reject) => {
			listener = (reason) => reject(new Error(reason));
			if (this.exited) {
				reject(new Error(this.exited));
			}
		});
		this.onExit.add(listener);
		promise.catch(() => undefined);
		return { promise, dispose: () => this.onExit.delete(listener) };
	}

	private client(): acp.Client {
		return {
			sessionUpdate: async ({ sessionId, update }) => {
				const turn = this.turns.get(sessionId);
				if (!turn) {
					this.replay(sessionId, update);
					return;
				}
				switch (update.sessionUpdate) {
					case "agent_message_chunk":
						if (update.content.type === "text") {
							turn.text(update.content.text);
						}
						break;
					case "tool_call":
						turn.progress(update.title);
						if (update.kind === "edit") {
							for (const location of update.locations ?? []) {
								turn.beginEdit(`${update.toolCallId}:${location.path}`, location.path);
							}
						}
						break;
					case "tool_call_update":
						if (update.status === "completed" || update.status === "failed") {
							turn.endEdits(`${update.toolCallId}:`);
						}
						break;
				}
			},
			requestPermission: async ({ sessionId, toolCall, options }) => {
				const turn = this.turns.get(sessionId);
				if (!turn) {
					return { outcome: { outcome: "cancelled" } };
				}
				const choice = await turn.choose(
					toolCall.title ?? "opencode asks for permission",
					undefined,
					options.map((o) => ({ id: o.optionId, label: o.name })),
				);
				return choice === undefined
					? { outcome: { outcome: "cancelled" } }
					: { outcome: { outcome: "selected", optionId: choice } };
			},
			writeTextFile: async ({ sessionId, path, content }) => {
				const turn = this.turns.get(sessionId);
				if (!turn) {
					throw new Error(`opencode asked to write ${path} outside a chat request`);
				}
				await turn.writeFile(path, content);
				return {};
			},
			readTextFile: async ({ path, line, limit }) => {
				// The editor's text, so unsaved changes are what the agent reads.
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
				let lines = document.getText().split("\n");
				const start = line ? line - 1 : 0;
				lines = lines.slice(start, limit ? start + limit : undefined);
				return { content: lines.join("\n") };
			},
		};
	}

	/** Collects the text of a session that loadSession replays. */
	private replay(sessionId: string, update: acp.SessionNotification["update"]): void {
		const replay = this.replays.get(sessionId);
		if (!replay) {
			return;
		}
		if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") {
			if (!replay.inPrompt) {
				replay.turns.push({ prompt: "", response: "" });
				replay.inPrompt = true;
			}
			replay.turns[replay.turns.length - 1].prompt += update.content.text;
		} else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
			replay.inPrompt = false;
			if (!replay.turns.length) {
				replay.turns.push({ prompt: "", response: "" });
			}
			replay.turns[replay.turns.length - 1].response += update.content.text;
		}
	}

	/** Loads a session into this process; returns the exchanges opencode replays. */
	async load(sessionId: string): Promise<HistoryTurn[]> {
		if (!this.canLoadSessions) {
			throw new Error(`opencode cannot reopen the session ${sessionId}: it does not offer loadSession`);
		}
		const replay = { turns: [] as HistoryTurn[], inPrompt: false };
		this.replays.set(sessionId, replay);
		try {
			// MCP servers come from opencode.json; none are added per session.
			await this.connection.loadSession({ sessionId, cwd: this.cwd, mcpServers: [] });
		} finally {
			this.replays.delete(sessionId);
		}
		this.loaded.add(sessionId);
		return replay.turns;
	}

	stop(): void {
		this.child.stdin.end();
	}
}

/** One opencode process per working folder; it holds every session there. */
const processes = new Map<string, Promise<OpencodeProcess>>();

function processFor(cwd: string): Promise<OpencodeProcess> {
	const existing = processes.get(cwd);
	if (existing) {
		return existing.then((p) => (p.exited ? start(cwd) : p));
	}
	return start(cwd);
}

function start(cwd: string): Promise<OpencodeProcess> {
	const starting = (async () => {
		const opencode = new OpencodeProcess(cwd);
		const exit = opencode.untilExit();
		try {
			const init = await Promise.race([
				opencode.connection.initialize({
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
				}),
				exit.promise,
			]);
			opencode.canLoadSessions = init.agentCapabilities?.loadSession === true;
			opencode.canTakeImages = init.agentCapabilities?.promptCapabilities?.image === true;
			return opencode;
		} finally {
			exit.dispose();
		}
	})();
	processes.set(cwd, starting);
	starting.catch(() => processes.delete(cwd));
	return starting;
}

/** The chat's opencode session in this process: loads it, or starts it for a new chat. */
async function sessionFor(opencode: OpencodeProcess, record: SessionRecord): Promise<string> {
	if (record.agentSession) {
		if (!opencode.loaded.has(record.agentSession)) {
			await opencode.load(record.agentSession);
		}
		return record.agentSession;
	}
	const created = await opencode.connection.newSession({ cwd: opencode.cwd, mcpServers: [] });
	opencode.loaded.add(created.sessionId);
	record.agentSession = created.sessionId;
	return created.sessionId;
}

async function run(
	record: SessionRecord,
	request: vscode.ChatRequest,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<void> {
	const opencode = await processFor(record.cwd);
	const images = await promptImages(request);
	if (images.length && !opencode.canTakeImages) {
		throw new Error("opencode does not take images in a prompt (its ACP promptCapabilities.image is not set)");
	}
	const sessionId = await sessionFor(opencode, record);
	const turn = new Turn(stream, opencode.cwd);
	opencode.turns.set(sessionId, turn);
	const exit = opencode.untilExit();
	const cancellation = token.onCancellationRequested(() => {
		opencode.connection.cancel({ sessionId }).catch(() => undefined);
	});
	try {
		const result = await Promise.race([
			opencode.connection.prompt({
				sessionId,
				prompt: [
					{ type: "text", text: promptText(request) },
					...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
				],
			}),
			exit.promise,
		]);
		if (result.stopReason === "refusal") {
			turn.text("\n\nopencode refused this request.");
		}
		if (result.stopReason === "max_tokens") {
			turn.text("\n\nopencode stopped: the answer reached the model's output limit.");
		}
	} finally {
		cancellation.dispose();
		exit.dispose();
		opencode.turns.delete(sessionId);
		turn.finish();
	}
}

export const opencode: Agent = {
	type: "thinkube-opencode",
	name: "Tandem (powered by opencode)",
	run,
	async history(record) {
		return (await processFor(record.cwd)).load(record.agentSession!);
	},
	dispose() {
		for (const starting of processes.values()) {
			starting.then((p) => p.stop(), () => undefined);
		}
	},
};
