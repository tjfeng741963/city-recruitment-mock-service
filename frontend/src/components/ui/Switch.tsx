import { forwardRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "id"> {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { id, label, description, disabled, className, ...rest },
  ref,
) {
  return (
    <div className={`ui-switch ${disabled ? "is-disabled" : ""} ${className ?? ""}`}>
      <label htmlFor={id} className="ui-switch-label">
        <span>{label}</span>
        {description && <span className="ui-switch-desc">{description}</span>}
      </label>
      <span className="ui-switch-track">
        <input ref={ref} id={id} type="checkbox" role="switch" className="ui-switch-input" disabled={disabled} {...rest} />
        <span className="ui-switch-thumb" aria-hidden="true" />
      </span>
    </div>
  );
});
