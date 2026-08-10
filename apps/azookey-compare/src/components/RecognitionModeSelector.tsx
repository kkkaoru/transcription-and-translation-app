import {
  type RecognitionProvider,
  isRecognitionProvider,
  recognitionProviderOptions,
} from "../lib/contract";

export interface RecognitionModeSelectorProps {
  provider: RecognitionProvider;
  onProviderChange: (provider: RecognitionProvider) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  className?: string;
}

export const RecognitionModeSelector = ({
  provider,
  onProviderChange,
  disabled = false,
  id = "recognition-provider",
  name = "recognitionProvider",
  label = "音声認識",
  description,
  className,
}: RecognitionModeSelectorProps) => {
  const selectedOption = recognitionProviderOptions.find((option) => option.value === provider);
  const helpText =
    description ??
    selectedOption?.description ??
    "Web Speech か Workers AI Nova-3 ASR を選択します。";

  return (
    <div className={className} data-testid="recognition-mode-control">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        name={name}
        value={provider}
        onChange={(event) => {
          const next = event.target.value;
          if (isRecognitionProvider(next)) {
            onProviderChange(next);
          }
        }}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        data-testid="recognition-mode-select"
      >
        {recognitionProviderOptions.map((option) => (
          <option key={option.value} value={option.value} title={option.description}>
            {option.label}
          </option>
        ))}
      </select>
      <p id={`${id}-description`} data-testid="recognition-mode-description" aria-live="polite">
        {helpText}
      </p>
    </div>
  );
};
