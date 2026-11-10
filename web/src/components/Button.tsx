import type { ButtonHTMLAttributes } from "react";
import type { Needs } from "../access";
import { Gate } from "./Access";

export type ButtonVariant = "secondary" | "primary" | "ghost" | "danger" | "danger-solid";

/** The classes of a button, for the places that need them on something else, such as a router <Link>. One primary button per view. */
export function buttonClass(variant: ButtonVariant = "secondary", size?: "sm", icon = false) {
  return ["btn", variant !== "secondary" && variant, size, icon && "icon"].filter(Boolean).join(" ");
}

/**
 * `needs` is the role the button takes (see access.ts). For someone without that role the button is off and says why, in words, on hover and to a screen reader.
 * The server refuses the request either way; this only keeps the screen honest about what the person can do.
 */
export function Button({ variant, size, icon, className, children, needs, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm"; icon?: boolean; needs?: Needs }) {
  const classes = [buttonClass(variant, size, icon), className].filter(Boolean).join(" ");
  if (!needs) return <button type="button" className={classes} {...rest}>{children}</button>;
  return (
    <Gate needs={needs}>
      {({ disabled, describedBy }) => (
        <button type="button" className={classes} {...rest} disabled={disabled || rest.disabled} aria-describedby={describedBy ?? rest["aria-describedby"]}>
          {children}
        </button>
      )}
    </Gate>
  );
}
