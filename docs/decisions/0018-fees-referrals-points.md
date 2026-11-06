# ADR-0018: Fee tiers, maker rebates, referral fee share and activity points

- Status: Accepted (product step C)
- Date: 2026-11-06
- Context: product brief rev 2, sections 3c and 6. Traders and large traders
  choose venues for fees, and growth should come from public, rule-based
  programmes, not hidden deals or fake volume.

## Decision

### 1. One rule: payouts come out of the taker fee of the same trade

For every trade the taker fee is split three ways, in this order:

1. **maker rebate**, capped at the taker fee;
2. **referral share** of what is left;
3. **revenue**, which is the rest.

The three parts always add up to the fee (property-tested). As a result:

- `FEE_REVENUE` never pays out more than it took in;
- nothing is minted;
- the ledger and reconciliation are unchanged.

Every rebate and referral payout is recorded in `fee_payouts`, linked to the
trade that funded it.

### 2. Fee tiers

**Schedule.** `fee_tiers` is a public schedule (`GET /v1/fees/schedule`) of
discounts on each market's published base fees, by 30-day volume.

- **Taker fee:** effective fee = base − discount, never below 0.
- **Maker fee:** effective fee = base − discount; a negative result is a
  rebate.

**Volume.** Volume is the traded notional in USD-like quote assets
(`FEE_VOLUME_QUOTE_ASSETS`, default: codes containing "USD"), normalised to
6 decimals and counted on both sides of each trade.

**Recomputation.** Tiers are recomputed into `user_fee_tiers` by the growth job
(`GROWTH_JOB_INTERVAL_SECONDS`, default hourly). Settlement loads them once
per batch.

**Asset of a spot rebate.** A spot rebate is paid in the taker fee's asset:
base when the taker buys, quote when the taker sells. On perpetuals
everything settles in the quote asset.

**Changing the schedule.** `PUT /v1/admin/fees/schedule` is staff-only
(`fees:configure`), with step-up, and audited. It is validated so that:

- tier 0 is zero;
- tiers are consecutive with increasing volume;
- discounts never decrease for higher tiers.

**Liquidations.** Liquidation fills pay their fee to the insurance fund. They
earn no rebate or referral share.

### 3. Referrals

**Codes.** Each wallet account has one code (`POST /v1/me/referrals/code`).

**Attaching a referrer.** A new account opened with `/connect?ref=<code>`
records `referred_by_user_id`. Rules:

- it counts only when that sign-in creates the account;
- unknown codes are ignored;
- the referrer is immutable (trigger), and self-referral is impossible
  (CHECK).

**Payout.** The referrer receives `REFERRAL_FEE_SHARE_BPS` (default 10%) of
the referred account's taker fees (after any maker rebate). This applies
for `REFERRAL_DURATION_DAYS` (default 365) after that account was created,
while the referrer is an active wallet account. The payout goes to the
referrer's balance, claimable on-chain like any other balance.

**Known limitation.** A trader can refer a second wallet of their own. The
effect is at most a 10% taker-fee discount, which is the same incentive the
programme offers anyone.

### 4. Activity points

**Rate.** Points per UTC day: 1 per unit of taker volume and 2 per unit of
maker volume, from settled trades only. They are stored in `user_points`
and recomputed idempotently by the job.

**Excluded volume** is recorded separately (`excludedVolume`):

- **linked accounts:** trades between a parent and its sub-accounts, or two
  sub-accounts of the same parent;
- **wash pairs:** on one day, each account sends ≥ 50% of its volume to the
  other and the two flows net out to within 20%.

**Leaderboard.** `GET /v1/points/leaderboard?days=` is public. It shows
shortened addresses only.

**Not a token.** Points are not a token. Neither the API nor the UI promises a
token, an airdrop or any value. Any such decision needs counsel review
first.

## Consequences

- Fees are lower for active traders and makers can earn rebates, without any
  private deal.
- Every payout can be traced to a real trade. Points cannot be bought with
  self-trades or wash pairs.
- **Simple wash heuristics:** more patterns can evade them, such as rings of
  three or more accounts. Excluded volume is visible to staff for review.
- **Per-account volume:** sub-account volume does not add to the parent's tier.
