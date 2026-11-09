import { forwardRef, useId, useState } from "react";
import type { CSSProperties, InputHTMLAttributes, ReactNode } from "react";

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "id"> {
  id?: string;
  label?: ReactNode;
  valueLabel?: ReactNode;
  className?: string;
}

function fillPercent(value: unknown, min: unknown, max: unknown): string {
  const lo = Number(min ?? 0);
  const hi = Number(max ?? 100);
  const v = Number(value ?? (lo + hi) / 2);
  if (!Number.isFinite(v) || hi <= lo) return "0%";
  return `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100))}%`;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { id, label, valueLabel, disabled, className, style, onChange, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const [uncontrolled, setUncontrolled] = useState(rest.defaultValue);
  const fill = fillPercent(rest.value ?? uncontrolled, rest.min, rest.max);

  return (
    <div className={`ui-slider ${disabled ? "is-disabled" : ""} ${className ?? ""}`}>
      {(label || valueLabel) && (
        <div className="ui-slider-head">
          {label && (
            <label htmlFor={fieldId} className="ui-slider-label">
              {label}
            </label>
          )}
          {valueLabel && (
            <span className="ui-slider-value" aria-hidden="true">
              {valueLabel}
            </span>
          )}
        </div>
      )}
      <input
        ref={ref}
        id={fieldId}
        type="range"
        className="ui-slider-input"
        disabled={disabled}
        style={{ ...style, "--fill": fill } as CSSProperties}
        onChange={(e) => {
          if (rest.value === undefined) setUncontrolled(e.target.value);
          onChange?.(e);
        }}
        {...rest}
      />
    </div>
  );
});
