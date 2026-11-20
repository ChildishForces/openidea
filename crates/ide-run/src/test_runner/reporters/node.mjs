// OpenIDEA's reporter for Node's test runner (`node --test`): reports each test file, suite and test to
// the IDE as TeamCity service messages. The IDE builds its test tree from them and hides them from the
// console; the `spec` reporter still prints the run as usual.
//
// Node reports tests in the order they are defined: a suite's `test:start` comes before its tests', its
// `test:pass` / `test:fail` after them, so each file keeps a stack of the open suites. Whether a node is a
// suite is only known when it finishes; it is reported once it has a test or when it finishes.

import path from "node:path";

const ESCAPES = { "|": "||", "'": "|'", "[": "|[", "]": "|]", "\n": "|n", "\r": "|r" };
const escape = (value) => String(value).replace(/[|'[\]\n\r]/g, (c) => ESCAPES[c]);

function message(kind, attrs) {
  let body = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) body += ` ${key}='${escape(value)}'`;
  }
  return `##teamcity[${kind}${body}]\n`;
}

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value);
  } catch {
    return String(value);
  }
}

export default async function* openIdeaReporter(source) {
  let ids = 0;
  /** Per file: its node id and the stack of started, not yet finished tests. */
  const files = new Map();

  const fileOf = (file, out) => {
    let entry = files.get(file);
    if (!entry) {
      entry = { id: String(++ids), stack: [], name: path.relative(process.cwd(), file) };
      files.set(file, entry);
      out.push(
        message("testSuiteStarted", {
          name: entry.name,
          nodeId: entry.id,
          parentNodeId: "0",
          locationHint: `file://${file}`,
        }),
      );
    }
    return entry;
  };

  const location = (data) => `file://${data.file}${data.line ? `:${data.line}:${data.column ?? 1}` : ""}`;

  /** Reports `node` as a suite (and the suites around it), once. */
  const openSuite = (entry, at, out) => {
    const node = entry.stack[at];
    if (node.reported) return;
    if (at > 0) openSuite(entry, at - 1, out);
    node.reported = true;
    const parent = at > 0 ? entry.stack[at - 1].id : entry.id;
    out.push(
      message("testSuiteStarted", {
        name: node.name,
        nodeId: node.id,
        parentNodeId: parent,
        locationHint: node.location,
      }),
    );
  };

  for await (const event of source) {
    const data = event.data ?? {};
    const out = [];
    if (!data.file) continue;
    // Output events name the file relative to the working directory, test events absolutely.
    data.file = path.resolve(data.file);
    const entry = fileOf(data.file, out);
    switch (event.type) {
      case "test:start": {
        // A file that fails to load is reported as a test named after the file.
        if (data.nesting === 0 && data.name === entry.name) break;
        entry.stack[data.nesting] = {
          id: String(++ids),
          name: data.name,
          location: location(data),
          reported: false,
        };
        entry.stack.length = data.nesting + 1;
        break;
      }
      case "test:pass":
      case "test:fail": {
        const details = data.details ?? {};
        const error = details.error;
        const node = entry.stack[data.nesting];
        if (!node || node.name !== data.name) {
          // The file itself failed (it threw while loading, or a hook outside every suite failed).
          if (event.type === "test:fail") {
            const cause = error?.cause ?? error;
            out.push(message("testFailed", { nodeId: entry.id, message: cause?.message, details: cause?.stack }));
          }
          break;
        }
        const parent = data.nesting > 0 ? entry.stack[data.nesting - 1] : null;
        if (details.type === "suite") {
          openSuite(entry, data.nesting, out);
          // A suite whose tests failed fails through them; report only failures of its own (hooks).
          if (event.type === "test:fail" && error?.failureType !== "subtestsFailed") {
            const cause = error?.cause ?? error;
            out.push(message("testFailed", { nodeId: node.id, message: cause?.message, details: cause?.stack }));
          }
          out.push(message("testSuiteFinished", { nodeId: node.id }));
        } else {
          if (parent) openSuite(entry, data.nesting - 1, out);
          out.push(
            message("testStarted", {
              name: node.name,
              nodeId: node.id,
              parentNodeId: parent ? parent.id : entry.id,
              locationHint: node.location,
            }),
          );
          if (event.type === "test:fail") {
            const cause = error?.cause ?? error;
            const compared = cause && "expected" in cause && "actual" in cause;
            out.push(
              message("testFailed", {
                nodeId: node.id,
                message: cause?.message?.split("\n")[0],
                details: cause?.stack ?? cause?.message,
                expected: compared ? show(cause.expected) : undefined,
                actual: compared ? show(cause.actual) : undefined,
              }),
            );
          } else if (data.skip || data.todo) {
            out.push(
              message("testIgnored", {
                nodeId: node.id,
                message: typeof data.skip === "string" ? data.skip : undefined,
              }),
            );
          }
          out.push(message("testFinished", { nodeId: node.id, duration: Math.round(details.duration_ms ?? 0) }));
        }
        entry.stack.length = data.nesting;
        break;
      }
      case "test:stdout":
      case "test:stderr":
        // Output of a test file's process, not of one test.
        out.push(
          message(event.type === "test:stderr" ? "testStdErr" : "testStdOut", { nodeId: entry.id, out: data.message }),
        );
        break;
    }
    if (out.length) yield out.join("");
  }
}
