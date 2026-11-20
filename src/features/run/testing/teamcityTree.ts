/**
 * Test trees reported as TeamCity service messages with node ids (`nodeId` / `parentNodeId`), as the IDE's
 * own test reporters print them (`crates/ide-run/src/test_runner/reporters`). Tests of several files may
 * interleave, so each message names its node rather than relying on the order of suites.
 */
import { serviceMessage } from "./teamcity";
import type { TestEvent, TestLocation, TestOutputParser } from "./types";

/** `file:///abs/a.test.ts:12:3` → the file, line and column. */
function hintLocation(hint: string | undefined): TestLocation | null {
  const m = hint ? /^file:\/\/(.+?)(?::(\d+)(?::(\d+))?)?$/.exec(hint) : null;
  if (!m) return null;
  return {
    path: m[1]!,
    ...(m[2] ? { line: Number(m[2]) } : {}),
    ...(m[3] ? { col: Number(m[3]) } : {}),
    resolve: "path",
  };
}

const outputLines = (path: string[], text: string | undefined): TestEvent[] =>
  text
    ? text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => ({ type: "output", path, line }))
    : [];

/**
 * Builds the tree from the reporter's messages. Until the first one arrives, other output goes to
 * `fallback`: a run whose reporter could not load (an older framework version, a container target)
 * still shows what its console output tells.
 */
export function teamcityTreeParser(fallback: TestOutputParser): TestOutputParser {
  const paths = new Map<string, string[]>();
  const finished = new Map<string, "failed" | "skipped">();
  let reporting = false;
  return {
    feed(line) {
      const message = serviceMessage(line);
      if (!message) return reporting ? [] : fallback.feed(line);
      reporting = true;
      const { kind, attrs: a } = message;
      const id = a.nodeId ?? "";
      const path = paths.get(id);
      switch (kind) {
        case "testSuiteStarted":
        case "testStarted": {
          const parent = !a.parentNodeId || a.parentNodeId === "0" ? [] : paths.get(a.parentNodeId);
          if (!parent || !id || !a.name) return [];
          const own = [...parent, a.name];
          paths.set(id, own);
          const location = hintLocation(a.locationHint);
          // A suite's status follows its tests.
          return [
            ...(kind === "testStarted" ? [{ type: "start", path: own } as const] : []),
            ...(location ? [{ type: "location", path: own, location } as const] : []),
          ];
        }
        case "testFailed": {
          if (!path) return [];
          finished.set(id, "failed");
          const comparison =
            a.expected !== undefined && a.actual !== undefined
              ? [`Expected: ${a.expected}`, `Received: ${a.actual}`].map((l): TestEvent => ({
                  type: "output",
                  path,
                  line: l,
                }))
              : [];
          return [
            ...outputLines(path, a.message),
            ...comparison,
            ...outputLines(path, a.details),
            { type: "result", path, status: "failed", ...(a.duration ? { durationMs: Number(a.duration) } : {}) },
          ];
        }
        case "testIgnored":
          if (!path) return [];
          finished.set(id, "skipped");
          return [...outputLines(path, a.message), { type: "result", path, status: "skipped" }];
        case "testFinished": {
          const status = finished.get(id) ?? "passed";
          if (!path || (status === "skipped" && !a.duration)) return [];
          // A failure stays a failure (the result is sticky); the finish adds its duration.
          return [{ type: "result", path, status, ...(a.duration ? { durationMs: Number(a.duration) } : {}) }];
        }
        case "testStdOut":
        case "testStdErr":
          return path ? outputLines(path, a.out) : [];
        default:
          return [];
      }
    },
    end: () => (reporting ? [] : (fallback.end?.() ?? [])),
  };
}
