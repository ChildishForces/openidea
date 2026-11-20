// OpenIDEA's bun test reporter (bun test's reporter module API, `bun test --reporter=<module>`): reports each
// test file, `describe` block and test to the IDE as TeamCity service messages on stdout. The IDE builds its
// test tree from them and hides them from the console; bun test's own reporter still prints the run as usual.
// A bun test without this API refuses to start, so the IDE loads it only for the "bun-test-live" runner.

import { relative } from "node:path";
import { writeSync } from "node:fs";

const ESCAPES = { "|": "||", "'": "|'", "[": "|[", "]": "|]", "\n": "|n", "\r": "|r" };
const escape = (value) => String(value).replace(/[|'[\]\n\r]/g, (c) => ESCAPES[c]);

// Written at once, so the messages of the run's last events are out before bun test exits.
function message(kind, attrs) {
  let body = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) body += ` ${key}='${escape(value)}'`;
  }
  writeSync(1, `##teamcity[${kind}${body}]\n`);
}

export default class OpenIdeaReporter {
  /** Each file's tests and `describe` blocks from `fileCollected`, by id. */
  nodes = new Map();
  /** Node ids reported and not finished yet. */
  started = new Set();

  /** Node ids are unique across files: bun test's ids are unique within a file. */
  nodeId(file, id) {
    return id === null ? file : `${file}#${id}`;
  }

  location(file, node) {
    return `file://${file}${node?.line ? `:${node.line}:${node.column}` : ""}`;
  }

  /** Reports the file, or the node `id` of `file` and the `describe` blocks around it, once each. */
  open(file, id) {
    const nodeId = this.nodeId(file, id);
    if (this.started.has(nodeId)) return nodeId;
    const node = id === null ? undefined : this.nodes.get(file)?.get(id);
    const parentNodeId = id === null ? "0" : this.open(file, node?.parentId ?? null);
    message(node?.type === "test" ? "testStarted" : "testSuiteStarted", {
      name: id === null ? relative(process.cwd(), file) : (node?.name ?? id),
      nodeId,
      parentNodeId,
      locationHint: this.location(file, node),
    });
    this.started.add(nodeId);
    return nodeId;
  }

  fail(nodeId, errors) {
    for (const error of errors) {
      message("testFailed", {
        nodeId,
        message: error.message.split("\n")[0],
        details: error.stack,
        expected: error.expected,
        actual: error.actual,
      });
    }
  }

  onFileStart(event) {
    this.open(event.file, null);
  }

  onFileCollected(event) {
    this.nodes.set(event.file, new Map(event.tests.map((node) => [node.id, node])));
  }

  onTestStart(event) {
    this.open(event.file, event.id);
  }

  onTestEnd(event) {
    // Tests a name filter (`-t`) or `.only` left out: the tree shows only the tests the run selected.
    if (event.reason === "filtered") return;
    const nodeId = this.open(event.file, event.id);
    if (event.status === "fail") {
      // A test that fails without throwing, such as one that timed out, has no error.
      this.fail(nodeId, event.errors.length ? event.errors : [{ message: event.reason ?? "failed" }]);
    } else if (event.status !== "pass") {
      message("testIgnored", { nodeId, message: event.status === "todo" ? "todo" : undefined });
    }
    message("testFinished", { nodeId, duration: Math.round(event.duration) });
    this.started.delete(nodeId);
  }

  // A failed `beforeAll` or `afterAll` fails its `describe` block, or the file at its top level.
  onHookFailure(event) {
    this.fail(this.open(event.file, event.parentId), event.errors);
  }

  onUnhandledError(event) {
    this.fail(this.open(event.file, null), [event.error]);
  }

  onFileEnd(event) {
    const prefix = `${event.file}#`;
    for (const nodeId of [...this.started].reverse()) {
      if (nodeId !== event.file && !nodeId.startsWith(prefix)) continue;
      message("testSuiteFinished", { nodeId });
      this.started.delete(nodeId);
    }
    this.nodes.delete(event.file);
  }
}
