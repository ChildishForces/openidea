import type { RunTarget } from "./targets";

// Not `testing/rerun`'s: that module builds reruns from this one.
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Swift Testing (`@Test` functions, in types or at the top level) and XCTest (`func test…()` of an
 * `XCTestCase` subclass) tests. Paths are type names then the function's (`["AddTests", "adds"]`),
 * as `swift test` identifies tests (`Module.AddTests/adds()`).
 */
export function swiftTargets(text: string): RunTarget[] {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"/g, (value) =>
    value.replace(/[^\r\n]/g, " "),
  );
  const tokens =
    /\b(?:struct|class|enum|actor|extension)\s+(\w+)([^{};]*)\{|@Test\b|\bfunc\s+(\w+)\s*(\([^)]*\))?|[{}]/g;
  const types: Array<{ name: string; depth: number; line: number; xctest: boolean }> = [];
  // Types holding tests are their suites, nested ones included (`Outer/Inner`).
  const suites = new Map<string, RunTarget>();
  const tests: RunTarget[] = [];
  let depth = 0;
  let line = 0;
  let offset = 0;
  let marked = false;
  for (const match of code.matchAll(tokens)) {
    while (offset < match.index) {
      if (code.charCodeAt(offset) === 10) line++;
      offset++;
    }
    const value = match[0];
    if (match[1]) {
      types.push({ name: match[1], depth: depth++, line, xctest: /:[^{]*\bXCTestCase\b/.test(match[2] ?? "") });
      marked = false;
    } else if (value === "@Test") {
      marked = true;
    } else if (match[3]) {
      const owner = types.at(-1);
      const member = !owner || owner.depth === depth - 1;
      const xctest = !!owner?.xctest && member && /^test/.test(match[3]) && /^\(\s*\)$/.test(match[4] ?? "()");
      if ((marked && member) || xctest) {
        const path = [...types.map((t) => t.name), match[3]];
        types.forEach((t, i) => {
          const key = path.slice(0, i + 1).join("/");
          if (!suites.has(key))
            suites.set(key, { line: t.line, kind: "suite", name: t.name, path: path.slice(0, i + 1) });
        });
        tests.push({ line, kind: "test", name: path.join("."), path, ...(xctest ? { xctest } : {}) });
      }
      marked = false;
    } else if (value === "{") depth++;
    else if (value === "}") {
      depth--;
      while (types.length && types.at(-1)!.depth >= depth) types.pop();
    }
  }
  return [...suites.values(), ...tests].sort((a, b) => a.line - b.line);
}

/**
 * `swift test --filter` for a target: a regular expression searched in each test's identifier,
 * `Module.Suite/function()` (Swift Testing) or `Module.Class/testMethod` (XCTest).
 */
export function swiftFilter(target: Pick<RunTarget, "kind" | "path" | "xctest">): string {
  const path = `(^|\\.)${target.path.map(escapeRegExp).join("/")}`;
  if (target.kind === "suite") return `${path}(/|$)`;
  return target.xctest ? `${path}$` : `${path}\\(`;
}

/** `swift test` arguments without their `--filter` (a file's configuration has one). */
export function withoutSwiftFilter(args: readonly string[]): string[] {
  return args.filter((a, i) => a !== "--filter" && args[i - 1] !== "--filter" && !a.startsWith("--filter="));
}

/** A file's tests: its outermost suites and top-level test functions. */
export function swiftFileFilter(text: string): string | null {
  const outer = swiftTargets(text).filter((t) => t.path.length === 1);
  return outer.length ? outer.map(swiftFilter).join("|") : null;
}
