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
  return (
    <select value={value} onChange={onChange}>
      <option value="default">{t("audio.defaultDevice")}</option>
      {devices
        .filter((device) => device.deviceId !== "default")
        .map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || t("audio.fallbackDevice", { number: index + 1 })}
          </option>
        ))}
    </select>
  );
};
