// OpenIDEA's Jest reporter (tests are reported as their results arrive, which carry their location): reports each test file, `describe` block and test to the IDE as TeamCity
// service messages on stdout. The IDE builds its test tree from them and hides them from the console;
// Jest's own reporter still prints the run as usual.
"use strict";

const path = require("path");

const ESCAPES = { "|": "||", "'": "|'", "[": "|[", "]": "|]", "\n": "|n", "\r": "|r" };
const escape = (value) => String(value).replace(/[|'[\]\n\r]/g, (c) => ESCAPES[c]);
const plain = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");

function message(kind, attrs) {
  let body = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) body += ` ${key}='${escape(value)}'`;
  }
  process.stdout.write(`##teamcity[${kind}${body}]\n`);
}

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value);
  } catch {
    return String(value);
  }
}

class OpenIdeaReporter {
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir;
    // Jest matches `-t` case-insensitively against the `describe` names and the test's, joined with spaces.
    this.pattern = globalConfig.testNamePattern ? new RegExp(globalConfig.testNamePattern, "i") : null;
    /** Node ids by file and name path (`\u0000`-joined), and the reported ones. */
    this.ids = new Map();
    this.started = new Set();
    this.finished = new Set();
  }

  /** The tree shows only the tests the run selected: `-t` leaves the others pending. */
  selected(result) {
    return !this.pattern || this.pattern.test([...result.ancestorTitles, result.title].join(" "));
  }

  id(key) {
    if (!this.ids.has(key)) this.ids.set(key, String(this.ids.size + 1));
    return this.ids.get(key);
  }

  /** Reports the file once; returns its node id. */
  openFile(file) {
    const id = this.id(file);
    if (this.started.has(id)) return id;
    this.started.add(id);
    message("testSuiteStarted", {
      name: path.relative(this.rootDir, file),
      nodeId: id,
      parentNodeId: "0",
      locationHint: `file://${file}`,
    });
    return id;
  }

  /** Reports the test (and its `describe` blocks, once each); returns its node id. */
  openTest(file, info) {
    let parent = this.openFile(file);
    let key = file;
    for (const title of info.ancestorTitles) {
      key += `\u0000${title}`;
      const id = this.id(key);
      if (!this.started.has(id)) {
        this.started.add(id);
        message("testSuiteStarted", { name: title, nodeId: id, parentNodeId: parent, locationHint: `file://${file}` });
      }
      parent = id;
    }
    key += `\u0000${info.title}`;
    let id = this.id(key);
    // Tests of the same name in one block each get a node.
    for (let n = 2; this.finished.has(id); n++) id = this.id(`${key}\u0000${n}`);
    if (!this.started.has(id)) {
      this.started.add(id);
      const at = info.location ? `:${info.location.line}:${info.location.column}` : "";
      message("testStarted", {
        name: info.title,
        nodeId: id,
        parentNodeId: parent,
        locationHint: `file://${file}${at}`,
      });
    }
    return id;
  }

  finishTest(file, result) {
    const id = this.openTest(file, result);
    if (result.status === "failed") {
      const details = (result.failureDetails ?? []).find((d) => d && d.matcherResult);
      const comparison = details && details.matcherResult;
      const text = plain((result.failureMessages ?? []).join("\n"));
      message("testFailed", {
        nodeId: id,
        message: text.split("\n")[0],
        details: text,
        expected: comparison ? show(comparison.expected) : undefined,
        actual: comparison ? show(comparison.actual) : undefined,
      });
    } else if (result.status !== "passed") {
      message("testIgnored", { nodeId: id });
    }
    message("testFinished", { nodeId: id, duration: Math.round(result.duration ?? 0) });
    this.finished.add(id);
  }

  onTestFileStart(test) {
    this.openFile(test.path);
  }

  onTestCaseResult(test, result) {
    this.finishTest(test.path, result);
  }

  onTestFileResult(test, fileResult) {
    const file = fileResult.testFilePath;
    const fileId = this.openFile(file);
    // Skipped and todo tests (and every test, before Jest called `onTestCaseResult`) arrive only here.
    for (const result of fileResult.testResults) {
      if (!this.selected(result)) continue;
      const key = [file, ...result.ancestorTitles, result.title].join("\u0000");
      if (!this.ids.has(key) || !this.finished.has(this.ids.get(key))) this.finishTest(file, result);
    }
    // Jest collects console output per file, not per test.
    for (const entry of fileResult.console ?? []) {
      const kind = entry.type === "error" || entry.type === "warn" ? "testStdErr" : "testStdOut";
      message(kind, { nodeId: fileId, out: `${entry.message}\n` });
    }
    // A file that fails to load has no tests.
    if (fileResult.testExecError || (fileResult.failureMessage && fileResult.testResults.length === 0)) {
      const text = plain(fileResult.failureMessage ?? fileResult.testExecError.message ?? "");
      message("testFailed", { nodeId: fileId, message: text.split("\n")[0], details: text });
    }
    message("testSuiteFinished", { nodeId: fileId });
  }
}

module.exports = OpenIdeaReporter;
