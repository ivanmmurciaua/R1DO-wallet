import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Mnemonic } from "ethers";

/** The RAILGUN 0zk wallet's BIP39 mnemonic, derived deterministically from the
    passkey PRF (HKDF-SHA256, "seed" branch → 16 bytes entropy → 12-word phrase).
    SINGLE SOURCE OF TRUTH for the 0zk seed: createPoolWallet uses it to create
    the wallet, and the "Show seed" backup uses it to display the same phrase.
    Importing this phrase into any standard RAILGUN wallet recovers the identical
    0zk address (and therefore the funds) — that's the whole point of the backup.

    Kept deliberately lightweight (only @noble + ethers, NO Railgun SDK/WASM) so
    it can be imported from UI code without dragging the engine into the SSR
    bundle (a static Railgun import in a client component crashes `next start`). */
export function poolMnemonicFromPRF(prf: Uint8Array): string {
  const entropy = hkdf(sha256, prf, undefined, "r1do/pool/railgun/seed/v1", 16);
  const phrase = Mnemonic.fromEntropy("0x" + bytesToHex(entropy)).phrase;
  entropy.fill(0);
  return phrase;
}
