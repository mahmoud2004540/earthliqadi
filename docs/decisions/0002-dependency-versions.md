# ADR-0002: Dependency version policy

- Status: Accepted
- Date: 2026-11-03

## Context

When this was written, npm `latest` tags pointed at very recent majors:
TypeScript 7 (native compiler), NestJS 12, Prisma 7 (with an 8.x RC tagged
latest for the CLI) and Next.js 16. A financial platform values stability and
well-understood behaviour over novelty.

## Decision

Use the **latest patch of the newest well-established major**, pin exact
versions (`save-exact`), and record the choices here:

| Area       | Chosen                                                                         | Reason                                                                                |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Runtime    | Node.js 22 LTS                                                                 | LTS, matches the container base image                                                 |
| Language   | TypeScript 5.9.3                                                               | TS 7 is a new native compiler; NestJS decorator metadata support not yet proven there |
| API        | NestJS 11.2.x                                                                  | Still-maintained 11.x line (`legacy` tag) with mature ecosystem support; 12.x is new  |
| ORM        | Prisma 6.19.x                                                                  | Stable `prisma-client-js` workflow; 7.x changes the client generator and driver model |
| Web        | Next.js 15.5.x, React 19                                                       | Mature App Router line with security backports                                        |
| Styling    | Tailwind CSS 4.3, shadcn-style components                                      | Components copied into the repo (no runtime UI kit dependency)                        |
| Validation | zod 4.x                                                                        | Shared schemas and JSON Schema export for OpenAPI                                     |
| Lint       | ESLint 10 + typescript-eslint 8                                                | ESLint 9 reached end of support                                                       |
| Tests      | Jest 30 (API), Vitest 4 (packages, web)                                        | Jest is Nest's first-class runner; Vitest is lighter for ESM packages                 |
| Containers | node 22.23.4-alpine3.24, postgres 16.15, redis 7.4.12, nginx-unprivileged 1.28 | Pinned patch tags                                                                     |

Upgrades to the newer majors get their own ADRs once ecosystem support has settled.

## Security overrides

Vulnerable transitive dependencies are overridden in `pnpm-workspace.yaml`. Each
override says which advisory it fixes and is removed when the direct dependency
ships the fix. CI fails on any high or critical advisory. See
[dependency policy](../security/dependency-policy.md).
