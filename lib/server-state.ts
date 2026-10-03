// 服务端内存态权威审计链。
//
// 写入流程（applyOperation）在同一个同步块内完成“追加事件 + 更新业务状态”，
// 因此业务状态与事件要么一起落地，要么一起不落地，不存在半条链。
// - 同号重试：seenOperationIds 命中即返回首次结果（duplicate），不重复追加；
// - 乐观并发：expectedVersion 与实体当前 version 不一致时，追加 CONFLICT_REJECTED 事件并返回 conflict；
// - 先到成立：版本匹配的首个操作落地，后到的同实体操作因 version 已变而被拒并留冲突。

import {
  appendEvent,
  verifyChain,
  findEventByOperationId,
  migrateEntities,
  type AuditEvent,
  type BreakPoint,
  type EntityType
} from './audit';
import {
  CURRENT_ACTOR,
  defaultFindings,
  defaultIssuanceChecks,
  defaultRecords,
  type CarbonRecord,
  type Finding,
  type IssuanceMeta
} from './domain';

export type OperationEnvelope = {
  operationId: string;
  entityType: EntityType;
  entityId: string;
  action: string;
  expectedVersion: number;
  actor: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type EvidenceState = {
  records: CarbonRecord[];
  findings: Finding[];
  issuanceChecks: Record<string, boolean>;
  issuanceMeta: Record<string, IssuanceMeta>;
  chain: AuditEvent[];
  chainHeadHash: string;
  chainValid: boolean;
  chainBreakAt: BreakPoint | null;
  migratedCount: number;
};

export type OperationResult =
  | { status: 'applied'; event: AuditEvent; state: EvidenceState }
  | { status: 'duplicate'; event: AuditEvent; state: EvidenceState }
  | { status: 'conflict'; reason: string; event: AuditEvent; state: EvidenceState };

type ServerState = {
  records: CarbonRecord[];
  findings: Finding[];
  issuanceChecks: Record<string, boolean>;
  issuanceMeta: Record<string, IssuanceMeta>;
  chain: AuditEvent[];
  seenOperationIds: Set<string>;
  migratedCount: number;
  initialized: boolean;
};

const state: ServerState = {
  records: [],
  findings: [],
  issuanceChecks: { ...defaultIssuanceChecks },
  issuanceMeta: {},
  chain: [],
  seenOperationIds: new Set(),
  migratedCount: 0,
  initialized: false
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 取实体当前并发版本号。 */
function currentVersion(entityType: EntityType, entityId: string): number {
  if (entityType === 'record') return state.records.find((r) => r.id === entityId)?.version ?? 0;
  if (entityType === 'finding') return state.findings.find((f) => f.id === entityId)?.version ?? 0;
  return state.issuanceMeta[entityId]?.version ?? 0;
}

/** 写入实体的 version / headHash。 */
function applyHead(entityType: EntityType, entityId: string, headHash: string, version: number): void {
  if (entityType === 'record') {
    const record = state.records.find((r) => r.id === entityId);
    if (record) {
      record.headHash = headHash;
      record.version = version;
    }
  } else if (entityType === 'finding') {
    const finding = state.findings.find((f) => f.id === entityId);
    if (finding) {
      finding.headHash = headHash;
      finding.version = version;
    }
  } else {
    state.issuanceMeta[entityId] = { version, headHash };
  }
}

/** 依据动作落地业务状态（与事件追加在同一同步块内）。 */
function applyBusinessChange(envelope: OperationEnvelope): void {
  const { entityType, entityId, action, payload } = envelope;
  if (entityType === 'record') {
    const record = state.records.find((r) => r.id === entityId);
    if (!record) return;
    if (action === 'VERIFY') record.status = '已核验';
    else if (action === 'START_CORRECTION') record.status = '复核中';
    else if (action === 'BATCH_VERIFY') record.status = '已核验';
    else if (action === 'REVISE') {
      record.activity = Number(payload.value);
      record.revision = Number(payload.revision ?? record.revision + 1);
      record.status = '复核中';
    }
  } else if (entityType === 'finding') {
    const finding = state.findings.find((f) => f.id === entityId);
    if (!finding) return;
    if (action === 'REQUEST_EVIDENCE') finding.status = '补证中';
    else if (action === 'CLOSE_FINDING') finding.status = '已关闭';
  } else if (entityType === 'issuance') {
    if (action === 'TOGGLE_ISSUANCE') state.issuanceChecks[entityId] = Boolean(payload.checked);
  }
}

function snapshot(): EvidenceState {
  const verification = verifyChain(state.chain);
  return {
    records: clone(state.records),
    findings: clone(state.findings),
    issuanceChecks: { ...state.issuanceChecks },
    issuanceMeta: clone(state.issuanceMeta),
    chain: clone(state.chain),
    chainHeadHash: state.chain.length === 0 ? '' : state.chain[state.chain.length - 1].hash,
    chainValid: verification.valid,
    chainBreakAt: verification.breakAt,
    migratedCount: state.migratedCount
  };
}

/** 初始化：载入旧数据并为缺摘要的实体补成首版（GENESIS）。 */
export function ensureInitialized(): void {
  if (state.initialized) return;
  state.records = defaultRecords.map((r) => ({ ...r }));
  state.findings = defaultFindings.map((f) => ({ ...f }));
  state.issuanceChecks = { ...defaultIssuanceChecks };
  state.issuanceMeta = {};
  state.chain = [];
  state.seenOperationIds = new Set();

  const entities: { type: EntityType; id: string; state: unknown }[] = [
    ...state.records.map((r) => ({ type: 'record' as EntityType, id: r.id, state: { ...r } })),
    ...state.findings.map((f) => ({ type: 'finding' as EntityType, id: f.id, state: { ...f } })),
    ...Object.keys(state.issuanceChecks).map((id) => ({ type: 'issuance' as EntityType, id, state: { id, checked: state.issuanceChecks[id] } }))
  ];
  const { chain, added } = migrateEntities([], entities, CURRENT_ACTOR);
  state.chain = chain;
  state.migratedCount = added.length;
  for (const event of added) {
    applyHead(event.entityType, event.entityId, event.hash, 1);
    state.seenOperationIds.add(event.operationId);
  }
  state.initialized = true;
}

/** 应用一个操作（幂等 + 乐观并发 + 原子写入）。 */
export function applyOperation(envelope: OperationEnvelope): OperationResult {
  ensureInitialized();
  const { operationId, entityType, entityId, action, actor, timestamp, payload } = envelope;

  // 1. 幂等：同号重试取首次结果。
  if (state.seenOperationIds.has(operationId)) {
    const first = findEventByOperationId(state.chain, operationId);
    if (first) return { status: 'duplicate', event: clone(first), state: snapshot() };
  }

  // 2. 乐观并发：版本不一致 → 追加冲突事件，业务状态不动。
  const expectedVersion = currentVersion(entityType, entityId);
  if (expectedVersion !== envelope.expectedVersion) {
    const { chain, event } = appendEvent(state.chain, {
      operationId,
      entityType,
      entityId,
      action: 'CONFLICT_REJECTED',
      actor,
      timestamp,
      payload: {
        reason: 'VERSION_MISMATCH',
        expectedVersion: envelope.expectedVersion,
        actualVersion: expectedVersion,
        attemptedAction: action,
        note: '后到操作因版本不匹配被拒绝，先到操作已成立'
      }
    });
    state.chain = chain;
    state.seenOperationIds.add(operationId);
    return { status: 'conflict', reason: 'VERSION_MISMATCH', event: clone(event), state: snapshot() };
  }

  // 3. 原子写入：同一同步块内追加事件 + 落地业务状态。
  const { chain, event } = appendEvent(state.chain, { operationId, entityType, entityId, action, actor, timestamp, payload });
  state.chain = chain;
  applyBusinessChange(envelope);
  applyHead(entityType, entityId, event.hash, expectedVersion + 1);
  state.seenOperationIds.add(operationId);
  return { status: 'applied', event: clone(event), state: snapshot() };
}

export function getEvidenceState(): EvidenceState {
  ensureInitialized();
  return snapshot();
}

/** 演示用：重置为初始状态并重新迁移。 */
export function resetForDemo(): EvidenceState {
  state.initialized = false;
  state.chain = [];
  state.seenOperationIds = new Set();
  state.records = [];
  state.findings = [];
  state.issuanceMeta = {};
  state.migratedCount = 0;
  ensureInitialized();
  return snapshot();
}
