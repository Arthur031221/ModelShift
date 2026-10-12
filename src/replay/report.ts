import { promptText } from "./prompts.js";
import type { PromptResult, ReplayReport, SideResult } from "./runner.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _yesNo(v: boolean | null): string {
  if (v === null) return "n/a";
  return v ? "yes" : "no";
}

function money(v: number | null): string {
  if (v === null) return "n/a";
  if (v === 0) return "$0";
  return `$${v.toFixed(v < 0.01 ? 5 : 4)}`;
}

function sideCell(s: SideResult, expectJson: boolean, hasTools: boolean): string {
  if (s.error) return `<td class="bad" colspan="1">error</td>`;
  const bits: string[] = [];
  if (expectJson)
    bits.push(`json ${s.jsonValid ? (s.jsonStrict ? "valid" : "valid*") : "invalid"}`);
  if (hasTools)
    bits.push(`tools ${s.toolShape.called.length ? s.toolShape.called.join(",") : "none"}`);
  bits.push(s.refusal ? "refusal" : "answered");
  return `<td>${esc(bits.join(" / "))}</td>`;
}

function outputBlock(label: string, s: SideResult): string {
  const body = s.error
    ? `<pre class="bad">${esc(s.error)}</pre>`
    : `<pre>${esc(s.text || "(empty)")}</pre>`;
  const calls = s.toolCalls.length
    ? `<pre class="calls">${esc(s.toolCalls.map((c) => `${c.name}(${c.arguments})`).join("\n"))}</pre>`
    : "";
  const meta = s.error
    ? ""
    : `<div class="meta">${s.latencyMs} ms, ${s.inputTokens ?? "?"} in / ${s.outputTokens ?? "?"} out tokens, ${money(s.costUsd)}, finish: ${esc(s.finishReason ?? "n/a")}</div>`;
  const assertions = s.assertions.length
    ? `<ul>${s.assertions.map((a) => `<li class="${a.passed ? "" : "bad"}">${esc(a.message)}</li>`).join("")}</ul>`
    : "";
  return `<div class="side"><h4>${esc(label)}</h4>${meta}${calls}${body}${assertions}</div>`;
}

function row(r: PromptResult, i: number): string {
  const expectJson = r.prompt.expect === "json";
  const hasTools = Boolean(r.prompt.tools?.length);
  const flag = r.regressions.length
    ? `<span class="pill bad">${esc(r.regressions.join(", "))}</span>`
    : `<span class="pill ok">ok</span>`;
  const delta =
    r.lengthDeltaPct === null ? "n/a" : `${r.lengthDeltaPct > 0 ? "+" : ""}${r.lengthDeltaPct}%`;
  const sim = r.similarity === null ? "n/a" : r.similarity.toFixed(2);
  return `
<tr class="summary-row">
  <td>${i + 1}</td>
  <td><code>${esc(r.id)}</code></td>
  ${sideCell(r.from, expectJson, hasTools)}
  ${sideCell(r.to, expectJson, hasTools)}
  <td class="num">${delta}</td>
  <td class="num">${r.from.error ? "n/a" : r.from.latencyMs}</td>
  <td class="num">${r.to.error ? "n/a" : r.to.latencyMs}</td>
  <td class="num">${sim}</td>
  <td>${flag}</td>
</tr>
<tr class="detail-row">
  <td colspan="9">
    <details>
      <summary>Prompt and outputs</summary>
      <div class="prompt"><h4>Prompt</h4><pre>${esc(promptText(r.prompt))}</pre>${
        hasTools
          ? `<div class="meta">tools: ${esc(r.prompt.tools!.map((t) => t.name).join(", "))}</div>`
          : ""
      }</div>
      ${r.prompt.assertions?.length ? `<h4>Assertions</h4><pre>${esc(JSON.stringify(r.prompt.assertions, null, 2))}</pre>` : ""}
      <div class="sides">${outputBlock(r.from.error ? "from (error)" : "from", r.from)}${outputBlock(r.to.error ? "to (error)" : "to", r.to)}</div>
    </details>
  </td>
</tr>`;
}

export function renderHtmlReport(report: ReplayReport): string {
  const a = report.aggregate;
  const from = esc(report.from.model);
  const to = esc(report.to.model);
  const summary = `
<table class="agg">
  <thead><tr><th>Metric</th><th>${from}</th><th>${to}</th></tr></thead>
  <tbody>
    <tr><td>Prompts</td><td>${a.prompts}</td><td>${a.prompts}</td></tr>
    <tr><td>Errors</td><td>${a.errors.from}</td><td class="${a.errors.to > a.errors.from ? "bad" : ""}">${a.errors.to}</td></tr>
    <tr><td>Refusals</td><td>${a.refusals.from}</td><td class="${a.refusals.to > a.refusals.from ? "bad" : ""}">${a.refusals.to}</td></tr>
    <tr><td>Valid JSON (of ${a.jsonExpected} expected)</td><td>${a.jsonValid.from}</td><td class="${a.jsonValid.to < a.jsonValid.from ? "bad" : ""}">${a.jsonValid.to}</td></tr>
    <tr><td>Tool calls made (of ${a.toolPrompts} tool prompts)</td><td>${a.toolCalls.from}</td><td class="${a.toolCalls.to < a.toolCalls.from ? "bad" : ""}">${a.toolCalls.to}</td></tr>
    <tr><td>Tool call shape changed</td><td colspan="2">${a.toolShapeChanged}</td></tr>
    <tr><td>Mean output length (chars)</td><td>${a.meanChars.from}</td><td>${a.meanChars.to}${a.meanLengthDeltaPct === null ? "" : ` (${a.meanLengthDeltaPct > 0 ? "+" : ""}${a.meanLengthDeltaPct}%)`}</td></tr>
    <tr><td>Mean latency (ms)</td><td>${a.meanLatencyMs.from}</td><td>${a.meanLatencyMs.to}</td></tr>
    <tr><td>Total cost</td><td>${money(a.totalCostUsd.from)}</td><td>${money(a.totalCostUsd.to)}</td></tr>
    <tr><td>Mean similarity</td><td colspan="2">${a.meanSimilarity === null ? "n/a" : a.meanSimilarity.toFixed(3)} (${esc(report.similarityMethod)})</td></tr>
    <tr><td>Prompts with regressions</td><td colspan="2" class="${a.regressions ? "bad" : ""}">${a.regressions}</td></tr>
    ${a.assertionsExpected ? `<tr><td>Assertions passed (of ${a.assertionsExpected})</td><td>${a.assertionsPassed.from}</td><td>${a.assertionsPassed.to}</td></tr>` : ""}
  </tbody>
</table>`;
  const rows = report.results.map(row).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>modelshift replay</title>
<style>
:root { --bg: #ffffff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --bad-bg: #fde8e8; --bad-fg: #9b1c1c; --ok-bg: #e6f4ea; --ok-fg: #1e6b3a; --code-bg: #f6f6f6; }
@media (prefers-color-scheme: dark) { :root { --bg: #131313; --fg: #ececec; --muted: #9a9a9a; --line: #2c2c2c; --bad-bg: #3a1717; --bad-fg: #ff9c9c; --ok-bg: #163321; --ok-fg: #8fe0a8; --code-bg: #1d1d1d; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h4 { margin: 8px 0 4px; font-size: 13px; }
.sub { color: var(--muted); margin-bottom: 20px; }
table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.agg { max-width: 640px; }
.bad { background: var(--bad-bg); color: var(--bad-fg); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
.pill.ok { background: var(--ok-bg); color: var(--ok-fg); }
.pill.bad { background: var(--bad-bg); color: var(--bad-fg); }
.detail-row td { padding: 0 8px 12px; border-bottom: 1px solid var(--line); }
details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 800px) { .sides { grid-template-columns: 1fr; } }
pre { background: var(--code-bg); padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; margin: 4px 0; max-height: 420px; overflow: auto; font-size: 12px; }
pre.calls { border-left: 3px solid var(--muted); }
.meta { color: var(--muted); font-size: 12px; }
code { font-size: 12px; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<main>
<h1>modelshift replay: ${from} to ${to}</h1>
<div class="sub">${esc(report.from.provider)} (${esc(report.from.baseUrl)}) to ${esc(report.to.provider)} (${esc(report.to.baseUrl)}). Started ${esc(report.startedAt)}, took ${Math.round(report.durationMs / 1000)} s.</div>
${summary}
<table class="results">
  <thead><tr><th>#</th><th>Prompt</th><th>${from}</th><th>${to}</th><th>Length delta</th><th>${from} ms</th><th>${to} ms</th><th>Similarity</th><th>Result</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<footer>json valid* means the JSON had to be extracted from fences or surrounding text. Refusal detection is a phrase classifier plus provider stop reasons. Costs use the bundled price table where known and $0 for local servers.</footer>
</main>
</body>
</html>
`;
}
