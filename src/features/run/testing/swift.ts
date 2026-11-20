/**
 * `swift test`. Swift Testing reports through its JSON event stream (`--experimental-event-stream-output`,
 * written to stdout next to its console output): each test with its identifier and source location, then
 * its events. XCTest prints only console lines (`Test Case '-[Module.Class testX]' passed (0.001 seconds).`).
 * Tests are rooted at their test target: `[Module, Suite…, function]`.
 */
import { parseDuration, TestStdout, type TestEvent, type TestOutputParser } from "./types";

/** The event stream's options; `/dev/stdout` is the test process's own output (not on Windows). */
export const SWIFT_EVENT_STREAM = [
  "--experimental-event-stream-output",
  "/dev/stdout",
  "--experimental-event-stream-version",
  "0",
];

interface SourceLocation {
  _filePath?: string;
  line?: number;
  column?: number;
}

interface Message {
  symbol?: string;
  text?: string;
}

interface Expression {
  sourceCode?: string;
  runtimeValue?: string;
  children?: Expression[];
}

interface Record {
  kind: "test" | "event";
  payload: {
    kind?: string;
    id?: string;
    testID?: string;
    sourceLocation?: SourceLocation;
    instant?: { absolute?: number };
    messages?: Message[];
    issue?: { isKnown?: boolean; _expression?: Expression };
  };
}

function parseRecord(json: string): Record | null {
  try {
    const record = JSON.parse(json);
    return (record?.kind === "test" || record?.kind === "event") && record.payload && typeof record.version === "number"
      ? record
      : null;
  } catch {
    return null;
  }
}

/**
 * The stream record on `line` and the console text around it: the stream and the console share stdout,
 * so a record can run together with a console line.
 */
export function splitStreamRecord(line: string): { record: Record; text: string } | null {
  const at = line.indexOf('{"kind":');
  if (at < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let i = at; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      const record = parseRecord(line.slice(at, i + 1));
      return record && { record, text: line.slice(0, at) + line.slice(i + 1) };
    }
  }
  return null;
}

/** `Module.Outer/Inner/named()/A.swift:7:10` → `["Module", "Outer", "Inner", "named()"]`. */
function idPath(id: string, fn: boolean): string[] {
  const dot = id.indexOf(".");
  const slash = id.indexOf("/");
  if (dot < 0 || (slash >= 0 && slash < dot)) return id.split("/");
  const parts = id.slice(dot + 1).split("/");
  if (fn && /\.swift:\d+:\d+$/.test(parts.at(-1) ?? "")) parts.pop();
  return [id.slice(0, dot), ...parts];
}

const XCTEST_CASE_RE =
  /^Test Case '(?:-\[(\w+)\.(\w+) (\w+)\]|(\w+)\.(\w+))' (started|passed|failed|skipped)(?: \(([\d.]+) seconds\))?/;
const XCTEST_ISSUE_RE = /^(.+\.swift):(\d+): (?:error|warning): (?:-\[(\w+)\.(\w+) (\w+)\]|(\w+)\.(\w+)) : (.*)$/;

export function swiftParser(): TestOutputParser {
  const tests = new Map<string, { path: string[]; function: boolean }>();
  const started = new Map<string, number>();
  const failed = new Set<string>();

  const streamEvents = ({ kind, payload: p }: Record): TestEvent[] => {
    if (kind === "test") {
      if (!p.id) return [];
      const fn = p.kind === "function";
      const path = idPath(p.id, fn);
      tests.set(p.id, { path, function: fn });
      const at = p.sourceLocation;
      return at?._filePath
        ? [{ type: "location", path, location: { path: at._filePath, line: at.line, col: at.column, resolve: "path" } }]
        : [];
    }
    const test = p.testID ? tests.get(p.testID) : undefined;
    if (!test) return [];
    const { path } = test;
    const text = (p.messages ?? []).map((m) => m.text ?? "").filter(Boolean);
    switch (p.kind) {
      case "testStarted":
        if (p.instant?.absolute !== undefined) started.set(p.testID!, p.instant.absolute);
        return test.function ? [{ type: "start", path }] : [];
      case "issueRecorded": {
        if (!p.issue?.isKnown) failed.add(p.testID!);
        const events: TestEvent[] = text.map((line) => ({ type: "output", path, line }));
        // `#expect(a == b)`: its two sides, for Show Diff (Swift doesn't say which one is expected).
        const [left, right] = p.issue?._expression?.children ?? [];
        if (/^[^=]+ == [^=]+$/.test(p.issue?._expression?.sourceCode ?? "") && left && right)
          events.push(
            { type: "output", path, line: `left: ${left.runtimeValue ?? ""}` },
            { type: "output", path, line: `right: ${right.runtimeValue ?? ""}` },
          );
        return events;
      }
      case "testSkipped":
        return [
          ...text.map((line): TestEvent => ({ type: "output", path, line })),
          ...(test.function ? [{ type: "result", path, status: "skipped" } as const] : []),
        ];
      case "testEnded": {
        // A suite's status follows its tests.
        if (!test.function) return [];
        const start = started.get(p.testID!);
        const end = p.instant?.absolute;
        const status = failed.has(p.testID!) || p.messages?.[0]?.symbol === "fail" ? "failed" : "passed";
        return [
          {
            type: "result",
            path,
            status,
            ...(start !== undefined && end !== undefined ? { durationMs: Math.round((end - start) * 1e6) / 1e3 } : {}),
          },
        ];
      }
      default:
        return [];
    }
  };

  let xctest: string[] | null = null;
  return {
    feed(line) {
      const split = splitStreamRecord(line);
      if (split) return streamEvents(split.record);
      let m: RegExpExecArray | null;
      if ((m = XCTEST_CASE_RE.exec(line))) {
        // Linux prints `Class.testX`, without the module.
        const path = m[1] ? [m[1], m[2]!, m[3]!] : [m[4]!, m[5]!];
        const outcome = m[6]!;
        xctest = outcome === "started" ? path : null;
        if (outcome === "started") return [{ type: "start", path }];
        const status = outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "skipped";
        return [{ type: "result", path, status, durationMs: parseDuration(m[7] && `${m[7]}s`) }];
      }
      if ((m = XCTEST_ISSUE_RE.exec(line))) {
        const path = m[3] ? [m[3], m[4]!, m[5]!] : [m[6]!, m[7]!];
        return [
          { type: "output", path, line: m[8]! },
          { type: "location", path, location: { path: m[1]!, line: Number(m[2]), resolve: "path" } },
        ];
      }
      // What a running XCTest method prints (Swift Testing runs tests in parallel: its output stays in the console).
      if (xctest && !/^Test (Suite|Case) '/.test(line)) return [{ type: "output", path: xctest, line }];
      return [];
    },
  };
}

/** Swift Testing's stream records feed the tree; the console shows the rest. */
export class SwiftTestOutput extends TestStdout {
  constructor(feedLine: (line: string) => void) {
    super(feedLine, (line) => {
      const split = splitStreamRecord(line);
      if (!split) return line + "\n";
      return split.text.trim() ? split.text + "\n" : "";
    });
  }
}
