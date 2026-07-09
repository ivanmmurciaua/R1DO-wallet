/*
  oracle.ts — on-chain ETH/USD price (Chainlink), the fee model's only I/O
  dependency (lib/fees.ts). Isolated here so fees.ts stays pure arithmetic: the
  oracle is the network boundary.

  KEY: the ETH/USD price is a GLOBAL fact, it does NOT depend on the chain the
  user picks. It's one of the very few reads done ALWAYS against **Ethereum
  mainnet** (fixed feed + mainnet RPCs of its own), even when the wallet is
  operating on Sepolia/Arbitrum/whatever. That's why it does NOT use
  activeNetwork(). Mainnet also has the most liquid and fresh feed (testnet ones
  go stale).

  - Source: Chainlink AggregatorV3Interface (latestRoundData) on mainnet.
    NO API key, NO external price service — it's an eth_call to public mainnet
    RPCs (they must be in the CSP connect-src, see next.config.ts).
  - Only invoked when a non-ETH asset is involved (see fees.quoteFee): a pure-ETH
    op needs no gas→stable conversion, so the oracle is NOT even called.
  - In-memory cache (short TTL): the price doesn't move enough in 60s to change a
    ~1-cent floor, and it avoids hammering the RPC on every quote.

  Always returns the price scaled to ETH_USD_DECIMALS (8), regardless of the
  decimals the feed reports — that's the contract with fees.ts.
*/
import { createPublicClient, http, fallback } from "viem";
import { mainnet } from "viem/chains";

/** Scale of the price returned by this module (Chainlink ETH/USD convention = 8). */
export const ETH_USD_DECIMALS = 8;

// Chainlink ETH/USD on Ethereum mainnet (8 decimals). Official, FIXED address.
const ETH_USD_FEED_MAINNET = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;

// Public mainnet RPCs JUST for this read (latestRoundData, light, cached 60s).
// Independent of the active network's list. They must appear in the CSP
// connect-src (next.config.ts). All verified (2026-06-25) serving eth_call
// against the feed → ETH/USD. Tried in fallback order; blxrbdn goes LAST on
// purpose (last-resort alternative).
const MAINNET_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://rpc.mevblocker.io",
  "https://eth.drpc.org",
  "https://eth.api.pocket.network",
  "https://rpc.nodeflare.app/eth/public",
  "https://eth.rpc.blxrbdn.com",
] as const;

const AGGREGATOR_V3_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const TTL_MS = 60_000;
let cached: { price: bigint; at: number } | null = null;

/**
 * ETH/USD price scaled to ETH_USD_DECIMALS. Reads Chainlink on mainnet.
 * Throws if the feed returns a non-positive price — the caller (fees.quoteFee)
 * decides how to degrade (today: it propagates).
 */
export async function getEthUsd(): Promise<bigint> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.price;

  const client = createPublicClient({
    chain: mainnet,
    transport: fallback(MAINNET_RPCS.map((u) => http(u))),
  });
  const [round, dec] = await Promise.all([
    client.readContract({ address: ETH_USD_FEED_MAINNET, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }),
    client.readContract({ address: ETH_USD_FEED_MAINNET, abi: AGGREGATOR_V3_ABI, functionName: "decimals" }),
  ]);

  const answer = round[1]; // int256 price
  if (answer <= 0n) throw new Error("Chainlink ETH/USD returned a non-positive price");

  // Rescale to ETH_USD_DECIMALS in case the feed reports different decimals.
  const feedDecimals = Number(dec);
  let price = answer;
  if (feedDecimals > ETH_USD_DECIMALS) {
    price = price / 10n ** BigInt(feedDecimals - ETH_USD_DECIMALS);
  } else if (feedDecimals < ETH_USD_DECIMALS) {
    price = price * 10n ** BigInt(ETH_USD_DECIMALS - feedDecimals);
  }

  cached = { price, at: Date.now() };
  return price;
}
