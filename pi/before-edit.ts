// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0
//
// Loaded only by thinkube-agent-chat, into the `pi --mode rpc` process it
// runs for a chat (pi -e <this file>). Before Pi's edit or write tool changes
// a file, it asks the chat client through a confirm dialog with the title
// below; the client answers once VS Code has recorded the file as it is, so
// the edit shows as a change the user can keep or undo. A "no" blocks the
// edit: an edit VS Code did not record could not be undone.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BEFORE_EDIT = "thinkube-agent-chat:before-edit";
const EDIT_TOOLS = new Set(["edit", "write"]);

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!EDIT_TOOLS.has(event.toolName)) return undefined;
		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== "string") return undefined;
		const message = JSON.stringify({ toolCallId: event.toolCallId, path });
		if (!(await ctx.ui.confirm(BEFORE_EDIT, message))) {
			return { block: true, reason: `VS Code did not record ${path} before the edit, so the edit was not made` };
		}
		return undefined;
	});
}
