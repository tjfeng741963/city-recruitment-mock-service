import { forwardRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { FieldShell, describedByFor, type FieldStatus } from "./Field";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  id: string;
  label?: ReactNode;
  helperText?: ReactNode;
  error?: string;
  success?: string;
  loading?: boolean;
  required?: boolean;
  className?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { id, label, helperText, error, success, loading, required, disabled, className, ...rest },
  ref,
) {
  const status: FieldStatus = error ? "error" : success ? "success" : loading ? "loading" : "default";

  return (
    <FieldShell id={id} label={label} required={required} helperText={helperText} error={error} success={success} disabled={disabled}>
      <div className="ui-input-wrap" data-status={status}>
        <input
          ref={ref}
          id={id}
          className={`ui-input ${className ?? ""}`}
          disabled={disabled || loading}
          aria-invalid={status === "error" || undefined}
          aria-describedby={describedByFor(id, status, Boolean(helperText))}
          required={required}
          {...rest}
        />
        {loading && <span className="ui-input-spinner" aria-hidden="true" />}
      </div>
    </FieldShell>
  );
});
