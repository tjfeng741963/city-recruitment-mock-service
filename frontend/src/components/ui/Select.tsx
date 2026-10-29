import { forwardRef } from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { FieldShell, describedByFor, type FieldStatus } from "./Field";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "id"> {
  id: string;
  label?: ReactNode;
  helperText?: ReactNode;
  error?: string;
  success?: string;
  required?: boolean;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id, label, helperText, error, success, required, disabled, options, placeholder, className, ...rest },
  ref,
) {
  const status: FieldStatus = error ? "error" : success ? "success" : "default";

  return (
    <FieldShell id={id} label={label} required={required} helperText={helperText} error={error} success={success} disabled={disabled}>
      <div className="ui-select-wrap" data-status={status}>
        <select
          ref={ref}
          id={id}
          className={`ui-select ${className ?? ""}`}
          disabled={disabled}
          aria-invalid={status === "error" || undefined}
          aria-describedby={describedByFor(id, status, Boolean(helperText))}
          required={required}
          defaultValue={rest.value === undefined ? (rest.defaultValue ?? (placeholder ? "" : undefined)) : undefined}
          {...rest}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="ui-select-caret" aria-hidden="true" />
      </div>
    </FieldShell>
  );
});
