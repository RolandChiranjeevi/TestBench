import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "secondary" | "primary" | "ghost" | "danger" | "danger-solid";

/** The classes of a button, for the places that need them on something else, such as a router <Link>. One primary button per view. */
export function buttonClass(variant: ButtonVariant = "secondary", size?: "sm", icon = false) {
  return ["btn", variant !== "secondary" && variant, size, icon && "icon"].filter(Boolean).join(" ");
}

export function Button({ variant, size, icon, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm"; icon?: boolean }) {
  return (
    <button type="button" className={[buttonClass(variant, size, icon), className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </button>
  );
}
