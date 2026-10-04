// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

import * as path from "node:path";
import * as vscode from "vscode";

export interface Choice {
	id: string;
	label: string;
}

/**
 * One chat request answered by an agent: what the agent streams is drawn in
 * VS Code's chat, its questions are asked there, and its file edits are
 * tracked as agent edits so they show as diffs the user can keep or undo.
 */
export class Turn {
	private readonly edits = new Map<string, () => void>();
	private questions = 0;

	constructor(
		private readonly stream: vscode.ChatResponseStream,
		readonly cwd: string,
	) {}

	text(value: string): void {
		this.stream.markdown(value);
	}

	progress(value: string): void {
		this.stream.progress(value);
	}

	uri(file: string): vscode.Uri {
		return vscode.Uri.file(path.isAbsolute(file) ? file : path.resolve(this.cwd, file));
	}

	/** Asks the user to pick one choice; undefined when the question is skipped. */
	async choose(title: string, message: string | undefined, choices: Choice[]): Promise<string | undefined> {
		const id = `q${++this.questions}`;
		const question = new vscode.ChatQuestion(id, vscode.ChatQuestionType.SingleSelect, title, {
			message,
			options: choices.map((c) => ({ id: c.id, label: c.label, value: c.id })),
			allowFreeformInput: false,
		});
		const answers = await this.stream.questionCarousel([question], true);
		return answerText(answers?.[id]);
	}

	/** Asks the user for text; undefined when the question is skipped. */
	async enterText(title: string, message: string | undefined, prefill: string | undefined): Promise<string | undefined> {
		const id = `q${++this.questions}`;
		const question = new vscode.ChatQuestion(id, vscode.ChatQuestionType.Text, title, {
			message,
			defaultValue: prefill,
			allowFreeformInput: true,
		});
		const answers = await this.stream.questionCarousel([question], true);
		return answerText(answers?.[id]);
	}

	/**
	 * Starts tracking an edit the agent makes to file itself: changes made to
	 * it until endEdit(key) count as agent edits. Resolves once VS Code has
	 * recorded the file as it is; a change made before that is not undoable.
	 */
	beginEdit(key: string, file: string): Promise<void> {
		if (this.edits.has(key)) {
			return Promise.resolve();
		}
		let done!: () => void;
		const finished = new Promise<void>((resolve) => (done = resolve));
		this.edits.set(key, done);
		let recorded = false;
		return new Promise<void>((resolve, reject) => {
			this.stream
				.externalEdit(this.uri(file), () => {
					recorded = true;
					resolve();
					return finished;
				})
				.then(undefined, (error: unknown) => {
					this.edits.delete(key);
					if (recorded) {
						this.progress(`Could not track the edit of ${file}: ${errorText(error)}`);
					} else {
						reject(error);
					}
				});
		});
	}

	endEdit(key: string): void {
		this.edits.get(key)?.();
		this.edits.delete(key);
	}

	/** Ends every edit whose key starts with prefix. */
	endEdits(prefix: string): void {
		for (const key of [...this.edits.keys()]) {
			if (key.startsWith(prefix)) {
				this.endEdit(key);
			}
		}
	}

	/** Writes content to file as an agent edit. */
	async writeFile(file: string, content: string): Promise<void> {
		const uri = this.uri(file);
		await this.stream.externalEdit(uri, () => vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8")));
	}

	/** Ends the edits still open, so none is left pending when the turn ends. */
	finish(): void {
		this.endEdits("");
	}
}

/**
 * The text of one answer of questionCarousel: a string for a text question,
 * { selectedValue, freeformValue? } for a single-select question.
 */
function answerText(answer: unknown): string | undefined {
	if (answer === undefined || answer === null) {
		return undefined;
	}
	if (typeof answer === "object") {
		const value = answer as { selectedValue?: unknown; freeformValue?: unknown };
		return answerText(value.freeformValue ?? value.selectedValue);
	}
	return String(answer);
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The folder an agent works in: the active editor's workspace folder, else the first one. */
export function workingFolder(): string {
	const active = vscode.window.activeTextEditor?.document.uri;
	const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error("Open a folder or workspace first: the agent works in a workspace folder.");
	}
	return folder.uri.fsPath;
}

/** An image the user attached or pasted, as the agents take it: base64 data and its media type. */
export interface PromptImage {
	data: string;
	mimeType: string;
}

/** The images the user attached or pasted into the request. */
export async function promptImages(request: vscode.ChatRequest): Promise<PromptImage[]> {
	const images: PromptImage[] = [];
	for (const ref of request.references) {
		if (ref.value instanceof vscode.ChatReferenceBinaryData && ref.value.mimeType.startsWith("image/")) {
			const data = await ref.value.data();
			images.push({ data: Buffer.from(data).toString("base64"), mimeType: ref.value.mimeType });
		}
	}
	return images;
}

/** The request as text for the agent, with the files and selections the user attached. */
export function promptText(request: vscode.ChatRequest): string {
	const attached: string[] = [];
	for (const ref of request.references) {
		if (ref.value instanceof vscode.Uri) {
			attached.push(ref.value.fsPath);
		} else if (ref.value instanceof vscode.Location) {
			const r = ref.value.range;
			attached.push(`${ref.value.uri.fsPath}:${r.start.line + 1}-${r.end.line + 1}`);
		}
	}
	return attached.length ? `${request.prompt}\n\nAttached: ${attached.join(", ")}` : request.prompt;
}
