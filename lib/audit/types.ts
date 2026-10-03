// 追加式审计链的共享类型定义（客户端可安全引用，不含任何服务端依赖）。

export const GENESIS_HASH = 'GENESIS';

export type EventOutcome = 'applied' | 'conflict';

export type CommandName =
  | 'sample.toggle'
  | 'record.startCorrection'
  | 'record.verify'
  | 'record.batchVerify'
  | 'finding.requestEvidence'
  | 'finding.close'
  | 'issuance.toggleCheck'
  | 'record.revise'
  | 'issuance.submit';

export interface AuditCommand {
  opId: string;
  type: CommandName;
  actor: string;
  /** 受管实体上的版本；未携带（0）表示不做并发校验，例如批量操作。 */
  expectedVersion?: number;
  targetId?: string;
  payload?: Record<string, unknown>;
}

export type EventPayload = Record<string, unknown>;

/**
 * 审计事件：一经追加不可改、不可删。
 * hash = sha256(规范化 JSON(除 hash 外的全部字段, 键名排序))，
 * prevHash 指向上一条事件的 hash，首版/首条指向 GENESIS。
 */
export interface AuditEvent {
  seq: number;
  opId: string;
  type: string;
  actor: string;
  targetId: string | null;
  entity: 'record' | 'finding' | 'sample' | 'issuance' | 'chain';
  expectedVersion: number;
  fromVersion: number;
  toVersion: number;
  payload: EventPayload;
  outcome: EventOutcome;
  /** 冲突事件用：先成立那条事件的序号。 */
  conflictOfSeq: number | null;
  /** 旧数据升级产生的首版事件；正文必须含 digest 补摘要。 */
  migrated: boolean;
  at: string;
  prevHash: string;
  hash: string;
}

/** 签发前门禁检查项（其勾选变化同样写入审计链）。 */
export interface IssuanceCheckView {
  id: string;
  title: string;
  checked: boolean;
  version: number;
}

export interface RecordView {
  id: string;
  source: string;
  activity: number;
  unit: string;
  factor: number;
  factorUnit: string;
  timeRange: string;
  evidenceCount: number;
  anomaly: number;
  owner: string;
  status: string;
  revision: number;
  version: number;
  /** 断链导致首版事件缺失、实体无法重建时为 true。 */
  missing?: boolean;
  /** 当前实体上后到失败的操作号（先到已成立），解决（按新 opId 重试成功）后清空。 */
  conflict: { opId: string; type: string; actor: string; at: string; againstSeq: number } | null;
}

export interface FindingView {
  id: string;
  recordId: string;
  type: string;
  title: string;
  detail: string;
  assignee: string;
  due: string;
  status: string;
  version: number;
  missing?: boolean;
}

export interface ChainBreak {
  atSeq: number | null;
  kind: 'missing-event' | 'hash-mismatch' | 'prevhash-mismatch' | 'gap' | 'missing-digest' | 'tampered';
  message: string;
}

export interface ChainVerification {
  valid: boolean;
  eventCount: number;
  lastHash: string;
  breaks: ChainBreak[];
}

/** 审计链当前投影（业务状态 + 链信息），服务端是唯一事实来源。 */
export interface StateView {
  project: {
    id: string;
    name: string;
    methodology: string;
    vintage: string;
    verifier: string;
  };
  summary: {
    period: string;
    reduction: number;
    evidenceRate: number;
    openFindings: number;
    sampled: number;
  };
  records: RecordView[];
  findings: FindingView[];
  sampledIds: string[];
  checks: IssuanceCheckView[];
  issuance: {
    submitted: boolean;
    submittedAt: string | null;
    version: number;
    /** 业务门禁全部满足且审计链完整，才允许提交签发准备。 */
    ready: boolean;
    invalidReasons: string[];
  };
  audit: {
    chain: ChainVerification;
    lastOpId: string | null;
    /** 已落链但业务上未解决的后到冲突（记录/发现项/检查项均会出现）。 */
    conflicts: { entity: string; targetId: string; opId: string; type: string; actor: string; at: string; againstSeq: number }[];
  };
}

/** POST 统一响应；applied 幂等重放时 replayed=true。 */
export interface CommandResponse {
  status: 'applied' | 'conflict' | 'invalid' | 'chain-broken';
  replayed: boolean;
  opId: string;
  seq: number | null;
  event: AuditEvent | null;
  state: StateView;
  conflictOfSeq?: number;
  error?: string;
}

export const eventTypeLabels: Record<string, string> = {
  'chain.bootstrap': '旧数据升级 · 补首版摘要',
  'chain.repair': '旧链升级修复',
  'sample.toggle': '抽样勾选变更',
  'record.startCorrection': '发起复核',
  'record.verify': '核验通过',
  'record.batchVerify': '批量核验',
  'finding.requestEvidence': '发起补证',
  'finding.close': '关闭发现项',
  'issuance.toggleCheck': '签发检查项变更',
  'record.revise': '活动数据修订',
  'issuance.submit': '提交签发准备'
};
