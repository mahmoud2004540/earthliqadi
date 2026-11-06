import { z } from 'zod';

/** Listing request board (ADR-0026). */
export const LISTING_STATUSES = ['open', 'review', 'listed', 'rejected', 'withdrawn'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const createListingSchema = z
  .object({
    baseSymbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,16}$/, '2-16 letters or digits'),
    baseName: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9 .()_-]+$/, 'Letters, digits, spaces and . ( ) _ - only'),
    kind: z.enum(['spot', 'perpetual']),
    /** An asset that already exists on the platform. */
    quoteAsset: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,16}$/),
    /** EVM token contract, when the asset is a token. Both or neither. */
    chainId: z.number().int().min(1).max(2_147_483_647).optional(),
    tokenAddress: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .transform((v) => v.toLowerCase())
      .optional(),
    rationale: z.string().trim().min(20).max(1000),
    /** One https link (project site, docs or explorer). Shown as text, never as a live link. */
    link: z
      .string()
      .trim()
      .max(200)
      .regex(/^https:\/\/[^\s<>"']+$/, 'An https URL')
      .optional(),
  })
  .refine((v) => (v.chainId === undefined) === (v.tokenAddress === undefined), {
    message: 'chainId and tokenAddress go together',
    path: ['tokenAddress'],
  });

export const listingQuerySchema = z.object({
  status: z.enum(LISTING_STATUSES).optional(),
});

export const listingDecisionSchema = z
  .object({
    status: z.enum(['review', 'listed', 'rejected']),
    /** Required for listed/rejected: which published criteria the decision rests on. */
    note: z.string().trim().min(10).max(500).optional(),
    /** Required for listed: the market that was created. */
    market: z.string().optional(),
  })
  .refine((v) => v.status === 'review' || v.note !== undefined, {
    message: 'A decision needs a note referring to the published criteria',
    path: ['note'],
  })
  .refine((v) => (v.status === 'listed') === (v.market !== undefined), {
    message: 'A listing names its market (and only a listing does)',
    path: ['market'],
  });

export interface ListingRequestDto {
  id: string;
  baseSymbol: string;
  baseName: string;
  kind: 'spot' | 'perpetual';
  quoteAsset: string;
  chainId: number | null;
  tokenAddress: string | null;
  rationale: string;
  link: string | null;
  status: ListingStatus;
  /** Votes from accounts that had traded when voting: these rank the board. */
  eligibleVotes: number;
  totalVotes: number;
  decisionNote: string | null;
  decidedAt: string | null;
  market: string | null;
  createdAt: string;
  /** Only on requests read by a signed-in user. */
  mine?: boolean;
  votedByMe?: boolean;
}
