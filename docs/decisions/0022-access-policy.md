# ADR-0022: Access policy: restricted regions, sanctions screening, terms of use

- Status: Accepted (owner request, 2026-11-07); amended by ADR-0023 and ADR-0024 (restricted locations are now fully blocked by default)
- Date: 2026-11-07
- Context: the owner wants the access model of established non-custodial
  venues: open to the world without accounts or identity checks, while
  refusing restricted jurisdictions and sanctioned wallets and requiring
  users to accept terms of use. This lowers legal risk; it does not replace
  counsel review (product brief §8).

## Decision

### 1. One gate, three checks

Routes that open or manage risk carry `@AccessPolicy(kind)`. A global guard
runs after authentication and permissions. The rules are a pure function
(`decide`, exhaustively tested):

| Kind       | Routes                                                                                                                      | Sanctions | Region (unless reduce-only) | Terms  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------- | ------ |
| `open`     | place order, batch, TWAP/iceberg, RFQ request/quote/accept, create leader vault, deposit into a vault, create a sub-account | blocks    | blocks                      | needed |
| `manage`   | leverage, margin, TP/SL, margin mode, transfers between own accounts                                                        | blocks    | —                           | needed |
| `withdraw` | vault withdrawals, leader-vault redemptions                                                                                 | blocks    | —                           | —      |

**Never gated:** cancels, cancel-all and the dead-man switch, so exposure
can always be reduced.

**Who answers for an account:** sub-accounts and vault accounts answer for
their parent wallet, both for sanctions and for terms. API-key requests are
checked exactly like browser requests.

### 2. Restricted regions

**Where the country comes from.** It is read from a header set by the
edge/CDN (`GEO_COUNTRY_HEADER`, for example `cf-ipcountry`). The deployment's
proxy must overwrite any client-sent value. These values count as unknown:

- a repeated header;
- a malformed code;
- anonymiser codes (`T1`, `XX` …).

**Policy for unknown countries.** `GEO_UNKNOWN_COUNTRY` decides. It must be
`deny` in production.

**The list.** `RESTRICTED_COUNTRIES` (ISO codes) is the same list the
identity module uses. It is published at `GET /v1/access` and on the
`/terms` page.

- Production refuses to boot without a list.
- Staging and production refuse a list without a header.
- **The list itself is legal input:** the code contains no default list.

**What a restricted region blocks:**

- **No new accounts:** a wallet's first sign-in is refused (451
  `REGION_RESTRICTED`).
- **No new risk:** non-reduce-only orders and the other `open` routes are
  refused with 451.

**What stays open:**

- existing accounts can sign in from anywhere;
- reduce-only orders;
- cancels and withdrawals.

Funds are never trapped by geography.

**Limit:** region checks are best-effort by nature. A VPN defeats them, and
the terms forbid that.

### 3. Sanctions screening

**The list.** `sanctioned_addresses` is loaded by operators from official
lists with `pnpm --filter @platform/api cli:sanctions import <file> --source
<name>`. Each import replaces that source's list and is audited. The code
ships with **no addresses**: we never invent list contents.

**What a listed wallet cannot do:**

- sign in;
- use any gated route (`open`, `manage`, `withdraw`).

Existing sessions are screened on every gated request, so a newly listed
wallet is blocked immediately. Cancels stay open.

**Not blockable by the platform.** The vault contract's escape hatch
(ADR-0014) cannot be blocked by the operator. That is the point of
non-custody. Whether committed balances of listed wallets must be treated
differently is a question for counsel.

### 4. Terms of use

**Version.** `TERMS_VERSION` names the current version.

**Acceptance.** `POST /v1/me/terms/accept {version}` records the version and
time on the main account. It is audited, and the region is recorded as
metadata.

**Enforcement:**

- `open` and `manage` routes return 403 `TERMS_NOT_ACCEPTED` until the
  current version is accepted;
- a new version requires accepting again;
- withdrawals never require it.

**The text.** `/terms` is a **draft for counsel review**. It shows the live
version and the restricted list. A notice in the site layout asks for
acceptance, and explains region or sanctions blocks.

### Endpoints

| Method | Path                  | Auth           | Description                                                      |
| ------ | --------------------- | -------------- | ---------------------------------------------------------------- |
| GET    | `/v1/access`          | public         | `{country, regionRestricted, restrictedCountries, termsVersion}` |
| GET    | `/v1/me/access`       | session or key | adds `termsAcceptedVersion`, `termsAccepted`, `sanctioned`       |
| POST   | `/v1/me/terms/accept` | session        | `{version}` (must equal the current version, else 409)           |

## Consequences

- The platform stays account-free and KYC-free for permitted regions, while
  refusing restricted regions and listed wallets in a way that is visible,
  audited and the same for everyone.
- **Open for the owner and counsel:**
  - which countries to restrict;
  - which sanctions lists to load and how often;
  - the final terms text;
  - whether the operator's own country of residence must be restricted.
- **Future: an own blockchain.** The owner plans to move matching and
  settlement onto an app-specific chain later. That is a separate, large
  project (consensus, validators, bridge, audits) and needs its own ADR. This
  policy layer stays in the interface and API either way.
