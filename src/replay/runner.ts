import type { ChatResponse, Provider, ToolCall } from "../providers/types.js";
import type { RegistryIndex } from "../registry/index.js";
import { type AssertionResult, evaluateAssertions } from "./assertions.js";
import {
  checkJson,
  cosine,
  isRefusal,
  lexicalSimilarity,
  sameToolShape,
  type ToolShape,
  toolShape,
  wordCount,
} from "./metrics.js";
import { costUsd, type PriceTable, priceFor } from "./prices.js";
import type { PromptCase } from "./prompts.js";

export interface Side {
  model: string;
  provider: Provider;
}

export interface SideResult {
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  chars: number;
  words: number;
  jsonValid: boolean | null;
  jsonStrict: boolean | null;
  refusal: boolean;
  providerRefusal: boolean;
  toolShape: ToolShape;
  finishReason: string | null;
  error: string | null;
  assertions: AssertionResult[];
}

export interface PromptResult {
  id: string;
  prompt: PromptCase;
  from: SideResult;
  to: SideResult;
  lengthDeltaPct: number | null;
  similarity: number | null;
  toolShapeChanged: boolean;
  /** Target assertion failures, or comparison regressions when no assertions were supplied. */
  regressions: string[];
}

export interface Aggregate {
  prompts: number;
  errors: { from: number; to: number };
  refusals: { from: number; to: number };
  jsonExpected: number;
  jsonValid: { from: number; to: number };
  toolPrompts: number;
  toolCalls: { from: number; to: number };
  toolShapeChanged: number;
  meanChars: { from: number; to: number };
  meanLengthDeltaPct: number | null;
  meanLatencyMs: { from: number; to: number };
  totalCostUsd: { from: number | null; to: number | null };
  meanSimilarity: number | null;
  regressions: number;
  assertionsExpected: number;
  assertionsPassed: { from: number; to: number };
}

export interface ReplayReport {
  from: { model: string; provider: string; baseUrl: string };
  to: { model: string; provider: string; baseUrl: string };
  startedAt: string;
  durationMs: number;
  similarityMethod: string;
  results: PromptResult[];
  aggregate: Aggregate;
}

export interface ProgressEvent {
  side: "from" | "to" | "similarity";
  index: number;
  total: number;
  id: string;
  latencyMs?: number;
  error?: string;
}

export interface RunOptions {
  from: Side;
  to: Side;
  prompts: PromptCase[];
  prices: PriceTable;
  index?: RegistryIndex;
  maxTokens?: number;
  embed?: { provider: Provider; model: string };
  onProgress?: (event: ProgressEvent) => void;
}

function emptySide(error: string): SideResult {
  return {
    text: "",
    toolCalls: [],
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    chars: 0,
    words: 0,
    jsonValid: null,
    jsonStrict: null,
    refusal: false,
    providerRefusal: false,
    toolShape: { called: [], unknownTools: [], argsParse: true, missingRequired: [] },
    finishReason: null,
    error,
    assertions: [],
  };
}

function toSideResult(
  response: ChatResponse,
  prompt: PromptCase,
  side: Side,
  prices: PriceTable,
  index?: RegistryIndex,
): SideResult {
  const json = prompt.expect === "json" ? checkJson(response.text) : null;
  const price = priceFor(side.model, side.provider.name, prices, index);
  return {
    text: response.text,
    thinking: response.thinking,
    toolCalls: response.toolCalls,
    latencyMs: response.latencyMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: costUsd(price, response.inputTokens, response.outputTokens),
    chars: response.text.length,
    words: wordCount(response.text),
    jsonValid: json ? json.valid : null,
    jsonStrict: json ? json.strict : null,
    refusal: response.providerRefusal || isRefusal(response.text),
    providerRefusal: response.providerRefusal,
    toolShape: toolShape(response.toolCalls, prompt.tools),
    finishReason: response.finishReason,
    error: null,
    assertions: [],
  };
}

async function runSide(
  side: Side,
  label: "from" | "to",
  prompts: PromptCase[],
  options: RunOptions,
): Promise<SideResult[]> {
  const out: SideResult[] = [];
  for (let i = 0; i < prompts.length; i += 1) {
    const prompt = prompts[i]!;
    try {
      const response = await side.provider.chat({
        model: side.model,
        messages: prompt.messages,
        tools: prompt.tools,
        maxTokens: prompt.maxTokens ?? options.maxTokens ?? 512,
        temperature: prompt.temperature,
        jsonMode: prompt.expect === "json",
      });
      const result = toSideResult(response, prompt, side, options.prices, options.index);
      result.assertions = evaluateAssertions(prompt.assertions ?? [], result);
      out.push(result);
      options.onProgress?.({
        side: label,
        index: i,
        total: prompts.length,
        id: prompt.id,
        latencyMs: result.latencyMs,
      });
    } catch (error) {
      const message = (error as Error).message;
      const result = emptySide(message);
      result.assertions = evaluateAssertions(prompt.assertions ?? [], result);
      out.push(result);
      options.onProgress?.({
        side: label,
        index: i,
        total: prompts.length,
        id: prompt.id,
        error: message,
      });
    }
  }
  return out;
}

async function similarities(
  fromResults: SideResult[],
  toResults: SideResult[],
  options: RunOptions,
): Promise<{ scores: Array<number | null>; method: string }> {
  const scores: Array<number | null> = fromResults.map(() => null);
  const usable = fromResults.map(
    (f, i) => !f.error && !toResults[i]!.error && (f.text || toResults[i]!.text),
  );
  if (options.embed?.provider.embed) {
    try {
      const texts: string[] = [];
      const slots: number[] = [];
      fromResults.forEach((f, i) => {
        if (!usable[i]) return;
        texts.push(f.text || " ", toResults[i]!.text || " ");
        slots.push(i);
      });
      if (texts.length > 0) {
        const vectors = await options.embed.provider.embed(options.embed.model, texts);
        slots.forEach((slot, k) => {
          scores[slot] = cosine(vectors[k * 2]!, vectors[k * 2 + 1]!);
        });
      }
      return { scores, method: `embedding cosine (${options.embed.model})` };
    } catch (error) {
      options.onProgress?.({
        side: "similarity",
        index: 0,
        total: 1,
        id: "embed",
        error: (error as Error).message,
      });
    }
  }
  fromResults.forEach((f, i) => {
    if (usable[i]) scores[i] = lexicalSimilarity(f.text, toResults[i]!.text);
  });
  return { scores, method: "lexical cosine (term frequencies)" };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function sumCost(results: SideResult[]): number | null {
  const known = results.filter((r) => !r.error).map((r) => r.costUsd);
  if (known.length === 0 || known.some((c) => c === null)) return null;
  return known.reduce<number>((a, b) => a + (b ?? 0), 0);
}

export function aggregate(results: PromptResult[]): Aggregate {
  const from = results.map((r) => r.from);
  const to = results.map((r) => r.to);
  const okFrom = from.filter((r) => !r.error);
  const okTo = to.filter((r) => !r.error);
  const jsonPrompts = results.filter((r) => r.prompt.expect === "json");
  const toolPrompts = results.filter((r) => r.prompt.tools && r.prompt.tools.length > 0);
  const deltas = results.map((r) => r.lengthDeltaPct).filter((d): d is number => d !== null);
  const sims = results.map((r) => r.similarity).filter((s): s is number => s !== null);
  return {
    prompts: results.length,
    errors: { from: from.filter((r) => r.error).length, to: to.filter((r) => r.error).length },
    refusals: {
      from: okFrom.filter((r) => r.refusal).length,
      to: okTo.filter((r) => r.refusal).length,
    },
    jsonExpected: jsonPrompts.length,
    jsonValid: {
      from: jsonPrompts.filter((r) => r.from.jsonValid === true).length,
      to: jsonPrompts.filter((r) => r.to.jsonValid === true).length,
    },
    toolPrompts: toolPrompts.length,
    toolCalls: {
      from: toolPrompts.filter((r) => r.from.toolCalls.length > 0).length,
      to: toolPrompts.filter((r) => r.to.toolCalls.length > 0).length,
    },
    toolShapeChanged: results.filter((r) => r.toolShapeChanged).length,
    meanChars: {
      from: Math.round(mean(okFrom.map((r) => r.chars))),
      to: Math.round(mean(okTo.map((r) => r.chars))),
    },
    meanLengthDeltaPct: deltas.length ? Math.round(mean(deltas)) : null,
    meanLatencyMs: {
      from: Math.round(mean(okFrom.map((r) => r.latencyMs))),
      to: Math.round(mean(okTo.map((r) => r.latencyMs))),
    },
    totalCostUsd: { from: sumCost(from), to: sumCost(to) },
    meanSimilarity: sims.length ? Number(mean(sims).toFixed(3)) : null,
    regressions: results.filter((r) => r.regressions.length > 0).length,
    assertionsExpected: results.reduce((total, r) => total + (r.prompt.assertions?.length ?? 0), 0),
    assertionsPassed: {
      from: from.reduce((total, r) => total + r.assertions.filter((a) => a.passed).length, 0),
      to: to.reduce((total, r) => total + r.assertions.filter((a) => a.passed).length, 0),
    },
  };
}

export async function runReplay(options: RunOptions): Promise<ReplayReport> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const fromResults = await runSide(options.from, "from", options.prompts, options);
  const toResults = await runSide(options.to, "to", options.prompts, options);
  const sim = await similarities(fromResults, toResults, options);
  const results: PromptResult[] = options.prompts.map((prompt, i) => {
    const from = fromResults[i]!;
    const to = toResults[i]!;
    const bothOk = !from.error && !to.error;
    const lengthDeltaPct =
      bothOk && from.chars > 0 ? Math.round(((to.chars - from.chars) / from.chars) * 100) : null;
    const toolShapeChanged =
      bothOk && Boolean(prompt.tools?.length) && !sameToolShape(from.toolShape, to.toolShape);
    const regressions: string[] = [];
    if (prompt.assertions?.length) {
      for (const [j, assertion] of to.assertions.entries()) {
        if (!assertion.passed) regressions.push(`assertion ${j + 1} ${assertion.message}`);
      }
      if (!to.error && prompt.expect === "json" && !to.jsonValid) regressions.push("json broke");
    } else if (!from.error && to.error) regressions.push("error on target");
    else if (bothOk) {
      if (!from.refusal && to.refusal) regressions.push("new refusal");
      if (from.jsonValid === true && to.jsonValid === false) regressions.push("json broke");
      if (toolShapeChanged) regressions.push("tool shape changed");
      if (from.toolCalls.length > 0 && to.toolCalls.length === 0) regressions.push("no tool call");
      const score = sim.scores[i] ?? null;
      if (score !== null && score < 0.4) regressions.push("low similarity");
    }
    return {
      id: prompt.id,
      prompt,
      from,
      to,
      lengthDeltaPct,
      similarity: sim.scores[i] === null ? null : Number(sim.scores[i]!.toFixed(3)),
      toolShapeChanged,
      regressions,
    };
  });
  return {
    from: {
      model: options.from.model,
      provider: options.from.provider.name,
      baseUrl: options.from.provider.baseUrl,
    },
    to: {
      model: options.to.model,
      provider: options.to.provider.name,
      baseUrl: options.to.provider.baseUrl,
    },
    startedAt,
    durationMs: Math.round(performance.now() - started),
    similarityMethod: sim.method,
    results,
    aggregate: aggregate(results),
  };
}
