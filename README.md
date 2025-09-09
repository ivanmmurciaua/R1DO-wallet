## SafeKey Wallet

SafeKey Wallet is a dApp for normies that creates a very simple EVM smart wallet using a passkey and [Safe{Core} SDK](https://github.com/safe-global/safe-core-sdk). It preserves decentralization and self-custody without relying on external providers like Privy, Web3Auth, or Magic.

### Description
**SafeKey Wallet** generates keys and an EVM-compatible smart wallet using the device passkey (Secure Enclave / Secure Element). Designed for non-technical users who want full control of their assets without sacrificing usability.

> [!CAUTION]
> This is a very lightweight version of a wallet. Please, don't use it to store the savings of your entire life.

### Rationale

On a daily basis, users rely on multiple services to authenticate themselves. This poses a significant risk to their information, as it depends on the security of a third party, which cannot be audited and is generally not transparent about how it handles their data. In the web3 world, a series of services for social login, i.e., using social networks and email, has recently emerged.

Although less dangerous than other services, this is still risky because your identity depends on a unique ID hosted on these companies' servers, which is usually linked to the EOA they generate. In addition, these services, as companies, are required to keep minimum connection records, including IPs, timestamps, device IDs, etc.

For several years now, the [FIDO Alliance](https://fidoalliance.org/overview/), an open association made up of leading technology companies, has been looking for ways to eliminate passwords from our lives in order to reduce phishing and various security breaches.

Among the most important milestones is the creation of [passkeys](https://fidoalliance.org/passkeys/), which allow users to sign in to apps and websites using the same process they use to unlock their device (biometrics, PIN, or pattern).

Now, with the [precompilation of the secp256r1 curve](https://eips.ethereum.org/EIPS/eip-7951) in EVM networks, the door is open to the option of having a smart wallet thanks to passkeys.

This method is simple and clean for users who are not used to dealing with seed phrases, while maintaining self-custody.

> I don't want normie users to depend on third services that may trade their data just to create a wallet and interact with it, that's not why I entered this wonderful world of web3. And although traditional methods (seed phrases, passphrases, dice, paper) **are the most recommended**, SafeKey Wallet aims to give control back to the user and offers an easy and simple way to interact with a wallet with no other requirements than a username (accepting the responsibilities and risks of self-custody).

### Why not passwords?
Relying on passwords mean trust in a server trusting a server. A server that you don't manage. Why choose passkeys? Easy, [KISS](https://en.wikipedia.org/wiki/KISS_principle). Instead of trusting a **private** server, you are storing your **public** key coordinates in a public smart contract related to your user (stored as a hashed fingerprint).

This maintains user's privacy while storing the information on a public server that everyone can see, but no one can decrypt. Even so, one potential danger is that they know your public key and the address derived from it. This is not a problem in itself due to the very nature of [asymmetric key cryptography](https://en.wikipedia.org/wiki/Public-key_cryptography).

> [!WARNING]
> If you do not choose the external providers option, you will not be able to manage your passkey, as it is generated internally on your device and **if you lose it or change it, you will lose complete access to your wallet**.

### Technologies
- Next.js
- EVM-compatible chains (Ethereum and compatibles)
- Passkeys / WebAuthn (Secure Enclave / Secure Element)

### Get Started
```bash
npm install
npm run dev
```

### Known issues with passkeys
- Passkeys depend on specific hardware/software: **only works** on devices with passkeys (Secure Enclave / Secure Element or External providers services as Google or Apple) and **browsers with [WebAuthAPI PublicKeyCredential](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential) allowed**.
- **Limited portability**: moving a passkey between devices can be complex or require OS-level sync.
- **Recovery**: if a user loses access to their device and didn't sync the passkey using external providers, recovery, is difficult — same risk as other self-custody options e.g if you lose your seedphrase paper.
- **Compatibility**: not all browsers and environments implement WebAuthn/passkeys the same way, e.g Android Webviews.
- UX edge-cases: **native authentication prompts can confuse** non-technical users.

### Roadmap
- [X] Improve cross-browser and device compatibility.
- [X] Import passkeys.
- [X] Improve SC.
- [ ] Integrate recovery flows (social recovery, ZKProofs to recover funds, Key rotation on chain).
- [ ] UX/UI improvements for non-technical users (guided onboarding).
- [ ] Integrate DeFi options.
- [ ] More privacy, integrate stealth mechanisms.
- [ ] E2E tests and security audit
- ...

---

### Contributions
Contributions welcome. Open issues for bugs and features; PRs will be reviewed. Keep commits clear and add tests when possible.

### License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2025 Iván M.M
