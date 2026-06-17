// Client-side error logger. (Antes hacía POST a /api/log-error, pero la app se
// exporta estática para IPFS — sin servidor — así que logueamos en consola.)
export const log = async (context: string, e: unknown) => {
  console.error(`[R1DO]${context ? " [" + context + "]" : ""}:`, e);
};
