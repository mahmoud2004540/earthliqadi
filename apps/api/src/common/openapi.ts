import { applyDecorators } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';

/** Documents a request body in OpenAPI from the same zod schema that validates it. */
export function ApiZodBody(schema: z.ZodType): MethodDecorator & ClassDecorator {
  // zod emits JSON Schema (draft 2020-12); OpenAPI 3.1 schema objects are compatible.
  const jsonSchema = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as unknown as SchemaObject;
  return applyDecorators(ApiBody({ schema: jsonSchema }));
}
