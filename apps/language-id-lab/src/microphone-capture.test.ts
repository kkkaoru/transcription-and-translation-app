// Runs with Bun during test.
import { expect, it } from "vitest";
import { normalizedAudioLevel } from "./microphone-capture";

it("normalizes silence and audible RMS for the microphone meter", () => {
  expect(normalizedAudioLevel(new Float32Array([0, 0, 0, 0]))).toBe(0);
  expect(normalizedAudioLevel(new Float32Array([0.18, -0.18]))).toBe(1);
  expect(normalizedAudioLevel(new Float32Array([0.09, -0.09]))).toBeCloseTo(0.5);
});
