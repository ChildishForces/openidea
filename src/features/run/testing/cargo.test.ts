import { describe, expect, it } from "vitest";
import { cargoParser, CargoTestOutput } from "./cargo";
import { parseComparison } from "./comparison";
import { TestResults } from "./results";
import type { TestEvent } from "./types";

// `cargo test --test math -- add:: -Z unstable-options --format json --report-time`: a failing, a passing
// and an ignored test, after Cargo's `Running` line (on stderr).
const RUN = [
  "     Running tests/math.rs (target/debug/deps/math-30ac1a9902798060)",
  '{ "type": "suite", "event": "started", "test_count": 3 }',
  '{ "type": "test", "event": "started", "name": "add::adds_negative_numbers" }',
  '{ "type": "test", "event": "started", "name": "add::adds_positive_numbers" }',
  '{ "type": "test", "event": "started", "name": "add::handles_zero" }',
  '{ "type": "test", "name": "add::handles_zero", "event": "ignored", "message": "later" }',
  '{ "type": "test", "name": "add::adds_positive_numbers", "event": "failed", "exec_time": 1.4943623750000001, "stdout": "\\nthread \'add::adds_positive_numbers\' (3210034) panicked at tests/math.rs:17:9:\\nassertion `left == right` failed\\n  left: 5.0\\n right: 6.0\\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\\n" }',
  '{ "type": "test", "name": "add::adds_negative_numbers", "event": "ok", "exec_time": 2.495022 }',
  '{ "type": "suite", "event": "failed", "passed": 1, "failed": 1, "ignored": 1, "measured": 0, "filtered_out": 29, "exec_time": 2.495230459 }',
];

const at = (...path: string[]) => path.join("\u0000");

describe("cargo test's JSON events", () => {
  it("show each test running, then its result, under its test target", () => {
    const parser = cargoParser();
    const r = new TestResults();
    const running: string[] = [];
    for (const line of RUN) {
      const events: TestEvent[] = parser.feed(line);
      r.apply(events);
      if (line.includes('"event": "started", "name": "add::adds_positive_numbers"'))
        running.push(r.get(at("tests/math.rs", "add", "adds_positive_numbers"))!.own!);
    }
    expect(running).toEqual(["running"]);
    const failed = r.get(at("tests/math.rs", "add", "adds_positive_numbers"))!;
    expect(failed.own).toBe("failed");
    expect(failed.location).toMatchObject({ path: "tests/math.rs", line: 17, col: 9 });
    expect(parseComparison(failed.output)).toMatchObject({ expected: "5.0", actual: "6.0" });
    expect(r.get(at("tests/math.rs", "add", "adds_negative_numbers"))!.own).toBe("passed");
    const ignored = r.get(at("tests/math.rs", "add", "handles_zero"))!;
    expect([ignored.own, ignored.output]).toEqual(["skipped", ["later"]]);
    expect(r.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
  });

  it("read in the console as libtest's usual lines", () => {
    const console = new CargoTestOutput(() => {});
    const text = console.feed(RUN.slice(1).join("\n") + "\n");
    expect(text).not.toContain('"type"');
    expect(text).toContain("running 3 tests");
    expect(text).toContain("test add::adds_negative_numbers ... ok");
    expect(text).toContain("test add::handles_zero ... ignored, later");
    expect(text).toContain("test add::adds_positive_numbers ... FAILED");
    expect(text).toContain("---- add::adds_positive_numbers stdout ----");
    expect(text).toContain("test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 29 filtered out");
  });
});
