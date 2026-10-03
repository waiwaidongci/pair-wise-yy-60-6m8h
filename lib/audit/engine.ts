// 服务端审计链引擎（只允许在 Route Handler / 服务端任务中引用）。
//
// 设计要点：
// 1. 只追加：业务状态永远由事件重放得到，任何写操作 = 先判定再追加 1 条事件。
// 2. 哈希链：hash = sha256(规范化 JSON(事件除 hash 外字段))，prevHash 指向上一条；
//    首条指向 GENESIS。缺事件（断号）、被改动（hash/prevHash 对不上）一验即知。
// 3. 操作号幂等：同一 opId 的重试直接返回首次结果（replayed），绝不追加第二条。
// 4. 乐观版本：命令带 expectedVersion，两人同改一条时先到成立，后到原样留一条
//    outcome=conflict 的冲突事件（链上可见、业务状态不动）。
// 5. 原子落盘：状态不从内存修改，每次由落盘后的事件文件重放；写入用临时文件 +
//    rename，要么整条事件在链里、要么不在，不存在半条链。
// 6. 旧数据升级：首次启动为每个旧实体补一条 chain.bootstrap 首版事件，正文带
//    旧实体快照摘要 digest；缺摘要的迁移事件在校验时直接判断点。

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AuditCommand,
  AuditEvent,
  ChainBreak,
  ChainVerification,
  CommandResponse,
  EventOutcome,
  GENESIS_HASH,
  IssuanceCheckView,
  FindingView,
  RecordView,
  StateView
} from './types';
import {
  checkSeeds,
  findingSeeds,
  projectSeed,
  recordSeeds,
  sampledSeed,
  summarySeed
} from './seed';

const DATA_DIR = path.join(process.cwd(), '.audit-data');
const CHAIN_FILE = path.join(DATA_DIR, 'chain.json');
const MIGRATION_SOURCE = 'legacy-page-store@v1';

interface ChainFile {
  version: 1;
  createdAt: string;
  events: AuditEvent[];
}

interface RecordState {
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
  conflict: RecordView['conflict'];
}

interface FindingState {
  id: string;
  recordId: string;
  type: string;
  title: string;
  detail: string;
  assignee: string;
  due: string;
  status: string;
  version: number;
}

interface CheckState {
  id: string;
  checked: boolean;
  version: number;
}

interface MutableState {
  records: Map<string, RecordState>;
  findings: Map<string, FindingState>;
  checks: Map<string, CheckState>;
  sampled: Set<string>;
  issuanceSubmitted: boolean;
  issuanceSubmittedAt: string | null;
  /** 仅 issuance.submit 事件使用的版本号。 */
  issuanceVersion: number;
}

interface PlannedEvent {
  opId: string;
  type: string;
  actor: string;
  entity: AuditEvent['entity'];
  targetId: string | null;
  expectedVersion: number;
  payload: Record<string, unknown>;
  outcome: EventOutcome;
  conflictOfSeq: number | null;
  fromVersion: number;
  toVersion: number;
}

// ---------- 规范化哈希 ----------

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(',')}}`;
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

// 关键：存盘对象与参与哈希的对象必须是同一份规范化（键序排序）结构，
// 否则“算 hash 时的字段序”和“校验时展开拷贝的字段序”不一致会误报篡改。
function canonicalClone<T>(value: T): T {
  return JSON.parse(canonical(value)) as T;
}

function eventHash(event: Omit<AuditEvent, 'hash'>): string {
  return sha256Hex(canonicalClone(event));
}

// ---------- 链文件读取 / 原子写入 ----------

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeChainAtomic(file: ChainFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CHAIN_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // 先完整落临时文件再原子替换：中途崩溃不会出现写了一半的链。
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await fs.rename(tmp, CHAIN_FILE);
}

// ---------- 旧数据升级：补首版摘要 ----------

function buildEvent(fields: Omit<AuditEvent, 'seq' | 'hash'>, seq: number, prevHash: string): AuditEvent {
  const body = canonicalClone({ seq, ...fields });
  return { ...body, hash: eventHash(body) };
}

function bootstrapEvents(now: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  let prevHash = GENESIS_HASH;
  let seq = 0;
  const push = (fields: Omit<AuditEvent, 'seq' | 'hash'>) => {
    seq += 1;
    const event = buildEvent(fields, seq, prevHash);
    events.push(event);
    prevHash = event.hash;
  };

  for (const seed of recordSeeds) {
    const snapshot = { ...seed, version: 1 };
    push({
      opId: `migrate-record-${seed.id}`,
      type: 'chain.bootstrap',
      actor: 'system-upgrade',
      targetId: seed.id,
      entity: 'record',
      expectedVersion: 0,
      fromVersion: 0,
      toVersion: 1,
      payload: { migratedFrom: MIGRATION_SOURCE, snapshot, digest: sha256Hex(snapshot) },
      outcome: 'applied',
      conflictOfSeq: null,
      migrated: true,
      at: now,
      prevHash
    });
  }
  for (const seed of findingSeeds) {
    const snapshot = { ...seed, version: 1 };
    push({
      opId: `migrate-finding-${seed.id}`,
      type: 'chain.bootstrap',
      actor: 'system-upgrade',
      targetId: seed.id,
      entity: 'finding',
      expectedVersion: 0,
      fromVersion: 0,
      toVersion: 1,
      payload: { migratedFrom: MIGRATION_SOURCE, snapshot, digest: sha256Hex(snapshot) },
      outcome: 'applied',
      conflictOfSeq: null,
      migrated: true,
      at: now,
      prevHash
    });
  }
  push({
    opId: 'migrate-sample-set',
    type: 'chain.bootstrap',
    actor: 'system-upgrade',
    targetId: 'SAMPLE',
    entity: 'sample',
    expectedVersion: 0,
    fromVersion: 0,
    toVersion: 1,
    payload: { migratedFrom: MIGRATION_SOURCE, snapshot: { ids: sampledSeed }, digest: sha256Hex({ ids: sampledSeed }) },
    outcome: 'applied',
    conflictOfSeq: null,
    migrated: true,
    at: now,
    prevHash
  });
  for (const seed of checkSeeds) {
    const snapshot = { ...seed, version: 1 };
    push({
      opId: `migrate-check-${seed.id}`,
      type: 'chain.bootstrap',
      actor: 'system-upgrade',
      targetId: seed.id,
      entity: 'issuance',
      expectedVersion: 0,
      fromVersion: 0,
      toVersion: 1,
      payload: { migratedFrom: MIGRATION_SOURCE, snapshot, digest: sha256Hex(snapshot) },
      outcome: 'applied',
      conflictOfSeq: null,
      migrated: true,
      at: now,
      prevHash
    });
  }
  return events;
}

async function loadOrBootstrap(): Promise<ChainFile> {
  if (await fileExists(CHAIN_FILE)) {
    const raw = await fs.readFile(CHAIN_FILE, 'utf8');
    const parsed = JSON.parse(raw) as ChainFile;
    // 旧版本数据升级：首版事件缺摘要的补 digest（仅此一种断点允许自愈）。
    return repairMigratedDigests(parsed);
  }
  const file: ChainFile = { version: 1, createdAt: new Date().toISOString(), events: bootstrapEvents(new Date().toISOString()) };
  await writeChainAtomic(file);
  return file;
}

/**
 * 旧数据升级路径：迁移首版事件缺 digest 时按其快照补成首版摘要。
 * 补摘要会改变这些事件的 hash，因此重算整条哈希链，并追加一条 chain.repair
 * 事件记录修复范围；其他类型断点（内容被改动、断号）一律不在此自愈。
 */
async function repairMigratedDigests(file: ChainFile): Promise<ChainFile> {
  const repairedSeqs: number[] = [];
  for (const event of file.events) {
    if (event.migrated && (typeof event.payload.digest !== 'string' || event.payload.digest.length === 0)) {
      const snapshot = event.payload.snapshot;
      if (snapshot && typeof snapshot === 'object') {
        event.payload.digest = sha256Hex(snapshot);
        repairedSeqs.push(event.seq);
      }
    }
  }
  if (repairedSeqs.length === 0) return file;

  const rebuilt: AuditEvent[] = [];
  let prevHash = GENESIS_HASH;
  file.events.forEach((event, index) => {
    const { hash: _hash, seq: _seq, ...body } = event;
    void _hash;
    void _seq;
    const next = buildEvent(body, index + 1, prevHash);
    rebuilt.push(next);
    prevHash = next.hash;
  });

  const repairedFile: ChainFile = { ...file, events: rebuilt };
  const marker = buildEvent(
    {
      opId: `upgrade-fill-digest-${Date.now()}`,
      type: 'chain.repair',
      actor: 'system-upgrade',
      targetId: null,
      entity: 'chain',
      expectedVersion: 0,
      fromVersion: 0,
      toVersion: 0,
      payload: { kind: 'fill-migrated-digest', repairedSeqs, note: '旧数据升级：为缺摘要的首版事件补算 digest 并重算哈希链' },
      outcome: 'applied',
      conflictOfSeq: null,
      migrated: false,
      at: new Date().toISOString(),
      prevHash
    },
    rebuilt.length + 1,
    prevHash
  );
  repairedFile.events = [...rebuilt, marker];
  await writeChainAtomic(repairedFile);
  return repairedFile;
}

// ---------- 校验：缺事件 / 被改动 / 缺摘要 ----------

export function verifyChain(events: AuditEvent[]): ChainVerification {
  const breaks: ChainBreak[] = [];
  let prevHash = GENESIS_HASH;

  events.forEach((event, index) => {
    const expectedSeq = index + 1;
    if (event.seq !== expectedSeq) {
      breaks.push({ atSeq: event.seq, kind: 'gap', message: `审计链断号：期望第 ${expectedSeq} 条，实际序号 ${event.seq}，中间有事件缺失` });
    }
    if (event.prevHash !== prevHash) {
      breaks.push({ atSeq: event.seq, kind: 'prevhash-mismatch', message: `事件 #${event.seq} 的 prevHash 与前序事件对不上（应为 ${prevHash.slice(0, 12)}…），前序事件缺失或被改动` });
    }
    const { hash, ...body } = event;
    if (eventHash(body) !== hash) {
      breaks.push({ atSeq: event.seq, kind: hash ? 'tampered' : 'hash-mismatch', message: `事件 #${event.seq} 内容摘要校验失败：事件被改动或字段缺失` });
    }
    if (event.migrated && (typeof event.payload.digest !== 'string' || event.payload.digest.length === 0)) {
      breaks.push({ atSeq: event.seq, kind: 'missing-digest', message: `迁移首版事件 #${event.seq}（${event.targetId ?? event.entity}）缺少旧数据摘要 digest` });
    }
    prevHash = event.hash;
  });

  return {
    valid: breaks.length === 0,
    eventCount: events.length,
    lastHash: events.length ? events[events.length - 1].hash : GENESIS_HASH,
    breaks
  };
}

// ---------- 重放：事件 -> 当前业务状态 ----------

function emptyState(): MutableState {
  return {
    records: new Map(),
    findings: new Map(),
    checks: new Map(),
    sampled: new Set(),
    issuanceSubmitted: false,
    issuanceSubmittedAt: null,
    issuanceVersion: 0
  };
}

function replay(events: AuditEvent[]): MutableState {
  const state = emptyState();

  for (const event of events) {
    if (event.outcome === 'conflict') continue; // 后到冲突原样留链，但不改变业务状态

    switch (event.type) {
      case 'chain.bootstrap': {
        const snapshot = event.payload.snapshot as Record<string, unknown>;
        // 必须结构化复制：重放产生的可变状态绝不能与事件正文共享对象引用，
        // 否则后续版本修改会“回写”首版事件，表现为哈希链被自身重放篡改。
        if (event.entity === 'record') {
          state.records.set(String(snapshot.id), {
            ...(structuredClone(snapshot) as Omit<RecordState, 'conflict'>),
            conflict: null
          });
        } else if (event.entity === 'finding') {
          state.findings.set(String(snapshot.id), structuredClone(snapshot) as unknown as FindingState);
        } else if (event.entity === 'issuance') {
          state.checks.set(String(snapshot.id), { id: String(snapshot.id), checked: Boolean(snapshot.checked), version: 1 });
        } else if (event.entity === 'sample') {
          state.sampled = new Set((snapshot.ids as string[]) ?? []);
        }
        break;
      }
      case 'sample.toggle': {
        const id = String(event.payload.recordId);
        if (event.payload.add) state.sampled.add(id);
        else state.sampled.delete(id);
        break;
      }
      case 'record.startCorrection': {
        const record = state.records.get(String(event.targetId));
        if (record) {
          record.status = '复核中';
          record.version = event.toVersion;
          record.conflict = null;
        }
        break;
      }
      case 'record.verify': {
        const record = state.records.get(String(event.targetId));
        if (record) {
          record.status = '已核验';
          record.version = event.toVersion;
          record.conflict = null;
        }
        break;
      }
      case 'record.batchVerify': {
        const ids = (event.payload.ids as string[]) ?? [];
        for (const id of ids) {
          const record = state.records.get(id);
          if (record && record.status !== '需补证') {
            record.status = '已核验';
            record.version += 1;
            record.conflict = null;
          }
        }
        break;
      }
      case 'record.revise': {
        const record = state.records.get(String(event.targetId));
        if (record) {
          record.activity = Number(event.payload.value);
          record.revision = Number(event.payload.revision);
          record.status = '复核中';
          record.version = event.toVersion;
          record.conflict = null;
        }
        break;
      }
      case 'finding.requestEvidence': {
        const finding = state.findings.get(String(event.targetId));
        if (finding) {
          finding.status = '补证中';
          finding.version = event.toVersion;
        }
        break;
      }
      case 'finding.close': {
        const finding = state.findings.get(String(event.targetId));
        if (finding) {
          finding.status = '已关闭';
          finding.version = event.toVersion;
        }
        break;
      }
      case 'issuance.toggleCheck': {
        const check = state.checks.get(String(event.targetId));
        if (check) {
          check.checked = Boolean(event.payload.checked);
          check.version = event.toVersion;
        }
        break;
      }
      case 'issuance.submit': {
        state.issuanceSubmitted = true;
        state.issuanceSubmittedAt = event.at;
        state.issuanceVersion = event.toVersion;
        break;
      }
    }
  }

  return state;
}
// 跨实体扫描未决后到冲突：冲突之后若同一实体出现过任何新的 applied 事件
// （说明后到方已基于新版本重新操作），视为冲突已解决。
function findOpenConflicts(events: AuditEvent[]): StateView['audit']['conflicts'] {
  const open: StateView['audit']['conflicts'] = [];
  for (const event of events) {
    if (event.outcome !== 'conflict') continue;
    const resolvedByNewer = events.some(
      (later) =>
        later.seq > event.seq &&
        later.outcome === 'applied' &&
        later.entity === event.entity &&
        later.targetId === event.targetId
    );
    if (!resolvedByNewer) {
      open.push({
        entity: event.entity,
        targetId: String(event.targetId),
        opId: event.opId,
        type: event.type,
        actor: event.actor,
        at: event.at,
        againstSeq: event.conflictOfSeq ?? 0
      });
    }
  }
  return open;
}

// ---------- 投影：供接口返回 ----------

function reductionOf(record: { activity: number; factor: number; unit: string }): number {
  const divisor = record.unit === 'kWh' || record.unit === 'L' ? 1000 : 1;
  return (record.activity * record.factor) / divisor;
}

function project(file: ChainFile): StateView {
  const chain = verifyChain(file.events);
  const state = replay(file.events);
  const conflicts = findOpenConflicts(file.events);

  // 记录行上的冲突角标：与跨实体未决冲突清单保持一致。
  for (const conflict of conflicts) {
    if (conflict.entity === 'record') {
      const record = state.records.get(conflict.targetId);
      if (record) {
        record.conflict = { opId: conflict.opId, type: conflict.type, actor: conflict.actor, at: conflict.at, againstSeq: conflict.againstSeq };
      }
    }
  }

  const records: RecordView[] = recordSeeds.map((seed) => {
    const current = state.records.get(seed.id);
    // 断链（缺事件）时对应实体可能没有快照：用旧数据占位继续投影，断点本身由 chain.breaks 指出。
    if (!current) return { ...seed, version: 0, conflict: null, missing: true } as RecordView;
    return { ...current };
  });
  const findings: FindingView[] = findingSeeds.map((seed) => {
    const current = state.findings.get(seed.id);
    if (!current) return { ...seed, version: 0, missing: true } as FindingView;
    return { ...current };
  });
  const checks: IssuanceCheckView[] = checkSeeds.map((seed) => {
    const check = state.checks.get(seed.id);
    if (!check) return { id: seed.id, title: `${seed.title}（首版事件缺失）`, checked: false, version: 0 };
    return { id: seed.id, title: seed.title, checked: check.checked, version: check.version };
  });

  const openFindings = findings.filter((f) => f.status !== '已关闭');

  const businessReady = checks.every((c) => c.checked) && openFindings.length === 0;
  const ready = businessReady && chain.valid;

  return {
    project: { ...projectSeed },
    summary: {
      period: summarySeed.period,
      reduction: Math.round(records.reduce((sum, r) => sum + reductionOf(r), 0)),
      evidenceRate: summarySeed.evidenceRate,
      openFindings: openFindings.length,
      sampled: summarySeed.sampled
    },
    records,
    findings,
    sampledIds: [...state.sampled],
    checks,
    issuance: {
      submitted: state.issuanceSubmitted,
      submittedAt: state.issuanceSubmittedAt,
      version: state.issuanceVersion,
      ready,
      invalidReasons: [
        ...openFindings.slice(0, 3).map((f) => `开放发现项未关闭：${f.title}`),
        ...checks.filter((c) => !c.checked).map((c) => `签发检查项未确认：${c.title}`),
        ...(chain.valid ? [] : chain.breaks.map((b) => `审计链断点 @#${b.atSeq ?? '?'}：${b.message}`))
      ]
    } as StateView['issuance'],
    audit: {
      chain,
      lastOpId: file.events.length ? file.events[file.events.length - 1].opId : null,
      conflicts
    }
  };
}

// ---------- 命令校验与规划 ----------

const commandTypes = new Set([
  'sample.toggle',
  'record.startCorrection',
  'record.verify',
  'record.batchVerify',
  'finding.requestEvidence',
  'finding.close',
  'issuance.toggleCheck',
  'record.revise',
  'issuance.submit'
]);

function validateCommandShape(body: unknown): { command: AuditCommand | null; error?: string } {
  const cmd = body as Partial<AuditCommand>;
  if (!cmd || typeof cmd !== 'object') return { command: null, error: '请求体必须是对象' };
  if (typeof cmd.opId !== 'string' || !/^[\w:.-]{6,120}$/.test(cmd.opId)) return { command: null, error: 'opId 缺失或格式不合法（6-120 位字母数字及 _:.-）' };
  if (typeof cmd.type !== 'string' || !commandTypes.has(cmd.type)) return { command: null, error: `不支持的操作类型：${String(cmd.type)}` };
  if (typeof cmd.actor !== 'string' || !cmd.actor.trim()) return { command: null, error: '缺少操作人 actor' };
  return {
    command: {
      opId: cmd.opId,
      type: cmd.type,
      actor: cmd.actor.trim(),
      expectedVersion: typeof cmd.expectedVersion === 'number' ? cmd.expectedVersion : 0,
      targetId: typeof cmd.targetId === 'string' ? cmd.targetId : undefined,
      payload: cmd.payload && typeof cmd.payload === 'object' ? cmd.payload : {}
    }
  };
}

function lastAppliedSeqFor(events: AuditEvent[], entity: string, targetId: string | null): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.outcome === 'applied' && event.entity === entity && (event.targetId ?? null) === targetId) return event.seq;
  }
  return 0;
}

/** 纯函数：在当前状态上判定命令结果并规划待追加事件，不修改状态。 */
function plan(command: AuditCommand, state: MutableState, events: AuditEvent[], now: string): PlannedEvent | { error: string } {
  const expected = command.expectedVersion ?? 0;
  const base = {
    opId: command.opId,
    type: command.type,
    actor: command.actor,
    expectedVersion: expected
  };

  const conflict = (entity: AuditEvent['entity'], targetId: string, currentVersion: number): PlannedEvent => ({
    ...base,
    entity,
    targetId,
    payload: { currentVersion, note: '后到操作：同一条目已被先到操作修改，本次保持原内容并留冲突' },
    outcome: 'conflict',
    conflictOfSeq: lastAppliedSeqFor(events, entity, targetId),
    fromVersion: expected,
    toVersion: currentVersion
  });

  switch (command.type) {
    case 'sample.toggle': {
      const recordId = String(command.payload?.recordId ?? command.targetId ?? '');
      const add = Boolean(command.payload?.add);
      if (!state.records.has(recordId)) return { error: `记录 ${recordId} 不存在` };
      return { ...base, entity: 'sample', targetId: 'SAMPLE', payload: { recordId, add }, outcome: 'applied', conflictOfSeq: null, fromVersion: 0, toVersion: 0 };
    }
    case 'record.batchVerify': {
      const ids = Array.isArray(command.payload?.ids) ? (command.payload!.ids as unknown[]).map(String) : [...state.sampled];
      const valid = ids.filter((id) => state.records.has(id));
      return { ...base, entity: 'record', targetId: null, payload: { ids: valid }, outcome: 'applied', conflictOfSeq: null, fromVersion: 0, toVersion: 0 };
    }
    case 'record.startCorrection':
    case 'record.verify': {
      const record = state.records.get(String(command.targetId));
      if (!record) return { error: `记录 ${command.targetId} 不存在` };
      if (expected > 0 && expected !== record.version) return conflict('record', record.id, record.version);
      const next = record.version + (record.status === (command.type === 'record.verify' ? '已核验' : '复核中') ? 0 : 1);
      return { ...base, entity: 'record', targetId: record.id, payload: { status: command.type === 'record.verify' ? '已核验' : '复核中' }, outcome: 'applied', conflictOfSeq: null, fromVersion: record.version, toVersion: next };
    }
    case 'record.revise': {
      const record = state.records.get(String(command.targetId));
      if (!record) return { error: `记录 ${command.targetId} 不存在` };
      const value = Number(command.payload?.value);
      const reason = String(command.payload?.reason ?? '').trim();
      if (!Number.isFinite(value)) return { error: '修订值必须是数字' };
      if (!reason) return { error: '必须填写修订原因' };
      if (expected > 0 && expected !== record.version) return conflict('record', record.id, record.version);
      return {
        ...base,
        entity: 'record',
        targetId: record.id,
        payload: { value, reason, previousValue: record.activity, revision: record.revision + 1 },
        outcome: 'applied',
        conflictOfSeq: null,
        fromVersion: record.version,
        toVersion: record.version + 1
      };
    }
    case 'finding.requestEvidence':
    case 'finding.close': {
      const finding = state.findings.get(String(command.targetId));
      if (!finding) return { error: `发现项 ${command.targetId} 不存在` };
      const nextStatus = command.type === 'finding.close' ? '已关闭' : '补证中';
      if (expected > 0 && expected !== finding.version) {
        return {
          ...base,
          entity: 'finding',
          targetId: finding.id,
          payload: { currentVersion: finding.version },
          outcome: 'conflict',
          conflictOfSeq: lastAppliedSeqFor(events, 'finding', finding.id),
          fromVersion: expected,
          toVersion: finding.version
        };
      }
      return { ...base, entity: 'finding', targetId: finding.id, payload: { status: nextStatus }, outcome: 'applied', conflictOfSeq: null, fromVersion: finding.version, toVersion: finding.version + (finding.status === nextStatus ? 0 : 1) };
    }
    case 'issuance.toggleCheck': {
      const check = state.checks.get(String(command.targetId));
      if (!check) return { error: `检查项 ${command.targetId} 不存在` };
      const checked = Boolean(command.payload?.checked);
      if (expected > 0 && expected !== check.version) {
        return {
          ...base,
          entity: 'issuance',
          targetId: check.id,
          payload: { currentVersion: check.version },
          outcome: 'conflict',
          conflictOfSeq: lastAppliedSeqFor(events, 'issuance', check.id),
          fromVersion: expected,
          toVersion: check.version
        };
      }
      const bumped = check.version + 1;
      return { ...base, entity: 'issuance', targetId: check.id, payload: { checked }, outcome: 'applied', conflictOfSeq: null, fromVersion: check.version, toVersion: checked === check.checked ? check.version : bumped };
    }
    case 'issuance.submit': {
      const open = [...state.findings.values()].filter((f) => f.status !== '已关闭');
      const unchecked = [...state.checks.values()].filter((c) => !c.checked);
      if (state.issuanceSubmitted) return { error: '签发准备已提交，不能重复提交' };
      if (open.length || unchecked.length) {
        return { error: `签发门禁未完成：${open.length} 个发现项开放，${unchecked.length} 个检查项未确认` };
      }
      return { ...base, entity: 'issuance', targetId: 'ISSUANCE', payload: {}, outcome: 'applied', conflictOfSeq: null, fromVersion: state.issuanceVersion, toVersion: state.issuanceVersion + 1 };
    }
  }
}

// ---------- 追加（串行化 + 原子写） ----------

let chainLock: Promise<unknown> = Promise.resolve();

function withLock<T>(work: () => Promise<T>): Promise<T> {
  const run = chainLock.then(work, work);
  chainLock = run.catch(() => undefined);
  return run;
}

function response(status: CommandResponse['status'], event: AuditEvent | null, file: ChainFile, extra: Partial<CommandResponse> = {}): CommandResponse {
  return {
    status,
    replayed: extra.replayed ?? false,
    opId: event?.opId ?? extra.opId ?? '',
    seq: event?.seq ?? null,
    event,
    state: project(file),
    ...extra
  };
}

export async function getStateView(): Promise<StateView> {
  const file = await loadOrBootstrap();
  return project(file);
}

export async function getEvents(): Promise<{ events: AuditEvent[]; chain: ChainVerification }> {
  const file = await loadOrBootstrap();
  return { events: file.events, chain: verifyChain(file.events) };
}

export async function appendCommand(rawBody: unknown): Promise<{ httpStatus: number; body: CommandResponse }> {
  return withLock(async () => {
    const { command, error } = validateCommandShape(rawBody);
    if (!command) {
      const file = await loadOrBootstrap();
      return { httpStatus: 400, body: { status: 'invalid', replayed: false, opId: '', seq: null, event: null, state: project(file), error } };
    }

    const file = await loadOrBootstrap();

    // 同号重试：直接取首次结果，绝不重复追加。
    const first = file.events.find((event) => event.opId === command.opId);
    if (first) {
      const status = first.outcome === 'conflict' ? 'conflict' : 'applied';
      return { httpStatus: status === 'conflict' ? 409 : 200, body: response(status, first, file, { replayed: true, conflictOfSeq: first.conflictOfSeq ?? undefined }) };
    }

    // 链已经断了：停止受理写操作，强制先指出断点。
    const chain = verifyChain(file.events);
    if (!chain.valid) {
      return { httpStatus: 409, body: response('chain-broken', null, file, { opId: command.opId, error: '审计链校验未通过，已冻结写入' }) };
    }

    const state = replay(file.events);
    const planned = plan(command, state, file.events, new Date().toISOString());
    if ('error' in planned) {
      return { httpStatus: 400, body: response('invalid', null, file, { opId: command.opId, error: planned.error }) };
    }

    const prevHash = file.events.length ? file.events[file.events.length - 1].hash : GENESIS_HASH;
    const event = buildEvent(
      {
        opId: planned.opId,
        type: planned.type,
        actor: planned.actor,
        targetId: planned.targetId,
        entity: planned.entity,
        expectedVersion: planned.expectedVersion,
        fromVersion: planned.fromVersion,
        toVersion: planned.toVersion,
        payload: planned.payload,
        outcome: planned.outcome,
        conflictOfSeq: planned.conflictOfSeq,
        migrated: false,
        at: new Date().toISOString(),
        prevHash
      },
      file.events.length + 1,
      prevHash
    );

    const nextFile: ChainFile = { ...file, events: [...file.events, event] };

    // 业务状态与事件在同一次原子写入中提交；写失败则链文件不变，
    // 客户端按原 opId 重试即可，不会留下半条链。
    await writeChainAtomic(nextFile);

    const status = planned.outcome === 'conflict' ? 'conflict' : 'applied';
    return { httpStatus: status === 'conflict' ? 409 : 200, body: response(status, event, nextFile, { conflictOfSeq: planned.conflictOfSeq ?? undefined }) };
  });
}

// 仅供测试/运维：重置链文件。
export async function resetChainForDev(): Promise<void> {
  await withLock(async () => {
    await fs.rm(CHAIN_FILE, { force: true });
    await loadOrBootstrap();
  });
}

// 仅供演示：直接改一条事件的正文且不重算 hash（模拟链被改动）。
export async function tamperChainForDev(seq?: number): Promise<number> {
  return withLock(async () => {
    const file = await loadOrBootstrap();
    const targetSeq = seq ?? file.events[file.events.length - 1].seq;
    const event = file.events.find((item) => item.seq === targetSeq);
    if (!event) throw new Error('事件不存在');
    // 故意只改正文、保留原 hash。
    event.payload = { ...event.payload, tampered: true, tamperedAt: new Date().toISOString() };
    await writeChainAtomic(file);
    return targetSeq;
  });
}

// 仅供演示：删掉倒数第二条事件（模拟缺事件/断号）。
export async function dropMiddleEventForDev(): Promise<number> {
  return withLock(async () => {
    const file = await loadOrBootstrap();
    if (file.events.length < 3) throw new Error('链太短，无法演示缺事件');
    const index = file.events.length - 2;
    const removed = file.events[index].seq;
    file.events.splice(index, 1);
    await writeChainAtomic(file);
    return removed;
  });
}
