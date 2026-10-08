import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReplayCommand } from "../src/commands/replay.js";
import type { IO } from "../src/commands/shared.js";
import type { SessionSampleResult } from "../src/replay/sessions.js";

const temporaryDirectories: string[] = [];

function fakeIO(
  cwd: string,
  confirm: (question: string) => Promise<boolean>,
): IO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    cwd,
    isTTY: false,
    confirm,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelshift-replay-"));
  temporaryDirectories.push(directory);
  return directory;
}

const sessionSample: SessionSampleResult = {
  prompts: [
    {
      id: "session-001",
      messages: [{ role: "user", content: "Summarize this short example." }],
      source: "codex",
      file: "session.jsonl",
    },
  ],
  filesScanned: 1,
  candidates: 1,
  redactions: 0,
  sources: ["codex"],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("replay session confirmation", () => {
  it("aborts when confirmation is declined after writing the sample for review", async () => {
    const cwd = await temporaryDirectory();
    const confirm = vi.fn(async (_question: string) => false);
    const io = fakeIO(cwd, confirm);
    const sampleSessions = vi.fn(async () => sessionSample);

    expect(
      await runReplayCommand(
        ["--from", "source", "--to", "target", "--from-sessions", "--out", "sample.jsonl"],
        io,
        { sampleSessions },
      ),
    ).toBe(2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toContain("Send these 1 prompts to source and target?");
    expect(io.err.join("")).toContain("Aborted.");
    expect(await readFile(path.join(cwd, "sample.jsonl"), "utf8")).toContain(
      "Summarize this short example.",
    );
    expect(sampleSessions).toHaveBeenCalledWith({ n: 20, seed: undefined });
  });

  it("skips confirmation and replays when --yes is supplied", async () => {
    const cwd = await temporaryDirectory();
    const confirm = vi.fn(async (_question: string) => false);
    const io = fakeIO(cwd, confirm);
    const sampleSessions = vi.fn(async () => sessionSample);

    expect(
      await runReplayCommand(
        ["--from", "source", "--to", "target", "--from-sessions", "--yes", "--no-report"],
        io,
        { sampleSessions },
      ),
    ).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(io.out.join("")).toContain("modelshift replay source");
    expect(io.err.join("")).not.toContain("Aborted.");
  });
});
