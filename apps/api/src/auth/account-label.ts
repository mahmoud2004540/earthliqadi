import { toChecksumAddress } from './siwe';

/** Human-readable identity for staff views: the email, or the EIP-55 wallet address. */
export function accountLabel(u: { email: string | null; walletAddress?: string | null }): string {
  if (u.email) return u.email;
  if (u.walletAddress) return toChecksumAddress(u.walletAddress);
  return '(unknown)';
}
