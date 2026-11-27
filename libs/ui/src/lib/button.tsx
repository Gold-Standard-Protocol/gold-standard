import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";


import Spinner from "./icons/spinner";
import { type IconComponent } from "./types";
import { cn } from "./misc";

const buttonVariants = cva(
  "inline-flex gap-1.5 items-center justify-center rounded-md font-medium tracking-tight whitespace-nowrap ring-offset-background transition-[background-color,border-color,color,box-shadow,transform] duration-150 outline-none focus-visible:ring-2 ring-ring ring-offset-2 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-card text-foreground hover:bg-accent hover:border-border hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground border border-border/60 hover:bg-accent",
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline px-0",
      },
      size: {
        default: "h-11 px-4 py-2 text-sm",
        xs: "h-auto p-0 text-xs tap-target",
        sm: "h-11 rounded-md px-3 text-sm",
        lg: "h-12 rounded-lg px-6 text-[0.95rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const buttonLoaderVariants = cva("", {
  variants: {
    size: {
      xs: "w-4 h-4",
      sm: "w-[18px] h-[18px]",
      default: "w-5 h-5",
      lg: "w-5 h-5 stroke-[2px]",
      xl: "w-5 h-5 stroke-[2px]",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

const buttonIconVariants = cva("", {
  variants: {
    size: {
      xs: "w-4 h-4",
      sm: "w-[18px] h-[18px]",
      default: "w-5 h-5",
      lg: "w-5 h-5",
      xl: "w-5 h-5",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  icon?: IconComponent;
  iconProps?: Omit<React.ComponentProps<"svg">, "width" | "height">;
  iconPosition?: "start" | "end";
  asChild?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  testId?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      fullWidth,
      icon: Icon,
      iconProps,
      iconPosition = "start",
      disabled = false,
      className,
      variant,
      size,
      children,
      asChild = false,
      loading = false,
      testId,
      id,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        disabled={loading ? true : disabled}
        className={cn(
          buttonVariants({
            variant,
            size,
            className: cn(className, fullWidth ? "w-full" : ""),
          })
        )}
        ref={ref}
        {...props}
        testdata-id={`${testId || id}-button`}
      >
        <ButtonContent asChild={asChild}>
          {loading ? (
            <Spinner className={buttonLoaderVariants({ size })} />
          ) : Icon && iconPosition === "start" ? (
            <Icon
              {...iconProps}
              className={buttonIconVariants({
                size,
                className: iconProps?.className,
              })}
            />
          ) : null}
          {children}
          {Icon && iconPosition === "end" ? (
            <Icon
              {...iconProps}
              className={buttonIconVariants({
                size,
                className: iconProps?.className,
              })}
            />
          ) : null}
        </ButtonContent>
      </Comp>
    );
  }
);

Button.displayName = "Button";

interface ButtonContentProps extends React.HTMLAttributes<HTMLDivElement> {
  asChild?: boolean;
}

const ButtonContent = React.forwardRef<HTMLDivElement, ButtonContentProps>(
  function Button({ asChild, children, ...props }, ref) {
    if (asChild) {
      return (
        <div className="inline-flex gap-1" ref={ref} {...props}>
          {children}
        </div>
      );
    }

    return children;
  }
);

export { Button, buttonVariants };
