// Client-side error logger. (It used to POST to /api/log-error, but the app is
// exported statically for IPFS — no server — so we log to the console instead.)
export const log = async (context: string, e: unknown) => {
  console.error(`[R1DO]${context ? " [" + context + "]" : ""}:`, e);
};
