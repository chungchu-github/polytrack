import clsx from "clsx";

/**
 * Lightweight skeleton primitives. Avoid the standard "shimmer" hue here —
 * we use a subtle pulse that respects prefers-reduced-motion (Tailwind's
 * animate-pulse already does, sort of).
 */
export function Skeleton({ className }) {
  return (
    <div
      className={clsx(
        "animate-pulse rounded-md bg-surface-800",
        "motion-reduce:animate-none motion-reduce:opacity-60",
        className,
      )}
    />
  );
}

/** A single stat-style card placeholder (matches Dashboard top row). */
export function StatCardSkeleton() {
  return (
    <div className="card flex flex-col">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-16 mt-2" />
    </div>
  );
}

/** A row in a table-like list (e.g. wallets, trades). */
export function ListRowSkeleton({ rows = 3 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-md border border-surface-800 bg-surface-900/50 px-3 py-2"
        >
          <div className="space-y-1.5 flex-1 min-w-0">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
          <Skeleton className="h-2 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A generic full-card placeholder (header + body). */
export function CardSkeleton({ height = "h-32" }) {
  return (
    <div className="card">
      <Skeleton className="h-3 w-32 mb-3" />
      <Skeleton className={clsx("w-full", height)} />
    </div>
  );
}
