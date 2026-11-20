import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn((_config: unknown, _channel: unknown) =>
    Promise.resolve({
      status: "ok" as const,
      data: { id: 7, configId: "pytest", name: "pytest", pid: 1, running: true, pty: false },
    }),
  ),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import type { OutputChunk, RunConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { resetRuns, runtime, startRun } from "./store";

const pytest: RunConfig = {
  id: "pytest",
  name: "pytest",
  kind: "pytest",
  command: "pytest",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
};

const channel = () => ipc.runStart.mock.calls.at(-1)![1] as { onmessage: (m: OutputChunk) => void };

beforeEach(() => {
  resetRuns();
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify: () => undefined });
});

describe("a reporter writing on stderr (pytest's plugin)", () => {
  it("feeds the test tree and keeps its messages out of the console", async () => {
    const session = (await startRun(pytest))!;
    channel().onmessage({
      kind: "stderr",
      text: [
        "##teamcity[testSuiteStarted name='test_a.py' nodeId='test_a.py' parentNodeId='0' locationHint='file:///p/test_a.py']",
        "a warning from the code",
        "##teamcity[testStarted name='test_adds' nodeId='test_a.py::test_adds' parentNodeId='test_a.py' locationHint='file:///p/test_a.py:3']",
        "##teamcity[testFinished nodeId='test_a.py::test_adds' duration='2']",
        "",
      ].join("\n"),
    });
    channel().onmessage({ kind: "stdout", text: "test_a.py::test_adds PASSED [100%]\n" });
    const rt = runtime(session.id)!;
    await vi.waitFor(() => expect(rt.tests?.get("test_a.py\u0000test_adds")?.own).toBe("passed"));
    expect(rt.tests!.get("test_a.py\u0000test_adds")!.location).toMatchObject({ path: "/p/test_a.py", line: 3 });
    const text = rt.console.lines.map((l) => l.text).join("\n");
    expect(text).toContain("a warning from the code");
    expect(text).toContain("test_a.py::test_adds PASSED");
    expect(text).not.toContain("##teamcity");
  });
});
