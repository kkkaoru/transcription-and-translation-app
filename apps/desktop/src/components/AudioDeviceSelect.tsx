import type { ChangeEventHandler } from "react";
import type { AudioInputDevice } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";

export const AudioDeviceSelect = ({
  devices,
  value,
  onChange,
}: {
  devices: AudioInputDevice[];
  value: string;
  onChange: ChangeEventHandler<HTMLSelectElement>;
}) => {
  const { t } = useI18n();
  const inputs = devices.filter((device) => device.deviceId && device.deviceId !== "default");
  // Keep a stale saved deviceId selectable until the user picks another entry.
  // Without this, React warns and the control may snap to the first option.
  const orphanSelected =
    Boolean(value) && value !== "default" && !inputs.some((device) => device.deviceId === value);

  return (
    <select value={value || "default"} onChange={onChange}>
      <option value="default">{t("audio.defaultDevice")}</option>
      {orphanSelected ? (
        <option value={value}>
          {t("audio.fallbackDevice", { number: "…" })} ({value.slice(0, 12)})
        </option>
      ) : null}
      {inputs.map((device, index) => (
        <option key={device.deviceId} value={device.deviceId}>
          {device.label || t("audio.fallbackDevice", { number: index + 1 })}
        </option>
      ))}
    </select>
  );
};
