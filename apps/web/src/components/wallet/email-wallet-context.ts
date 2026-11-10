'use client';

import { createContext, useContext } from 'react';
import type { Eip1193 } from '@/lib/wallet';

/**
 * Email wallets through Privy (ADR-0035).
 *
 * Privy creates a wallet for users who sign up with an e-mail address. Per
 * Privy's documentation the key is sharded and only assembled in a trusted
 * enclave or, on export, in an isolated Privy frame; this app never receives
 * it and only gets an EIP-1193 provider that asks the user to confirm. The exchange never sees the e-mail address: the
 * account is still the wallet address, proven by a Sign-In with Ethereum
 * signature like any other wallet (ADR-0013).
 */
/** Why the email sign-in did not produce a wallet; the page shows its own text. */
export class EmailWalletError extends Error {
  constructor(public readonly reason: 'unavailable' | 'cancelled') {
    super(`email wallet ${reason}`);
    this.name = 'EmailWalletError';
  }
}

export interface EmailWallet {
  /** False when no Privy app id is configured: only extension wallets. */
  available: boolean;
  /** Address of the user's email wallet in this browser, if signed in to Privy. */
  address: string | null;
  /** Opens Privy's e-mail sign-in and resolves with the wallet once it exists. */
  connect: () => Promise<{ address: string; provider: Eip1193 }>;
  /** Signs out of Privy in this browser. */
  logout: () => Promise<void>;
  /** Opens Privy's modal that shows the private key to the user only. */
  exportKey: () => Promise<void>;
}

const unavailable: EmailWallet = {
  available: false,
  address: null,
  connect: () => Promise.reject(new EmailWalletError('unavailable')),
  logout: () => Promise.resolve(),
  exportKey: () => Promise.resolve(),
};

export const EmailWalletContext = createContext<EmailWallet>(unavailable);

export function useEmailWallet(): EmailWallet {
  return useContext(EmailWalletContext);
}
