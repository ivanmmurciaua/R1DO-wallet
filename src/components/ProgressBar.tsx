/*
  ProgressBar — a tiny determinate bar for known-total operations (stealth scan
  windows, multi-UserOp private sends). Uses `currentColor` so it adapts to both
  the light and shadow worlds with no per-theme styling. When `total` is 0 it
  renders an indeterminate sweep (total not known yet).
*/
"use client";

export function ProgressBar({
  done,
  total,
  label,
  showCount = true,
}: {
  done: number;
  total: number;
  /** Optional caption above the bar (e.g. "Scanning…", "Sending…"). */
  label?: string;
  /** Show the `done/total` counter next to the label. */
  showCount?: boolean;
}) {
  const determinate = total > 0;
  const pct = determinate ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div style={{ width: "100%", maxWidth: 320, margin: "0 auto" }}>
      {(label || (determinate && showCount)) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "0.68rem",
            opacity: 0.75,
            marginBottom: 6,
          }}
        >
          <span>{label}</span>
          {determinate && showCount && <span>{done}/{total}</span>}
        </div>
      )}
      <div
        style={{
          height: 6,
          border: "1px solid currentColor",
          borderRadius: 2,
          overflow: "hidden",
          opacity: 0.85,
        }}
      >
        <div
          style={
            determinate
              ? { width: `${pct}%`, height: "100%", background: "currentColor", transition: "width 0.25s ease" }
              : {
                  width: "35%",
                  height: "100%",
                  background: "currentColor",
                  borderRadius: 2,
                  animation: "r1do-progress-sweep 1.1s ease-in-out infinite",
                }
          }
        />
      </div>
      <style>{`@keyframes r1do-progress-sweep { 0%{margin-left:-35%} 100%{margin-left:100%} }`}</style>
    </div>
  );
}
