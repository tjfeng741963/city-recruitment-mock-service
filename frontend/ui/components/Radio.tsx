import type { ReactNode } from "react";

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  name: string;
  legend?: ReactNode;
  options: RadioOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function RadioGroup({ name, legend, options, value, defaultValue, onChange, disabled, className }: RadioGroupProps) {
  return (
    <fieldset className={`ui-radio-group ${className ?? ""}`} disabled={disabled}>
      {legend && <legend className="ui-radio-legend">{legend}</legend>}
      {options.map((opt) => {
        const id = `${name}-${opt.value}`;
        return (
          <div className={`ui-radio ${disabled || opt.disabled ? "is-disabled" : ""}`} key={opt.value}>
            <input
              id={id}
              type="radio"
              name={name}
              value={opt.value}
              className="ui-radio-input"
              disabled={disabled || opt.disabled}
              checked={value !== undefined ? value === opt.value : undefined}
              defaultChecked={value === undefined ? defaultValue === opt.value : undefined}
              onChange={() => onChange?.(opt.value)}
            />
            <span className="ui-radio-dot" aria-hidden="true" />
            <label htmlFor={id} className="ui-radio-label">
              <span>{opt.label}</span>
              {opt.description && <span className="ui-radio-desc">{opt.description}</span>}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
