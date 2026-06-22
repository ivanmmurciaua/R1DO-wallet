import { activeNetwork } from "@/lib/networks";

// Server-side proxy for the Pimlico bundler + paymaster.
//
// WHY: the relay-kit (Safe4337Pack) talks JSON-RPC straight to Pimlico from the
// browser. Embedding the API key in that URL means `NEXT_PUBLIC_PIMLICO_API_KEY`
// gets inlined into the client bundle — exfiltrable from devtools. Routing
// through this handler keeps the key server-only (`PIMLICO_API_KEY`, no
// NEXT_PUBLIC_ prefix). The client points bundlerUrl/paymasterUrl here; we
// forward to Pimlico with the key attached and pass the response back verbatim.
//
// SCOPE: this is a server route → it only exists in the Node/Vercel deployment,
// NOT in the static IPFS export (which has no server; that build is frozen and
// will get its own key-handling). Rate-limiting is handled upstream in the
// Vercel WAF (per the deployment owner); the protection added HERE is the method
// whitelist so the endpoint can't be used as an open relay for arbitrary RPC.

// Bundler (ERC-4337) + Pimlico paymaster/utility methods the wallet legitimately
// needs. Anything else → 403, so this proxy can't be abused as a general RPC.
const ALLOWED_METHODS = new Set<string>([
  // ERC-4337 bundler
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "eth_supportedEntryPoints",
  "eth_chainId",
  // Pimlico paymaster
  "pm_sponsorUserOperation",
  "pm_getPaymasterData",
  "pm_getPaymasterStubData",
  "pm_validateSponsorshipPolicies",
  // Pimlico bundler extensions
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
]);

type JsonRpcCall = { method?: unknown };

export async function POST(req: Request): Promise<Response> {
  const key = process.env.PIMLICO_API_KEY;
  if (!key) {
    // Misconfiguration, not a client error — never leak which env is missing.
    console.error("[api/pimlico] PIMLICO_API_KEY is not set");
    return Response.json({ error: "proxy not configured" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // JSON-RPC payloads are a single object or a batch array — validate each.
  const calls: JsonRpcCall[] = Array.isArray(body) ? body : [body as JsonRpcCall];
  if (calls.length === 0) {
    return Response.json({ error: "empty request" }, { status: 400 });
  }
  for (const c of calls) {
    const method = c && typeof c.method === "string" ? c.method : null;
    if (!method || !ALLOWED_METHODS.has(method)) {
      return Response.json({ error: `method not allowed: ${method ?? "(none)"}` }, { status: 403 });
    }
  }

  const slug = activeNetwork().bundlerSlug;
  const upstream = `https://api.pimlico.io/v2/${slug}/rpc?apikey=${key}`;

  let res: Response;
  try {
    res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("[api/pimlico] upstream fetch failed:", e);
    return Response.json({ error: "upstream unreachable" }, { status: 502 });
  }

  // Pass Pimlico's response (and status) straight through — the relay-kit expects
  // the raw JSON-RPC envelope, errors included.
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
