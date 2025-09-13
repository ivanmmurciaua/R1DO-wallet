// import { Button } from "@mui/material";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
// import { formatEther } from "viem";
import { BuildingNotice } from "./BuildingNotice";
// import { UserMenu } from "./UserMenu";
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
      <div style={{ textAlign: "center" }}>
        <h2> {userBalance} ⧫ </h2>
        <br />
        <div style={{ marginTop: "11px" }}>
          {parseFloat(userBalance) > 0 ? (
            <div>
              {/*<UserMenu />*/}
              <span>Hey {username}, I see you have ⧫ in your wallet!</span>
              <p style={{ marginTop: "3px" }}>
                <span>Now, stay tunned for new features ;)</span>
              </p>
            </div>
          ) : (
            <div>
              <p>
                Ow... you don`t have any ⧫... so sad :( <br />
                Ask a few friends to send you some using
              </p>
              {/*<p>your username: {username}</p>*/}
              {/*<span>or</span>*/}
              <br />
              <p>your address:</p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: "0.9em", wordBreak: "break-all" }}>
                  {address}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div>
        <BuildingNotice />
      </div>
    </div>
  );
}
