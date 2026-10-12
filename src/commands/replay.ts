import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { bold, dim, green, red, yellow } from "../output/colors.js";
import { plural } from "../output/format.js";
import { renderTable } from "../output/table.js";
import {
  guessPreset,
  PRESET_NAMES,
  PRESETS,
  type Provider,
  resolveProvider,
} from "../providers/index.js";
import { OllamaNativeProvider } from "../providers/ollama.js";
import { loadPrices } from "../replay/prices.js";
import { loadPromptsFile, type PromptCase } from "../replay/prompts.js";
import { renderHtmlReport } from "../replay/report.js";
import { type ProgressEvent, type ReplayReport, runReplay } from "../replay/runner.js";
import { sampledToJsonl, sampleSessions } from "../replay/sessions.js";
import {
  COMMON_OPTIONS,
  flag,
  type IO,
  int,
  loadIndex,
  parse,
  str,
  UsageError,
  type Values,
} from "./shared.js";

export const REPLAY_HELP = `Usage: modelshift replay --from <model> --to <model> (--prompts <file.jsonl> | --from-sessions) [options]

Runs the same prompts on two models and reports JSON validity, output length,
refusals, tool call shape, latency, cost and similarity per prompt and in aggregate.
Writes a static HTML report.
JSONL assertions check response requirements and determine target pass/fail when supplied.

Prompt sources:
  --prompts <file>        JSONL file. Each line: {"id","prompt"|"messages","system","tools","expect":"json","assertions","max_tokens"}
  --from-sessions         Sample real user turns from ~/.claude/projects and ~/.codex/sessions (read only)
  --n <count>             Number of session prompts to sample (default 20)
  --seed <int>            Make the sample reproducible
  --out <file>            Where the sampled prompts are written (default modelshift-sessions.jsonl)
  --sample-only           Write the sample and stop without calling any model
  --yes                   Skip the confirmation before sending sampled prompts
  --limit <n>             Only run the first n prompts

Providers (auto-detected from the model id, override as needed):
  --provider <name>       Preset for both sides: ${PRESET_NAMES.join(", ")}
  --from-provider <name>  Preset for the source model
  --to-provider <name>    Preset for the target model
  --from-base-url <url>   Override the source base URL (also OPENAI_BASE_URL, ANTHROPIC_BASE_URL, GEMINI_BASE_URL, OLLAMA_HOST)
  --to-base-url <url>     Override the target base URL
  --from-key <key>        API key for the source (also OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY)
  --to-key <key>          API key for the target
  --no-think              Disable thinking on Ollama models (uses Ollama's native API)
  --max-tokens <n>        Output budget per call (default 512)
  --timeout <ms>          Per request timeout (default 120000)

Output:
  --embed-model <id>      Compute similarity with this embedding model instead of lexical similarity
  --embed-provider <name> Preset for the embedding model (default: the target's provider)
  --report <file>         HTML report path (default modelshift-report.html)
  --no-report             Skip the HTML report
  --fail-on-regression    Exit 1 on target assertion failures or comparison regressions
  --quiet                 No progress output
  --json                  Print the full report as JSON
  -h, --help              Show this help
`;

const OPTIONS = {
  ...COMMON_OPTIONS,
  from: { type: "string" as const },
  to: { type: "string" as const },
  prompts: { type: "string" as const },
  "from-sessions": { type: "boolean" as const },
  n: { type: "string" as const },
  seed: { type: "string" as const },
  out: { type: "string" as const },
  "sample-only": { type: "boolean" as const },
  yes: { type: "boolean" as const, short: "y" },
  limit: { type: "string" as const },
  provider: { type: "string" as const },
  "from-provider": { type: "string" as const },
  "to-provider": { type: "string" as const },
  "from-base-url": { type: "string" as const },
  "to-base-url": { type: "string" as const },
  "from-key": { type: "string" as const },
  "to-key": { type: "string" as const },
  "no-think": { type: "boolean" as const },
  "max-tokens": { type: "string" as const },
  timeout: { type: "string" as const },
  "embed-model": { type: "string" as const },
  "embed-provider": { type: "string" as const },
  report: { type: "string" as const },
  "no-report": { type: "boolean" as const },
  "fail-on-regression": { type: "boolean" as const },
  quiet: { type: "boolean" as const },
};

function buildProvider(
  model: string,
  side: "from" | "to",
  values: Values,
  io: IO,
  timeoutMs: number,
): Provider {
  const preset = str(values, `${side}-provider`) ?? str(values, "provider") ?? guessPreset(model);
  if (!PRESETS[preset])
    throw new UsageError(`Unknown provider "${preset}". Choose one of: ${PRESET_NAMES.join(", ")}`);
  const baseUrl = str(values, `${side}-base-url`);
  if (preset === "ollama" && flag(values, "no-think")) {
    return new OllamaNativeProvider({
      baseUrl: baseUrl ?? PRESETS.ollama!.baseUrl(io.env),
      name: "ollama",
      fetchImpl: io.fetchImpl,
      timeoutMs,
      think: false,
    });
  }
  return resolveProvider({
    model,
    preset,
    baseUrl,
    apiKey: str(values, `${side}-key`),
    env: io.env,
    fetchImpl: io.fetchImpl,
    timeoutMs,
  });
}

async function confirm(io: IO, question: string): Promise<boolean> {
  if (io.confirm) return io.confirm(question);
  if (!io.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(?:es)?$/i.test(answer.trim()));
    });
  });
}

function fmtMoney(v: number | null): string {
  if (v === null) return "n/a";
  if (v === 0) return "$0";
  return `$${v.toFixed(v < 0.01 ? 5 : 4)}`;
}

function cell(ok: boolean | null, good: string, bad: string): string {
  if (ok === null) return "-";
  return ok ? good : bad;
}

export function renderReplaySummary(report: ReplayReport, reportPath: string | null): string {
  const a = report.aggregate;
  const rows = report.results.map((r) => {
    const expectJson = r.prompt.expect === "json";
    const hasTools = Boolean(r.prompt.tools?.length);
    const fromJson = r.from.error ? "err" : cell(expectJson ? r.from.jsonValid : null, "ok", "bad");
    const toJson = r.to.error ? "err" : cell(expectJson ? r.to.jsonValid : null, "ok", "bad");
    const fromRef = r.from.error ? "err" : r.from.refusal ? "yes" : "no";
    const toRef = r.to.error ? "err" : r.to.refusal ? "yes" : "no";
    const fromTools = r.from.error ? "err" : hasTools ? String(r.from.toolCalls.length) : "-";
    const toTools = r.to.error ? "err" : hasTools ? String(r.to.toolCalls.length) : "-";
    const delta =
      r.lengthDeltaPct === null ? "-" : `${r.lengthDeltaPct > 0 ? "+" : ""}${r.lengthDeltaPct}%`;
    const latency = `${r.from.error ? "-" : r.from.latencyMs} > ${r.to.error ? "-" : r.to.latencyMs}`;
    const sim = r.similarity === null ? "-" : r.similarity.toFixed(2);
    const result = r.regressions.length
      ? red(r.regressions.join(", "))
      : r.to.error
        ? red("error")
        : green("ok");
    return {
      id: r.id,
      json: `${fromJson} > ${toJson}`,
      refusal: `${fromRef} > ${toRef}`,
      tools: `${fromTools} > ${toTools}`,
      length: delta,
      latency,
      sim,
      assertions: `${r.from.assertions.filter((a) => a.passed).length}/${r.from.assertions.length} > ${r.to.assertions.filter((a) => a.passed).length}/${r.to.assertions.length}`,
      result,
    };
  });
  const table = renderTable(
    [
      { key: "id", header: "PROMPT", maxWidth: 28 },
      { key: "json", header: "JSON" },
      { key: "refusal", header: "REFUSAL" },
      { key: "tools", header: "TOOL CALLS" },
      { key: "length", header: "LENGTH", align: "right" },
      { key: "latency", header: "LATENCY MS" },
      { key: "sim", header: "SIM", align: "right" },
      ...(a.assertionsExpected ? [{ key: "assertions", header: "ASSERTIONS" }] : []),
      { key: "result", header: "RESULT" },
    ],
    rows,
  );
  const lengthDelta =
    a.meanLengthDeltaPct === null
      ? ""
      : ` (${a.meanLengthDeltaPct > 0 ? "+" : ""}${a.meanLengthDeltaPct}%)`;
  const localNote = a.totalCostUsd.from === 0 && a.totalCostUsd.to === 0 ? " (local models)" : "";
  const lines = [
    `${bold("modelshift replay")} ${report.from.model} ${dim(`(${report.from.provider})`)} > ${report.to.model} ${dim(`(${report.to.provider})`)}, ${plural(a.prompts, "prompt")}, ${Math.round(report.durationMs / 1000)} s`,
    "",
    table,
    "",
    bold("Aggregate (from > to)"),
    `  errors          ${a.errors.from} > ${a.errors.to}`,
    `  refusals        ${a.refusals.from} > ${a.refusals.to}`,
    `  valid JSON      ${a.jsonValid.from}/${a.jsonExpected} > ${a.jsonValid.to}/${a.jsonExpected}`,
    `  tool calls      ${a.toolCalls.from}/${a.toolPrompts} > ${a.toolCalls.to}/${a.toolPrompts}${a.toolShapeChanged ? `, shape changed on ${a.toolShapeChanged}` : ""}`,
    `  mean length     ${a.meanChars.from} > ${a.meanChars.to} chars${lengthDelta}`,
    `  mean latency    ${a.meanLatencyMs.from} > ${a.meanLatencyMs.to} ms`,
    `  cost            ${fmtMoney(a.totalCostUsd.from)} > ${fmtMoney(a.totalCostUsd.to)}${localNote}`,
    `  similarity      ${a.meanSimilarity === null ? "n/a" : a.meanSimilarity.toFixed(3)} mean, ${report.similarityMethod}`,
    `  regressions     ${a.regressions ? red(`${a.regressions} of ${a.prompts} prompts`) : green("none")}`,
  ];
  if (a.assertionsExpected)
    lines.push(
      `  assertions      ${a.assertionsPassed.from} > ${a.assertionsPassed.to} passed (of ${a.assertionsExpected})`,
    );
  if (reportPath) lines.push("", `Report written to ${reportPath}`);
  return `${lines.join("\n")}\n`;
}

export async function runReplayCommand(
  argv: string[],
  io: IO,
  dependencies: { sampleSessions: typeof sampleSessions } = { sampleSessions },
): Promise<number> {
  const { values } = parse(argv, OPTIONS);
  if (flag(values, "help")) {
    io.stdout(REPLAY_HELP);
    return 0;
  }
  const from = str(values, "from");
  const to = str(values, "to");
  if (!from || !to) throw new UsageError("replay needs --from <model> and --to <model>");
  const quiet = flag(values, "quiet");
  const json = flag(values, "json");
  const log = (text: string) => {
    if (!quiet) io.stderr(text);
  };

  let prompts: PromptCase[];
  const promptsFile = str(values, "prompts");
  if (promptsFile) {
    prompts = loadPromptsFile(path.resolve(io.cwd, promptsFile));
  } else if (flag(values, "from-sessions")) {
    const n = int(values, "n", 20, 1);
    const seedRaw = str(values, "seed");
    const seed = seedRaw === undefined ? undefined : int(values, "seed", 0);
    const sample = await dependencies.sampleSessions({ n, seed });
    const outFile = path.resolve(io.cwd, str(values, "out") ?? "modelshift-sessions.jsonl");
    if (sample.prompts.length === 0) {
      io.stderr(
        `No user prompts found in ~/.claude/projects or ~/.codex/sessions (${plural(sample.filesScanned, "file")} read). Nothing was written.\n`,
      );
      return 2;
    }
    await fs.writeFile(outFile, sampledToJsonl(sample.prompts), "utf8");
    io.stderr(
      `Sampled ${sample.prompts.length} of ${sample.candidates} user prompts from ${sample.sources.join(" and ")} (${plural(sample.filesScanned, "file")} read, ${plural(sample.redactions, "secret")} redacted).\nWritten to ${path.relative(io.cwd, outFile) || outFile} for review. Nothing has been sent anywhere.\n`,
    );
    for (const p of sample.prompts.slice(0, 3)) {
      const text = p.messages[0]!.content.replace(/\s+/g, " ");
      io.stderr(dim(`  ${p.id}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}\n`));
    }
    if (flag(values, "sample-only")) return 0;
    if (!flag(values, "yes")) {
      const ok = await confirm(
        io,
        `Send these ${sample.prompts.length} prompts to ${from} and ${to}? [y/N] `,
      );
      if (!ok) {
        io.stderr("Aborted. Review the file, then rerun with --prompts <file> or --yes.\n");
        return 2;
      }
    }
    prompts = sample.prompts;
  } else {
    throw new UsageError("replay needs --prompts <file.jsonl> or --from-sessions");
  }
  const limit =
    str(values, "limit") !== undefined ? int(values, "limit", prompts.length, 1) : undefined;
  if (limit !== undefined) prompts = prompts.slice(0, limit);

  const timeoutMs = int(values, "timeout", 120_000, 1000);
  const fromProvider = buildProvider(from, "from", values, io, timeoutMs);
  const toProvider = buildProvider(to, "to", values, io, timeoutMs);
  const embedModel = str(values, "embed-model");
  let embed: { provider: Provider; model: string } | undefined;
  if (embedModel) {
    const preset = str(values, "embed-provider");
    const provider = preset
      ? resolveProvider({
          model: embedModel,
          preset,
          env: io.env,
          fetchImpl: io.fetchImpl,
          timeoutMs,
        })
      : toProvider;
    if (!provider.embed) {
      log(
        `${yellow("warning")}: provider ${provider.name} has no embeddings endpoint, falling back to lexical similarity.\n`,
      );
    } else {
      embed = { provider, model: embedModel };
    }
  }
  const index = loadIndex(values, io);
  const prices = loadPrices();
  log(
    `${dim(`Running ${prompts.length} prompts on ${from} (${fromProvider.name}) then ${to} (${toProvider.name})...`)}\n`,
  );
  const report = await runReplay({
    from: { model: from, provider: fromProvider },
    to: { model: to, provider: toProvider },
    prompts,
    prices,
    index,
    maxTokens: int(values, "max-tokens", 512, 1),
    embed,
    onProgress: (e: ProgressEvent) => {
      if (e.side === "similarity") {
        log(`${yellow("warning")}: embeddings failed (${e.error}), using lexical similarity.\n`);
        return;
      }
      const model = e.side === "from" ? from : to;
      log(
        e.error
          ? `${red(`[${e.side} ${e.index + 1}/${e.total}]`)} ${e.id} on ${model}: ${e.error}\n`
          : `${dim(`[${e.side} ${e.index + 1}/${e.total}]`)} ${e.id} on ${model}: ${e.latencyMs} ms\n`,
      );
    },
  });
  let reportPath: string | null = null;
  if (!flag(values, "no-report")) {
    reportPath = path.resolve(io.cwd, str(values, "report") ?? "modelshift-report.html");
    await fs.writeFile(reportPath, renderHtmlReport(report), "utf8");
    reportPath = path.relative(io.cwd, reportPath) || reportPath;
  }
  if (json) {
    io.stdout(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  } else {
    io.stdout(renderReplaySummary(report, reportPath));
  }
  if (flag(values, "fail-on-regression") && report.aggregate.regressions > 0) return 1;
  return 0;
}
