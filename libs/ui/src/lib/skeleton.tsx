import { cn } from "./misc";


// Announced as loading: a bare pulse told a screen reader nothing.
function Skeleton({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    >
      {children ?? <span className="sr-only">Loading</span>}
    </div>
  );
}

export { Skeleton };
