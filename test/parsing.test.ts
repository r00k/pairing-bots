import { describe, expect, it } from "vitest";
import { parseDriverDecision, parseDriverReport, parseJointVerdict, parseNavigatorReview } from "../src/parsing.js";

describe("parsing", () => {
	it("parses driver report tags", () => {
		const parsed = parseDriverReport(`
<status>done</status>
<summary>Implemented tests and fix.</summary>
<changes>src/a.ts, src/b.ts</changes>
<questions_for_navigator>Check edge case handling.</questions_for_navigator>
`);

		expect(parsed.status).toBe("done");
		expect(parsed.summary).toContain("Implemented");
		expect(parsed.changes).toContain("src/a.ts");
		expect(parsed.questionsForNavigator).toContain("edge case");
	});

	it("parses navigator private and public sections", () => {
		const parsed = parseNavigatorReview(`
<private_reflection>Need to inspect null handling.</private_reflection>
<public_feedback>Add null guard in parseConfig().</public_feedback>
<driver_recommendation>handoff</driver_recommendation>
`);

		expect(parsed.privateReflection).toContain("null handling");
		expect(parsed.hasFeedback).toBe(true);
		expect(parsed.driverRecommendation).toBe("handoff");
	});

	it("treats NONE feedback as no feedback", () => {
		const parsed = parseNavigatorReview(`
<private_reflection>Looks stable.</private_reflection>
<public_feedback>NONE</public_feedback>
`);

		expect(parsed.hasFeedback).toBe(false);
		expect(parsed.driverRecommendation).toBe("continue");
	});

	it("treats NONE feedback with punctuation as no feedback", () => {
		const parsed = parseNavigatorReview(`
<private_reflection>Looks stable.</private_reflection>
<public_feedback>NONE.</public_feedback>
`);

		expect(parsed.hasFeedback).toBe(false);
		expect(parsed.driverRecommendation).toBe("continue");
	});

	it("parses joint verdict", () => {
		const parsed = parseJointVerdict(`
<joint_verdict>APPROVED</joint_verdict>
<rationale>Checks pass and no findings remain.</rationale>
<next_steps>NONE</next_steps>
`);

		expect(parsed.jointVerdict).toBe("APPROVED");
		expect(parsed.nextSteps).toBe("NONE");
	});

	it("defaults malformed driver decision to partial", () => {
		const parsed = parseDriverDecision("unstructured output");
		expect(parsed.decision).toBe("partial");
		expect(parsed.justification).toContain("unstructured output");
	});
});
