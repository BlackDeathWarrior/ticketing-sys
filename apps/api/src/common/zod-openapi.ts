import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

type JsonSchema = Record<string, unknown> & {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

/**
 * The OpenAPI schema of a zod contract from @tms/shared, so the API docs
 * describe exactly what `ZodPipe` validates. Inlined (no `$ref`s), because
 * each contract is used in one place.
 */
export function openApiSchema(schema: ZodTypeAny): JsonSchema {
  // Typed loosely: the library's generics over a `ZodTypeAny` are too deep for the compiler.
  const convert = zodToJsonSchema as (
    schema: unknown,
    options: { target: 'openApi3'; $refStrategy: 'none' },
  ) => JsonSchema & { $schema?: string };
  const { $schema: _draft, ...rest } = convert(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
  });
  return rest;
}

/** Documents a request body validated with `new ZodPipe(schema)`. */
export const ZodBody = (schema: ZodTypeAny) => ApiBody({ schema: openApiSchema(schema) });

/** Documents the query parameters validated with `new ZodPipe(schema)` (an object schema). */
export function ZodQuery(schema: ZodTypeAny) {
  const json = openApiSchema(schema);
  const required = new Set(json.required ?? []);
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, property]) => {
      const { description, ...rest } = property as { description?: string };
      return ApiQuery({ name, required: required.has(name), description, schema: rest });
    }),
  );
}
