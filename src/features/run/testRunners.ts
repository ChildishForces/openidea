/** The test frameworks a test configuration can name (`RunConfig.testRunner`), loaded once from the backend. */
import { useEffect } from "react";
import { create } from "zustand";
import type { TestRunnerInfo } from "@/bindings";
import { call, commands, isTauri, type RunConfig } from "@/platform/ipc";

const useTestRunnerList = create<{ runners: TestRunnerInfo[] }>(() => ({ runners: [] }));
let loading: Promise<void> | null = null;

function loadTestRunners(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  loading ??= Promise.resolve()
    .then(() => call(commands.runTestRunners()))
    .then((runners) => useTestRunnerList.setState({ runners }))
    .catch(() => {
      loading = null;
    });
  return loading;
}

/** The runners that can run tests through a configuration of `kind`. */
export function runnersFor(runners: readonly TestRunnerInfo[], kind: string): TestRunnerInfo[] {
  return runners.filter((r) => r.configKinds.includes(kind));
}

/** The runner `config` names, if the IDE knows it. */
export function configRunner(runners: readonly TestRunnerInfo[], config: RunConfig): TestRunnerInfo | undefined {
  return config.testRunner ? runners.find((r) => r.id === config.testRunner) : undefined;
}

/** The known runners, loading them the first time a test configuration needs them. */
export function useTestRunners(needed: boolean): TestRunnerInfo[] {
  const runners = useTestRunnerList((s) => s.runners);
  useEffect(() => {
    if (needed) void loadTestRunners();
  }, [needed]);
  return runners;
}
