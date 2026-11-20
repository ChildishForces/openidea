// OpenIDEA's Vitest reporter (Vitest 3+ reporter API): reports each test file, suite and test to the IDE
// as TeamCity service messages on stdout. The IDE builds its test tree from them and hides them from the
// console; Vitest's own reporter still prints the run as usual. Older Vitest versions call none of these
// hooks, and the IDE reads their console output instead.

const ESCAPES = { "|": "||", "'": "|'", "[": "|[", "]": "|]", "\n": "|n", "\r": "|r" };
const escape = (value) => String(value).replace(/[|'[\]\n\r]/g, (c) => ESCAPES[c]);

function message(kind, attrs) {
  let body = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) body += ` ${key}='${escape(value)}'`;
  }
  process.stdout.write(`##teamcity[${kind}${body}]\n`);
}

export default class OpenIdeaReporter {
  /** Reported and not finished yet. */
  started = new Set();
  /** Every task reported in this run, for routing console output. */
  known = new Set();
  pattern = undefined;

  onInit(vitest) {
    this.pattern = vitest.config?.testNamePattern;
  }

  /** `-t` matches a test's suite names and its own, joined with spaces. */
  filteredOut(test) {
    if (!this.pattern) return false;
    const names = [];
    for (let task = test; task && task.type !== "module"; task = task.parent) names.unshift(task.name);
    this.pattern.lastIndex = 0;
    return !this.pattern.test(names.join(" "));
  }

  location(task) {
    const file = task.type === "module" ? task.moduleId : task.module.moduleId;
    return `file://${file}${task.location ? `:${task.location.line}:${task.location.column}` : ""}`;
  }

  /** Reports `task` and the suites around it, once each. */
  open(task) {
    if (this.started.has(task.id)) return;
    if (task.type !== "module") this.open(task.parent);
    const attrs = {
      name: task.type === "module" ? task.relativeModuleId : task.name,
      nodeId: task.id,
      parentNodeId: task.type === "module" ? "0" : task.parent.id,
      locationHint: this.location(task),
    };
    message(task.type === "test" ? "testStarted" : "testSuiteStarted", attrs);
    this.started.add(task.id);
    this.known.add(task.id);
  }

  close(task) {
    if (this.started.delete(task.id)) message("testSuiteFinished", { nodeId: task.id });
  }

  /** Tests a name filter (`-t`) left out: the tree shows only the tests the run selected. */
  hidden(test) {
    return test.options.mode === "skip" && this.filteredOut(test);
  }

  // Every node is reported once its file is collected: console output arrives before a test's result.
  onTestModuleCollected(module) {
    for (const test of module.children.allTests()) {
      if (!this.hidden(test)) this.open(test);
    }
  }

  onTestCaseResult(test) {
    const result = test.result();
    if (!this.started.has(test.id) && this.hidden(test)) return;
    this.open(test);
    const duration = Math.round(test.diagnostic()?.duration ?? 0);
    if (result.state === "failed") {
      for (const error of result.errors ?? []) {
        message("testFailed", {
          nodeId: test.id,
          message: error.message ?? String(error),
          details: error.stack,
          expected: error.expected,
          actual: error.actual,
        });
      }
    } else if (result.state === "skipped") {
      message("testIgnored", { nodeId: test.id, message: result.note });
    }
    message("testFinished", { nodeId: test.id, duration });
    this.started.delete(test.id);
  }

  onTestSuiteResult(suite) {
    this.close(suite);
  }

  onTestModuleEnd(module) {
    // A file that fails to load or collect has errors but no tests.
    const errors = module.errors?.() ?? [];
    if (errors.length) {
      this.open(module);
      for (const error of errors) {
        message("testFailed", { nodeId: module.id, message: error.message ?? String(error), details: error.stack });
      }
    }
    this.close(module);
  }

  onUserConsoleLog(log) {
    if (!log.taskId || !this.known.has(log.taskId)) return;
    message(log.type === "stderr" ? "testStdErr" : "testStdOut", { nodeId: log.taskId, out: log.content });
  }
}
