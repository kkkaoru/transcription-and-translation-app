// Runs with Bun during test.
import { expect, it } from "vitest";
import { normalizedAudioLevel, setStreamEnabled } from "./microphone-capture";

it("normalizes silence and audible RMS for the microphone meter", () => {
  expect(normalizedAudioLevel(new Float32Array([0, 0, 0, 0]))).toBe(0);
  expect(normalizedAudioLevel(new Float32Array([0.18, -0.18]))).toBe(1);
  expect(normalizedAudioLevel(new Float32Array([0.09, -0.09]))).toBeCloseTo(0.5);
});

it("toggles every microphone audio track for VAD mute control", () => {
  const firstTrack = { enabled: true };
  const secondTrack = { enabled: true };
  const stream = { getAudioTracks: () => [firstTrack, secondTrack] };

  setStreamEnabled(stream, false);
  expect(firstTrack.enabled).toBe(false);
  expect(secondTrack.enabled).toBe(false);

  setStreamEnabled(stream, true);
  expect(firstTrack.enabled).toBe(true);
  expect(secondTrack.enabled).toBe(true);
});
