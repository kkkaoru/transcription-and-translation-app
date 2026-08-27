// This file runs with bun.
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class {} }));

import { commandSucceeded, criuCheckSucceeded } from "./criu-poc";

describe("CRIU capability probe", () => {
  it("accepts a successful criu check", () => {
    expect(
      criuCheckSucceeded([
        {
          name: "criu-check-all",
          argv: ["criu", "check", "--all"],
          exitCode: 0,
          stdout: "Looks good.",
          stderr: "",
        },
      ]),
    ).toBe(true);
  });

  it("rejects a failed criu check", () => {
    expect(
      criuCheckSucceeded([
        {
          name: "criu-check-all",
          argv: ["criu", "check", "--all"],
          exitCode: 1,
          stdout: "",
          stderr: "Error: PTRACE_O_SUSPEND_SECCOMP is not supported",
        },
      ]),
    ).toBe(false);
  });

  it("accepts a successful same-instance restore", () => {
    expect(
      commandSucceeded(
        [
          {
            name: "same-instance-sleep-dump-restore",
            argv: ["/bin/sh", "-c", "..."],
            exitCode: 0,
            stdout: "restored_command=sleep 600",
            stderr: "",
          },
        ],
        "same-instance-sleep-dump-restore",
      ),
    ).toBe(true);
  });

  it("rejects a report without criu check output", () => {
    expect(
      criuCheckSucceeded([
        {
          name: "kernel",
          argv: ["uname", "-a"],
          exitCode: 0,
          stdout: "Linux",
          stderr: "",
        },
      ]),
    ).toBe(false);
  });
});
