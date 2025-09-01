// import { Input, Stack, Typography } from "@mui/material";
// import { Safe4337Pack } from "@safe-global/relay-kit";

type props = {
  //wallet: Safe4337Pack;
  address: string;
};

export default function AccountDetails({ address }: props) {
  //wallet, address }: props) {
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
      <br />
      <p style={{ fontSize: "1.3em" }}>🏗️ Stay tunned for new updates 🏗️</p>
      <br />
      Feel free to contact me if you have any feedback:
      <br />
      <a
        href="https://t.me/Ivanovish10"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "7px",
          marginTop: "1px",
          textDecoration: "none",
          background: "#229ED9",
          color: "#fff",
          borderRadius: "4px",
          padding: "3px 12px",
          fontWeight: 500,
          fontSize: "1rem",
          border: "none",
          cursor: "pointer",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ background: "none" }}
        >
          <path d="M22 2L11 13" />
          <path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
        Telegram
      </a>
      <br />
      <br />
      Thanks for testing
    </div>
  );
}
