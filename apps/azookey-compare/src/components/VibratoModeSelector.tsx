import { type ComparisonMode, comparisonModeOptions, isComparisonMode } from "../lib/contract";

export interface VibratoModeSelectorProps {
  mode: ComparisonMode;
  onModeChange: (mode: ComparisonMode) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  className?: string;
}

/**
 * Small controlled selector shared by the comparison page and future embeds.
 * The option descriptions intentionally remain visible below the select so a
 * mode change explains which side of the Worker/browser boundary is active.
 */
export const VibratoModeSelector = ({
  mode,
  onModeChange,
  disabled = false,
  id = "vibrato-mode",
  name = "mode",
  label = "Recognition mode",
  description,
  className,
}: VibratoModeSelectorProps) => {
  const selectedOption = comparisonModeOptions.find((option) => option.value === mode);
  const helpText = description ?? selectedOption?.description ?? "Choose a Vibrato endpoint.";

  return (
    <div className={className} data-testid="vibrato-mode-control">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        name={name}
        value={mode}
        onChange={(event) => {
          const nextMode = event.target.value;
          if (isComparisonMode(nextMode)) {
            onModeChange(nextMode);
          }
        }}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        data-testid="vibrato-mode-select"
      >
        {comparisonModeOptions.map((option) => (
          <option key={option.value} value={option.value} title={option.description}>
            {option.label}
          </option>
        ))}
      </select>
      <p id={`${id}-description`} data-testid="vibrato-mode-description" aria-live="polite">
        {helpText}
      </p>
    </div>
  );
};
