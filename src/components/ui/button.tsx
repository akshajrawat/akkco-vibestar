import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";
const variants = cva("button", {
  variants: {
    variant: {
      default: "primary",
      secondary: "secondary",
      ghost: "ghost",
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
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof variants> & { asChild?: boolean }) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type="button"
      className={cn(variants({ variant, size, className }))}
      {...props}
    />
  );
};
