"use client";

// FrameSection / FrameExplain: shared collapsibles for the hegota rail homes (FrameHome,
// FrameStealthHome, FrameSchemePicker), so long teaching texts do not stretch every screen.
//
// Pure presentation, rail-owned and removable like the other Frame* components. FrameSection is a
// titled section (same look as the earlier inline "▸ label" boxes); FrameExplain is a small muted toggle for
// teaching notes. Open/closed is plain view state (nothing is persisted): every view starts from the
// given default. The body stays mounted when closed by default, so form state inside survives a
// collapse.
import { useState, type ReactNode, type KeyboardEvent } from "react";
import { Box, Collapse } from "@mui/material";

const label = { fontSize: "0.72rem", opacity: 0.6, letterSpacing: "0.06em", textTransform: "uppercase" as const };

function useOpen(defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(defaultOpen);
  return [open, () => setOpen((prev) => !prev)];
}

// Enter / Space toggle, like a native button.
function onKeyToggle(toggle: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
}

/** Collapsible titled section. `pinned` stays visible under the header even when closed (safety alerts). */
export default function FrameSection({
  id, title, defaultOpen = false, right, pinned, unmountOnExit = false, sx, children,
}: {
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  pinned?: ReactNode;
  unmountOnExit?: boolean;
  sx?: object;
  children: ReactNode;
}) {
  const [open, toggle] = useOpen(defaultOpen);
  return (
    <Box sx={sx} data-section={id}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={onKeyToggle(toggle)}
          sx={{ ...label, display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", cursor: "pointer", userSelect: "none", "&:hover": { opacity: 0.85 } }}
        >
          <span aria-hidden>{open ? "▾" : "▸"}</span>
          {title}
        </Box>
        {right}
      </Box>
      {pinned}
      <Collapse in={open} unmountOnExit={unmountOnExit}>
        <Box sx={{ pt: 0.75 }}>{children}</Box>
      </Collapse>
    </Box>
  );
}

/** Small muted toggle that reveals a teaching note (collapsed by default). */
export function FrameExplain({
  id, label: text = "how this differs from a 4337 wallet", defaultOpen = false, children,
}: { id: string; label?: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, toggle] = useOpen(defaultOpen);
  return (
    <Box sx={{ my: 0.5 }} data-explain={id}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyToggle(toggle)}
        sx={{ display: "inline-block", fontSize: "0.66rem", opacity: 0.55, cursor: "pointer", userSelect: "none", "&:hover": { opacity: 0.85 } }}
      >
        {open ? "▾" : "▸"} {text}
      </Box>
      <Collapse in={open}>
        {children}
      </Collapse>
    </Box>
  );
}
