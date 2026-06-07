import { keccak256, toHex } from "viem";
import { PasskeyArgType, extractPasskeyData } from "@safe-global/protocol-kit";
import { PACKED_VERIFIERS_HEX } from "@/app/constants";

import { registryABI } from "./registryAbi";
import { REGISTRY_ADDRESS } from "@/app/constants";
import { client } from "./client";
import { PasskeyOnchainResponseType, PasskeyResponseType } from "@/types";
import { log } from "./common";
import { setLocalData } from "./localstorage";

export const generateFingerprint = (userAuthKey: string) =>
  keccak256(toHex(userAuthKey));

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
  const authenticatorSelection: AuthenticatorSelectionCriteria = {
    userVerification: "preferred",
  };

  if (external) {
    authenticatorSelection.requireResidentKey = true;
    authenticatorSelection.residentKey = "required";
  }

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
    userAuthKey: displayName,
    prfOutput,
  };
}

/**
 * Create a passkey using WebAuthn API.
 * @returns {Promise<PasskeyResponseType>} Object with rawId and coordinates related with a fingerprint.
 * @throws {Error} If passkey creation fails.
 */
export async function createPasskey(
  username: string,
  external: boolean = false,
): Promise<PasskeyResponseType> {
  try {
    const { passkeyCredential, userAuthKey, prfOutput } = await generateCredential(
      username,
      external,
    );

    // Generate fingerprint
    const fingerprint = generateFingerprint(userAuthKey);
    // TRACE - DEBUG
    // console.log("Creating ", fingerprint);

    const extracted = await extractPasskeyData(passkeyCredential);
    const passkey: PasskeyArgType = {
      ...extracted,
      verifierAddress: PACKED_VERIFIERS_HEX,
    };

    setLocalData(username, "", passkey);

    return {
      fingerprint,
      passkey,
      prfOutput,
    };
  } catch (e: unknown) {
    console.error(e);
    await log("creatingPasskey", e);

    return {
      fingerprint: "",
      passkey: {
        rawId: "",
        coordinates: { x: "", y: "" },
        verifierAddress: "",
      },
    };
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

export async function readFromSC(
  functionName: string,
  fingerprint: string,
): Promise<boolean | PasskeyOnchainResponseType | null> {
  try {
    const data = (await client.readContract({
      address: REGISTRY_ADDRESS,
      abi: registryABI,
      functionName: functionName,
      args: [fingerprint],
    })) as boolean | PasskeyOnchainResponseType;
    return data;
  } catch (e: unknown) {
    console.error(e);
    await log(functionName, e);
    return null;
  }
}
