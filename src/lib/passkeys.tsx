import { PasskeyResponseType } from "@/types";
import { log } from "./common";

export const checkPRFSupport = async (): Promise<boolean> => {
  try {
    if (typeof PublicKeyCredential === "undefined") {
      console.log("[PRF] WebAuthn not available");
      return false;
    }

    // getClientCapabilities is available in Chrome 132+ / Edge 132+
    if (!("getClientCapabilities" in PublicKeyCredential)) {
      console.log("[PRF] getClientCapabilities not supported in this browser");
      return false;
    }

    const caps = await (
      PublicKeyCredential as unknown as {
        getClientCapabilities: () => Promise<Record<string, unknown>>;
      }
    ).getClientCapabilities();

    const prfSupported = caps["extension:prf"] === true;
    console.log("[PRF] Client capabilities:", caps);
    console.log("[PRF] PRF extension supported:", prfSupported);
    return prfSupported;
  } catch (e) {
    console.error("[PRF] Error checking capabilities:", e);
    return false;
  }
};

// export const generateAuthKey = (username: string): string => `${username}_${navigator.platform.split(" ")[0].toLowerCase()}_${navigator.maxTouchPoints > 0 ? "mobile" : "desktop"}`;

// Deterministic PRF salt — domain separator for R1DO stealth key derivation
const PRF_SALT = new TextEncoder().encode("r1do-stealth-v1").buffer;

export async function generateCredential(
  displayName: string,
  external: boolean = false,
) {
  // Honest "Storage Type" lever — the user genuinely chooses where the key lives:
  //
  //   external = true  → RESIDENT / discoverable passkey. The provider
  //     (iCloud / Google / 1Password) stores and SYNCS it; recoverable from
  //     the passkey alone on a new device. The directory is optional.
  //
  //   external = false → NON-RESIDENT, device-bound. The private key stays
  //     wrapped in the credential ID inside THIS authenticator's secure
  //     element — no provider sync, no "save passkey" popup. To use it we
  //     must supply the rawId (allowCredentials); the encrypted on-chain
  //     directory is the off-device copy of that rawId. Bound to this chip:
  //     lose the device with no sync = lose access (the "i" hint says so).
  //
  // PRF rides on both paths identically — key derivation is unaffected by
  // discoverability, so the choice never changes the wallet's keys.
  const authenticatorSelection: AuthenticatorSelectionCriteria = external
    ? {
        userVerification: "preferred",
        requireResidentKey: true,
        residentKey: "required",
      }
    : {
        userVerification: "preferred",
        requireResidentKey: false,
        residentKey: "discouraged",
      };

  const passkeyCredential = await navigator.credentials.create({
    publicKey: {
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      authenticatorSelection,
      rp: {
        name: `${displayName}_wallet`,
        id: window.location.hostname,
      },
      user: {
        displayName,
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: `${displayName}_${new Date().toISOString()}`,
      },
      timeout: 60_000,
      attestation: "none",
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
    },
  });

  if (!passkeyCredential) {
    throw Error("Passkey creation failed: No credential was returned.");
  }

  const extResults = (passkeyCredential as PublicKeyCredential).getClientExtensionResults() as
    AuthenticationExtensionsClientOutputs & {
      prf?: { results?: { first?: ArrayBuffer } };
    };

  const prfOutput = extResults.prf?.results?.first
    ? new Uint8Array(extResults.prf.results.first)
    : undefined;

  console.log(`[generateCredential] PRF extension result: ${prfOutput ? `✓ enabled (${prfOutput.length} bytes)` : "✗ not supported by this authenticator"}`);

  return {
    passkeyCredential,
    prfOutput,
  };
}

/**
 * Create a passkey using WebAuthn API.
 * v2: only the rawId (credential pointer) and the PRF output matter — the
 * P-256 public key never leaves the authenticator's role of gating the PRF.
 * Nothing is persisted here; the caller stores the credential only after
 * the PRF check passes.
 * @returns {Promise<PasskeyResponseType>} rawId is "" if creation failed.
 */
export async function createPasskey(
  username: string,
  external: boolean = false,
): Promise<PasskeyResponseType> {
  try {
    const { passkeyCredential, prfOutput } = await generateCredential(
      username,
      external,
    );

    const rawId = Buffer.from(
      (passkeyCredential as PublicKeyCredential).rawId,
    ).toString("hex");

    return { rawId, prfOutput };
  } catch (e: unknown) {
    console.error(e);
    await log("creatingPasskey", e);
    return { rawId: "" };
  }
}

// Returns PRF output (32 bytes) if the authenticator supports it, null if not, throws if credential not found.
export async function loadFromDevice(rawId: string): Promise<Uint8Array | null> {
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          {
            type: "public-key",
            id: new Uint8Array(Buffer.from(rawId, "hex")),
          },
        ],
        userVerification: "preferred",
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: PRF_SALT } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;

    const extResults = credential.getClientExtensionResults() as
      AuthenticationExtensionsClientOutputs & {
        prf?: { results?: { first?: ArrayBuffer } };
      };

    const prfOutput = extResults.prf?.results?.first
      ? new Uint8Array(extResults.prf.results.first)
      : null;

    console.log(`[loadFromDevice] PRF: ${prfOutput ? `✓ (${prfOutput.length} bytes)` : "✗ not supported by this authenticator"}`);

    // null  → credential not found (falsy)
    // Uint8Array(0)  → found, no PRF (truthy)
    // Uint8Array(32) → found + PRF output (truthy)
    return prfOutput ?? new Uint8Array(0);
  } catch (e: unknown) {
    console.error("Error loading passkey:", e);
    await log("Error loading passkey:", e);
    return null;
  }
}

// v2: the legacy on-chain PasskeyRegistry (readFromSC) is gone. Username
// resolution lives in src/lib/registry-v2.ts (Argon2id-encrypted directory).
