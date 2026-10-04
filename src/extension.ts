// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { opencode } from "./opencode";
import { createPi } from "./pi";
import { registerAgent } from "./sessions";

export function activate(context: vscode.ExtensionContext): void {
	registerAgent(context, createPi(context.extensionPath));
	registerAgent(context, opencode);
}

export function deactivate(): void {}
