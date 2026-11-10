# ADR-0036: Deposit sheet with wallet address, QR code and arrival detection

- Status: Accepted (owner request, 2026-11-10: "like Hyperliquid")
- Context: the owner wants funding to look and work like Hyperliquid's
  account page: Deposit and Withdraw buttons, then "Transfer crypto" (an
  address and QR code to send to) or "Buy with fiat". Hyperliquid's address
  comes from a third-party bridge (Across) and its fiat purchase from a
  payment provider. Neither works on a testnet. The roadmap (Sprint 10,
  item 5) keeps both for the launch phase.

## Decision

Balances shows **Deposit** and **Withdraw**. Each opens a sheet: at the
bottom on phones, centred on wider screens. It is rendered through a portal,
closes with Escape (unless a wallet request is running) and is labelled as a
modal dialog.

### Deposit → Transfer crypto

- **Selectors:** the asset, and the network. Only one network exists, so its
  selector is disabled.
- **Address:** the user's **own wallet address**, as a locally drawn QR code
  (`qrcode`, data URL; no image service) and as tap-to-copy text.
  - It is stated plainly that this is the user's wallet, not the vault.
  - This differs from Hyperliquid, whose address belongs to a bridge. The
    page does not pretend otherwise.
- **Summary:**
  - what the wallet holds (token and gas);
  - what the user receives;
  - processing: `confirmations` from `/v1/vault/config`.
- **Arrival detection:** while the view is open, `GET /v1/vault/wallet` is
  polled every 8 s.
  - The endpoint reads the wallet's token and gas balances on the vault
    network.
  - When a balance rises, the page shows "{asset} arrived in your wallet".
- **Move to exchange:** an amount with **Max**, then the existing approve
  and deposit transactions. The contract's deposit cap is checked before the
  wallet prompt (ADR-0033).
- **Test tokens:** a mint or faucet link, and the gas help.
- **Red warning:** send only this asset on this network. Other assets, other
  networks, or a transfer straight to the vault are lost. It links to the
  deposit guide.

### Deposit → Buy with card

- Shown with an **At launch** badge. Selecting it says:
  - it is not available on the testnet;
  - a licensed provider, named on the page, will do it at launch;
  - the exchange never holds card details or money;
  - legal approval comes first, so there is no date.
- **No provider is named or implied today.**

### Withdraw

- An asset and amount form.
- It states that the funds are paid to the user's own wallet address on the
  vault network.
- The flow is unchanged: the operator signs, then the user's wallet submits.

## Not done (and not claimed)

- **No automatic deposit from the wallet.** It would need a key that signs
  without the user, which a non-custodial exchange must not hold. The user
  presses "Move to exchange" once.
- **No cross-chain or multi-asset deposit addresses, and no fiat purchase:**
  launch phase, roadmap Sprint 10 item 5.

## Tests

- **API end-to-end** (Anvil, `vault.e2e-spec.ts`): `GET /v1/vault/wallet`
  returns the faucet's tokens and gas for the signed-in wallet.
- **Browser check** against the production build with mocked API responses:
  - the menu, the transfer view (QR, address, balances);
  - the arrival message when the balance rises, and Max;
  - the fiat view, and the withdraw view;
  - no page errors.
