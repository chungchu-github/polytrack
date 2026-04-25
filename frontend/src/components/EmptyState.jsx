import clsx from "clsx";

/**
 * Reusable empty state. Use when a list / grid / metric resolves to no data
 * and we want to *explain* why instead of leaving a "0" sitting in space.
 *
 * Variants:
 *   - "card"   (default): full empty card with title / description / action
 *   - "inline": one-liner, fits inside another card's body
 *
 * Tone:
 *   - "neutral" (default): grey, informational
 *   - "warning": amber, "you should probably do something"
 *   - "info"   : primary, "next thing to try"
 */
export default function EmptyState({
  title,
  description,
  action,        // { label, onClick }  or  { label, href }
  variant = "card",
  tone = "neutral",
  icon,          // optional emoji / unicode glyph string
}) {
  const toneText = tone === "warning" ? "text-amber-400"
                 : tone === "info"    ? "text-primary"
                 : "text-surface-400";

  if (variant === "inline") {
    return (
      <div className="flex items-center gap-2 text-xs text-surface-500">
        {icon && <span className={clsx("text-base", toneText)}>{icon}</span>}
        <span>{description || title}</span>
        {action && <ActionLink {...action} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center text-center px-4 py-8">
      {icon && (
        <div className={clsx("text-3xl mb-2", toneText)}>{icon}</div>
      )}
      {title && (
        <p className="text-sm font-medium text-surface-200">{title}</p>
      )}
      {description && (
        <p className="text-2xs text-surface-500 mt-1 max-w-xs">{description}</p>
      )}
      {action && <ActionLink {...action} className="mt-3" />}
    </div>
  );
}

function ActionLink({ label, onClick, href, className }) {
  const cls = clsx(
    "text-2xs font-semibold text-primary underline underline-offset-2 hover:no-underline",
    className,
  );
  if (href) return <a href={href} className={cls}>{label}</a>;
  return (
    <button type="button" onClick={onClick} className={cls}>
      {label}
    </button>
  );
}
