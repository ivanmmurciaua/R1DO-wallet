import styles from "../app/page.module.css";
import { Paper } from "@mui/material";

export default function Popup({ popupMessage }: { popupMessage: string }) {
  return (
    <div className={styles.popupOverlay}>
      <Paper
        className={styles.popup}
        sx={{
          fontFamily: "var(--font-geist-mono), monospace",
          letterSpacing: "0.02em",
          textAlign: "center",
          minWidth: 300,
          maxWidth: 420,
          px: 4,
          py: 4,
          border: "1px solid currentColor",
        }}
      >
        <h3>{popupMessage}</h3>
      </Paper>
    </div>
  );
}
