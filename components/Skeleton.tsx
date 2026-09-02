/**
 * components/Skeleton.tsx — shared loading placeholders (§1: skeletons, never
 * blank space). Purely presentational; pulse animation comes from Tailwind.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-surface-overlay ${className}`}
    />
  );
}

/** Matches the ActivityHeatmap's real layout while it "loads". */
export function HeatmapSkeleton() {
  return (
    <div className="flex gap-[3px]" data-testid="heatmap-skeleton">
      <div className="mr-1 flex flex-col gap-[3px]">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-6" />
        ))}
      </div>
      <div className="flex gap-[3px] overflow-hidden">
        {Array.from({ length: 12 }).map((_, c) => (
          <div key={c} className="flex flex-col gap-[3px]">
            {Array.from({ length: 7 }).map((_, r) => (
              <Skeleton key={r} className="h-3 w-3 rounded-[3px]" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A roadmap-day-shaped placeholder used while a roadmap generates. */
export function DayCardSkeleton() {
  return (
    <li className="rounded-xl bg-surface-raised p-4 ring-1 ring-white/5">
      <div className="mb-3 flex items-center justify-between">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-8 w-24 rounded-lg" />
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
    </li>
  );
}