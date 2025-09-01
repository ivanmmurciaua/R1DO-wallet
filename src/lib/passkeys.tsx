import { keccak256, toHex } from "viem";
import { PasskeyArgType, extractPasskeyData } from "@safe-global/protocol-kit";

import { registryABI } from "./registryAbi";
import { REGISTRY_ADDRESS } from "@/app/constants";
import { client } from "./client";
import { PasskeyResponseType } from "@/types";

export const generateFingerprint = (userAuthKey: string) =>
  keccak256(toHex(userAuthKey));

export const generateAuthKey = (username: string): string =>
  `${username}_${navigator.platform.replace(/\s/g, "_")}_${navigator.maxTouchPoints > 0 ? "mobile" : "desktop"}`;

// function generateAuthKey(username: string, credentials: Credential): string {
//   // Fingerprint data
//   const platform = navigator.maxTouchPoints > 0 ? "mobile" : "desktop";

//   // Aquí tienes info del authenticator:
//   const transports = credentials?.response.getTransports();
//   // // TRACE - DEBUG
//   console.log(transports); // → ["usb", "nfc", "ble", "internal"]

//   const attachment = credentials?.authenticatorAttachment;
//   // // TRACE - DEBUG
//   console.log(attachment); // → "platform" (biometría del dispositivo) → "cross-platform" (YubiKey, etc)

//   const authType =
//     transports.length > 0
//       ? `${attachment}_${transports.sort().join("-")}`
//       : attachment;

//   // // TRACE - DEBUG
//   console.log(authType);

//   return `${username}_${platform}_${authType}`;
// }

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
        name: `${displayName}_${navigator.userAgent.replace(/\s/g, "")}`,
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

  // const userAuthKey = generateAuthKey(displayName, passkeyCredential);
  const userAuthKey = generateAuthKey(displayName);

  // TRACE - DEBUG
  console.log("Creating ", userAuthKey);

  return {
    passkeyCredential: passkeyCredential,
    userAuthKey: userAuthKey,
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
  /////////////////////////////////////////////////////////////////////////////////////
  const { passkeyCredential, userAuthKey } = await generateCredential(
    username,
    external,
  );

  // Generate fingerprint
  const fingerprint = generateFingerprint(userAuthKey);
  localStorage.setItem(username, fingerprint);

  // TRACE - DEBUG
  console.log("Creating ", fingerprint);

  ////////////////////////////////////////////////////////////////////
  const passkey = await extractPasskeyData(passkeyCredential);

  // === MOCK ===
  // const result = {};

  // const { fingerprint, passkey } = result;

  // return {
  //   userAuthKey: result.userAuthKey,
  //   passkey: result.passkey,
  // };
  // === MOCK ===

  ////////////////////////////////////////////////////////////////////////////

  // TRACE - DEBUG
  console.log("Passkey generated: ");
  console.log(passkey);

  return {
    fingerprint: fingerprint,
    passkey: passkey,
  };
}

export async function load(test1: PasskeyArgType): Promise<boolean> {
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          {
            type: "public-key",
            id: new Uint8Array(Buffer.from(test1.rawId, "hex")),
          },
        ],
        userVerification: "preferred",
        timeout: 60_000,
      },
    })) as PublicKeyCredential;

    // // TRACE - DEBUG
    const assertionResponse =
      credential.response as AuthenticatorAssertionResponse;
    // TRACE - DEBUG
    if (assertionResponse) {
      // TRACE - DEBUG
      console.log(assertionResponse);
      console.log("OK");
    }

    return true;
  } catch (e) {
    console.error("Error loading passkey:", e);
    return false;
  }
}

//TODO: Merge in one function to read from SC
export async function existsPasskey(fingerprint: string): Promise<boolean> {
  const data = (await client.readContract({
    address: REGISTRY_ADDRESS,
    abi: registryABI,
    functionName: "isRegistered",
    args: [fingerprint],
  })) as boolean;

  return data;
}

//TODO: Type that
export async function getPasskey(fingerprint: string) {
  const data = await client.readContract({
    address: REGISTRY_ADDRESS,
    abi: registryABI,
    functionName: "getPasskey",
    args: [fingerprint],
  });

  return data;
}
