export const BuildingNotice = () => {
  return (
    <div style={{ marginTop: "17em" }}>
      <p style={{ fontSize: "0.77em" }}>
        Feel free to contact me if you have any feedback:
      </p>
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
          fontSize: "0.77rem",
          border: "none",
          cursor: "pointer",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
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
      <p style={{ fontSize: "0.77em" }}>Thx for testing it</p>
    </div>
  );
};
