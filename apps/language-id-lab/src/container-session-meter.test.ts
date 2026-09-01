// Runs with Bun during test.
import { expect, it } from "vitest";
import {
  emptyContainerActivityMeter,
  estimatedContainerActiveMs,
  releaseContainerActivity,
  touchContainerActivity,
} from "./container-session-meter";

it("counts only active Container windows and caps idle time at thirty seconds", () => {
  const started = touchContainerActivity(emptyContainerActivityMeter(), 1_000);
  expect(estimatedContainerActiveMs(started, 6_000)).toBe(5_000);
  expect(estimatedContainerActiveMs(started, 60_000)).toBe(30_000);

  const restarted = touchContainerActivity(started, 60_000);
  expect(estimatedContainerActiveMs(restarted, 65_000)).toBe(35_000);
});

it("extends a live window and stops billing immediately on explicit release", () => {
  const started = touchContainerActivity(emptyContainerActivityMeter(), 1_000);
  const extended = touchContainerActivity(started, 20_000);
  expect(estimatedContainerActiveMs(extended, 45_000)).toBe(44_000);

  const released = releaseContainerActivity(extended, 25_000);
  expect(estimatedContainerActiveMs(released, 100_000)).toBe(24_000);
});
