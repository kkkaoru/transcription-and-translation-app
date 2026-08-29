// Runs in the browser; built and tested with Bun.
import type { MicrophoneConfiguration, VadConfiguration } from "./model";

interface CaptureControlsProps {
  microphone: MicrophoneConfiguration;
  vad: VadConfiguration;
  devices: readonly MediaDeviceInfo[];
  disabled: boolean;
  onMicrophoneChange: (configuration: MicrophoneConfiguration) => void;
  onVadChange: (configuration: VadConfiguration) => void;
}

interface BooleanControl {
  key:
    | "echoCancellation"
    | "noiseSuppression"
    | "autoGainControl"
    | "voiceIsolation"
    | "suppressLocalAudioPlayback"
    | "restrictOwnAudio";
  label: string;
}

interface NumberControl {
  key: "channelCount" | "sampleRate" | "sampleSize" | "latency" | "volume";
  label: string;
  min: number;
  max: number;
  step: number;
}

interface VadNumberControl {
  key:
    | "positiveSpeechThreshold"
    | "negativeSpeechThreshold"
    | "redemptionMs"
    | "preSpeechPadMs"
    | "minSpeechMs";
  label: string;
  min: number;
  max: number;
  step: number;
}

const BOOLEAN_CONTROLS: readonly BooleanControl[] = [
  { key: "echoCancellation", label: "エコーキャンセル" },
  { key: "noiseSuppression", label: "ノイズ抑制" },
  { key: "autoGainControl", label: "自動ゲイン調整" },
  { key: "voiceIsolation", label: "音声分離" },
  { key: "suppressLocalAudioPlayback", label: "ローカル再生抑制" },
  { key: "restrictOwnAudio", label: "自タブ音声除外" },
] satisfies readonly BooleanControl[];
const NUMBER_CONTROLS: readonly NumberControl[] = [
  { key: "channelCount", label: "チャンネル数", min: 1, max: 8, step: 1 },
  { key: "sampleRate", label: "入力sample rate", min: 8_000, max: 192_000, step: 1_000 },
  { key: "sampleSize", label: "sample bit数", min: 8, max: 32, step: 1 },
  { key: "latency", label: "latency秒", min: 0, max: 2, step: 0.001 },
  { key: "volume", label: "入力volume", min: 0, max: 1, step: 0.01 },
] satisfies readonly NumberControl[];
const VAD_CONTROLS: readonly VadNumberControl[] = [
  { key: "positiveSpeechThreshold", label: "発話開始threshold", min: 0.01, max: 0.99, step: 0.01 },
  { key: "negativeSpeechThreshold", label: "発話終了threshold", min: 0.01, max: 0.99, step: 0.01 },
  { key: "redemptionMs", label: "終了猶予ms", min: 0, max: 5_000, step: 10 },
  { key: "preSpeechPadMs", label: "先頭padding ms", min: 0, max: 2_000, step: 10 },
  { key: "minSpeechMs", label: "最短発話ms", min: 32, max: 5_000, step: 10 },
] satisfies readonly VadNumberControl[];

const triState = (value: string): "default" | "enabled" | "disabled" =>
  value === "enabled" ? "enabled" : value === "disabled" ? "disabled" : "default";
const optionalNumber = (value: string): number | null => (value === "" ? null : Number(value));
const deviceConfiguration = (
  microphone: MicrophoneConfiguration,
  devices: readonly MediaDeviceInfo[],
  deviceId: string,
): MicrophoneConfiguration => ({
  ...microphone,
  deviceId,
  deviceLabel: devices.find((device) => device.deviceId === deviceId)?.label || "Browser default",
  groupId: devices.find((device) => device.deviceId === deviceId)?.groupId ?? "",
});
const processorPreference = (value: string): VadConfiguration["processorPreference"] => {
  if (value === "script-processor") {
    return "script-processor";
  }
  return value === "audio-worklet" ? "audio-worklet" : "auto";
};

export function CaptureControls({
  microphone,
  vad,
  devices,
  disabled,
  onMicrophoneChange,
  onVadChange,
}: CaptureControlsProps) {
  return (
    <details className="capture-controls" open>
      <summary>マイク入力・Silero VADパラメーター</summary>
      <p className="hint">
        ブラウザが対応する全設定について、要求値と実際に適用されたsettings/capabilitiesを音声ごとに保存します。
      </p>
      <div className="parameter-grid">
        <label>
          入力デバイス
          <select
            value={microphone.deviceId}
            disabled={disabled}
            onChange={(event) =>
              onMicrophoneChange(
                deviceConfiguration(microphone, devices, event.currentTarget.value),
              )
            }
          >
            <option value="">ブラウザ既定</option>
            {devices.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `マイク ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        {BOOLEAN_CONTROLS.map((control) => (
          <label key={control.key}>
            {control.label}
            <select
              value={microphone[control.key]}
              disabled={disabled}
              onChange={(event) =>
                onMicrophoneChange({
                  ...microphone,
                  [control.key]: triState(event.currentTarget.value),
                })
              }
            >
              <option value="default">ブラウザ既定</option>
              <option value="enabled">ON</option>
              <option value="disabled">OFF</option>
            </select>
          </label>
        ))}
        {NUMBER_CONTROLS.map((control) => (
          <label key={control.key}>
            {control.label}
            <input
              type="number"
              value={microphone[control.key] ?? ""}
              min={control.min}
              max={control.max}
              step={control.step}
              disabled={disabled}
              placeholder="既定"
              onChange={(event) =>
                onMicrophoneChange({
                  ...microphone,
                  [control.key]: optionalNumber(event.currentTarget.value),
                })
              }
            />
          </label>
        ))}
      </div>
      <div className="parameter-grid vad-parameters">
        {VAD_CONTROLS.map((control) => (
          <label key={control.key}>
            {control.label}
            <input
              type="number"
              value={vad[control.key]}
              min={control.min}
              max={control.max}
              step={control.step}
              disabled={disabled}
              onChange={(event) =>
                onVadChange({ ...vad, [control.key]: Number(event.currentTarget.value) })
              }
            />
          </label>
        ))}
        <label>
          音声processor
          <select
            value={vad.processorPreference}
            disabled={disabled}
            onChange={(event) =>
              onVadChange({
                ...vad,
                processorPreference: processorPreference(event.currentTarget.value),
              })
            }
          >
            <option value="auto">自動（AudioWorklet優先）</option>
            <option value="audio-worklet">AudioWorklet強制</option>
            <option value="script-processor">ScriptProcessor比較</option>
          </select>
        </label>
      </div>
    </details>
  );
}
