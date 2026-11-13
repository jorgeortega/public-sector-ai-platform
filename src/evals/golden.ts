import { z } from 'zod';
import data from '../../data/golden.json';
import type { Application } from '../permit/applications.ts';

// The golden set (evals spec V1): fictional applications and what each
// city's code says about them. Imported, not read from disk, like the
// applications.

export const DECISIONS = ['approve', 'deny', 'refer'] as const;
export type Decision = (typeof DECISIONS)[number];

const SectionId = z.string().regex(/^(pac|kbc)-[0-9a-z.-]+$/);

const ApplicationSchema = z
  .object({
    id: z.string().regex(/^(pa|kb)-[a-z]+-\d{4}$/),
    tenant: z.enum(['port-alder', 'kestrel-bay']),
    business: z.string().min(1),
    type: z.string().min(1),
    zone: z.string().min(1),
    staff: z.number().int().min(0),
    foodHandlerCertificate: z.boolean().optional(),
    signSquareMetres: z.number().optional(),
    outdoorSeats: z.number().int().optional(),
    hours: z.string().optional(),
    stateLicences: z.boolean().optional(),
    kitchen: z.string().optional(),
    largestEventGuests: z.number().int().optional(),
    sellsFood: z.boolean().optional(),
    flammableGoods: z.boolean().optional(),
    applicant: z.string(),
  })
  .strict();

export const GoldenCaseSchema = z
  .object({
    application: ApplicationSchema,
    decision: z.enum(DECISIONS),
    // The sections the decision rests on: the unmet rule for deny and refer;
    // none for approve, which no one section decides.
    restsOn: z.array(SectionId),
    neverCite: z.array(SectionId),
    why: z.string().min(1),
  })
  .strict()
  .refine((c) => (c.decision === 'approve') === (c.restsOn.length === 0), { message: 'approve rests on no section; deny and refer rest on at least one' });

export type GoldenCase = Omit<z.infer<typeof GoldenCaseSchema>, 'application'> & { application: Application };

export const GOLDEN: GoldenCase[] = z.object({ note: z.string(), cases: z.array(GoldenCaseSchema) }).parse(data).cases as GoldenCase[];

export const goldenCase = (id: string): GoldenCase => {
  const found = GOLDEN.find((c) => c.application.id === id);
  if (!found) throw new Error(`No golden case ${id}.`);
  return found;
};
