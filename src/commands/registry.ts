import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { bold, dim, green, red } from "../output/colors.js";
import { colorStatus, plural, statusLabel } from "../output/format.js";
import { renderTable } from "../output/table.js";
import {
  computeStatus,
  defaultRegistryPath,
  type LifecycleEntry,
  validateRegistry,
} from "../registry/index.js";
import { refreshRegistry } from "../registry/refresh.js";
import type { Status } from "../registry/types.js";
import {
  COMMON_OPTIONS,
  flag,
  type IO,
  int,
  loadIndex,
  parse,
  resolveToday,
  str,
  UsageError,
} from "./shared.js";

export const REGISTRY_HELP = `Usage: modelshift registry <subcommand> [options]

Subcommands:
  list                 List registry entries (filters: --provider <name>, --status <status>)
  show <id>            Show one entry and its computed status
  validate [file]      Validate a lifecycle.json file
  refresh              Re-fetch the provider pages and merge changes (use --write to save)
  sources              Print the pages the registry was built from

Options:
  --days <n>           Window for "retiring" (default 90)
  --write              With refresh: write the merged registry to --out
  --out <file>         With refresh: output path (default: the bundled registry)
  --registry <file>    Use a different lifecycle.json
  --today <date>       Evaluate as of this ISO date
  --json               Print machine readable output
  -h, --help           Show this help
`;

const OPTIONS = {
  ...COMMON_OPTIONS,
  days: { type: "string" as const },
  provider: { type: "string" as const },
  status: { type: "string" as const },
  write: { type: "boolean" as const },
  out: { type: "string" as const },
};

function entryJson(e: LifecycleEntry, today: string, days: number): Record<string, unknown> {
  const info = computeStatus(e, today, days);
  return { ...e, status: info.status, daysLeft: info.daysLeft, statusDate: info.date };
}

export async function runRegistry(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parse(argv, OPTIONS);
  const sub = positionals[0];
  if (flag(values, "help") || !sub) {
    io.stdout(REGISTRY_HELP);
    return flag(values, "help") ? 0 : 2;
  }
  const days = int(values, "days", 90);
  const today = resolveToday(values);
  const json = flag(values, "json");

  if (sub === "sources") {
    const index = loadIndex(values, io);
    if (json) {
      io.stdout(
        `${JSON.stringify({ version: index.registry.version, sources: index.registry.sources }, null, 2)}\n`,
      );
      return 0;
    }
    io.stdout(`registry ${index.registry.version}\n`);
    for (const [name, url] of Object.entries(index.registry.sources))
      io.stdout(`  ${name.padEnd(18)} ${url}\n`);
    return 0;
  }

  if (sub === "list") {
    const index = loadIndex(values, io);
    const provider = str(values, "provider");
    const status = str(values, "status") as Status | undefined;
    let entries = index.entries();
    if (provider) entries = entries.filter((e) => e.provider === provider);
    const rows = entries
      .map((e) => ({ e, info: computeStatus(e, today, days) }))
      .filter((r) => !status || r.info.status === status);
    if (json) {
      io.stdout(
        `${JSON.stringify(
          rows.map((r) => entryJson(r.e, today, days)),
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    if (rows.length === 0) {
      io.stdout("No entries match.\n");
      return 0;
    }
    io.stdout(
      `${renderTable(
        [
          { key: "id", header: "MODEL", maxWidth: 44 },
          { key: "provider", header: "PROVIDER" },
          { key: "status", header: "STATUS" },
          { key: "replacement", header: "REPLACEMENT", maxWidth: 36 },
        ],
        rows.map((r) => ({
          id: r.e.id,
          provider: r.e.provider,
          status: colorStatus(
            r.info.status,
            statusLabel({ status: r.info.status, daysLeft: r.info.daysLeft, date: r.info.date }),
          ),
          replacement: r.e.replacement ?? "",
        })),
      )}\n\n${plural(rows.length, "entry")} (registry ${index.registry.version}, today ${today})\n`,
    );
    return 0;
  }

  if (sub === "show") {
    const id = positionals[1];
    if (!id) throw new UsageError("registry show needs a model id");
    const index = loadIndex(values, io);
    const hit = index.lookup(id);
    if (!hit) {
      io.stderr(
        `No registry entry for "${id}". Run "modelshift registry list" to see known models.\n`,
      );
      return 1;
    }
    const data = entryJson(hit.entry, today, days);
    if (json) {
      io.stdout(
        `${JSON.stringify({ ...data, matchedKey: hit.matchedKey, viaAlias: hit.viaAlias }, null, 2)}\n`,
      );
      return 0;
    }
    const info = computeStatus(hit.entry, today, days);
    io.stdout(
      `${bold(hit.entry.id)}${hit.viaAlias ? dim(` (matched alias ${hit.matchedKey})`) : ""}\n`,
    );
    io.stdout(`  provider      ${hit.entry.provider}\n`);
    io.stdout(
      `  status        ${colorStatus(info.status, statusLabel({ status: info.status, daysLeft: info.daysLeft, date: info.date }))}\n`,
    );
    io.stdout(`  aliases       ${hit.entry.aliases.join(", ") || "-"}\n`);
    io.stdout(`  announced     ${hit.entry.announced ?? "-"}\n`);
    io.stdout(`  deprecated    ${hit.entry.deprecated ?? "-"}\n`);
    io.stdout(
      `  retirement    ${hit.entry.retirement ?? (hit.entry.retirement_earliest ? `not sooner than ${hit.entry.retirement_earliest}` : "-")}\n`,
    );
    io.stdout(
      `  replacement   ${hit.entry.replacement ?? "-"}${hit.entry.replacement && index.resolveReplacement(hit.entry) !== hit.entry.replacement ? dim(` (chain resolves to ${index.resolveReplacement(hit.entry)})`) : ""}\n`,
    );
    if (hit.entry.notes) io.stdout(`  notes         ${hit.entry.notes}\n`);
    io.stdout(`  source        ${hit.entry.source}\n`);
    return 0;
  }

  if (sub === "validate") {
    const file = positionals[1]
      ? path.resolve(io.cwd, positionals[1])
      : str(values, "registry")
        ? path.resolve(io.cwd, str(values, "registry")!)
        : defaultRegistryPath();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      io.stderr(`error: cannot parse ${file}: ${(error as Error).message}\n`);
      return 1;
    }
    const problems = validateRegistry(parsed);
    if (json) {
      io.stdout(`${JSON.stringify({ file, ok: problems.length === 0, problems }, null, 2)}\n`);
      return problems.length ? 1 : 0;
    }
    if (problems.length) {
      io.stdout(`${red("invalid")} ${file}\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
      return 1;
    }
    const count = (parsed as { models: unknown[] }).models.length;
    io.stdout(`${green("valid")} ${file} (${plural(count, "entry")})\n`);
    return 0;
  }

  if (sub === "refresh") {
    const index = loadIndex(values, io);
    const result = await refreshRegistry(index.registry, today, io.fetchImpl ?? fetch);
    const outFile = path.resolve(
      io.cwd,
      str(values, "out") ?? str(values, "registry") ?? defaultRegistryPath(),
    );
    const write = flag(values, "write");
    if (write && (result.added.length || result.updated.length)) {
      await fs.writeFile(outFile, `${JSON.stringify(result.registry, null, 2)}\n`, "utf8");
    }
    if (json) {
      io.stdout(
        `${JSON.stringify({ fetched: result.fetched, added: result.added, updated: result.updated, written: write, out: outFile }, null, 2)}\n`,
      );
    } else {
      for (const [name, f] of Object.entries(result.fetched)) {
        io.stdout(
          f.ok
            ? `${green("fetched")} ${name}: ${plural(f.parsed, "row")} parsed\n`
            : `${red("failed")} ${name}: ${f.error}\n`,
        );
      }
      io.stdout(
        `\n${plural(result.added.length, "new entry")}, ${plural(result.updated.length, "updated field")}.\n`,
      );
      for (const a of result.added) io.stdout(`  + ${a}\n`);
      for (const u of result.updated) io.stdout(`  ~ ${u}\n`);
      if (result.added.length || result.updated.length) {
        io.stdout(write ? `\nWritten to ${outFile}\n` : "\nDry run. Add --write to save.\n");
      }
    }
    const failures = Object.values(result.fetched).filter((f) => !f.ok).length;
    return failures === Object.keys(result.fetched).length ? 1 : 0;
  }

  throw new UsageError(
    `Unknown registry subcommand "${sub}". Use list, show, validate, refresh or sources.`,
  );
}
