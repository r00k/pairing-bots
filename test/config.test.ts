import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCli } from "../src/config.js";

describe("parseCli", () => {
	it("parses --log-file into resolved logFile", () => {
		// 1. Absolute path — use resolve() so expectation is platform-neutral
		const abs = resolve("/tmp/session.json");
		const withAbsolute = parseCli(["--task", "x", "--log-file", abs]);
		expect(withAbsolute.logFile).toBe(abs);

		// 2. Relative path — resolves against process.cwd(), not processCwd
		const withRelative = parseCli(["--task", "x", "--log-file", "out/log.json"]);
		expect(withRelative.logFile).toBe(resolve("out/log.json"));

		// 3. Omitted — logFile is undefined
		const withoutFlag = parseCli(["--task", "x"]);
		expect(withoutFlag.logFile).toBeUndefined();
	});

	it("parses workspace and event stream options", () => {
		const parsed = parseCli([
			"--task",
			"x",
			"--execution-mode",
			"solo_driver_then_reviewer",
			"--event-stream-mode",
			"full",
			"--workspace-mode",
			"ephemeral_copy",
			"--keep-workspace",
			"--compare-strategies",
			"--event-log-file",
			"logs/events.jsonl",
		]);
		expect(parsed.pair.executionMode).toBe("solo_driver_then_reviewer");
		expect(parsed.eventStreamMode).toBe("full");
		expect(parsed.workspaceMode).toBe("ephemeral_copy");
		expect(parsed.keepWorkspace).toBe(true);
		expect(parsed.compareStrategies).toBe(true);
		expect(parsed.eventLogFile).toBe(resolve("logs/events.jsonl"));
	});

	it("defaults to paired execution mode and compare disabled", () => {
		const parsed = parseCli(["--task", "x"]);
		expect(parsed.pair.executionMode).toBe("paired_turns");
		expect(parsed.compareStrategies).toBe(false);
	});
});
