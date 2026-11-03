# ADR-0008: English-only user interface

- Status: Accepted (supersedes the Arabic/RTL requirement in the original brief)
- Date: 2026-11-03

## Context

Phase 1 shipped the web app in English (LTR) and Arabic (RTL), with
locale-prefixed URLs (`/en/...`, `/ar/...`). The product owner decided that the
platform is **English-only**.

## Decision

- Remove Arabic entirely: the dictionary, the Noto Sans Arabic font, RTL
  handling and the language switcher.
- Remove the locale URL segment. Pages live at `/`, `/login`, `/dashboard` and so
  on. The middleware **permanently redirects (308)** legacy `/en/...` and
  `/ar/...` URLs to the new paths, so old bookmarks and already-sent email links
  keep working.
- Email links point to `/verify-email`, `/reset-password` and `/forgot-password`.
- Registration no longer takes a `locale` field, and the unused `users.locale`
  column is dropped (migration `drop_user_locale`).
- UI copy stays in one typed dictionary (`apps/web/src/i18n/en.ts`), so wording
  is reviewable in one place and localisation can be reintroduced later without
  touching components.

## Consequences

- Simpler routing, smaller font payload, and one copy source to review for
  accuracy (the "no unverified claims" test still runs against it).
- Reintroducing a language later means adding a dictionary, a locale resolution
  strategy and RTL-aware layout review. Components already use logical CSS
  properties (`ms-`/`me-`, `start`/`end`), so most layouts would carry over.
