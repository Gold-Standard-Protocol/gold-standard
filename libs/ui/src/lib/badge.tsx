import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './misc';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-none tracking-tight whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-muted text-muted-foreground',
        gold: 'border-primary/20 bg-accent text-primary',
        success: 'border-success/20 bg-success-soft text-success',
        warning: 'border-warning/25 bg-warning-soft text-warning',
        danger: 'border-danger/20 bg-danger-soft text-danger',
        outline: 'border-border bg-transparent text-foreground',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Renders a small leading status dot in the current text colour. */
  dot?: boolean;
}

function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-current"
        />
      )}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
