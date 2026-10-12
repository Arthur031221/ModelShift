import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderReplaySummary, runReplayCommand } from "../src/commands/replay.js";
import type { IO } from "../src/commands/shared.js";
import type { ChatResponse, Provider } from "../src/providers/types.js";
import { loadPrices } from "../src/replay/prices.js";
import { parsePromptsJsonl } from "../src/replay/prompts.js";
import { renderHtmlReport } from "../src/replay/report.js";
import { runReplay } from "../src/replay/runner.js";

function provider(response: Partial<ChatResponse> | Error): Provider {
  return {
    kind: "openai",
    name: "ollama",
    baseUrl: "http://fake",
    async chat() {
      if (response instanceof Error) throw response;
      return {
        text: "answer",
        toolCalls: [],
        inputTokens: 5,
        outputTokens: 5,
        latencyMs: 10,
        finishReason: "stop",
        providerRefusal: false,
        ...response,
      };
    },
  };
}

async function replay(
  assertions: unknown,
  from: Partial<ChatResponse> | Error = {},
  to: Partial<ChatResponse> | Error = from,
  extra: Record<string, unknown> = {},
) {
  return runReplay({
    from: { model: "source", provider: provider(from) },
    to: { model: "target", provider: provider(to) },
    prompts: parsePromptsJsonl(JSON.stringify({ prompt: "test", assertions, ...extra })),
    prices: loadPrices(),
  });
}

describe("user-defined replay requirements (reddit:pd1zidr:1)", () => {
  it.each([
    [{ type: "text-equals", value: "expected" }, { text: "wrong" }],
    [{ type: "text-contains", value: "expected" }, { text: "wrong" }],
    [{ type: "json-equals", value: { answer: 42 } }, { text: '{"answer":41}' }],
    [{ type: "refusal", value: true }, { text: "Sure, here you go." }],
    [{ type: "tool-called", value: "weather" }, { toolCalls: [] }],
    [{ type: "tool-count", value: 0 }, { toolCalls: [{ name: "weather", arguments: "{}" }] }],
    [{ type: "min-chars", value: 5 }, { text: "four" }],
    [{ type: "max-chars", value: 3 }, { text: "four" }],
    [{ type: "max-latency-ms", value: 10 }, { latencyMs: 11 }],
  ])("fails %j even when the source has the same failure", async (assertion, response) => {
    const report = await replay([assertion], response);
    expect(report.aggregate.regressions).toBe(1);
    expect(report.results[0]!.regressions[0]).toContain(assertion.type);
    expect(report.results[0]!.from).toHaveProperty("assertions.0.passed", false);
    expect(report.results[0]!.to).toHaveProperty("assertions.0.passed", false);
  });

  it("reports passing requirements on both sides and includes boundary values", async () => {
    const report = await replay(
      [
        { type: "text-equals", value: "answer" },
        { type: "text-contains", value: "swer" },
        { type: "refusal", value: false },
        { type: "tool-called", value: "weather" },
        { type: "tool-count", value: 1 },
        { type: "min-chars", value: 6 },
        { type: "max-chars", value: 6 },
        { type: "max-latency-ms", value: 10 },
      ],
      { toolCalls: [{ name: "weather", arguments: "{}" }] },
    );
    expect(report.results[0]!.from).toHaveProperty("assertions.0.passed", true);
    expect(report.results[0]!.to).toHaveProperty("assertions.7.passed", true);
    expect(report.aggregate.regressions).toBe(0);
    expect(renderHtmlReport(report)).toContain("text-equals: pass");
    expect(renderReplaySummary(report, null)).toContain("assertions");
  });

  it("compares JSON values without depending on object key order", async () => {
    const report = await replay(
      [{ type: "json-equals", value: { result: [42, { a: 1, b: 2 }] } }],
      { text: '{"result":[42,{"b":2,"a":1}]}' },
    );
    expect(report.results[0]!.to).toHaveProperty("assertions.0.passed", true);
    expect(report.aggregate.regressions).toBe(0);
  });

  it.each(["not json", '```json\n{"answer":42}\n```', '{"answer":42,"extra":true}'])(
    "rejects a response that is not the exact JSON value: %s",
    async (text) => {
      const report = await replay([{ type: "json-equals", value: { answer: 42 } }], { text });
      expect(report.aggregate.regressions).toBe(1);
    },
  );

  it("does not treat a provider error as a passing empty response", async () => {
    const report = await replay([{ type: "max-chars", value: 0 }], new Error("offline"));
    expect(report.results[0]!.to).toHaveProperty("assertions.0.passed", false);
    expect(report.aggregate.regressions).toBe(1);
  });

  it("requires every assertion and preserves the explicit JSON requirement", async () => {
    const report = await replay([
      { type: "text-contains", value: "answer" },
      { type: "max-chars", value: 3 },
    ]);
    expect(report.results[0]!.to.assertions.map((a) => a.passed)).toEqual([true, false]);
    expect(report.aggregate.assertionsPassed).toEqual({ from: 1, to: 1 });
    expect(report.aggregate.assertionsExpected).toBe(2);
    expect(report.aggregate.regressions).toBe(1);
    const json = await replay(
      [{ type: "text-equals", value: "answer" }],
      {},
      {},
      { expect: "json" },
    );
    expect(json.results[0]!.regressions).toEqual(["json broke"]);
  });

  it("accepts a passing target when the source has a provider error", async () => {
    const report = await replay([{ type: "refusal", value: true }], new Error("offline"), {
      providerRefusal: true,
    });
    expect(report.results[0]!.from.assertions[0]!.passed).toBe(false);
    expect(report.results[0]!.to.assertions[0]!.passed).toBe(true);
    expect(report.aggregate.regressions).toBe(0);
  });

  it("rejects non-finite latency limits and preserves the JSONL line number", () => {
    expect(() =>
      parsePromptsJsonl(
        '\n{"prompt":"test","assertions":[{"type":"max-latency-ms","value":1e400}]}',
      ),
    ).toThrow("line 2: assertions[0]");
  });

  it("escapes assertion values and messages in the HTML report", async () => {
    const report = await replay([{ type: "text-contains", value: "<script>alert(1)</script>" }]);
    const html = renderHtmlReport(report);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it.each([
    null,
    {},
    [],
    [null],
    [{ type: "unknown", value: "x" }],
    [{ type: "text-equals" }],
    [{ type: "text-contains", value: "" }],
    [{ type: "refusal", value: "false" }],
    [{ type: "tool-called", value: 42 }],
    [{ type: "tool-count", value: 0.5 }],
    [{ type: "min-chars", value: -1 }],
    [{ type: "max-chars", value: "10" }],
    [{ type: "max-latency-ms", value: null }],
    [{ type: "max-chars", value: 10, vaule: 5 }],
  ])("rejects malformed assertions before provider calls: %j", (assertions) => {
    expect(() => parsePromptsJsonl(JSON.stringify({ prompt: "test", assertions }))).toThrow(
      "line 1: assertions",
    );
  });

  it("enforces assertions through the replay command and writes their HTML results", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "modelshift-assertions-"));
    try {
      await writeFile(
        path.join(cwd, "prompts.jsonl"),
        JSON.stringify({
          prompt: "test",
          assertions: [{ type: "text-equals", value: "expected" }],
        }),
      );
      const out: string[] = [];
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "wrong" }, finish_reason: "stop" }] }),
            { status: 200 },
          ),
      );
      const io: IO = {
        cwd,
        env: {},
        isTTY: false,
        stdout: (text) => out.push(text),
        stderr: () => {},
        fetchImpl,
      };
      const code = await runReplayCommand(
        [
          "--from",
          "source",
          "--to",
          "target",
          "--provider",
          "ollama",
          "--prompts",
          "prompts.jsonl",
          "--fail-on-regression",
          "--json",
        ],
        io,
      );
      expect(code).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.parse(out.join("")).results[0].to.assertions[0].passed).toBe(false);
      expect(await readFile(path.join(cwd, "modelshift-report.html"), "utf8")).toContain(
        "text-equals: fail",
      );
      out.length = 0;
      expect(
        await runReplayCommand(
          [
            "--from",
            "source",
            "--to",
            "target",
            "--provider",
            "ollama",
            "--prompts",
            "prompts.jsonl",
            "--no-report",
          ],
          io,
        ),
      ).toBe(0);
      expect(out.join("")).toContain("text-equals");

      await writeFile(
        path.join(cwd, "prompts.jsonl"),
        JSON.stringify({
          prompt: "test",
          assertions: [{ type: "max-chars", value: "bad" }],
        }),
      );
      fetchImpl.mockClear();
      await expect(
        runReplayCommand(
          [
            "--from",
            "source",
            "--to",
            "target",
            "--provider",
            "ollama",
            "--prompts",
            "prompts.jsonl",
          ],
          io,
        ),
      ).rejects.toThrow("line 1: assertions[0]");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("response outcome acceptance (reddit:pdb7ff7:1)", () => {
  const tools = [{ name: "weather" }, { name: "forecast" }];

  it("accepts the same response produced with a different tool", async () => {
    const from = { text: "It is sunny.", toolCalls: [{ name: "weather", arguments: "{}" }] };
    const to = { text: "It is sunny.", toolCalls: [{ name: "forecast", arguments: "{}" }] };
    const report = await replay([{ type: "text-equals", value: "It is sunny." }], from, to, {
      tools,
    });
    expect(report.results[0]!.toolShapeChanged).toBe(true);
    expect(report.results[0]!.regressions).toEqual([]);
    expect(report.aggregate.regressions).toBe(0);
    const legacy = await replay(undefined, from, to, { tools });
    expect(legacy.results[0]!.regressions).toContain("tool shape changed");
    const withoutCalls = await replay(
      [{ type: "text-equals", value: "It is sunny." }],
      from,
      {
        text: "It is sunny.",
        toolCalls: [],
      },
      { tools },
    );
    expect(withoutCalls.results[0]!.regressions).toEqual([]);
    const requiresTool = await replay([{ type: "tool-called", value: "weather" }], from, to, {
      tools,
    });
    expect(requiresTool.aggregate.regressions).toBe(1);
  });

  it("accepts a required refusal despite a source answer and low similarity", async () => {
    const report = await replay(
      [{ type: "refusal", value: true }],
      { text: "Instructions follow below." },
      { text: "I cannot help with that request." },
    );
    expect(report.results[0]!.similarity).toBe(0);
    expect(report.results[0]!.regressions).toEqual([]);
  });

  it("still fails the wrong result even if both models use the same tool", async () => {
    const calls = [{ name: "weather", arguments: "{}" }];
    const report = await replay(
      [{ type: "text-equals", value: "It is sunny." }],
      { text: "It is sunny.", toolCalls: calls },
      { text: "It is cloudy.", toolCalls: calls },
      { tools },
    );
    expect(report.results[0]!.toolShapeChanged).toBe(false);
    expect(report.aggregate.regressions).toBe(1);
  });
});
