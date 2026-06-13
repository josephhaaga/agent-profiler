import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded px-1.5 py-0 text-[10px] font-semibold tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 select-none",
  {
    variants: {
      variant: {
        neutral: "bg-secondary text-secondary-foreground",
        ok: "bg-[hsl(158_64%_15%)] text-[hsl(var(--green))]",
        warn: "bg-[hsl(43_96%_14%)] text-[hsl(var(--amber))]",
        critical: "bg-[hsl(0_72%_14%)] text-[hsl(var(--red))]",
        muted: "bg-muted text-muted-foreground",
        info: "bg-[hsl(213_94%_14%)] text-[hsl(var(--primary))]",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
