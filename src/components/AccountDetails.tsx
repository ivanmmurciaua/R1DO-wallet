// import { Button } from "@mui/material";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
// import { formatEther } from "viem";
import { BuildingNotice } from "./BuildingNotice";
// import { SendEth } from "./SendEth";
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
    };

    fetchBalance();
    const id = setInterval(fetchBalance, 7000);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [wallet, address]);

  return (
    <div>
      <h2>🎉 Your Wallet is ready!</h2>
      <p
        style={{
          wordBreak: "break-all",
          fontSize: "0.8em",
          padding: "8px 0",
          margin: 0,
          overflowWrap: "anywhere",
        }}
      >
        {address}
      </p>
      <br />
      <p>Your balance: {userBalance} ⧫</p>
      <br />
      <div>
        <div>
          {parseFloat(userBalance) > 0 ? (
            <div>
              Send a few ⧫ to your friends!
              {/*<SendEth />*/}
            </div>
          ) : (
            <div>
              Ask a few friends to send you some ⧫ using your username:{" "}
              {username}
            </div>
          )}
        </div>
      </div>
      <BuildingNotice />
    </div>
  );
}
