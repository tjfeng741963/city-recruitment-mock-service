import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "tinted" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, disabled, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      className={`ui-btn ui-btn-${variant} ui-btn-${size} ${className ?? ""}`}
      disabled={disabled || loading}
      aria-disabled={disabled || loading || undefined}
      data-state={loading ? "loading" : undefined}
      {...rest}
    >
      {loading && <span className="ui-btn-spinner" aria-hidden="true" />}
      {icon && !loading && (
        <span className="ui-btn-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-btn-label">{children}</span>
    </button>
  );
});
