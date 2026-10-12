import { isDeepStrictEqual } from "node:util";
import type { SideResult } from "./runner.js";

export type ReplayAssertion =
  | { type: "text-equals" | "text-contains" | "tool-called"; value: string }
  | { type: "json-equals"; value: unknown }
  | { type: "refusal"; value: boolean }
  | { type: "tool-count" | "min-chars" | "max-chars" | "max-latency-ms"; value: number };

export interface AssertionResult {
  type: ReplayAssertion["type"];
  passed: boolean;
  message: string;
}

/** Validate before sending any prompts so typos cannot silently disable a requirement. */
export function parseAssertions(value: unknown, lineNumber: number): ReplayAssertion[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`line ${lineNumber}: assertions must be a non-empty array`);
  return value.map((entry: unknown, i) => {
    const fail = (reason: string): never => {
      throw new Error(`line ${lineNumber}: assertions[${i}] ${reason}`);
    };
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return fail("must be an object with type and value");
    const a = entry as Record<string, unknown>;
    if (Object.keys(a).some((key) => key !== "type" && key !== "value"))
      return fail("only accepts type and value");
    if (a.value === undefined) return fail("needs a value");
    switch (a.type) {
      case "text-equals":
      case "text-contains":
      case "tool-called":
        if (typeof a.value !== "string" || (a.type !== "text-equals" && !a.value.length))
          return fail("needs a string value (non-empty for text-contains and tool-called)");
        return { type: a.type, value: a.value };
      case "json-equals":
        return { type: a.type, value: a.value };
      case "refusal":
        if (typeof a.value !== "boolean") return fail("needs a boolean value");
        return { type: a.type, value: a.value };
      case "tool-count":
      case "min-chars":
      case "max-chars":
      case "max-latency-ms":
        if (
          typeof a.value !== "number" ||
          !Number.isFinite(a.value) ||
          a.value < 0 ||
          (a.type !== "max-latency-ms" && !Number.isInteger(a.value))
        )
          return fail("needs a finite non-negative number (integer for counts and lengths)");
        return { type: a.type, value: a.value };
      default:
        return fail(`has unknown type ${JSON.stringify(a.type)}`);
    }
  });
}

export function evaluateAssertions(
  assertions: ReplayAssertion[],
  side: SideResult,
): AssertionResult[] {
  return assertions.map((a) => {
    let passed = false;
    let reason = "provider error";
    if (!side.error) {
      switch (a.type) {
        case "text-equals":
          passed = side.text === a.value;
          reason = "response text differs";
          break;
        case "text-contains":
          passed = side.text.includes(a.value);
          reason = `response text does not contain ${JSON.stringify(a.value)}`;
          break;
        case "json-equals":
          try {
            passed = isDeepStrictEqual(JSON.parse(side.text), a.value);
            reason = "JSON value differs";
          } catch {
            reason = "response is not strict JSON";
          }
          break;
        case "refusal":
          passed = side.refusal === a.value;
          reason = `expected refusal ${a.value}, received ${side.refusal}`;
          break;
        case "tool-called":
          passed = side.toolCalls.some((call) => call.name === a.value);
          reason = `missing tool ${JSON.stringify(a.value)}`;
          break;
        case "tool-count":
          passed = side.toolCalls.length === a.value;
          reason = `expected ${a.value} tool calls, received ${side.toolCalls.length}`;
          break;
        case "min-chars":
          passed = side.chars >= a.value;
          reason = `expected at least ${a.value} chars, received ${side.chars}`;
          break;
        case "max-chars":
          passed = side.chars <= a.value;
          reason = `expected at most ${a.value} chars, received ${side.chars}`;
          break;
        case "max-latency-ms":
          passed = side.latencyMs <= a.value;
          reason = `expected at most ${a.value} ms, received ${side.latencyMs}`;
          break;
      }
    }
    return { type: a.type, passed, message: `${a.type}: ${passed ? "pass" : `fail (${reason})`}` };
  });
}
