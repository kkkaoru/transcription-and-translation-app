/** Number input paired with a range slider for the same bound value. */
export const NumberSliderField = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  testId?: string;
}) => {
  const safe = Number.isFinite(value) ? value : min;
  return (
    <label className="field compact number-slider-field">
      <span>{label}</span>
      <div className="number-slider-controls">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={safe}
          data-testid={testId ? `${testId}-slider` : undefined}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={safe}
          data-testid={testId}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
      </div>
    </label>
  );
};
