# ADR-0005: zod schemas shared between web and API

- Status: Accepted
- Date: 2026-11-03

## Decision

Request schemas live in `packages/shared`.

- The API validates every body, query and path parameter with
  `ZodValidationPipe`. Unknown keys are stripped, which prevents mass assignment.
- The web app runs the same schemas before submitting, so client feedback and
  server rules cannot drift apart.
- OpenAPI request bodies are generated from the same schemas with
  `z.toJSONSchema` (`ApiZodBody`).

We chose this over `class-validator` DTOs, which are NestJS-specific and cannot
be reused in the browser.

## Consequences

- Response DTOs are TypeScript interfaces in `packages/shared`. They are not yet
  runtime-validated or documented as OpenAPI response schemas (a known gap).
- zod adds about 50 KB (gzipped, before tree-shaking) to auth pages. We may
  switch to `zod/mini` on the client if bundle budgets require it.
