import { describe, expect, it } from "vitest";

import {
  buildAudioDeviceOptions,
  isLoopbackHost,
} from "../src/lib/audio-devices";
import type { AudioDeviceInfo } from "../src/lib/types";

const device = (
  host: string,
  id: string,
  display_name = id,
): AudioDeviceInfo => ({
  id,
  host,
  display_name,
  channels: 1,
  sample_rate: 48000,
});

describe("isLoopbackHost", () => {
  it("detects the loopback suffix", () => {
    expect(isLoopbackHost("CoreAudio (Loopback)")).toBe(true);
    expect(isLoopbackHost("CoreAudio")).toBe(false);
  });
});

describe("buildAudioDeviceOptions", () => {
  it("groups by preferred host order, then sorted unknown hosts", () => {
    const groups = buildAudioDeviceOptions([
      device("Wasapi", "a"),
      device("Zebra", "d"),
      device("CoreAudio", "b"),
      device("Null", "c"),
      device("Alpha", "e"),
    ]);
    expect(groups.map((g) => g.group)).toEqual([
      "Wasapi",
      "CoreAudio",
      "Null",
      "Alpha",
      "Zebra",
    ]);
  });

  it("collapses loopback devices into a single custom-named group", () => {
    const groups = buildAudioDeviceOptions(
      [
        device("CoreAudio (Loopback)", "l1", "System Audio"),
        device("CoreAudio (Loopback)", "l2", "System Audio 2"),
      ],
      "System Audio",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.group).toBe("System Audio");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "CoreAudio (Loopback)\u0000l1",
      "CoreAudio (Loopback)\u0000l2",
    ]);
  });

  it("uses the default group label when no loopback label is supplied", () => {
    const groups = buildAudioDeviceOptions([device("Null (Loopback)", "l")]);
    expect(groups[0]?.group).toBe("Loopback");
  });

  it("returns an empty list when there are no devices", () => {
    expect(buildAudioDeviceOptions([])).toEqual([]);
  });
});
