import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
import { Snackbar, Alert, CircularProgress } from "@mui/material";
import { BuildingNotice } from "./BuildingNotice";
import { UserMenu } from "./UserMenu";

type props = {
  username: string;
  wallet: Safe4337Pack;
  address: string;
};

export default function AccountDetails({ username, wallet, address }: props) {
  const [isLoaded, setLoaded] = useState(false);
  const [userBalance, setBalance] = useState<string>("0");
  const [showCopySuccess, setShowCopySuccess] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    let mounted = true;

    const fetchBalance = async () => {
      try {
        const bal = await wallet.protocolKit.getBalance();
        if (!mounted) return;
        setBalance(bal.toString());
      } catch (err) {
        console.error("fetchBalance error", err);
      }
      if (!isLoaded) setLoaded(true);
    };

    fetchBalance();
    const id = setInterval(fetchBalance, 7000);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [wallet, address, isLoaded]);

  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setShowCopySuccess(true);
    } catch (err) {
      console.error("Failed to copy address:", err);
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = address;
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand("copy");
        setShowCopySuccess(true);
      } catch (fallbackErr) {
        console.error("Fallback copy failed:", fallbackErr);
      }
      document.body.removeChild(textArea);
    }
  };

  return isLoaded ? (
    <div>
      {/*<h2>👋 Welcome back {username}!</h2>*/}
      <div style={{ textAlign: "center" }}>
        <h2
          onClick={handleCopyAddress}
          style={{
            cursor: "pointer",
            userSelect: "none",
            transition: "transform 0.1s ease",
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.95)")}
          onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          title="Click to copy address"
        >
          {userBalance} ⧫
        </h2>
        <br />
        <div style={{ marginTop: "11px" }}>
          {parseFloat(userBalance) > 0 ? (
            <div>
              <UserMenu wallet={wallet} />
            </div>
          ) : (
            <div style={{ marginBottom: "-25px" }}>
              <p>
                Ow... you don`t have any ⧫... so sad :( <br />
                <br />
                Ask a few friends to send you some using your username:{" "}
                {username}
              </p>
              <br />
              <p>or your address by clicking your balance</p>
            </div>
          )}
        </div>
      </div>
      <div>
        <BuildingNotice />
      </div>

      <Snackbar
        open={showCopySuccess}
        autoHideDuration={2000}
        onClose={() => setShowCopySuccess(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          onClose={() => setShowCopySuccess(false)}
          severity="success"
          variant="filled"
        >
          Address copied to clipboard!
        </Alert>
      </Snackbar>
    </div>
  ) : (
    <CircularProgress size={50} sx={{ alignItems: "center", mb: 2, mt: 3 }} />
  );
}
