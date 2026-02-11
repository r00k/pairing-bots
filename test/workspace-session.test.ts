import { access, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { prepareWorkspaceSession } from "../src/workspace-session.js";

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("workspace session", () => {
	it("returns direct workspace without cleanup side effects", async () => {
		const session = await prepareWorkspaceSession({
			baseCwd: process.cwd(),
			mode: "direct",
			keepWorkspace: false,
		});
		expect(session.runtimeCwd).toBe(process.cwd());
		const result = await session.cleanup();
		expect(result.cleaned).toBe(false);
	});

	it("creates and cleans ephemeral workspace copy", async () => {
		const root = join(tmpdir(), `pairing-bots-test-${Date.now()}`);
		await mkdir(root, { recursive: true });
		const source = join(root, "source");
		await mkdir(source, { recursive: true });
		await mkdir(join(source, "src"), { recursive: true });
		await mkdir(join(source, ".git"), { recursive: true });
		await mkdir(join(source, ".pairing-bots"), { recursive: true });
		await writeFile(join(source, "src", "a.txt"), "hello", "utf-8");
		await writeFile(join(source, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
		await writeFile(join(source, ".pairing-bots", "state.txt"), "private", "utf-8");
		await mkdir(join(source, "node_modules"), { recursive: true });
		await symlink(join(source, "src"), join(source, "linked-src"));

		const session = await prepareWorkspaceSession({
			baseCwd: source,
			mode: "ephemeral_copy",
			keepWorkspace: false,
		});

		const copied = await readFile(join(session.runtimeCwd, "src", "a.txt"), "utf-8");
		expect(copied).toBe("hello");
		expect(await pathExists(join(session.runtimeCwd, ".git"))).toBe(false);
		expect(await pathExists(join(session.runtimeCwd, ".pairing-bots"))).toBe(false);
		expect(await pathExists(join(session.runtimeCwd, "node_modules"))).toBe(true);

		const linkedStat = await lstat(join(session.runtimeCwd, "linked-src"));
		expect(linkedStat.isSymbolicLink()).toBe(true);

		const scratchRoot = dirname(session.runtimeCwd);
		await session.cleanup();
		expect(await pathExists(scratchRoot)).toBe(false);

		await rm(root, { recursive: true, force: true });
	});
});
