import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getEnvApiKey } from "@mariozechner/pi-ai";

const execFileAsync = promisify(execFile);

const opRefValueCache = new Map<string, string>();
const opRefPendingCache = new Map<string, Promise<string>>();
let opInstallChecked = false;

function providerToOpRefEnvName(provider: string): string {
	const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	return `PAIRING_BOTS_${normalized}_OP_REF`;
}

export function isOpReference(value: string): boolean {
	return value.startsWith("op://");
}

export function hasApiKeySourceForProvider(provider: string): boolean {
	const direct = getEnvApiKey(provider as any);
	if (direct && direct.trim()) {
		return true;
	}
	const opRef = process.env[providerToOpRefEnvName(provider)];
	return Boolean(opRef && opRef.trim());
}

function getConfiguredKeyValue(provider: string): string | undefined {
	const direct = getEnvApiKey(provider as any);
	if (direct && direct.trim()) {
		return direct.trim();
	}

	const refVar = providerToOpRefEnvName(provider);
	const opRef = process.env[refVar];
	if (opRef && opRef.trim()) {
		return opRef.trim();
	}

	return undefined;
}

async function ensureOpInstalled(): Promise<void> {
	if (opInstallChecked) {
		return;
	}
	try {
		await execFileAsync("op", ["--version"]);
		opInstallChecked = true;
	} catch {
		throw new Error(
			"1Password CLI (op) is not installed or not on PATH. Install it and run 'op signin', or use plain API key env vars.",
		);
	}
}

async function resolveOpReference(reference: string): Promise<string> {
	const cached = opRefValueCache.get(reference);
	if (cached) {
		return cached;
	}

	const pending = opRefPendingCache.get(reference);
	if (pending) {
		return pending;
	}

	const resolution = (async () => {
		await ensureOpInstalled();
		try {
			const { stdout } = await execFileAsync("op", ["read", reference]);
			const value = stdout.trim();
			if (!value) {
				throw new Error(`1Password reference resolved to an empty value: ${reference}`);
			}
			opRefValueCache.set(reference, value);
			return value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to resolve 1Password reference (${reference}). Ensure 'op signin' is active and access is granted. Cause: ${message}`,
			);
		} finally {
			opRefPendingCache.delete(reference);
		}
	})();

	opRefPendingCache.set(reference, resolution);
	return resolution;
}

export async function resolveApiKeyForProvider(provider: string): Promise<string | undefined> {
	const configured = getConfiguredKeyValue(provider);
	if (!configured) {
		return undefined;
	}

	if (!isOpReference(configured)) {
		return configured;
	}

	return await resolveOpReference(configured);
}
