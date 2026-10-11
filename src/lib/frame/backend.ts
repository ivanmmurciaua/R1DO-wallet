/*
  backend.ts — READ-ONLY frame-native backend for FASE 0.

  Gives a frame-native network (currently only Hegota) the minimum read surface
  the wallet needs: a meta descriptor, a native balance, and a combined account
  view. It is built ONLY on viem (already a delta1 dependency) and the TS standard
  library: no engine import, no new dependency.

  FASE 0 is strictly read-only. Any mutating entry point (send/execute) throws a
  local NotImplemented error rather than silently no-op-ing, so a caller wiring the
  write path in a later phase fails loud instead of appearing to work.

  The viem client is built lazily and memoised: importing this module has NO
  import-time side effects (no network, no client construction), which keeps it off
  the hot path of any bundle that merely references the rail.
*/

import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import type { FrameNetwork } from "./network";

/** Thrown by write entry points while the rail is read-only (FASE 0). */
export class NotImplemented extends Error {
  constructor(message = "FASE 0 is read-only") {
    super(message);
    this.name = "NotImplemented";
  }
}

/** Minimal, serialisable description of the backend a caller is talking to. */
export type FrameBackendMeta = {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  backendKind: FrameNetwork["backendKind"];
  pool: FrameNetwork["pool"];
  readOnly: true;
};

/** Combined read view of an account on a frame-native network. */
export type FrameAccountView = {
  address: Address;
  balanceWei: bigint;
};

/** The read-only surface returned by createFrameReadBackend. */
export type FrameReadBackend = {
  getMeta(): FrameBackendMeta;
  getBalance(address: Address): Promise<bigint>;
  getAccountView(address: Address): Promise<FrameAccountView>;
  /** Write path is not available in FASE 0: always throws NotImplemented. */
  send(): never;
  /** Write path is not available in FASE 0: always throws NotImplemented. */
  execute(): never;
};

/** Build the viem Chain object for a frame-native network (18 decimals native). */
function frameChain(network: FrameNetwork): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: {
      name: network.symbol,
      symbol: network.symbol,
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [...network.rpcUrls] },
    },
    ...(network.explorerUrl
      ? {
          blockExplorers: {
            default: { name: `${network.name} Explorer`, url: network.explorerUrl },
          },
        }
      : {}),
  });
}

/**
 * Create a read-only frame-native backend for `network`.
 *
 * The underlying viem public client is created on first use (lazy) and reused
 * afterwards, so importing or constructing the backend performs no I/O. Reads use
 * a fallback transport over `network.rpcUrls`, tried in order.
 */
export function createFrameReadBackend(network: FrameNetwork): FrameReadBackend {
  const chain = frameChain(network);
  let client: PublicClient | undefined;

  const getClient = (): PublicClient => {
    if (!client) {
      client = createPublicClient({
        chain,
        transport: fallback(network.rpcUrls.map((url) => http(url))),
      });
    }
    return client;
  };

  return {
    getMeta(): FrameBackendMeta {
      return {
        id: network.id,
        chainId: network.chainId,
        name: network.name,
        symbol: network.symbol,
        backendKind: network.backendKind,
        pool: network.pool,
        readOnly: true,
      };
    },

    async getBalance(address: Address): Promise<bigint> {
      return getClient().getBalance({ address });
    },

    async getAccountView(address: Address): Promise<FrameAccountView> {
      const balanceWei = await getClient().getBalance({ address });
      return { address, balanceWei };
    },

    send(): never {
      throw new NotImplemented();
    },

    execute(): never {
      throw new NotImplemented();
    },
  };
}
