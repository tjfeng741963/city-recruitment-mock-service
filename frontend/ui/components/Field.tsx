import type { ReactNode } from "react";

export type FieldStatus = "default" | "loading" | "error" | "success";

export function describedByFor(id: string, status: FieldStatus, hasHelper: boolean): string | undefined {
  if (status === "error") return `${id}-error`;
  if (status === "success") return `${id}-success`;
  if (hasHelper) return `${id}-helper`;
  return undefined;
}

export interface FieldShellProps {
  id: string;
  label?: ReactNode;
  required?: boolean;
  helperText?: ReactNode;
  error?: string;
  success?: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function FieldShell({
  id,
  label,
  required,
  helperText,
  error,
  success,
  disabled,
  className,
  children,
}: FieldShellProps) {
  const status: FieldStatus = error ? "error" : success ? "success" : "default";
  const messageId = describedByFor(id, status, Boolean(helperText));

  return (
    <div className={`ui-field ${disabled ? "is-disabled" : ""} ${className ?? ""}`} data-status={status}>
      {label && (
        <label className="ui-field-label" htmlFor={id}>
          {label}
          {required && <span className="ui-field-required">*</span>}
        </label>
      )}
      {children}
      <div className="ui-field-message" id={messageId}>
        {error ? (
          <span className="ui-field-error" role="alert">
            {error}
          </span>
        ) : success ? (
          <span className="ui-field-success">{success}</span>
        ) : helperText ? (
          <span className="ui-field-hint">{helperText}</span>
        ) : null}
      </div>
    </div>
  );
}
