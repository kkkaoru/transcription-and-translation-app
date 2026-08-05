import { describe, expect, it } from "vitest";

import {
  buildAsrThreadOptions,
  buildNoiseCancellationModelOptions,
  buildRetentionModeOptions,
  buildTurnDetectorOptions,
} from "../src/lib/settings-options";

const t = (key: string) => `[${key}]`;

describe("settings option builders", () => {
  it("builds retention mode options", () => {
    expect(buildRetentionModeOptions(t)).toEqual([
      { label: "[options.retention.limited]", value: "limited" },
      { label: "[options.retention.unlimited]", value: "unlimited" },
    ]);
  });

  it("builds asr thread options", () => {
    expect(buildAsrThreadOptions(t)).toEqual([
      { label: "1", value: "1" },
      { label: "4", value: "4" },
      { label: "[settings.asrThreads.max]", value: "0" },
    ]);
  });

  it("builds turn detector options", () => {
    expect(buildTurnDetectorOptions(t)).toEqual([
      { label: "[options.turnDetector.simple]", value: "simple" },
      { label: "[options.turnDetector.morph]", value: "morph" },
      { label: "[options.turnDetector.namo]", value: "namo" },
    ]);
  });

  it("builds noise cancellation model options", () => {
    expect(buildNoiseCancellationModelOptions(t)).toEqual([
      {
        label: "[options.noiseCancellationModel.ulUnas]",
        value: "ul_unas",
      },
    ]);
  });
});
