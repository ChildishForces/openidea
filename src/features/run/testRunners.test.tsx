import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const runners = vi.hoisted(() => [
  { id: "vitest", label: "Vitest", configKinds: ["npm", "bun", "deno"], testFiles: ["**/*.{test,spec}.ts"] },
  { id: "deno-test", label: "Deno test", configKinds: ["deno"], testFiles: ["**/*_test.ts"] },
]);
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, runTestRunners: () => Promise.resolve({ status: "ok", data: runners }) },
  };
});

import type { RunConfig } from "@/platform/ipc";
import { ConfigForm } from "./ConfigForm";

const npmTest = (extra: Partial<RunConfig> = {}): RunConfig => ({
  id: "npm:test",
  name: "npm run test",
  kind: "npm",
  command: "npm",
  args: ["run", "test"],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: "js-debug",
  ...extra,
});

afterEach(cleanup);

describe("Test runner fields", () => {
  it("show the configuration's runner and its default test files", async () => {
    render(
      <ConfigForm
        config={npmTest({ testRunner: "vitest" })}
        all={[]}
        type={undefined}
        errors={{}}
        onChange={vi.fn()}
        modifyRequest={0}
      />,
    );
    expect((await screen.findByRole("button", { name: "Test runner" })).textContent).toContain("Vitest");
    expect(screen.getByRole("textbox", { name: "Test files" }).getAttribute("placeholder")).toBe("**/*.{test,spec}.ts");
  });

  it("offer only the runners of the configuration's kind, and set the files it runs", async () => {
    const onChange = vi.fn();
    render(
      <ConfigForm config={npmTest()} all={[]} type={undefined} errors={{}} onChange={onChange} modifyRequest={0} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Test runner" }));
    expect(screen.getByRole("option", { name: "Vitest" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Deno test" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Test files" }), {
      target: { value: "src/**/*.int.test.ts; e2e/*.ts" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ testFiles: ["src/**/*.int.test.ts", "e2e/*.ts"] }),
    );
  });

  it("are not shown for configurations that run no tests", async () => {
    render(
      <ConfigForm
        config={npmTest({ isTest: false })}
        all={[]}
        type={undefined}
        errors={{}}
        onChange={vi.fn()}
        modifyRequest={0}
      />,
    );
    await screen.findByRole("button", { name: "Debug adapter" });
    expect(screen.queryByRole("button", { name: "Test runner" })).toBeNull();
  });
});
