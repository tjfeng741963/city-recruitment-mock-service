import { forwardRef } from "react";
import type { ReactNode, TextareaHTMLAttributes } from "react";
import { FieldShell, describedByFor, type FieldStatus } from "./Field";

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "id"> {
  id: string;
  label?: ReactNode;
  helperText?: ReactNode;
  error?: string;
  success?: string;
  required?: boolean;
  className?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { id, label, helperText, error, success, required, disabled, rows = 4, className, ...rest },
  ref,
) {
  const status: FieldStatus = error ? "error" : success ? "success" : "default";

  return (
    <FieldShell id={id} label={label} required={required} helperText={helperText} error={error} success={success} disabled={disabled}>
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        className={`ui-textarea ${className ?? ""}`}
        disabled={disabled}
        aria-invalid={status === "error" || undefined}
        aria-describedby={describedByFor(id, status, Boolean(helperText))}
        required={required}
        {...rest}
      />
    </FieldShell>
  );
});
