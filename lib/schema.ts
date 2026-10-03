import { z } from 'zod';

export const entityTypeSchema = z.enum(['record', 'finding', 'issuance']);

export const auditEventSchema = z.object({
  eventId: z.string(),
  operationId: z.string(),
  seq: z.number(),
  entityType: entityTypeSchema,
  entityId: z.string(),
  action: z.string(),
  actor: z.string(),
  timestamp: z.string(),
  payload: z.record(z.unknown()),
  prevHash: z.string(),
  hash: z.string()
});

export const breakPointSchema = z.object({
  seq: z.number(),
  eventId: z.string(),
  reason: z.string()
});

const recordSchema = z.object({
  id: z.string(),
  source: z.string(),
  activity: z.number(),
  unit: z.string(),
  factor: z.number(),
  factorUnit: z.string(),
  timeRange: z.string(),
  evidenceCount: z.number(),
  anomaly: z.number(),
  owner: z.string(),
  status: z.enum(['待核验', '复核中', '已核验', '需补证']),
  revision: z.number(),
  version: z.number(),
  headHash: z.string()
});

const findingSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  type: z.enum(['缺失证据', '单位不一致', '时间范围', '异常波动']),
  title: z.string(),
  detail: z.string(),
  assignee: z.string(),
  due: z.string(),
  status: z.enum(['开放', '补证中', '已关闭']),
  version: z.number(),
  headHash: z.string()
});

export const evidenceResponseSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string(),
    methodology: z.string(),
    vintage: z.string(),
    verifier: z.string()
  }),
  summary: z.object({
    period: z.string(),
    reduction: z.number(),
    evidenceRate: z.number(),
    openFindings: z.number(),
    sampled: z.number()
  }),
  records: z.array(recordSchema),
  findings: z.array(findingSchema),
  issuanceChecks: z.record(z.boolean()),
  issuanceMeta: z.record(z.object({ version: z.number(), headHash: z.string() })),
  chain: z.array(auditEventSchema),
  chainHeadHash: z.string(),
  chainValid: z.boolean(),
  chainBreakAt: breakPointSchema.nullable(),
  migratedCount: z.number()
});

export type EvidenceResponse = z.infer<typeof evidenceResponseSchema>;

export const operationEnvelopeSchema = z.object({
  operationId: z.string().min(1),
  entityType: entityTypeSchema,
  entityId: z.string().min(1),
  action: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  actor: z.string().min(1),
  timestamp: z.string().min(1),
  payload: z.record(z.unknown())
});

export type OperationEnvelopeInput = z.infer<typeof operationEnvelopeSchema>;

export const operationResultSchema = z.object({
  status: z.enum(['applied', 'duplicate', 'conflict']),
  event: auditEventSchema,
  reason: z.string().optional(),
  state: evidenceResponseSchema
});

export type OperationResultResponse = z.infer<typeof operationResultSchema>;
