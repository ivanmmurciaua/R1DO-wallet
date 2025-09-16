import styles from "../app/page.module.css";

export default function Popup({ popupMessage }: { popupMessage: string }) {
  return (
    <div className={styles.popupOverlay}>
      <div className={styles.popup}>
        <h3>{popupMessage}</h3>
      </div>
    </div>
  );
}
