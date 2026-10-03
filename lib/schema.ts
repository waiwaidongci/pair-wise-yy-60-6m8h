import { z } from 'zod';

const chainBreakSchema = z.object({
  atSeq: z.number().nullable(),
  kind: z.enum(['missing-event', 'hash-mismatch', 'prevhash-mismatch', 'gap', 'missing-digest', 'tampered']),
  message: z.string()
});

const auditEventSchema = z.object({
  seq: z.number(),
  opId: z.string(),
  type: z.string(),
  actor: z.string(),
  targetId: z.string().nullable(),
  entity: z.string(),
  expectedVersion: z.number(),
  fromVersion: z.number(),
  toVersion: z.number(),
  payload: z.record(z.string(), z.unknown()),
  outcome: z.enum(['applied', 'conflict']),
  conflictOfSeq: z.number().nullable(),
  migrated: z.boolean(),
  at: z.string(),
  prevHash: z.string(),
  hash: z.string()
});

export const stateViewSchema = z.object({
  project: z.object({ id: z.string(), name: z.string(), methodology: z.string(), vintage: z.string(), verifier: z.string() }),
  summary: z.object({ period: z.string(), reduction: z.number(), evidenceRate: z.number(), openFindings: z.number(), sampled: z.number() }),
  records: z.array(z.object({
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
    status: z.string(),
    revision: z.number(),
    version: z.number(),
    missing: z.boolean().optional(),
    conflict: z.object({ opId: z.string(), type: z.string(), actor: z.string(), at: z.string(), againstSeq: z.number() }).nullable()
  })),
  findings: z.array(z.object({
    id: z.string(),
    recordId: z.string(),
    type: z.string(),
    title: z.string(),
    detail: z.string(),
    assignee: z.string(),
    due: z.string(),
    status: z.string(),
    version: z.number(),
    missing: z.boolean().optional()
  })),
  sampledIds: z.array(z.string()),
  checks: z.array(z.object({ id: z.string(), title: z.string(), checked: z.boolean(), version: z.number() })),
  issuance: z.object({
    submitted: z.boolean(),
    submittedAt: z.string().nullable(),
    version: z.number(),
    ready: z.boolean(),
    invalidReasons: z.array(z.string())
  }),
  audit: z.object({
    chain: z.object({ valid: z.boolean(), eventCount: z.number(), lastHash: z.string(), breaks: z.array(chainBreakSchema) }),
    lastOpId: z.string().nullable(),
    conflicts: z.array(z.object({ entity: z.string(), targetId: z.string(), opId: z.string(), type: z.string(), actor: z.string(), at: z.string(), againstSeq: z.number() }))
  })
});

export type StateViewDTO = z.infer<typeof stateViewSchema>;

export const auditEventsSchema = z.object({
  events: z.array(auditEventSchema),
  chain: z.object({ valid: z.boolean(), eventCount: z.number(), lastHash: z.string(), breaks: z.array(chainBreakSchema) })
});

export type AuditEventsDTO = z.infer<typeof auditEventsSchema>;
export type AuditEventDTO = z.infer<typeof auditEventSchema>;
