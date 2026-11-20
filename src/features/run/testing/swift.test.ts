import { describe, expect, it } from "vitest";
import { parseComparison } from "./comparison";
import { parseAll, TestResults } from "./index";
import { swiftParser, SwiftTestOutput } from "./swift";

// `swift test --filter AddTests --experimental-event-stream-output /dev/stdout` (Swift 6.4) with a failing
// `#expect(add(2, 3) == 6)`: the stream's records for two tests (backtraces left out).
const STREAM = [
  '{"kind":"test","payload":{"id":"MathLibTests.AddTests","kind":"suite","name":"AddTests","sourceLocation":{"_filePath":"/work/swift/Tests/MathLibTests/MathTests.swift","column":2,"fileID":"MathLibTests/MathTests.swift","line":4}},"version":0}',
  '{"kind":"test","payload":{"id":"MathLibTests.AddTests/handlesZero()/MathTests.swift:7:6","isParameterized":false,"kind":"function","name":"handlesZero()","sourceLocation":{"_filePath":"/work/swift/Tests/MathLibTests/MathTests.swift","column":6,"fileID":"MathLibTests/MathTests.swift","line":7}},"version":0}',
  '{"kind":"test","payload":{"id":"MathLibTests.AddTests/addsPositiveNumbers()/MathTests.swift:5:6","isParameterized":false,"kind":"function","name":"addsPositiveNumbers()","sourceLocation":{"_filePath":"/work/swift/Tests/MathLibTests/MathTests.swift","column":6,"fileID":"MathLibTests/MathTests.swift","line":5}},"version":0}',
  '{"kind":"event","payload":{"instant":{"absolute":27505.265970916,"since1970":1795136486.168077},"kind":"testStarted","messages":[{"symbol":"default","text":"Test handlesZero() started."}],"testID":"MathLibTests.AddTests/handlesZero()/MathTests.swift:7:6"},"version":0}',
  '{"kind":"event","payload":{"instant":{"absolute":27505.265990833,"since1970":1795136486.168097},"kind":"testStarted","messages":[{"symbol":"default","text":"Test addsPositiveNumbers() started."}],"testID":"MathLibTests.AddTests/addsPositiveNumbers()/MathTests.swift:5:6"},"version":0}',
  '{"kind":"event","payload":{"instant":{"absolute":27505.266076624997,"since1970":1795136486.168183},"kind":"testEnded","messages":[{"symbol":"pass","text":"Test handlesZero() passed after 0.001 seconds."}],"testID":"MathLibTests.AddTests/handlesZero()/MathTests.swift:7:6"},"version":0}',
  '{"kind":"event","payload":{"_comments":[],"_sourceLocation":{"_filePath":"/work/swift/Tests/MathLibTests/MathTests.swift","column":40,"fileID":"MathLibTests/MathTests.swift","line":5},"instant":{"absolute":27505.266176666,"since1970":1795136486.168283},"issue":{"_expression":{"children":[{"runtimeTypeName":"Swift.Double","runtimeValue":"5.0","sourceCode":"add(2, 3)"},{"runtimeTypeName":"Swift.Double","runtimeValue":"6.0","sourceCode":"6"}],"runtimeTypeName":"Swift.Bool","runtimeValue":"false","sourceCode":"add(2, 3) == 6"},"isKnown":false,"sourceLocation":{"_filePath":"/work/swift/Tests/MathLibTests/MathTests.swift","column":40,"fileID":"MathLibTests/MathTests.swift","line":5}},"kind":"issueRecorded","messages":[{"symbol":"fail","text":"Expectation failed: add(2, 3) == 6"},{"symbol":"details","text":"add(2, 3) == 6 \\u2192 false"},{"_indentation":1,"symbol":"details","text":"add(2, 3) \\u2192 5.0"},{"_indentation":1,"symbol":"details","text":"6 \\u2192 6.0"}],"testID":"MathLibTests.AddTests/addsPositiveNumbers()/MathTests.swift:5:6"},"version":0}',
  '{"kind":"event","payload":{"instant":{"absolute":27505.266529916,"since1970":1795136486.168636},"kind":"testEnded","messages":[{"symbol":"fail","text":"Test addsPositiveNumbers() failed after 0.001 seconds with 1 issue."}],"testID":"MathLibTests.AddTests/addsPositiveNumbers()/MathTests.swift:5:6"},"version":0}',
];

const tree = (lines: string[]) => {
  const r = new TestResults();
  r.apply(parseAll(swiftParser(), lines.join("\n")));
  return r;
};
const at = (...path: string[]) => path.join("\u0000");
const FILE = "/work/swift/Tests/MathLibTests/MathTests.swift";

describe("swiftParser", () => {
  it("builds the tree from Swift Testing's event stream, under the test target", () => {
    const r = tree(STREAM);
    const failed = r.get(at("MathLibTests", "AddTests", "addsPositiveNumbers()"))!;
    expect(failed.own).toBe("failed");
    expect(failed.location).toMatchObject({ path: FILE, line: 5, resolve: "path" });
    expect(failed.output[0]).toBe("Expectation failed: add(2, 3) == 6");
    // Show Diff gets the expectation's two sides.
    expect(parseComparison(failed.output)).toEqual({
      expected: "5.0",
      actual: "6.0",
      labels: { expected: "Left", actual: "Right" },
    });
    const passed = r.get(at("MathLibTests", "AddTests", "handlesZero()"))!;
    expect(passed.own).toBe("passed");
    expect(passed.durationMs).toBeGreaterThan(0);
    expect(r.get(at("MathLibTests", "AddTests"))!.location).toMatchObject({ path: FILE, line: 4 });
  });

  it("reads a record run together with a console line, and keeps only the text in the console", () => {
    const merged = STREAM.at(-1)! + "\u{10105B}  Suite AddTests failed after 0.001 seconds.";
    const r = tree([...STREAM.slice(0, -1), merged]);
    expect(r.get(at("MathLibTests", "AddTests", "addsPositiveNumbers()"))!.own).toBe("failed");
    const fed: string[] = [];
    const console = new SwiftTestOutput((line) => fed.push(line));
    expect(console.feed(`${STREAM[0]}\n${merged}\nBuilding for debugging...\n`)).toBe(
      "\u{10105B}  Suite AddTests failed after 0.001 seconds.\nBuilding for debugging...\n",
    );
    expect(fed).toHaveLength(3);
  });

  it("reads XCTest's console lines", () => {
    const r = tree([
      "Test Case '-[MathLibTests.LegacyTests testAdds]' started.",
      "printed by the test",
      '/work/swift/Tests/MathLibTests/LegacyTests.swift:9: error: -[MathLibTests.LegacyTests testAdds] : XCTAssertEqual failed: ("5") is not equal to ("6")',
      "Test Case '-[MathLibTests.LegacyTests testAdds]' failed (0.002 seconds).",
      "Test Case '-[MathLibTests.LegacyTests testZero]' passed (0.001 seconds).",
    ]);
    const failed = r.get(at("MathLibTests", "LegacyTests", "testAdds"))!;
    expect([failed.own, failed.durationMs, failed.location?.line]).toEqual(["failed", 2, 9]);
    expect(failed.output).toContain("printed by the test");
    expect(parseComparison(failed.output)).toMatchObject({ expected: "5", actual: "6" });
    expect(r.get(at("MathLibTests", "LegacyTests", "testZero"))!.own).toBe("passed");
  });
});
