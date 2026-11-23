import type { ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const variants = cva(
  "button inline-flex min-h-8 items-center justify-center gap-[7px] whitespace-nowrap border-0 px-3 py-[7px] text-[12px] font-medium [transition:background-color_var(--motion-fast),color_var(--motion-fast),transform_var(--motion-fast)] [&:active:not(:disabled)]:transform-[translateY(1px)] aria-busy:cursor-progress aria-busy:opacity-80",
  {
    variants: {
      variant: {
        default:
          "primary bg-button-primary text-ink-on-accent [&:hover:not(:disabled)]:bg-button-primary-hover [&:active:not(:disabled)]:bg-button-primary-active [&:hover:active:not(:disabled)]:bg-button-primary-active",
        secondary: "bg-surface-elevated [&:hover:not(:disabled)]:bg-surface-hover",
        ghost: "ghost bg-transparent [&:hover]:bg-surface-hover",
        destructive:
          "destructive bg-transparent text-accent-red [&:hover:not(:disabled)]:bg-surface-error",
      },
      size: {
        default: "",
        sm: "small min-h-[27px] px-[9px] py-1",
        icon: "icon-button size-7.5 min-h-7.5 rounded-[50%] p-[5px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

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
