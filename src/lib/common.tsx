export const log = async (e: unknown) => {
  try {
    await fetch("/api/log-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: e?.toString?.() || String(e),
        context: "creating passkey at passkeys.tsx",
      }),
    });
  } catch (apiErr) {
    console.error("Failed to log error to server:", apiErr);
  }
};
