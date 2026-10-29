import { forwardRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "id"> {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { id, label, description, disabled, className, ...rest },
  ref,
) {
  return (
    <div className={`ui-checkbox ${disabled ? "is-disabled" : ""} ${className ?? ""}`}>
      <input ref={ref} id={id} type="checkbox" className="ui-checkbox-input" disabled={disabled} {...rest} />
      <span className="ui-checkbox-box" aria-hidden="true">
        <svg viewBox="0 0 16 16" className="ui-checkbox-check">
          <path d="M3 8.5 6.2 11.5 13 4.5" />
        </svg>
      </span>
      <label htmlFor={id} className="ui-checkbox-label">
        <span>{label}</span>
        {description && <span className="ui-checkbox-desc">{description}</span>}
      </label>
    </div>
  );
});
