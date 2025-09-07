// import { Input, Stack, Typography } from "@mui/material";
// import { Button } from "@mui/material";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { BuildingNotice } from "./BuildingNotice";
// import { makeTx } from "@/lib/deploy";

type props = {
  username: string;
  wallet: Safe4337Pack;
  address: string;
};

export default function AccountDetails({ username, wallet, address }: props) {
  const [userBalance, setBalance] = useState<string>("0");

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
        {/*<div>
        {parseFloat(userBalance) > 0 ? (
          <div>
            Send a few ⧫ to your friends!

          </div>
        ) : (
          <div>
            Ask a few friends to send you some ⧫ using your username: {username}
            <button onClick={async () => makeTx(wallet)}>TX</button>
          </div>
        )}
      </div>*/}
      </div>
      <BuildingNotice />
    </div>
  );
}
