## SafeKey Wallet

SafeKey Wallet is a dApp for normies that creates a very simple EVM wallet using a passkey and Safe{Core} SDK. It preserves decentralization and self-custody without relying on external providers like Privy, Web3Auth, or Magic.

### Description
**SafeKey Wallet** generates keys and an EVM-compatible wallet using the device passkey (Secure Enclave / Secure Element). Designed for non-technical users who want full control of their assets without sacrificing usability.

### Rationale
I don't want you to depend on centralized services to custody keys. SafeKey Wallet aims to give control back to the user, accepting the responsibilities and risks of self-custody. I don't seek to sell your identity or monetize your key.

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
- Passkeys depend on specific hardware/software: **only works on devices with passkeys (Secure Enclave / Secure Element or External providers as Google and Apple)**.
- Limited portability: moving a passkey between devices can be complex or require OS-level sync.
- Recovery: if a user loses access to their device and didn't sync the passkey, recovery is difficult — same risk as other self-custody options.
- Compatibility: not all browsers and environments implement WebAuthn/passkeys the same way.
- UX edge-cases: native authentication prompts can confuse non-technical users.

### Roadmap
- [ ] Integrate recovery flows (social recovery, ZKProofs to recover funds, Key rotation on chain)
- [ ] Improve cross-browser and device compatibility
- [ ] E2E tests and security audit
- [ ] UX/UI improvements for non-technical users (guided onboarding)
- ...

---

### Contributions
Contributions welcome. Open issues for bugs and features; PRs will be reviewed. Keep commits clear and add tests when possible.

### License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2025 Iván M.M