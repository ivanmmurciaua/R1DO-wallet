import { keccak256, toHex } from "viem";
import { PasskeyArgType, extractPasskeyData } from "@safe-global/protocol-kit";

import { registryABI } from "./registryAbi";
import { REGISTRY_ADDRESS } from "@/app/constants";
import { client } from "./client";
import { PasskeyOnchainResponseType, PasskeyResponseType } from "@/types";
import { log } from "./common";

export const generateFingerprint = (userAuthKey: string) =>
  keccak256(toHex(userAuthKey));

// export const generateAuthKey = (username: string): string => `${username}_${navigator.platform.split(" ")[0].toLowerCase()}_${navigator.maxTouchPoints > 0 ? "mobile" : "desktop"}`;

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
      pubKeyCredParams: [
        {
          alg: -7,
          type: "public-key",
        },
      ],
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
    },
  });

  if (!passkeyCredential) {
    throw Error("Passkey creation failed: No credential was returned.");
  }

  // // TRACE - DEBUG
  // console.log(passkeyCredential);

  // const userAuthKey = displayName;

  // TRACE - DEBUG
  // console.log("Creating ", userAuthKey);

  return {
    passkeyCredential: passkeyCredential,
    userAuthKey: displayName,
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
    const { passkeyCredential, userAuthKey } = await generateCredential(
      username,
      external,
    );

    // Generate fingerprint
    const fingerprint = generateFingerprint(userAuthKey);
    // TRACE - DEBUG
    // console.log("Creating ", fingerprint);

    const passkey = (await extractPasskeyData(
      passkeyCredential,
    )) as PasskeyArgType;
    // TRACE - DEBUG
    // console.log("Passkey generated: ");
    // console.log(passkey);

    localStorage.setItem(
      username,
      JSON.stringify({
        fingerprint: "",
        passkey: {
          rawId: passkey.rawId,
          coordinates: {
            x: passkey.coordinates.x,
            y: passkey.coordinates.y,
          },
        },
      }),
    );

    return {
      fingerprint: fingerprint,
      passkey: passkey,
    };
  } catch (e: unknown) {
    console.error(e);
    await log("creatingPasskey", e);

    return {
      fingerprint: "",
      passkey: {
        rawId: "",
        coordinates: {
          x: "",
          y: "",
        },
      },
    };
  }
}

export async function loadFromDevice(rawId: string): Promise<boolean> {
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
      },
    })) as PublicKeyCredential;

    const assertionResponse =
      credential.response as AuthenticatorAssertionResponse;
    if (assertionResponse) {
      // TRACE - DEBUG
      // console.log(assertionResponse);
      console.log("OK");
    }
    return true;
  } catch (e: unknown) {
    console.error("Error loading passkey:", e);
    await log("Error loading passkey:", e);
    return false;
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
