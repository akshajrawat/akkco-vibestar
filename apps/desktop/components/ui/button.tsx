import type { ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const variants = cva("button", {
  variants: {
    variant: {
      default: "primary",
      secondary: "secondary",
      ghost: "ghost",
      outline: "outline",
      destructive: "destructive",
    },
    size: { default: "", sm: "small", icon: "icon-button" },
  },
  defaultVariants: { variant: "secondary", size: "default" },
});

export const Button = ({
  className,
  variant,
  size,
  asChild = false,
  busy = false,
  disabled,
  children,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof variants> & { asChild?: boolean; busy?: boolean }) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type="button"
      className={cn(variants({ variant, size, className }))}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {busy && <LoaderCircle size={14} className="spinning" aria-hidden="true" />}
          {children}
        </>
      )}
    </Comp>
  );
};
