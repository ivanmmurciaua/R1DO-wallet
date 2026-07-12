// Client-side error logger. (It used to POST to /api/log-error, but the app is
// exported statically for IPFS — no server — so we log to the console instead.)
export const log = async (context: string, e: unknown) => {
  console.error(`[R1DO]${context ? " [" + context + "]" : ""}:`, e);
};

// Human list join: "A" · "A and B" · "A, B and C". Used by the Receive screens
// to spell out the networks/assets a payment can land on.
export const formatList = (xs: string[]): string =>
  xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
