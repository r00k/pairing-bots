import { describe, expect, it } from "vitest";
import { isOpReference } from "../src/credentials.js";

describe("credentials", () => {
	it("detects op references", () => {
		expect(isOpReference("op://Vault/Item/field")).toBe(true);
		expect(isOpReference("sk-plain-key")).toBe(false);
	});
});
