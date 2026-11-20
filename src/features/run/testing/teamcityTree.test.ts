import { describe, expect, it, vi } from "vitest";
import { createTestParser, parseAll, TestResults } from "./index";
import { jsParser } from "./js";
import { teamcityTreeParser } from "./teamcityTree";

const F = "/work/pkg/src/math.test.ts";
// The IDE's Vitest reporter on `vitest run src/math.test.ts -t ^add` with a failing, a logging and a skipped test.
const run = [
  " RUN  v5.1.1 /work/pkg",
  `##teamcity[testSuiteStarted name='src/math.test.ts' nodeId='9' parentNodeId='0' locationHint='file://${F}']`,
  `##teamcity[testSuiteStarted name='add' nodeId='9_0' parentNodeId='9' locationHint='file://${F}:15:1']`,
  `##teamcity[testStarted name='adds positive numbers' nodeId='9_0_0' parentNodeId='9_0' locationHint='file://${F}:16:3']`,
  `##teamcity[testStarted name='handles zero' nodeId='9_0_1' parentNodeId='9_0' locationHint='file://${F}:18:3']`,
  `##teamcity[testStarted name='later' nodeId='9_0_2' parentNodeId='9_0' locationHint='file://${F}:19:3']`,
  "##teamcity[testStdOut nodeId='9_0_1' out='hello from zero|n']",
  "##teamcity[testFailed nodeId='9_0_0' message='expected 5 to be 6' details='AssertionError: expected 5 to be 6|n    at src/math.test.ts:16:55' expected='6' actual='5']",
  "##teamcity[testFinished nodeId='9_0_0' duration='2']",
  "##teamcity[testFinished nodeId='9_0_1' duration='0']",
  "##teamcity[testIgnored nodeId='9_0_2']",
  "##teamcity[testFinished nodeId='9_0_2' duration='0']",
  "##teamcity[testSuiteFinished nodeId='9_0']",
  " ✓ src/math.test.ts (43 tests | 40 skipped) 1ms",
  "##teamcity[testSuiteFinished nodeId='9']",
  "      Tests  1 failed | 1 passed | 41 skipped (43)",
].join("\n");

const tree = (text: string) => {
  const r = new TestResults();
  r.apply(parseAll(teamcityTreeParser(jsParser()), text));
  return r;
};
const at = (...path: string[]) => path.join("\u0000");

describe("teamcityTreeParser", () => {
  it("builds the tree from the reporter's node ids, with locations, durations and output", () => {
    const r = tree(run);
    const failed = r.get(at("src/math.test.ts", "add", "adds positive numbers"))!;
    expect(failed.own).toBe("failed");
    expect(failed.durationMs).toBe(2);
    expect(failed.location).toEqual({ path: F, line: 16, col: 3, resolve: "path" });
    expect(failed.output).toEqual([
      "expected 5 to be 6",
      "Expected: 6",
      "Received: 5",
      "AssertionError: expected 5 to be 6",
      "    at src/math.test.ts:16:55",
    ]);
    const zero = r.get(at("src/math.test.ts", "add", "handles zero"))!;
    expect([zero.own, zero.output]).toEqual(["passed", ["hello from zero"]]);
    expect(r.get(at("src/math.test.ts", "add", "later"))!.own).toBe("skipped");
    expect(r.get(at("src/math.test.ts", "add"))!.location).toEqual({ path: F, line: 15, col: 1, resolve: "path" });
    // Only the tests the run selected: the reporter leaves out what `-t` filtered.
    expect(r.get(at("src/math.test.ts", "subtract"))).toBeUndefined();
  });

  it("reads the Jest reporter's tree: console output per file, skipped tests in the selection", () => {
    const J = "/work/jest/src/math.test.ts";
    const jest = [
      `##teamcity[testSuiteStarted name='src/math.test.ts' nodeId='1' parentNodeId='0' locationHint='file://${J}']`,
      `##teamcity[testSuiteStarted name='add' nodeId='2' parentNodeId='1' locationHint='file://${J}']`,
      `##teamcity[testStarted name='adds positive numbers' nodeId='3' parentNodeId='2' locationHint='file://${J}:16:5']`,
      "##teamcity[testFailed nodeId='3' message='Error: expect(received).toBe(expected)' details='Expected: 6|nReceived: 5' expected='6' actual='5']",
      "##teamcity[testFinished nodeId='3' duration='1']",
      `##teamcity[testStarted name='later' nodeId='4' parentNodeId='2' locationHint='file://${J}:19:5']`,
      "##teamcity[testIgnored nodeId='4']",
      "##teamcity[testFinished nodeId='4' duration='0']",
      "##teamcity[testStdOut nodeId='1' out='hi|n']",
      "##teamcity[testSuiteFinished nodeId='1']",
    ].join("\n");
    const r = new TestResults();
    r.apply(
      parseAll(createTestParser({ kind: "npm", command: "npm", args: ["run", "test"], testRunner: "jest" }), jest),
    );
    const failed = r.get(at("src/math.test.ts", "add", "adds positive numbers"))!;
    expect([failed.own, failed.durationMs, failed.location?.line]).toEqual(["failed", 1, 16]);
    expect(r.get(at("src/math.test.ts", "add", "later"))!.own).toBe("skipped");
    expect(r.get(at("src/math.test.ts"))!.output).toEqual(["hi"]);
  });

  it("reads the bun test reporter's tree: failures with their values, hook failures, filtered tests left out", async () => {
    const written: string[] = [];
    vi.doMock("node:fs", () => ({ writeSync: (_fd: number, text: string) => written.push(text) }));
    // @ts-expect-error -- the reporter is plain JavaScript that bun test loads, with no declarations.
    const { default: BunReporter } = await import("../../../../crates/ide-run/src/test_runner/reporters/bun.mjs");
    vi.doUnmock("node:fs");
    const B = `${process.cwd()}/src/math.test.ts`;
    const node = (type: string, id: string, parentId: string | null, name: string, line: number) => ({
      type,
      id,
      parentId,
      name,
      line,
      column: 3,
    });
    const end = (id: string, name: string, status: string, extra = {}) => ({
      type: "testEnd",
      file: B,
      id,
      name,
      status,
      duration: 1.4,
      errors: [],
      ...extra,
    });
    // As `bun test src/math.test.ts --reporter=<bun.mjs> -t add` reports them.
    const reporter = new BunReporter();
    reporter.onFileStart({ type: "fileStart", file: B });
    reporter.onFileCollected({
      type: "fileCollected",
      file: B,
      tests: [
        node("describe", "d2", null, "add", 15),
        node("test", "t1", "d2", "adds positive numbers", 16),
        node("test", "t2", "d2", "later", 17),
        node("describe", "d3", null, "subtract", 21),
        node("test", "t3", "d3", "subtracts", 22),
      ],
    });
    reporter.onTestStart({ type: "testStart", file: B, id: "t1", attempt: 1 });
    reporter.onTestEnd(
      end("t1", "adds positive numbers", "fail", {
        errors: [
          {
            name: "AssertionError",
            message: "expect(received).toBe(expected)\n\nExpected: 6\nReceived: 5\n",
            stack: "AssertionError: expect(received).toBe(expected)\n      at src/math.test.ts:16:20\n",
            expected: "6",
            actual: "5",
            uncaught: false,
          },
        ],
      }),
    );
    reporter.onTestEnd(end("t2", "later", "todo"));
    reporter.onTestEnd(end("t3", "subtracts", "skip", { reason: "filtered" }));
    reporter.onHookFailure({
      type: "hookFailure",
      file: B,
      parentId: "d2",
      status: "fail",
      errors: [{ name: "Error", message: "no database", stack: "Error: no database", uncaught: false }],
    });
    reporter.onFileEnd({ type: "fileEnd", file: B, duration: 3, failedToLoad: false });

    const r = new TestResults();
    const parser = createTestParser({
      kind: "bun",
      command: "bun",
      args: ["run", "test"],
      testRunner: "bun-test-live",
    });
    r.apply(parseAll(parser, ["bun test v1.4.6", ...written.map((line) => line.replace(/\n$/, ""))].join("\n")));
    const failed = r.get(at("src/math.test.ts", "add", "adds positive numbers"))!;
    expect([failed.own, failed.durationMs, failed.location]).toEqual([
      "failed",
      1,
      { path: B, line: 16, col: 3, resolve: "path" },
    ]);
    expect(failed.output).toEqual([
      "expect(received).toBe(expected)",
      "Expected: 6",
      "Received: 5",
      "AssertionError: expect(received).toBe(expected)",
      "      at src/math.test.ts:16:20",
    ]);
    expect(r.get(at("src/math.test.ts", "add", "later"))!.own).toBe("skipped");
    expect(r.get(at("src/math.test.ts", "add"))!.output).toEqual(["no database", "Error: no database"]);
    expect(r.get(at("src/math.test.ts", "subtract"))).toBeUndefined();
  });

  it("reads the console output when the reporter didn't load", () => {
    const r = tree(" ✓ src/a.test.ts > m > adds 1ms\n ✓ src/a.test.ts > m > subtracts 0ms");
    expect(r.get(at("src/a.test.ts", "m", "adds"))!.own).toBe("passed");
  });

  it("is the parser of test configurations whose runner has an IDE reporter", () => {
    const parser = createTestParser({ kind: "npm", command: "npm", args: ["run", "test"], testRunner: "vitest" });
    const r = new TestResults();
    r.apply(parseAll(parser, run));
    expect(r.get(at("src/math.test.ts", "add", "handles zero"))!.own).toBe("passed");
  });
});
