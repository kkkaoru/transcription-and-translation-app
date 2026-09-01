// Runs with Bun during test.
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
}));

import {
  fetchContainerBeforeDeadline,
  parseLanguageRoute,
  validSessionId,
} from "./container-backend";

beforeEach(() => {
  vi.clearAllMocks();
});

it("parses model-specific Basic and Standard Container operations", () => {
  expect(parseLanguageRoute("/api/language/speechbrain-ecapa-basic/infer")).toStrictEqual({
    method: "speechbrain-ecapa-basic",
    tier: "basic",
    operation: "infer",
  });
  expect(parseLanguageRoute("/api/language/nvidia-ambernet-standard/release")).toStrictEqual({
    method: "nvidia-ambernet-standard",
    tier: "standard",
    operation: "release",
  });
  expect(parseLanguageRoute("/api/language/premium/infer")).toBeUndefined();
  expect(parseLanguageRoute("/api/language/speechbrain-ecapa-basic/unknown")).toBeUndefined();
});

it("accepts only bounded URL-safe session identifiers", () => {
  expect(validSessionId("abCD_12-test")).toBe(true);
  expect(validSessionId(null)).toBe(false);
  expect(validSessionId("")).toBe(false);
  expect(validSessionId("bad/session")).toBe(false);
  expect(validSessionId("x".repeat(65))).toBe(false);
});

it("returns a successful Container response before the deadline", async () => {
  const destroy = vi.fn(() => Promise.resolve());
  const startAndWaitForPorts = vi.fn(() => Promise.resolve());
  const response = await fetchContainerBeforeDeadline({
    container: {
      startAndWaitForPorts,
      fetch: vi.fn(() => Promise.resolve(new Response("ok"))),
      destroy,
    },
    request: new Request("https://container.test/infer"),
    operation: "infer",
    deadline: new Promise(() => undefined),
  });

  expect(await response.text()).toBe("ok");
  expect(startAndWaitForPorts).toHaveBeenCalledTimes(1);
  expect(destroy).not.toHaveBeenCalled();
});

it("destroys a timed-out or failed Container", async () => {
  const timeoutDestroy = vi.fn(() => Promise.resolve());
  await expect(
    fetchContainerBeforeDeadline({
      container: {
        startAndWaitForPorts: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(() => new Promise<Response>(() => undefined)),
        destroy: timeoutDestroy,
      },
      request: new Request("https://container.test/infer"),
      operation: "infer",
      deadline: Promise.resolve(),
    }),
  ).rejects.toThrow("Language ID Container exceeded 90000 ms");
  expect(timeoutDestroy).toHaveBeenCalledTimes(1);

  const failureDestroy = vi.fn(() => Promise.resolve());
  await expect(
    fetchContainerBeforeDeadline({
      container: {
        startAndWaitForPorts: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(() => Promise.resolve(new Response("failed", { status: 503 }))),
        destroy: failureDestroy,
      },
      request: new Request("https://container.test/infer"),
      operation: "infer",
      deadline: new Promise(() => undefined),
    }),
  ).rejects.toThrow("Language ID Container returned 503");
  expect(failureDestroy).toHaveBeenCalledTimes(1);
});
