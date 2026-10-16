// Frame-rail AccountPQ address derivation (FASE 1.2a).
//
// The PQ account is deployed at a DETERMINISTIC CREATE2 address so the wallet can derive
// it from the passkey alone, with no stored state, and re-derive it after a devnet reset.
// The address is a pure function of public inputs:
//
//   address = keccak256(0xff || factory || salt || keccak256(initcode))[12:]
//
// with salt = commit (the key commitment) and
//
//   initcode = AccountPQ runtime creation code || commit(32) || pad(12) || verifier(20)
//
// The AccountPQ constructor (see contracts/AccountPQ.yul) copies those 64 trailing bytes
// into storage slots 0 (commit) and 1 (verifier). Because the verifier address is part of
// the initcode, a re-anchor (devnet reset redeploys the verifier) changes the account
// address too: that is by design and documented in AccountPQ.yul.
//
// IMPORTANT: who PAYS to deploy is NOT part of this derivation. An EOA, a relayer or a
// sponsor can all CREATE2 to the same address, so the deploy mechanism can change (EOA
// now, sponsor/AA later) without the account address ever moving.
import { concat, getAddress, keccak256, pad, type Hex } from "viem";

/** Length of the appended constructor tail: commit(32) + left-padded verifier(32). */
export const CTOR_TAIL_BYTES = 64;

/** Build the AccountPQ constructor tail: commit(32) || pad(12) || verifier(20) = 64 bytes.
    This is what AccountPQ.yul's constructor reads (slot 0 = commit, slot 1 = verifier). */
export function accountCtorTail(commit: Hex, verifier: Hex): Hex {
  return concat([commit, pad(verifier, { size: 32, dir: "left" })]);
}

/** Full CREATE2 initcode for an AccountPQ: creation code || ctor tail.
    `accountBin` is the compiled AccountPQ creation code (no constructor args). */
export function accountInitcode(accountBin: Hex, commit: Hex, verifier: Hex): Hex {
  return concat([accountBin, accountCtorTail(commit, verifier)]);
}

/** Standard CREATE2 address: keccak256(0xff || factory || salt || keccak256(initcode))[12:]. */
export function create2Address(factory: Hex, salt: Hex, initcode: Hex): Hex {
  const hash = keccak256(concat(["0xff", factory, salt, keccak256(initcode)]));
  return getAddress(`0x${hash.slice(-40)}`);
}

/** Inputs needed to place an AccountPQ at its deterministic address. */
export interface AccountAddressInput {
  /** The deployed CREATE2 factory (a rail singleton). */
  factory: Hex;
  /** The key commitment = keccak256(expanded pk). Also used as the CREATE2 salt. */
  commit: Hex;
  /** The live ML-DSA verifier (baked into the account; changes the address on re-anchor). */
  verifier: Hex;
  /** The AccountPQ creation code (fixture bytes). */
  accountBin: Hex;
}

/** Derive the deterministic AccountPQ address and the initcode used to deploy it.
    salt = commit, so the account is a pure function of (factory, commit, verifier). */
export function deriveAccount(input: AccountAddressInput): { address: Hex; initcode: Hex; salt: Hex } {
  const initcode = accountInitcode(input.accountBin, input.commit, input.verifier);
  const salt = input.commit;
  return { address: create2Address(input.factory, salt, initcode), initcode, salt };
}

/** Factory calldata for a CREATE2 deploy: salt(32) || initcode (Factory.yul layout). */
export function factoryDeployCalldata(salt: Hex, initcode: Hex): Hex {
  return concat([salt, initcode]);
}
