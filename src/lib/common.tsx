export const log = async (context: string, e: unknown) => {
  try {
    await fetch("/api/log-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: e?.toString?.() || String(e),
        context: context,
      }),
    });
  } catch (apiErr) {
    console.error("Failed to log error to server:", apiErr);
  }
};
