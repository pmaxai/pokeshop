import { z } from 'zod';
import { CARD_LANGUAGES, CONDITIONS, FINISHES, GRADING_COMPANIES, SUPERTYPES } from './catalog.ts';
import { ApiError } from './errors.ts';

/** Request bodies of the scanning-app API (docs/openapi.yaml). Unknown fields are rejected. */

export const StorageLocation = z
  .string()
  .regex(/^\d{3,10}$/, 'box number: digits only, at least three (e.g. "014")');

const Money = z.strictObject({
  amount: z.number().int().min(0).max(100_000_000),
  currency: z.literal('EUR'),
});

const Grading = z
  .strictObject({
    company: z.enum(GRADING_COMPANIES),
    grade: z.string().trim().min(1).max(10),
    cert: z.string().trim().max(40).nullish(),
  })
  .nullish();

export const ImageInput = z.strictObject({
  role: z.enum(['front', 'back', 'extra']).default('front'),
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith('https://'), 'must be an https URL'),
});

const text = (max: number) => z.string().trim().min(1).max(max);

const identityShape = {
  card_ref: text(60).optional(),
  set_code: text(40).optional(),
  card_number: text(30).optional(),
  card_language: z.enum(CARD_LANGUAGES),
  condition: z.enum(
    Object.keys(CONDITIONS) as [keyof typeof CONDITIONS, ...(keyof typeof CONDITIONS)[]],
  ),
  finish: z.enum(Object.keys(FINISHES) as [keyof typeof FINISHES, ...(keyof typeof FINISHES)[]]),
  grading: Grading,
};

const fieldsShape = {
  external_id: text(100).optional(),
  name_de: text(200).optional(),
  name_en: text(200).optional(),
  /** Printed name for cards in other languages than DE/EN (French, Japanese …). */
  name_local: text(200).optional(),
  set_name_de: text(200).optional(),
  set_name_en: text(200).optional(),
  release_year: z.number().int().min(1996).max(2100).optional(),
  rarity: text(100).optional(),
  supertype: z.enum(SUPERTYPES).optional(),
  energy_types: z.array(text(30)).max(5).optional(),
  price: Money.optional(),
  purchase_price: Money.optional(),
  high_value: z.boolean().optional(),
  description_de: z.string().trim().max(5000).optional(),
  description_en: z.string().trim().max(5000).optional(),
  images: z.array(ImageInput).max(10).optional(),
  /** Category slugs (GET /categories); replaces the product's categories when sent. */
  categories: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'category slug')
        .max(60),
    )
    .max(20)
    .optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
};

const needsCard = (
  v: {
    card_ref?: string | undefined;
    set_code?: string | undefined;
    card_number?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (!v.card_ref && !(v.set_code && v.card_number)) {
    ctx.addIssue({
      code: 'custom',
      path: ['card_ref'],
      message: 'send card_ref, or set_code together with card_number',
    });
  }
};

export const IntakeRequest = z
  .strictObject({
    ...identityShape,
    ...fieldsShape,
    delta: z.number().int().min(1).max(1000),
    storage_location: StorageLocation,
  })
  .superRefine(needsCard);
export type IntakeRequest = z.infer<typeof IntakeRequest>;

export const ProductInput = z
  .strictObject({ ...identityShape, ...fieldsShape })
  .superRefine(needsCard);
export type ProductInput = z.infer<typeof ProductInput>;

export const ProductPatch = z.strictObject({
  ...fieldsShape,
  storage_location: StorageLocation.optional(),
});
export type ProductPatch = z.infer<typeof ProductPatch>;

export const StockChange = z.union([
  z.strictObject({
    delta: z
      .number()
      .int()
      .min(-1000)
      .max(1000)
      .refine((n) => n !== 0, 'must not be 0'),
    storage_location: StorageLocation,
    reason: z.string().max(200).optional(),
  }),
  z.strictObject({
    set: z.number().int().min(0).max(100_000),
    storage_location: StorageLocation,
    reason: z.string().max(200).optional(),
  }),
  z.strictObject({
    move: z.number().int().min(1).max(100_000),
    from: StorageLocation,
    to: StorageLocation,
    reason: z.string().max(200).optional(),
  }),
]);
export type StockChange = z.infer<typeof StockChange>;

export const BatchRequest = z.strictObject({
  operations: z
    .array(
      z.discriminatedUnion('op', [
        z.strictObject({ op: z.literal('intake'), body: z.unknown() }),
        z.strictObject({ op: z.literal('upsert'), sku: text(80), body: z.unknown() }),
        z.strictObject({ op: z.literal('stock'), sku: text(80), body: z.unknown() }),
      ]),
    )
    .min(1)
    .max(100),
});

/** Parses or throws a 422 ApiError listing each bad field. */
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    fields[key] ??=
      issue.code === 'unrecognized_keys'
        ? `unknown field(s): ${(issue as { keys: string[] }).keys.join(', ')}`
        : issue.message;
  }
  throw new ApiError(422, 'validation', 'request body is not valid', fields);
}
