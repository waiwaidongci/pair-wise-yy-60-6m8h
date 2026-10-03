// 追加式审计链（append-only audit chain）。
//
// 每条业务写入（记录 / 发现项 / 签发勾选）都生成一个事件，事件带操作号 operationId
// 与版本号 seq，并通过 prevHash 串成哈希链。任何一环缺事件或被改动，
// verifyChain 都会在断点处报出，签发准备据此立即失效。
//
// 事件哈希 = sha256(canonicalJson(事件除 hash 外的全部字段))，prevHash 指向上一事件哈希。

import { sha256Hex } from './sha256';

export type EntityType = 'record' | 'finding' | 'issuance';

export type AuditEvent = {
  eventId: string;
  /** 操作号：同号重试必须取首次结果，不得重复追加事件。 */
  operationId: string;
  /** 链上版本号（从 0 连续递增）。 */
  seq: number;
  entityType: EntityType;
  entityId: string;
  /** 业务动作，如 VERIFY / REVISE / CLOSE_FINDING / TOGGLE_ISSUANCE / GENESIS / CONFLICT_REJECTED。 */
  action: string;
  actor: string;
  timestamp: string;
  /** 业务载荷，含 before/after 快照与原因。 */
  payload: Record<string, unknown>;
  /** 上一事件哈希；创世事件指向 GENESIS。 */
  prevHash: string;
  hash: string;
};

export type BreakPoint = {
  seq: number;
  eventId: string;
  reason: string;
};

export type ChainVerification = {
  valid: boolean;
  breakAt: BreakPoint | null;
  eventCount: number;
  genesisCount: number;
};

export const GENESIS_PREV_HASH = 'GENESIS';

/** 稳定 JSON：键排序，保证同一对象无论键序如何都得到同一哈希。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

function hashablePart(event: AuditEvent): Omit<AuditEvent, 'hash'> {
  const { hash: _hash, ...rest } = event;
  return rest;
}

export function computeEventHash(event: AuditEvent): string {
  return sha256Hex(canonicalJson(hashablePart(event)));
}

export type EventInput = {
  operationId: string;
  entityType: EntityType;
  entityId: string;
  action: string;
  actor: string;
  payload: Record<string, unknown>;
  timestamp?: string;
  eventId?: string;
};

/** 在链尾追加一个事件，自动分配 seq、prevHash 并计算哈希。 */
export function appendEvent(chain: AuditEvent[], input: EventInput): { chain: AuditEvent[]; event: AuditEvent } {
  const seq = chain.length === 0 ? 0 : chain[chain.length - 1].seq + 1;
  const prevHash = chain.length === 0 ? GENESIS_PREV_HASH : chain[chain.length - 1].hash;
  const event: AuditEvent = {
    eventId: input.eventId ?? `evt_${input.operationId}`,
    operationId: input.operationId,
    seq,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    actor: input.actor,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload,
    prevHash,
    hash: ''
  };
  event.hash = computeEventHash(event);
  return { chain: [...chain, event], event };
}

/** 按操作号查找首次事件（幂等：同号重试取首次结果）。 */
export function findEventByOperationId(chain: AuditEvent[], operationId: string): AuditEvent | undefined {
  return chain.find((event) => event.operationId === operationId);
}

/** 某实体最近一次“已应用”事件（CONFLICT_REJECTED 未落地，不算已应用）。 */
export function lastAppliedEventFor(chain: AuditEvent[], entityType: EntityType, entityId: string): AuditEvent | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const event = chain[i];
    if (event.entityType === entityType && event.entityId === entityId && event.action !== 'CONFLICT_REJECTED') return event;
  }
  return undefined;
}

/** 为旧数据构造首版（GENESIS）事件。 */
export function buildGenesis(input: { entityType: EntityType; entityId: string; state: unknown; actor: string; timestamp?: string }): AuditEvent {
  const event: AuditEvent = {
    eventId: `evt_genesis_${input.entityType}_${input.entityId}`,
    operationId: `genesis_${input.entityType}_${input.entityId}`,
    seq: 0,
    entityType: input.entityType,
    entityId: input.entityId,
    action: 'GENESIS',
    actor: input.actor,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: { after: input.state, note: '首版摘要（旧数据升级补全）' },
    prevHash: GENESIS_PREV_HASH,
    hash: ''
  };
  event.hash = computeEventHash(event);
  return event;
}

/**
 * 旧数据升级：对缺少 GENESIS 的实体补成首版。
 * 返回新链与新增的首版事件列表。
 */
export function migrateEntities(
  chain: AuditEvent[],
  entities: { type: EntityType; id: string; state: unknown }[],
  actor: string
): { chain: AuditEvent[]; added: AuditEvent[] } {
  let next = [...chain];
  const added: AuditEvent[] = [];
  for (const entity of entities) {
    const hasGenesis = next.some((event) => event.entityType === entity.type && event.entityId === entity.id && event.action === 'GENESIS');
    if (!hasGenesis) {
      const { chain: appended, event } = appendEvent(next, {
        operationId: `genesis_${entity.type}_${entity.id}`,
        entityType: entity.type,
        entityId: entity.id,
        action: 'GENESIS',
        actor,
        payload: { after: entity.state, note: '首版摘要（旧数据升级补全）' }
      });
      next = appended;
      added.push(event);
    }
  }
  return { chain: next, added };
}

/**
 * 校验整条审计链：
 * 1. seq 连续无缺口；
 * 2. prevHash 与上一事件哈希一致；
 * 3. 每个事件哈希重算一致（防改动）；
 * 4. 每个实体都有 GENESIS 首版。
 * 任一不满足即返回断点，签发准备据此失效。
 */
export function verifyChain(chain: AuditEvent[]): ChainVerification {
  let genesisCount = 0;
  for (let i = 0; i < chain.length; i++) {
    const event = chain[i];
    if (event.seq !== i) {
      return {
        valid: false,
        breakAt: { seq: event.seq, eventId: event.eventId, reason: `序列断裂：第 ${i} 个位置的事件 seq=${event.seq}，期望 ${i}` },
        eventCount: chain.length,
        genesisCount
      };
    }
    const expectedPrev = i === 0 ? GENESIS_PREV_HASH : chain[i - 1].hash;
    if (event.prevHash !== expectedPrev) {
      return {
        valid: false,
        breakAt: { seq: event.seq, eventId: event.eventId, reason: `前链哈希不匹配：prevHash 与上一事件哈希不一致，链可能被增删` },
        eventCount: chain.length,
        genesisCount
      };
    }
    const expectedHash = computeEventHash(event);
    if (event.hash !== expectedHash) {
      return {
        valid: false,
        breakAt: { seq: event.seq, eventId: event.eventId, reason: `事件哈希被篡改：重算哈希与记录哈希不一致` },
        eventCount: chain.length,
        genesisCount
      };
    }
    if (event.action === 'GENESIS') genesisCount++;
  }
  return { valid: true, breakAt: null, eventCount: chain.length, genesisCount };
}
