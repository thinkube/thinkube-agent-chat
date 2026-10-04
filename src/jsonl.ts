// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

import { Readable } from "node:stream";

/**
 * Calls onRecord with each JSON record of a JSONL stream. Records are split
 * on LF only: Unicode line separators are valid inside JSON strings, so a
 * generic line reader (Node's readline) would cut records apart.
 */
export function readJsonl(input: Readable, onRecord: (record: any) => void, onBadLine: (line: string) => void): void {
	let buffer = "";
	input.setEncoding("utf8");
	input.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			if (!line) {
				continue;
			}
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				onBadLine(line);
				continue;
			}
			onRecord(record);
		}
	});
}
