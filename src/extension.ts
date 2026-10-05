// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { opencode } from "./opencode";
import { createPi } from "./pi";
import { registerAgent } from "./sessions";

/** A chat of VS Code's own agent: `vscode-chat-session://local/<id>`. */
function isLocalChat(resource: vscode.Uri): boolean {
	return resource.scheme === "vscode-chat-session" && resource.authority === "local";
}

/**
 * The chat panel picks the chat it shows at startup before this extension has
 * registered its session types, so it shows a chat of VS Code's own agent,
 * which has no model in Thinkube IDE. The first chat the panel reports is
 * replaced with a new Tandem (powered by Pi) chat when it is such a chat; the
 * replaced chat stays in the Sessions list.
 */
function openTandemAtStartup(context: vscode.ExtensionContext, type: string): void {
	const command = `workbench.action.chat.openNewSessionSidebar.${type}`;
	const replace = (resource: vscode.Uri | undefined): void => {
		if (resource && isLocalChat(resource)) {
			vscode.commands.executeCommand(command).then(undefined, (error: unknown) => {
				vscode.window.showErrorMessage(`Tandem could not open its chat in the chat panel (${command}): ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	};
	const current = vscode.window.activeChatPanelSessionResource;
	if (current) {
		replace(current);
		return;
	}
	const first = vscode.window.onDidChangeActiveChatPanelSessionResource((resource) => {
		first.dispose();
		replace(resource);
	});
	context.subscriptions.push(first);
}

export function activate(context: vscode.ExtensionContext): void {
	const pi = createPi(context.extensionPath);
	registerAgent(context, pi);
	registerAgent(context, opencode);
	openTandemAtStartup(context, pi.type);
}

export function deactivate(): void {}
