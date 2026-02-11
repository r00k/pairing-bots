import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SessionObserver } from "../src/observability.js";

describe("SessionObserver", () => {
	it("writes event stream incrementally and persists final summary log", async () => {
		const root = join(tmpdir(), `pairing-bots-observability-${Date.now()}`);
		await mkdir(root, { recursive: true });
		const logFile = join(root, "session.json");
		const eventLogFile = join(root, "session.events.jsonl");

		const observer = new SessionObserver({
			cwd: root,
			logFile,
			eventLogFile,
		});
		observer.record({
			category: "session",
			name: "test_event",
			actor: "system",
		});

		const summary = await observer.flush("completed");
		expect(summary.eventStreamFile).toBe(eventLogFile);
		expect(summary.eventStreamMode).toBe("compact");
		expect(summary.eventCount).toBe(1);

		observer.record({
			category: "session",
			name: "ignored_after_flush",
			actor: "system",
		});
		const summaryAgain = await observer.flush("completed");
		expect(summaryAgain.eventCount).toBe(1);

		const eventLines = (await readFile(eventLogFile, "utf-8")).trim().split("\n");
		expect(eventLines.length).toBeGreaterThanOrEqual(3);
		const parsed = eventLines.map((line) => JSON.parse(line) as { type?: string; name?: string });
		expect(parsed.some((entry) => entry.name === "event_stream_start")).toBe(true);
		expect(parsed.some((entry) => entry.name === "test_event")).toBe(true);
		expect(parsed.some((entry) => entry.name === "event_stream_end")).toBe(true);
		expect(parsed.some((entry) => entry.name === "ignored_after_flush")).toBe(false);

		const finalLog = JSON.parse(await readFile(logFile, "utf-8")) as {
			summary?: { eventCount?: number; eventStreamFile?: string; eventStreamMode?: string };
		};
		expect(finalLog.summary?.eventCount).toBe(1);
		expect(finalLog.summary?.eventStreamFile).toBe(eventLogFile);
		expect(finalLog.summary?.eventStreamMode).toBe("compact");

		await rm(root, { recursive: true, force: true });
	});
});
