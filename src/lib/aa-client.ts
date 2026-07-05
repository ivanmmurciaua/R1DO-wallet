"use client";
/*
  aa-client.ts — the Account Abstraction factory (permissionless).

  Replaces the relay-kit Safe4337Pack path. relay-kit's protocol-kit resolves the
  Safe contract addresses (singleton/factory/module) from @safe-global/safe-deployments
  at runtime, so a deployments bump could silently move the derived Safe address and
  lock users out. permissionless lets us PIN every address explicitly (aa-config.ts),
  which is the whole point of this migration.

  Two builders, same pinned params:
    • buildSafeAccount  — the counterfactual Safe smart account (has .address,
                          signs UserOps). Reads only; no bundler needed.
    • buildSafeClient   — the above wrapped in a SmartAccountClient with the
                          Pimlico bundler + sponsoring paymaster (for sending).

  L1 vs L2 singleton is chosen STATICALLY from networks.ts (`safeSingleton`) —
  NEVER getCode-probed (that needs an RPC and breaks the offline/counterfactual
  derivation login + stealth rely on). This is the deliberate difference from
  ~/Escritorio/the-great-dev/src/lib/aa-client-factory.ts, which probes on-chain
  for cross-L1 compatibility we don't need (our chains are pinned per-deployment).

  ⚠️ ADDRESS EQUIVALENCE — before switching the live flows over to this factory,
  verify it derives the SAME address relay-kit does for an existing Sepolia owner
  (same owner + saltNonce 0 → same Safe). If it differs, a pinned address here
  doesn't match the safe-deployments default relay-kit used → existing users would
  be locked out. The pinned set (aa-config.ts) is the canonical 1.4.1 / 4337-0.3.0
  deployment, which is exactly what safe-deployments returns, so they SHOULD match
  — but this is a must-run check, not an assumption.
*/
import {
  createPublicClient,
  http,
  fallback,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
} from "viem";
import type { UserOperation } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  ENTRYPOINT_ADDRESS,
  ENTRYPOINT_VERSION,
  SAFE_VERSION,
  SAFE_L1_SINGLETON_ADDRESS,
  SAFE_L2_SINGLETON_ADDRESS,
  SAFE_PROXY_FACTORY_ADDRESS,
  SAFE_MODULE_SETUP_ADDRESS,
  SAFE_4337_MODULE_ADDRESS,
  MULTI_SEND_ADDRESS,
  MULTI_SEND_CALL_ONLY_ADDRESS,
  SAFE_SALT_NONCE,
} from "./aa-config";
import { activeNetwork, type Network } from "./networks";
import { bundlerUrlFor } from "@/app/constants";

/** The Safe singleton for a network — L1 (`Safe`) vs L2 (`SafeL2`), chosen
    STATICALLY from networks.ts. It enters the CREATE2 initcode, so this choice is
    address-critical: never detect it at runtime. See aa-config.ts (the footgun).
    Defaults to the active network; pass a network to build for a specific chain
    (e.g. the directory network). Under the SafeL2-everywhere policy this returns
    the same singleton for every standard chain → one global address. */
export function activeSafeSingleton(net: Network = activeNetwork()): Address {
  return net.safeSingleton === "l2"
    ? SAFE_L2_SINGLETON_ADDRESS
    : SAFE_L1_SINGLETON_ADDRESS;
}

/** Read client for AA operations — deploy status (getCode), nonce, gas — for a
    given network. Prefers the network's OPS RPC (index 1, a different node than the
    scanner's primary at index 0) so a heavy stealth scan and a wallet op never
    fight over the same rate-limited endpoint; falls back across the rest. Defaults
    to the active network; the directory path passes the directory network so its
    reads hit Arbitrum, not the active chain. */
function opsPublicClient(net: Network = activeNetwork()) {
  const rpcs = net.rpcUrls;
  const opsUrl = rpcs[1] ?? rpcs[0];
  const urls = [opsUrl, ...rpcs.filter((u) => u !== opsUrl)];
  return createPublicClient({
    chain: net.chain as Chain,
    transport: fallback(urls.map((u) => http(u))),
  });
}

/** The pinned Safe params shared by both builders. Every entry here (except the
    bundler/paymaster/RPC, which aren't address-critical) feeds the counterfactual
    address — frozen via aa-config.ts. The only per-network input is the singleton,
    and SafeL2-everywhere makes even that identical across standard chains. */
function pinnedSafeParams(saltNonce: bigint, net: Network = activeNetwork()) {
  return {
    version: SAFE_VERSION,
    entryPoint: { address: ENTRYPOINT_ADDRESS, version: ENTRYPOINT_VERSION },
    safeSingletonAddress: activeSafeSingleton(net),
    safeProxyFactoryAddress: SAFE_PROXY_FACTORY_ADDRESS,
    safe4337ModuleAddress: SAFE_4337_MODULE_ADDRESS,
    safeModuleSetupAddress: SAFE_MODULE_SETUP_ADDRESS,
    multiSendAddress: MULTI_SEND_ADDRESS,
    multiSendCallOnlyAddress: MULTI_SEND_CALL_ONLY_ADDRESS,
    saltNonce,
  } as const;
}

/* ── Observability (testing pass) ────────────────────────────────────────────
   Greppable `[aa]` logs tracing the permissionless engine end-to-end during the
   Sepolia validation: the pinned config once, then per Safe derivation (chain +
   L1/L2 singleton + owner + salt → address), per prepared UserOp (gas breakdown +
   whether it deploys the Safe), and per submit (hash). Complements the per-op-type
   `[gas]`/`[makeTx]`/`[shield]`… logs in deploy.tsx. Trim once the engine is trusted. */
let _pinnedLogged = false;
function logPinnedOnce(): void {
  if (_pinnedLogged) return;
  _pinnedLogged = true;
  console.log(
    `[aa] pinned config — entrypoint=${ENTRYPOINT_ADDRESS}(v${ENTRYPOINT_VERSION}) safe=v${SAFE_VERSION} ` +
      `factory=${SAFE_PROXY_FACTORY_ADDRESS} moduleSetup=${SAFE_MODULE_SETUP_ADDRESS} module4337=${SAFE_4337_MODULE_ADDRESS} ` +
      `singletonL1=${SAFE_L1_SINGLETON_ADDRESS} singletonL2=${SAFE_L2_SINGLETON_ADDRESS} saltDefault=${SAFE_SALT_NONCE}`,
  );
}

/** One line per Safe derivation/build — the observability spine of the migration. */
function logSafe(
  kind: string,
  owner: Address,
  saltNonce: bigint,
  safe: Address,
  net: Network = activeNetwork(),
): void {
  logPinnedOnce();
  console.log(
    `[aa] ${kind} — chain=${net.chain.name}(${net.chain.id}) ` +
      `singleton=${net.safeSingleton}(${activeSafeSingleton(net)}) owner=${owner} salt=${saltNonce} → safe=${safe}`,
  );
}

/**
 * The counterfactual Safe smart account for an owner private key (the self/login
 * path and the receiver-spend path — anyone holding the PRF-derived owner key).
 * Returns a permissionless SmartAccount: `.address` is the counterfactual Safe,
 * and it signs UserOperations. No bundler involved — reads only.
 *
 * `saltNonce` defaults to 0 (the login Safe). Stealth passes the per-payment salt
 * derived from `h` (converted to bigint) so sender and receiver predict the same
 * address without coordination.
 */
export async function buildSafeAccount(
  ownerPrivateKey: `0x${string}`,
  saltNonce: bigint = SAFE_SALT_NONCE,
  net: Network = activeNetwork(),
) {
  const owner = privateKeyToAccount(ownerPrivateKey);
  const account = await toSafeSmartAccount({
    client: opsPublicClient(net),
    owners: [owner],
    ...pinnedSafeParams(saltNonce, net),
  });
  logSafe("build", owner.address, saltNonce, account.address, net);
  return account;
}

/**
 * The sending client: a SmartAccountClient over the Safe account, wired to the
 * Pimlico bundler + sponsoring paymaster (both via our /api/pimlico proxy, so the
 * API key never reaches the bundle). Use this to send/deploy; use buildSafeAccount
 * when you only need the address or to sign.
 */
export async function buildSafeClient(
  ownerPrivateKey: `0x${string}`,
  saltNonce: bigint = SAFE_SALT_NONCE,
  net: Network = activeNetwork(),
) {
  const account = await buildSafeAccount(ownerPrivateKey, saltNonce, net);
  // Bundler + paymaster both go through our proxy, tagged with the network id so
  // the server forwards to THIS chain's Pimlico slug (a directory op on Arbitrum
  // routes to Arbitrum even while the app's active chain is elsewhere).
  const bundlerUrl = bundlerUrlFor(net.id);
  const pimlicoClient = createPimlicoClient({
    transport: http(bundlerUrl),
    entryPoint: { address: ENTRYPOINT_ADDRESS, version: ENTRYPOINT_VERSION },
  });
  return createSmartAccountClient({
    account,
    chain: net.chain as Chain,
    bundlerTransport: http(bundlerUrl),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });
}

/* ── relay-kit-shaped adapter ────────────────────────────────────────────────
   The codebase was written against relay-kit's Safe4337Pack. Rather than touch
   every helper (makeTx, sendTxsViaSafe, gasWeiOf, submitSendWithFee, the draw
   path…) and ~40 call sites, SafeWallet wraps a permissionless SmartAccountClient
   and re-exposes the SAME surface: createTransaction / signSafeOperation /
   executeTransaction / getUserOperationReceipt + a `protocolKit` with getAddress /
   getBalance. Only the construction sites (Safe4337Pack.init → buildSafeWallet)
   and the static type change. */

type Call = { to: Address; data: Hex; value: bigint };

/** A prepared (not-yet-submitted) UserOperation, shaped like relay-kit's
 *  SafeOperation for drop-in use: `getUserOperation()` exposes the gas fields the
 *  fee logic reads (gasWeiOf), and `calls` is kept to submit at execute time. */
export type BuiltUserOp = {
  calls: Call[];
  userOperation: UserOperation<"0.7">;
  getUserOperation: () => UserOperation<"0.7">;
};

type SmartClient = Awaited<ReturnType<typeof buildSafeClient>>;

/**
 * permissionless SmartAccountClient behind relay-kit's Safe4337Pack surface.
 *
 * Build/send split mirrors the relay-kit flow the fee logic relies on:
 *  • createTransaction PREPARES the op so gasWeiOf can read real gas before submit.
 *  • executeTransaction SUBMITS from the calls — viem re-prepares+signs+sends as one
 *    atomic step, so the signature always matches the exact op the bundler gets (no
 *    stale-signature risk). Measured gas ≈ sent gas (same calls); the fee is an
 *    estimate either way, and Pimlico sponsors the actual gas.
 */
export class SafeWallet {
  /** ownerKey + saltNonce + network are retained so the wallet can spawn a sibling
   *  bound to a DIFFERENT chain (onNetwork). The owner key is already resident in
   *  the account signer for the session, so this holds no new secret — it just lets
   *  the same owner operate the (SafeL2-identical) address on another chain, which
   *  is how directory ops are pinned to Arbitrum from any active chain. */
  constructor(
    private readonly client: SmartClient,
    private readonly ownerKey: `0x${string}`,
    private readonly saltNonce: bigint,
    private readonly network: Network,
  ) {}

  /** Counterfactual Safe address (deployed on the first UserOp). */
  get address(): Address {
    return this.client.account.address;
  }

  /** relay-kit parity shim for the `wallet.protocolKit.*` sites. Reads hit THIS
   *  wallet's network (so a directory-bound wallet checks deploy/balance on Arbitrum). */
  readonly protocolKit = {
    getAddress: async (): Promise<Address> => this.client.account.address,
    getBalance: async (): Promise<bigint> =>
      opsPublicClient(this.network).getBalance({ address: this.client.account.address }),
    isSafeDeployed: async (): Promise<boolean> => {
      const code = await opsPublicClient(this.network).getCode({ address: this.client.account.address });
      return !!code && code !== "0x";
    },
  };

  /** A sibling wallet for the SAME owner/saltNonce bound to a DIFFERENT network.
   *  Because SafeL2 is used everywhere, the address is identical — only the chain
   *  the UserOp executes on (RPC + Pimlico slug) changes. Used to pin directory
   *  writes to the canonical directory network from any active chain. Returns
   *  `this` when already on that network. */
  async onNetwork(net: Network): Promise<SafeWallet> {
    if (net.id === this.network.id) return this;
    return buildSafeWallet(this.ownerKey, this.saltNonce, net);
  }

  async createTransaction({
    transactions,
  }: {
    transactions: { to: string; data: string; value: string }[];
  }): Promise<BuiltUserOp> {
    const calls: Call[] = transactions.map((t) => ({
      to: t.to as Address,
      data: (t.data || "0x") as Hex,
      value: BigInt(t.value || "0"),
    }));
    const userOperation = (await this.client.prepareUserOperation({
      calls,
    })) as unknown as UserOperation<"0.7">;
    const uo = userOperation;
    console.log(
      `[aa] prepared op — safe=${this.address} nonce=${uo.nonce} calls=${calls.length} ` +
        `deploy=${uo.factory ? "yes(+factory)" : "no"} paymaster=${uo.paymaster ?? "none"} | ` +
        `callGasLimit=${uo.callGasLimit} verificationGasLimit=${uo.verificationGasLimit} ` +
        `preVerificationGas=${uo.preVerificationGas} maxFeePerGas=${uo.maxFeePerGas} ` +
        `maxPriorityFeePerGas=${uo.maxPriorityFeePerGas}`,
    );
    return { calls, userOperation, getUserOperation: () => userOperation };
  }

  /** No-op passthrough: signing is deferred to executeTransaction so the signature
   *  matches the exact op the bundler receives. Kept for call-site compatibility
   *  (`const signed = await wallet.signSafeOperation(op); if (signed) …`). */
  async signSafeOperation(op: BuiltUserOp): Promise<BuiltUserOp> {
    return op;
  }

  /** Submit the op → the UserOperation hash. */
  async executeTransaction({
    executable,
  }: {
    executable: BuiltUserOp;
  }): Promise<`0x${string}`> {
    console.log(`[aa] submit — safe=${this.address} calls=${executable.calls.length}`);
    const hash = await this.client.sendUserOperation({ calls: executable.calls });
    console.log(`[aa] userOp submitted — safe=${this.address} hash=${hash}`);
    return hash;
  }

  /** null while pending (relay-kit returned falsy too), the receipt once mined
   *  ({ success, receipt: { transactionHash } }). viem throws when not-yet-found. */
  async getUserOperationReceipt(hash: string) {
    try {
      return await this.client.getUserOperationReceipt({ hash: hash as `0x${string}` });
    } catch {
      return null;
    }
  }
}

/** Drop-in replacement for `Safe4337Pack.init(...)`: a ready SafeWallet from an
 *  owner private key. `saltNonce` selects the Safe (0 = login; the stealth
 *  per-payment salt otherwise). */
export async function buildSafeWallet(
  ownerPrivateKey: `0x${string}`,
  saltNonce: bigint = SAFE_SALT_NONCE,
  net: Network = activeNetwork(),
): Promise<SafeWallet> {
  return new SafeWallet(
    await buildSafeClient(ownerPrivateKey, saltNonce, net),
    ownerPrivateKey,
    saltNonce,
    net,
  );
}

/** A signer-shaped object carrying ONLY an address; its sign methods throw (never
 *  invoked during address derivation). Lets toSafeSmartAccount compute a Safe
 *  address from an owner address with no private key. */
function viewOnlyOwner(address: Address): LocalAccount {
  const nope = async (): Promise<never> => {
    throw new Error("view-only owner cannot sign");
  };
  // Runtime-verified equivalent to a real key for ADDRESS derivation (view == real);
  // the shape isn't a full LocalAccount, hence the cast.
  return {
    address,
    type: "local",
    source: "custom",
    publicKey: "0x",
    signMessage: nope,
    signTypedData: nope,
    sign: nope,
    signTransaction: nope,
  } as unknown as LocalAccount;
}

/**
 * Predict a Safe address from an owner ADDRESS alone (no private key) — the stealth
 * SENDER path: it knows only the receiver's derived owner address yet must predict
 * the same Safe the receiver later derives from the key. Uses a view-only owner
 * through the IDENTICAL toSafeSmartAccount derivation, so the predicted address
 * matches the key-backed one byte-for-byte (verified offline: view == real). Pinned
 * params + the active chain's L1/L2 singleton, same as buildSafeAccount.
 */
export async function predictSafeAddress(
  ownerAddress: Address,
  saltNonce: bigint = SAFE_SALT_NONCE,
): Promise<Address> {
  const account = await toSafeSmartAccount({
    client: opsPublicClient(),
    owners: [viewOnlyOwner(ownerAddress)],
    ...pinnedSafeParams(saltNonce),
  });
  logSafe("predict", ownerAddress, saltNonce, account.address);
  return account.address;
}
