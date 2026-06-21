import type { Address, PublicClient } from "viem";

// Multicall3's own getEthBalance(addr) — lets us read many native balances in a
// single aggregate3 round-trip instead of one eth_getBalance per address.
const GET_ETH_BALANCE_ABI = [
  {
    inputs: [{ name: "addr", type: "address" }],
    name: "getEthBalance",
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Native balances for many addresses in ONE round-trip via Multicall3
 * (viem routes through the active chain's multicall3 deployment). Result order
 * matches `addresses`; a failed sub-call yields 0n. Falls back to parallel
 * eth_getBalance if the chain has no multicall3 configured.
 *
 * Replaces the per-UTXO `Promise.all(map(getBalance))` fan-out — N RPC calls
 * collapse to 1, which matters as a wallet accrues stealth UTXOs.
 */
export async function getStealthBalances(
  client: PublicClient,
  addresses: readonly Address[],
): Promise<bigint[]> {
  if (addresses.length === 0) return [];

  const multicall3 = client.chain?.contracts?.multicall3?.address;
  if (!multicall3) {
    return Promise.all(addresses.map((address) => client.getBalance({ address })));
  }

  const results = await client.multicall({
    contracts: addresses.map((addr) => ({
      address: multicall3,
      abi: GET_ETH_BALANCE_ABI,
      functionName: "getEthBalance" as const,
      args: [addr] as const,
    })),
    allowFailure: true,
  });

  return results.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));
}

// Minimal ERC20 balanceOf — the read every token balance needs.
const ERC20_BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * ERC20 balances of one `token` for many `addresses` in ONE round-trip — the
 * balanceOf sibling of getStealthBalances. Each balanceOf is an eth_call on the
 * token contract; viem batches them through the chain's Multicall3. Result order
 * matches `addresses`; a failed sub-call yields 0n. Falls back to parallel
 * readContract if the chain has no multicall3.
 *
 * Used (Fase 1+) to read a token across the main Safe + every stealth address in
 * one shot, the same way native balances are read today.
 */
export async function getTokenBalances(
  client: PublicClient,
  token: Address,
  addresses: readonly Address[],
): Promise<bigint[]> {
  if (addresses.length === 0) return [];

  const multicall3 = client.chain?.contracts?.multicall3?.address;
  if (!multicall3) {
    return Promise.all(
      addresses.map((address) =>
        client
          .readContract({ address: token, abi: ERC20_BALANCE_OF_ABI, functionName: "balanceOf", args: [address] })
          .then((r) => r as bigint)
          .catch(() => 0n),
      ),
    );
  }

  const results = await client.multicall({
    contracts: addresses.map((addr) => ({
      address: token,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf" as const,
      args: [addr] as const,
    })),
    allowFailure: true,
  });

  return results.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));
}
