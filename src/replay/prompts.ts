import { readFileSync } from "node:fs";
import type { ChatMessage, ToolDef } from "../providers/types.js";
import { parseAssertions, type ReplayAssertion } from "./assertions.js";

export interface PromptCase {
  id: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** "json" when the output must parse as JSON. */
  expect?: "json" | "text";
  /** Explicit response requirements, used instead of comparison heuristics when supplied. */
  assertions?: ReplayAssertion[];
  maxTokens?: number;
  temperature?: number;
  /** Where the prompt came from, for the report. */
  source?: string;
}

function asString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Turns one parsed JSONL record into a PromptCase, or throws with a reason. */
export function normalizePrompt(record: unknown, lineNumber: number): PromptCase {
  if (!record || typeof record !== "object") throw new Error(`line ${lineNumber}: not an object`);
  const r = record as Record<string, unknown>;
  const messages: ChatMessage[] = [];
  if (asString(r.system)) messages.push({ role: "system", content: r.system });
  if (Array.isArray(r.messages)) {
    for (const m of r.messages) {
      const mm = m as Record<string, unknown>;
      if (!mm || !asString(mm.role) || typeof mm.content !== "string")
        throw new Error(`line ${lineNumber}: messages entries need role and string content`);
      if (mm.role !== "system" && mm.role !== "user" && mm.role !== "assistant")
        throw new Error(`line ${lineNumber}: unsupported role "${mm.role}"`);
      messages.push({ role: mm.role, content: mm.content });
    }
  } else if (asString(r.prompt)) {
    messages.push({ role: "user", content: r.prompt });
  } else {
    throw new Error(`line ${lineNumber}: needs "prompt" (string) or "messages" (array)`);
  }
  let tools: ToolDef[] | undefined;
  if (r.tools !== undefined) {
    if (!Array.isArray(r.tools)) throw new Error(`line ${lineNumber}: tools must be an array`);
    tools = r.tools.map((t, i) => {
      const tt = t as Record<string, unknown>;
      if (!tt || !asString(tt.name))
        throw new Error(`line ${lineNumber}: tools[${i}] needs a name`);
      return {
        name: tt.name,
        description: asString(tt.description) ? tt.description : undefined,
        parameters:
          tt.parameters && typeof tt.parameters === "object"
            ? (tt.parameters as Record<string, unknown>)
            : tt.input_schema && typeof tt.input_schema === "object"
              ? (tt.input_schema as Record<string, unknown>)
              : undefined,
      };
    });
  }
  let expect: "json" | "text" | undefined;
  if (r.expect === "json" || r.expect_json === true) expect = "json";
  else if (r.expect === "text") expect = "text";
  else if (r.expect !== undefined)
    throw new Error(`line ${lineNumber}: expect must be "json" or "text"`);
  const id = asString(r.id) ? r.id : `prompt-${lineNumber}`;
  const out: PromptCase = { id, messages };
  if (tools) out.tools = tools;
  if (expect) out.expect = expect;
  if (r.assertions !== undefined) out.assertions = parseAssertions(r.assertions, lineNumber);
  if (typeof r.max_tokens === "number") out.maxTokens = r.max_tokens;
  if (typeof r.temperature === "number") out.temperature = r.temperature;
  if (asString(r.source)) out.source = r.source;
  return out;
}

export function parsePromptsJsonl(text: string): PromptCase[] {
  const cases: PromptCase[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`line ${i + 1}: invalid JSON (${(error as Error).message})`);
    }
    cases.push(normalizePrompt(parsed, i + 1));
  }
  return cases;
}

export function loadPromptsFile(file: string): PromptCase[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read prompts file ${file}: ${(error as Error).message}`);
  }
  const cases = parsePromptsJsonl(text);
  if (cases.length === 0) throw new Error(`Prompts file ${file} contains no prompts`);
  return cases;
}

export function promptText(c: PromptCase): string {
  const user = [...c.messages].reverse().find((m) => m.role === "user");
  return user?.content ?? c.messages.map((m) => m.content).join("\n");
}
