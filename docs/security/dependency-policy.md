# Dependency policy

- **Pin exact versions** (`.npmrc`: `save-exact=true`) and commit `pnpm-lock.yaml`.
  CI installs with `--frozen-lockfile`.
- **Install scripts are allow-listed** (`onlyBuiltDependencies` in
  `pnpm-workspace.yaml`). A new native or postinstall dependency needs review.
- **Prefer fewer dependencies.** Small, well-specified algorithms (e.g. RFC 6238
  TOTP, about 60 lines) are implemented locally with test vectors instead of
  pulling in a package.
- **Vulnerability gate:** CI runs `pnpm audit --audit-level high` and fails on
  high or critical advisories. Moderate and low advisories in development-only
  tooling are tracked but not blocking.
- **Overrides** for vulnerable transitive dependencies live in
  `pnpm-workspace.yaml`, each with the advisory and the direct dependency that
  pins the vulnerable version. Remove the override once upstream ships the fix.
- **Updates:** Dependabot opens grouped weekly PRs (npm, GitHub Actions, Docker).
  Major upgrades get an ADR.
- **Container images** are pinned to patch tags. Digest pinning is planned for
  release builds.

## Current overrides (2026-11-03)

| Package      | Pinned to | Advisory                             | Pulled in by                    |
| ------------ | --------- | ------------------------------------ | ------------------------------- |
| postcss      | 8.5.32    | GHSA-fxqj-rqcc-2cmp and related      | next 15.5.28                    |
| multer       | 2.5.0     | DoS via pending async file handling  | @nestjs/platform-express 11.2.8 |
| js-yaml (5)  | 5.5.0     | GHSA-r3ph-w7gj-g6xm                  | @nestjs/swagger 11.4.7          |
| deepmerge-ts | 8.0.2     | Stack exhaustion on recursive graphs | @prisma/config 6.19.3           |

Accepted (development tooling only, moderate/low): `minimatch` (eslint),
`glob` and `deepmerge` (@nestjs/cli).
