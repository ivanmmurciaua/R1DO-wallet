import React, { useState } from "react";
import { Button, Stack, Box } from "@mui/material";
import DiamondIcon from "@mui/icons-material/Diamond";
import { SendEth } from "./SendEth";
import Popup from "./Popup";
import { Safe4337Pack } from "@safe-global/relay-kit";

type UserMenuProps = {
  wallet: Safe4337Pack;
};

export const UserMenu: React.FC<UserMenuProps> = ({ wallet }) => {
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [currentView, setCurrentView] = useState<"menu" | "sendDiamonds">(
    "menu",
  );

  const handleShowPopup = (message: string) => {
    setShowPopup(true);
    setPopupMessage(message);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        setShowPopup(false);
        resolve();
      }, 2000);
    });
  };

  const handleSendDiamonds = () => {
    setCurrentView("sendDiamonds");
  };

  const handleEarnMoreDiamonds = () => {
    // TODO: Implement
    handleShowPopup("Easy there, cowboy—this'll be implemented soon 🐴");
  };

  const handleBackToMenu = (message: string = "") => {
    if (message !== "") {
      handleShowPopup(message);
    }
    setCurrentView("menu");
  };

  if (currentView === "sendDiamonds") {
    return <SendEth wallet={wallet} onBack={handleBackToMenu} />;
  }

  // Default menu view
  return (
    <Box sx={{ mt: 2, mb: 2 }}>
      <Stack
        spacing={2}
        direction="column"
        sx={{ width: "100%", maxWidth: 400, mx: "auto" }}
      >
        <Button
          variant="contained"
          color="primary"
          onClick={handleSendDiamonds}
          sx={{
            py: 1.5,
            fontSize: "1rem",
            borderRadius: 2,
          }}
        >
          Send ⧫ to your friends
        </Button>

        <Button
          variant="outlined"
          color="secondary"
          startIcon={<DiamondIcon />}
          endIcon={<DiamondIcon />}
          onClick={handleEarnMoreDiamonds}
          sx={{
            py: 1.5,
            fontSize: "1rem",
            borderRadius: 2,
          }}
        >
          Earn more
        </Button>
        {showPopup && popupMessage && <Popup popupMessage={popupMessage} />}
      </Stack>
    </Box>
  );
};
