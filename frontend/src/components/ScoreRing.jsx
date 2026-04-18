import clsx from "clsx";

const SIZE = 64;
const STROKE = 5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function ScoreRing({ score = 0, tier = "BASIC", size = SIZE, className }) {
  const pct = Math.min(score, 100) / 100;
  const offset = CIRCUMFERENCE * (1 - pct);
  const r = (size - STROKE) / 2;
  const circ = 2 * Math.PI * r;
  const dashOffset = circ * (1 - pct);

  const color =
    tier === "ELITE" ? "stroke-primary" :
    tier === "PRO"   ? "stroke-accent" :
                       "stroke-surface-500";

  const textColor =
    tier === "ELITE" ? "text-primary" :
    tier === "PRO"   ? "text-accent" :
                       "text-surface-400";

  return (
    <div className={clsx("relative inline-flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className="text-surface-700"
        />
        {/* Score arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dashOffset}
          className={clsx(color, "transition-all duration-500")}
        />
      </svg>
      {/* Center text */}
      <span
        className={clsx(
          "absolute font-display font-bold tabular-nums",
          textColor,
          size >= 64 ? "text-base" : "text-xs"
        )}
        aria-label={`Score ${score}`}
      >
        {score}
      </span>
    </div>
  );
}
