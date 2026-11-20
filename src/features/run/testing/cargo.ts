/**
 * `cargo test` (libtest) and `cargo nextest` output. The IDE's own `cargo test` runs print libtest's JSON
 * events (`--format json`: each test as it starts and ends), which `CargoTestOutput` shows as libtest's
 * usual console lines.
 */
import { parseDuration, TestStdout, type TestEvent, type TestOutputParser } from "./types";

interface LibtestEvent {
  type: "test" | "suite";
  event: string;
  name?: string;
  exec_time?: number;
  stdout?: string;
  message?: string;
  test_count?: number;
  passed?: number;
  failed?: number;
  ignored?: number;
  measured?: number;
  filtered_out?: number;
}

function libtestEvent(line: string): LibtestEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line);
    return (event?.type === "test" || event?.type === "suite") && typeof event.event === "string" ? event : null;
  } catch {
    return null;
  }
}

/** A libtest event as libtest's own console output reads. */
function consoleText(e: LibtestEvent): string {
  if (e.type === "suite") {
    if (e.event === "started") return `\nrunning ${e.test_count ?? 0} tests\n`;
    const result = e.event === "ok" ? "ok" : "FAILED";
    const counts = `${e.passed ?? 0} passed; ${e.failed ?? 0} failed; ${e.ignored ?? 0} ignored; ${e.measured ?? 0} measured; ${e.filtered_out ?? 0} filtered out`;
    return `\ntest result: ${result}. ${counts}; finished in ${(e.exec_time ?? 0).toFixed(2)}s\n\n`;
  }
  switch (e.event) {
    case "ok":
      return `test ${e.name} ... ok\n`;
    case "ignored":
      return `test ${e.name} ... ignored${e.message ? `, ${e.message}` : ""}\n`;
    case "failed":
      return `test ${e.name} ... FAILED\n${e.stdout ? `\n---- ${e.name} stdout ----\n${e.stdout.replace(/^\n/, "")}\n` : ""}`;
    default:
      return "";
  }
}

/** Console text of a `cargo test` run printing libtest's JSON events: their usual lines. */
export class CargoTestOutput extends TestStdout {
  constructor(feedLine: (line: string) => void) {
    super(feedLine, (line) => {
      const event = libtestEvent(line);
      return event ? consoleText(event) : line + "\n";
    });
  }
}

const RUNNING_RE = /^\s+Running (?:unittests )?(\S+) \(.+\)$/;
const DOCTESTS_RE = /^\s*Doc-tests (\S+)/;
const TEST_RE = /^test (.+?) \.\.\. (ok|FAILED|ignored|bench)(?:,.*)?(?:\s+<([\d.]+s)>)?$/;
const FAILURE_HEADER_RE = /^---- (.+?) (?:stdout|stderr) ----$/;
// Rust ≥ 1.73: `thread 'x' panicked at src/lib.rs:10:5:`; older: `panicked at 'msg', src/lib.rs:10:5`.
const PANIC_RE = /panicked at (?:'.*', |".*", )?([^\s:'"][^:'"]*):(\d+):(\d+)/;
const SUMMARY_RE =
  /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;.*?(?:finished in ([\d.]+s))?$/;
const NEXTEST_RE = /^\s*(PASS|FAIL|SKIP|SIGSEGV|SIGABRT|TIMEOUT|LEAK)\s+\[\s*([\d.]+s)\]\s+(\S+)\s+(.+)$/;
const NEXTEST_SUMMARY_RE =
  /^\s*Summary \[\s*([\d.]+s)\]\s+(\d+) tests? run: (\d+) passed(?:.*?(\d+) failed)?(?:.*?(\d+) skipped)?/;

export function cargoParser(): TestOutputParser {
  let suite: string | null = null;
  let failure: string[] | null = null;
  const totals = { passed: 0, failed: 0, skipped: 0, durationMs: 0 };

  const pathOf = (name: string) => {
    const parts = name.split("::");
    return suite ? [suite, ...parts] : parts;
  };

  /** A libtest JSON event's tree updates. */
  const jsonEvents = (e: LibtestEvent): TestEvent[] => {
    if (e.type === "suite") {
      if (e.event === "started") return [];
      totals.passed += e.passed ?? 0;
      totals.failed += e.failed ?? 0;
      totals.skipped += e.ignored ?? 0;
      totals.durationMs += (e.exec_time ?? 0) * 1000;
      return [{ type: "summary", ...totals }];
    }
    if (!e.name) return [];
    const path = pathOf(e.name);
    const durationMs = e.exec_time === undefined ? undefined : Math.round(e.exec_time * 1e6) / 1e3;
    switch (e.event) {
      case "started":
        return [{ type: "start", path }];
      case "ok":
        return [{ type: "result", path, status: "passed", durationMs }];
      case "ignored":
        return [
          ...(e.message ? [{ type: "output", path, line: e.message } as const] : []),
          { type: "result", path, status: "skipped" },
        ];
      case "failed": {
        const events: TestEvent[] = [];
        for (const line of (e.stdout ?? "").replace(/^\n/, "").replace(/\n$/, "").split("\n")) {
          events.push({ type: "output", path, line });
          const p = PANIC_RE.exec(line);
          if (p)
            events.push({
              type: "location",
              path,
              location: { path: p[1]!, line: Number(p[2]), col: Number(p[3]), resolve: "path" },
            });
        }
        return [...events, { type: "result", path, status: "failed", durationMs }];
      }
      default:
        return [];
    }
  };

  return {
    feed(line) {
      const json = libtestEvent(line);
      if (json) return jsonEvents(json);
      const events: TestEvent[] = [];
      let m: RegExpExecArray | null;
      if ((m = RUNNING_RE.exec(line))) {
        suite = m[1]!;
        failure = null;
      } else if ((m = DOCTESTS_RE.exec(line))) {
        suite = `Doc-tests ${m[1]}`;
        failure = null;
      } else if ((m = TEST_RE.exec(line))) {
        const status = m[2] === "ok" || m[2] === "bench" ? "passed" : m[2] === "FAILED" ? "failed" : "skipped";
        events.push({ type: "result", path: pathOf(m[1]!), status, durationMs: parseDuration(m[3]) });
      } else if ((m = FAILURE_HEADER_RE.exec(line))) {
        failure = pathOf(m[1]!);
      } else if ((m = SUMMARY_RE.exec(line))) {
        failure = null;
        totals.passed += Number(m[1]);
        totals.failed += Number(m[2]);
        totals.skipped += Number(m[3]);
        totals.durationMs += parseDuration(m[4]) ?? 0;
        events.push({ type: "summary", ...totals });
      } else if ((m = NEXTEST_RE.exec(line))) {
        const status = m[1] === "PASS" ? "passed" : m[1] === "SKIP" ? "skipped" : "failed";
        events.push({
          type: "result",
          path: [m[3]!, ...m[4]!.split("::")],
          status,
          durationMs: parseDuration(m[2]),
        });
      } else if ((m = NEXTEST_SUMMARY_RE.exec(line))) {
        events.push({
          type: "summary",
          durationMs: parseDuration(m[1]),
          passed: Number(m[3]),
          failed: m[4] ? Number(m[4]) : 0,
          skipped: m[5] ? Number(m[5]) : 0,
        });
      } else if (failure) {
        if (line === "failures:" || line.startsWith("failures:")) {
          failure = null;
        } else {
          events.push({ type: "output", path: failure, line });
          const p = PANIC_RE.exec(line);
          if (p) {
            events.push({
              type: "location",
              path: failure,
              location: { path: p[1]!, line: Number(p[2]), col: Number(p[3]), resolve: "path" },
            });
          }
        }
      }
      return events;
    },
  };
}
