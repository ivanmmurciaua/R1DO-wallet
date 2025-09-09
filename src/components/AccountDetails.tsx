// import { Button } from "@mui/material";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { BuildingNotice } from "./BuildingNotice";
// import { PasskeyArgType } from "@safe-global/protocol-kit";
// import { ImportedUserData } from "@/types";
// import { makeTx } from "@/lib/deploy";

type props = {
  username: string;
  wallet: Safe4337Pack;
  address: string;
};

export default function AccountDetails({ username, wallet, address }: props) {
  const [userBalance, setBalance] = useState<string>("0");

  // let canExport = false;
  // let userData: { fingerprint: string; passkey: PasskeyArgType } | null = null;
  // if (username !== "") {
  //   const userDataRaw = localStorage.getItem(username);
  //   if (userDataRaw) {
  //     try {
  //       const parsed = JSON.parse(userDataRaw);
  //       if (
  //         parsed.fingerprint !== "" &&
  //         parsed.passkey &&
  //         parsed.passkey.rawId !== "" &&
  //         parsed.passkey.coordinates &&
  //         parsed.passkey.coordinates.x !== "" &&
  //         parsed.passkey.coordinates.y !== ""
  //       ) {
  //         canExport = true;
  //         userData = {
  //           fingerprint: parsed.fingerprint,
  //           passkey: parsed.passkey,
  //         };
  //       }
  //     } catch (e: unknown) {
  //       console.error(e);
  //     }
  //   }
  // }

  // function exportUserData() {
  //   if (!username || !userData) return;
  //   const exportObj = {
  //     [username]: {
  //       fingerprint: userData.fingerprint,
  //       passkey: userData.passkey,
  //     },
  //   } as ImportedUserData;

  //   const jsonStr = JSON.stringify(exportObj, null, 2);
  //   const blob = new Blob([jsonStr], { type: "application/json" });
  //   const url = URL.createObjectURL(blob);

  //   const a = document.createElement("a");
  //   a.href = url;
  //   a.download = `${username}_safekey_backup.json`;
  //   document.body.appendChild(a);
  //   a.click();
  //   document.body.removeChild(a);
  //   URL.revokeObjectURL(url);
  // }

  useEffect(() => {
    const fetchBalance = async () => {
      const balance = await wallet.protocolKit.getBalance();
      setBalance(formatEther(balance));
    };
    fetchBalance();
  }, [wallet]);

  return (
    <div>
      <h2>🎉 Your Wallet is ready!</h2>
      <p
        style={{
          wordBreak: "break-all",
          fontSize: "1rem",
          padding: "8px 0",
          margin: 0,
          overflowWrap: "anywhere",
        }}
      >
        {address}
      </p>
      <br />
      <p>Username: {username}</p>
      <p>Balance: {userBalance} ⧫</p>
      <br />
      <div>
        {/*{canExport && (
          <Button variant="contained" color="info" onClick={exportUserData}>
            Backup wallet
          </Button>
        )}*/}
        {/*<div>
        {parseFloat(userBalance) > 0 ? (
          <div>
            Send a few ⧫ to your friends!

          </div>
        ) : (
          <div>
            Ask a few friends to send you some ⧫ using your username: {username}
            <button onClick={async () => makeTx(wallet)}>Test tx</button>
          </div>
        )}
      </div>*/}
      </div>
      <BuildingNotice />
    </div>
  );
}
