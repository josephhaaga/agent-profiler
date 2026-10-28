import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium select-none",
  {
    variants: {
      variant: {
        neutral: "bg-secondary text-secondary-foreground",
        ok: "bg-green/10 text-green",
        warn: "bg-amber/10 text-amber",
        critical: "bg-red/10 text-red",
        muted: "bg-muted text-muted-foreground",
        info: "bg-secondary text-secondary-foreground",
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
