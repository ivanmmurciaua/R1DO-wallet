import React, { useRef, useState } from "react";
import { Button, Typography, Box } from "@mui/material";
import styles from "../app/page.module.css";
import { ImportedUserData } from "@/types";

type ImportPasskeyProps = {
  onImport?: (username: string) => void;
};

const ImportPasskey: React.FC<ImportPasskeyProps> = ({ onImport }) => {
  const [popupMessage, setPopupMessage] = useState("");
  const [showPopup, setShowPopup] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openMessage = (message: string) => {
    setShowPopup(true);
    setPopupMessage(message);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        setShowPopup(false);
        resolve();
      }, 2700);
    });
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data: ImportedUserData = JSON.parse(text);

      let imported = false;
      let importedUsername = "";
      Object.entries(data).forEach(([username, userObj]) => {
        if (
          username &&
          userObj &&
          userObj.fingerprint &&
          userObj.passkey &&
          userObj.passkey.rawId &&
          userObj.passkey.coordinates &&
          userObj.passkey.coordinates.x &&
          userObj.passkey.coordinates.y
        ) {
          localStorage.setItem(username, JSON.stringify(userObj));
          imported = true;
          importedUsername = username;
        }
      });

      if (imported) {
        await openMessage("Wallet successfully imported");
        console.log(importedUsername);
        if (onImport) onImport(importedUsername);
      } else {
        await openMessage("No valid wallet data found in file.");
      }
    } catch (err: unknown) {
      await openMessage("Failed to import file. Please check the format.");
      console.log(err);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleImportClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  return (
    <Box textAlign="center">
      <Typography variant="h5" mb={2}></Typography>
      <input
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        ref={fileInputRef}
        onChange={handleFileChange}
      />

      <Typography variant="body2">
        Click this button and select a valid backup file to restore your wallet.
      </Typography>

      <Button
        variant="outlined"
        sx={{
          marginTop: "9px",
          marginBottom: "23px",
          backgroundColor: (theme) =>
            theme.palette.mode === "dark" ? "#222" : "#fff",
          color: (theme) => (theme.palette.mode === "dark" ? "#fff" : "#222"),
          borderColor: (theme) =>
            theme.palette.mode === "dark" ? "#fff" : "#222",
          "&:hover": {
            backgroundColor: (theme) =>
              theme.palette.mode === "dark" ? "#333" : "#f0f0f0",
            borderColor: (theme) =>
              theme.palette.mode === "dark" ? "#fff" : "#222",
          },
        }}
        onClick={handleImportClick}
      >
        Import Wallet
      </Button>

      {showPopup && popupMessage && (
        <div className={styles.popupOverlay}>
          <div className={styles.popup}>
            <h3>{popupMessage}</h3>
          </div>
        </div>
      )}
    </Box>
  );
};

export default ImportPasskey;
