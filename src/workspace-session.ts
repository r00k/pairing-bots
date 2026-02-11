import { cp, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { WorkspaceMode } from "./types.js";

const EXCLUDED_COPY_ENTRIES = new Set([".git", ".pairing-bots", "node_modules"]);

export interface WorkspaceSessionOptions {
	baseCwd: string;
	mode: WorkspaceMode;
	keepWorkspace: boolean;
}

export interface CleanupResult {
	cleaned: boolean;
	preservedPath?: string;
}

export interface WorkspaceSession {
	mode: WorkspaceMode;
	baseCwd: string;
	runtimeCwd: string;
	keepWorkspace: boolean;
	cleanup: () => Promise<CleanupResult>;
}

async function mirrorWorkspace(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	await cp(source, destination, {
		recursive: true,
		force: true,
		errorOnExist: false,
		filter: (srcPath) => !EXCLUDED_COPY_ENTRIES.has(basename(srcPath)),
	});

	const sourceNodeModules = join(source, "node_modules");
	const destinationNodeModules = join(destination, "node_modules");
	try {
		await lstat(sourceNodeModules);
		await symlink(sourceNodeModules, destinationNodeModules, "dir");
	} catch {
		// Dependencies are optional for short editing runs.
	}
}

export async function prepareWorkspaceSession(options: WorkspaceSessionOptions): Promise<WorkspaceSession> {
	if (options.mode === "direct") {
		return {
			mode: "direct",
			baseCwd: options.baseCwd,
			runtimeCwd: options.baseCwd,
			keepWorkspace: options.keepWorkspace,
			cleanup: async () => ({ cleaned: false }),
		};
	}

	const scratchRoot = await mkdtemp(join(tmpdir(), "pairing-bots-run-"));
	const runtimeCwd = join(scratchRoot, "workspace");
	await mirrorWorkspace(options.baseCwd, runtimeCwd);

	return {
		mode: "ephemeral_copy",
		baseCwd: options.baseCwd,
		runtimeCwd,
		keepWorkspace: options.keepWorkspace,
		cleanup: async () => {
			if (options.keepWorkspace) {
				return { cleaned: false, preservedPath: scratchRoot };
			}
			await rm(scratchRoot, { recursive: true, force: true });
			return { cleaned: true };
		},
	};
}
