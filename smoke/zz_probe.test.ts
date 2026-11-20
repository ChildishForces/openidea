/** Scratch probe (not committed): gutter runs on each modern-test package, dumping the tree. */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
const log = (s: string) => appendFileSync("/tmp/oi-probe/out.txt", s + "\n");
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { commands } from "@/bindings";
import { onIdeEvent } from "@/platform/ipc";
import { openProject, useProject } from "@/platform/project";
import { loadConfigs, onRunExited, runtime, startRun, useRun, waitForExit } from "@/features/run/store";
import { produceResolved, projectContext } from "@/features/run/contextRun";
import { registerBuiltinTypes } from "@/features/run/types";
import { nodeStatus, type TestNode } from "@/features/run/testing/results";
import { connectDesktop } from "./desktop";
import { Server } from "./server";

const SRC = "/Users/chris/Development/modern-test";
const ONLY = process.env.PROBE?.split(",");

interface Probe {
  file: string;
  /** Text on the line to put the caret on; null: the file. */
  at: (string | null)[];
}

const PROBES: Record<string, Probe> = {
  go: { file: "test-cases/go/go-test/math_test.go", at: [null, "func TestAdd(", '"adds positive numbers"'] },
  rust: { file: "test-cases/rust/cargo-test/tests/math.rs", at: [null, "mod add {", "fn adds_positive_numbers"] },
  python: {
    file: "test-cases/python/pytest/test_mathlib.py",
    at: [null, "class TestAdd", "def test_adds_positive_numbers"],
  },
  php: { file: "test-cases/php/phpunit/tests/MathFunctionsTest.php", at: [null, "function addsPositiveNumbers"] },
  kotlin: {
    file: "test-cases/kotlin/junit/src/test/kotlin/MathTest.kt",
    at: [null, "inner class Add", "`adds positive numbers`"],
  },
  csharp: {
    file: "test-cases/csharp/xunit/MathLib.Tests/MathFunctionsTests.cs",
    at: [null, "public class AddTests", "AddsPositiveNumbers()"],
  },
  swift: {
    file: "test-cases/swift/swift-test/Tests/MathLibTests/MathTests.swift",
    at: [null, "struct AddTests", "addsPositiveNumbers()"],
  },
};

let server: Server;
let root = "";

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "openidea-probe-")));
  root = join(base, "modern-test");
  execFileSync("rsync", ["-a", "--exclude", "node_modules", "--exclude", ".openidea", `${SRC}/`, `${root}/`]);
  server = await Server.start(join(base, "home"));
  // As the Run feature does: types prepare their launches (`dotnet test` resolves its runner).
  registerBuiltinTypes();
  connectDesktop(server);
  onIdeEvent("runExited", (e) => onRunExited(e.run, e.code));
  await openProject(root);
  await commands.projectTrustSet(root, true, false);
  useProject.setState({ project: { ...useProject.getState().project!, trusted: true } });
  await loadConfigs();
  log(`root ${root}`);
});
afterAll(() => server?.close());

function dump(nodes: readonly TestNode[], depth = 0, out: string[] = []): string[] {
  for (const n of nodes) {
    const loc = n.location ? ` @${n.location.path.replace(root + "/", "")}:${n.location.line ?? ""}` : "";
    const d = n.durationMs !== undefined ? ` ${n.durationMs}ms` : "";
    const o = n.output.length ? ` [out ${n.output.length}: ${n.output[0]!.slice(0, 60)}]` : "";
    out.push(`${"  ".repeat(depth)}${n.name} — ${nodeStatus(n)}${d}${loc}${o}`);
    if (depth < 3 || n.children.length < 4) dump(n.children, depth + 1, out);
    else out.push(`${"  ".repeat(depth + 1)}… ${n.children.length} children`);
  }
  return out;
}

for (const [lang, p] of Object.entries(PROBES)) {
  test.skipIf(ONLY && !ONLY.includes(lang))(lang, async () => {
    const path = join(root, p.file);
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    for (const at of p.at) {
      const line = at === null ? undefined : lines.findIndex((l) => l.includes(at));
      const produced = await produceResolved({ ...projectContext(), path, content, line });
      const head = `\n===== ${lang} @ ${at ?? "<file>"} (line ${line})`;
      if (!produced?.config) {
        log(`${head}\nNOTHING PRODUCED ${JSON.stringify(produced)}`);
        continue;
      }
      const c = produced.config;
      const output: string[] = [];
      const session = await startRun(c, undefined, undefined, { prepared: true, onLine: (l) => output.push(l) });
      if (!session) {
        log(`${head}\nDID NOT START`);
        continue;
      }
      await waitForExit([session.id], 8 * 60_000);
      const s = useRun.getState().sessions.find((x) => x.id === session.id)!;
      const tests = runtime(session.id)?.tests;
      log(
        [
          head,
          `name=${produced.name} kind=${c.kind} runner=${c.testRunner ?? "-"} cwd=${c.cwd}`,
          `cmd: ${c.command} ${c.args.join(" ")}`,
          `exit=${s.exitCode} status=${s.status} counts=${JSON.stringify(tests?.counts())}`,
          ...dump(tests?.roots ?? []).slice(0, 40),
          "--- output tail",
          ...output.slice(-12),
        ].join("\n"),
      );
    }
  });
}

test("configs", () => {
  log(
    useRun
      .getState()
      .configs.map((c) => `${c.id} kind=${c.kind} runner=${c.testRunner ?? "-"}`)
      .join("\n"),
  );
});
