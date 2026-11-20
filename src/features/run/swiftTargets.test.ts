import { describe, expect, it } from "vitest";
import { swiftFileFilter, swiftFilter, swiftTargets, withoutSwiftFilter } from "./swiftTargets";

const SWIFT_TESTING = [
  "import Testing",
  "@Suite struct AddTests {",
  "    @Test func addsPositiveNumbers() { #expect(add(2, 3) == 5) }",
  "    func helper() {}",
  "    @Suite struct Nested {",
  '        @Test("a display name") func named() {}',
  "    }",
  "}",
  "@Test func topLevel() {}",
  "// @Test func commentedOut() {}",
].join("\n");

const XCTEST = [
  "import XCTest",
  "final class LegacyTests: XCTestCase {",
  "    func testAdds() { XCTAssertEqual(add(2, 3), 5) }",
  "    func testWithArgument(_ x: Int) {}",
  "    func helper() {}",
  "}",
].join("\n");

const pick = (text: string) => swiftTargets(text).map((t) => [t.line, t.kind, t.path.join("/")]);

describe("swiftTargets", () => {
  it("finds Swift Testing suites and tests, nested ones included", () => {
    expect(pick(SWIFT_TESTING)).toEqual([
      [1, "suite", "AddTests"],
      [2, "test", "AddTests/addsPositiveNumbers"],
      [4, "suite", "AddTests/Nested"],
      [5, "test", "AddTests/Nested/named"],
      [8, "test", "topLevel"],
    ]);
  });

  it("finds XCTest methods: `test…` without arguments, in an XCTestCase subclass", () => {
    expect(pick(XCTEST)).toEqual([
      [1, "suite", "LegacyTests"],
      [2, "test", "LegacyTests/testAdds"],
    ]);
    expect(swiftTargets(XCTEST)[1]!.xctest).toBe(true);
  });
});

describe("swift test --filter", () => {
  it("matches a suite, a Swift Testing function or an XCTest method by its identifier", () => {
    const [suite, test] = swiftTargets(SWIFT_TESTING);
    const filter = (t: typeof suite) => new RegExp(swiftFilter(t!));
    expect(filter(suite).test("MathLibTests.AddTests/addsPositiveNumbers()/MathTests.swift:3:6")).toBe(true);
    expect(filter(suite).test("MathLibTests.AddTestsMore/x()")).toBe(false);
    expect(filter(test).test("MathLibTests.AddTests/addsPositiveNumbers()/MathTests.swift:3:6")).toBe(true);
    expect(filter(test).test("MathLibTests.AddTests/addsPositiveNumbersToo()")).toBe(false);
    const xctest = swiftTargets(XCTEST)[1]!;
    expect(new RegExp(swiftFilter(xctest)).test("MathLibTests.LegacyTests/testAdds")).toBe(true);
    expect(new RegExp(swiftFilter(xctest)).test("MathLibTests.LegacyTests/testAddsMore")).toBe(false);
  });

  it("runs a file through its outermost suites and tests, replacing the configuration's filter", () => {
    expect(swiftFileFilter(SWIFT_TESTING)).toBe("(^|\\.)AddTests(/|$)|(^|\\.)topLevel\\(");
    expect(swiftFileFilter("import Testing")).toBeNull();
    expect(withoutSwiftFilter(["test", "--filter", "old", "--filter=x", "-v"])).toEqual(["test", "-v"]);
  });
});
