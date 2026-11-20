"""OpenIDEA's pytest plugin: reports each test file, class and test to the IDE as TeamCity service
messages, live: every collected test when collection ends, then each one as it runs and finishes. The IDE
builds its test tree from them and hides them from the console; pytest's own report prints as usual.

The messages go to stderr, which pytest's terminal report doesn't use (its verbose lines are written in
two parts, around the test), through a copy of the descriptor made before pytest captures output.
"""

import os

_OUT = os.fdopen(os.dup(2), "w", buffering=1, encoding="utf-8", errors="replace")
_ESCAPES = {"|": "||", "'": "|'", "[": "|[", "]": "|]", "\n": "|n", "\r": "|r"}


def _escape(value):
    return "".join(_ESCAPES.get(c, c) for c in str(value))


def _message(kind, **attrs):
    body = "".join(f" {key}='{_escape(value)}'" for key, value in attrs.items() if value is not None)
    _OUT.write(f"##teamcity[{kind}{body}]\n")


class _Reporter:
    def __init__(self, config):
        self.root = str(config.rootpath)
        self.opened = set()
        self.finished = set()
        self.locations = {}

    def _location(self, path, line=None):
        path = path if os.path.isabs(path) else os.path.join(self.root, path)
        return f"file://{path}" + (f":{line + 1}" if line is not None else "")

    def open(self, nodeid, location=None):
        """Reports the test (and the file and classes around it, once each)."""
        if nodeid in self.opened:
            return
        parts = nodeid.split("::")
        file = parts[0]
        for i in range(1, len(parts)):
            suite = "::".join(parts[:i])
            if suite in self.opened:
                continue
            self.opened.add(suite)
            _message(
                "testSuiteStarted",
                name=parts[i - 1],
                nodeId=suite,
                parentNodeId="::".join(parts[: i - 1]) or "0",
                locationHint=self._location(file),
            )
        self.opened.add(nodeid)
        line = location[1] if location else None
        _message(
            "testStarted",
            name=parts[-1],
            nodeId=nodeid,
            parentNodeId="::".join(parts[:-1]) or "0",
            locationHint=self._location(location[0] if location else file, line),
        )

    def pytest_collection_finish(self, session):
        # The whole tree up front: each test then runs, then finishes, in it.
        for item in session.items:
            self.open(item.nodeid, item.location)

    def pytest_runtest_logstart(self, nodeid, location):
        self.open(nodeid, location)

    def pytest_runtest_logreport(self, report):
        nodeid = report.nodeid
        if report.failed and nodeid in self.finished:
            # A teardown that fails after the test passed: the test fails.
            _message("testFailed", nodeId=nodeid, message=f"Error in {report.when}", details=report.longreprtext)
            return
        if nodeid in self.finished:
            return
        self.open(nodeid, report.location)
        if report.failed:
            text = report.longreprtext or ""
            # pytest marks the failure's explanation `E   …`.
            explained = [line[1:].strip() for line in text.splitlines() if line.startswith("E ")]
            message = explained[0] if explained else f"Error in {report.when}"
            _message("testFailed", nodeId=nodeid, message=message, details=text)
        elif report.skipped:
            reason = report.longrepr[2] if isinstance(report.longrepr, tuple) else None
            _message("testIgnored", nodeId=nodeid, message=reason)
        elif report.when != "call":
            # Setup and teardown that pass don't end the test.
            return
        for name, out in (("testStdOut", report.capstdout), ("testStdErr", report.capstderr)):
            if out:
                _message(name, nodeId=nodeid, out=out)
        _message("testFinished", nodeId=nodeid, duration=round(report.duration * 1000))
        self.finished.add(nodeid)


def pytest_configure(config):
    config.pluginmanager.register(_Reporter(config), "openidea-reporter")
