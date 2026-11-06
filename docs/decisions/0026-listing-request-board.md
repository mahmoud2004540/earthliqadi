# ADR-0026: Listing request board

- Status: Accepted (product brief §3, item 11)
- Date: 2026-11-06

## Context

The product brief calls for new-market listings driven by a public
request-and-vote board, with the decision kept to published risk criteria.
Two things need guarding:

- **Ballot stuffing.** Wallets are free to create, so raw vote counts can be
  inflated.
- **Fake legitimacy.** Users must not mistake a vote count for a listing
  promise.

## Decision

### Requests

Any signed-in main account can request a market. Sub-accounts and vaults
cannot request or vote; they answer to their main account. A request names:

- **The asset:** a symbol (2–16 letters or digits) and a name.
- **The market type:** spot or perpetual.
- **The quote asset:** one that already exists on the platform.
- **The token contract (optional):** a chain id and an EVM token contract,
  both or neither.
- **The rationale:** 20–1000 characters.
- **A link (optional):** one https link.

Requests are gated like `manage` routes (ADR-0022): sanctioned wallets and
accounts without the current terms are refused. Restricted locations never
reach the API at all (ADR-0024).

**Refused requests:**

- **Duplicates.** There is one live request (open or under review) per
  symbol, type and quote. A partial unique index enforces it, and the error
  tells the user to vote instead.
- **Markets that already exist.**

**Flood control:** at most 3 live requests per account. An author can
withdraw their own open request.

**Anonymity.** Authors are never shown publicly. Each user only sees which
requests are theirs (`GET /v1/listings/mine`).

**User text.** Rationale and link are rendered as plain text. The link is
never made clickable; only https values are accepted, and a database check
enforces that.

### Votes

One vote per account per request, while the request is live. The author's
own vote is counted automatically.

**Eligibility.** A vote is **eligible** when the voter (with their
sub-accounts) had traded when voting. This is recorded per vote. Only
eligible votes rank the board; total votes are shown beside them. A wallet
created to vote adds to the total but not to the ranking.

### Decisions

Staff with `markets:configure` and a fresh step-up decide. The status moves:

```
open → review → listed / rejected
```

- **Explained.** `listed` and `rejected` need a note that refers to the
  published criteria.
- **Tied to a market.** `listed` must name an existing market whose base,
  quote and type match the request.
- **Enforced and recorded.** A database check enforces both rules. Every
  decision is audited (`listing.decided`) and published on the board with
  its note.

**Votes inform, never decide.** The criteria published on `/listings` are:

- liquidity;
- independent price sources;
- token contract powers;
- legal advice;
- market integrity;
- operational support.

### Endpoints

| Method | Path                              | Who                  |
| ------ | --------------------------------- | -------------------- |
| GET    | `/v1/listings[?status=]`          | public               |
| GET    | `/v1/listings/:id`                | public               |
| GET    | `/v1/listings/mine`               | signed in            |
| POST   | `/v1/listings`                    | signed in (`manage`) |
| POST   | `/v1/listings/:id/vote`           | signed in (`manage`) |
| DELETE | `/v1/listings/:id/vote`           | signed in            |
| POST   | `/v1/listings/:id/withdraw`       | author               |
| POST   | `/v1/admin/listings/:id/decision` | staff, step-up       |

## Consequences

- **The eligibility rule.** It is coarse: any trade makes an account
  eligible. Weighting by fees paid or by account age is possible later and
  is not promised.
- **No automatic listing.** Listing still means creating assets and markets
  through the existing staff flows; the board only records demand and
  decisions.
