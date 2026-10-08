import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { IO } from "../src/commands/shared.js";

const temporaryDirectories: string[] = [];

function fakeIO(cwd = process.cwd()): IO & { out: string[]; err: string[] } {
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
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelshift-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI", () => {
  it("shows help for every command", async () => {
    for (const command of ["scan", "check", "replay", "fix", "registry"]) {
      const io = fakeIO();
      expect(await main([command, "--help"], io)).toBe(0);
      expect(io.out.join("")).toContain(
        command === "registry"
          ? "Usage: modelshift registry <subcommand>"
          : `Usage: modelshift ${command}`,
      );
    }
  });

  it("returns usage code for an unknown command", async () => {
    const io = fakeIO();
    expect(await main(["not-a-command"], io)).toBe(2);
    expect(io.err.join("")).toContain('Unknown command "not-a-command".');
  });

  it("uses a path as the default scan command", async () => {
    const directory = await temporaryDirectory();
    const io = fakeIO(directory);
    expect(await main(["."], io)).toBe(0);
    expect(io.out.join("")).toContain("no model identifiers found");
  });
});
