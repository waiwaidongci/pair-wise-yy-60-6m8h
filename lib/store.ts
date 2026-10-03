import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  appendEvent,
  verifyChain,
  type AuditEvent,
  type BreakPoint,
  type EntityType
} from '@/lib/audit';
import {
  CURRENT_ACTOR,
  defaultFindings,
  defaultIssuanceChecks,
  defaultRecords,
  type CarbonRecord,
  type Finding,
  type IssuanceMeta
} from '@/lib/domain';
import { fetchEvidence, resetEvidence, submitOperation } from '@/lib/api';
import type { EvidenceResponse, OperationEnvelopeInput } from '@/lib/schema';

type PendingOpStatus = 'submitting' | 'confirmed' | 'conflict' | 'retryable';

type PendingOp = {
  status: PendingOpStatus;
  envelope: OperationEnvelopeInput;
  eventId: string;
  attempts: number;
  error?: string;
};

export type ConflictInfo = {
  operationId: string;
  reason: string;
  entityType: EntityType;
  entityId: string;
  action: string;
  at: string;
};

type State = {
  records: CarbonRecord[];
  findings: Finding[];
  selectedRecordId: string;
  sampledIds: string[];
  issuanceChecks: Record<string, boolean>;
  issuanceMeta: Record<string, IssuanceMeta>;
  chain: AuditEvent[];
  chainHeadHash: string;
  chainValid: boolean;
  chainBreakAt: BreakPoint | null;
  migratedCount: number;
  pendingOps: Record<string, PendingOp>;
  conflicts: ConflictInfo[];
  submitting: boolean;
  hydrated: boolean;
  hydrate: (data: EvidenceResponse) => void;
  selectRecord: (id: string) => void;
  toggleSample: (id: string) => void;
  startCorrection: (id: string) => Promise<void>;
  verifyRecord: (id: string) => Promise<void>;
  batchVerify: () => Promise<void>;
  requestEvidence: (findingId: string) => Promise<void>;
  closeFinding: (findingId: string) => Promise<void>;
  toggleIssuanceCheck: (id: string) => Promise<void>;
  reviseValue: (id: string, value: number, reason: string) => Promise<void>;
  submitIssuance: () => Promise<void>;
  retryOperation: (operationId: string) => Promise<void>;
  dismissConflict: (operationId: string) => void;
  tamperChain: () => void;
  tamperChainRemove: () => void;
  resyncChain: () => Promise<void>;
  resetDemo: () => Promise<void>;
};

const MAX_ATTEMPTS = 5;

function entityVersion(state: State, entityType: EntityType, entityId: string): number {
  if (entityType === 'record') return state.records.find((r) => r.id === entityId)?.version ?? 0;
  if (entityType === 'finding') return state.findings.find((f) => f.id === entityId)?.version ?? 0;
  return state.issuanceMeta[entityId]?.version ?? 0;
}

function snapshotEntity(state: State, entityType: EntityType, entityId: string): Record<string, unknown> {
  if (entityType === 'record') {
    const record = state.records.find((r) => r.id === entityId);
    return record ? { ...record } : {};
  }
  if (entityType === 'finding') {
    const finding = state.findings.find((f) => f.id === entityId);
    return finding ? { ...finding } : {};
  }
  return { id: entityId, checked: state.issuanceChecks[entityId], version: state.issuanceMeta[entityId]?.version ?? 0 };
}

/** 乐观地落地本地业务变化（与事件追加在同一 set 内，不留半条链）。 */
function applyLocalBusinessChange(
  state: State,
  entityType: EntityType,
  entityId: string,
  action: string,
  payload: Record<string, unknown>,
  newVersion: number,
  headHash: string
): Partial<State> {
  if (entityType === 'record') {
    return {
      records: state.records.map((record) => {
        if (record.id !== entityId) return record;
        const next = { ...record, version: newVersion, headHash };
        if (action === 'VERIFY' || action === 'BATCH_VERIFY') next.status = '已核验';
        else if (action === 'START_CORRECTION') next.status = '复核中';
        else if (action === 'REVISE') {
          next.activity = Number(payload.value);
          next.revision = Number(payload.revision ?? record.revision + 1);
          next.status = '复核中';
        }
        return next;
      })
    };
  }
  if (entityType === 'finding') {
    return {
      findings: state.findings.map((finding) => {
        if (finding.id !== entityId) return finding;
        const next = { ...finding, version: newVersion, headHash };
        if (action === 'REQUEST_EVIDENCE') next.status = '补证中';
        else if (action === 'CLOSE_FINDING') next.status = '已关闭';
        return next;
      })
    };
  }
  return {
    issuanceChecks: action === 'TOGGLE_ISSUANCE' ? { ...state.issuanceChecks, [entityId]: Boolean(payload.checked) } : state.issuanceChecks,
    issuanceMeta: { ...state.issuanceMeta, [entityId]: { version: newVersion, headHash } }
  };
}

export const useCarbonStore = create<State>()(
  persist(
    (set, get) => {
      /**
       * 提交一个操作：
       * 1. 生成操作号 operationId，读取实体当前 version 作为 expectedVersion；
       * 2. 在同一个 set 内“追加乐观事件 + 落地业务变化 + 登记 pendingOp”（原子，无半条链）；
       * 3. POST 到服务端；成功则采用服务端状态（含服务端事件），冲突则回滚并记录冲突；
       * 4. 网络/5xx 失败则标记 retryable，按原操作号自动重试（同号取首次结果）。
       */
      async function commitOperation(input: {
        entityType: EntityType;
        entityId: string;
        action: string;
        payload: Record<string, unknown>;
      }): Promise<void> {
        const operationId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = new Date().toISOString();
        const state = get();
        const expectedVersion = entityVersion(state, input.entityType, input.entityId);
        const envelope: OperationEnvelopeInput = {
          operationId,
          entityType: input.entityType,
          entityId: input.entityId,
          action: input.action,
          expectedVersion,
          actor: CURRENT_ACTOR,
          timestamp,
          payload: input.payload
        };

        // 乐观事件：与业务变化在同一 set 内写入。
        const before = snapshotEntity(state, input.entityType, input.entityId);
        const { chain: optimisticChain, event: optimisticEvent } = appendEvent(state.chain, {
          operationId,
          entityType: input.entityType,
          entityId: input.entityId,
          action: input.action,
          actor: CURRENT_ACTOR,
          timestamp,
          payload: { ...input.payload, before }
        });
        const localChange = applyLocalBusinessChange(
          state,
          input.entityType,
          input.entityId,
          input.action,
          input.payload,
          expectedVersion + 1,
          optimisticEvent.hash
        );

        set((s) => ({
          ...localChange,
          chain: optimisticChain,
          chainHeadHash: optimisticEvent.hash,
          chainValid: true,
          chainBreakAt: null,
          submitting: true,
          pendingOps: {
            ...s.pendingOps,
            [operationId]: { status: 'submitting', envelope, eventId: optimisticEvent.eventId, attempts: 1 }
          }
        }));

        await dispatchOperation(operationId, envelope);
      }

      async function dispatchOperation(operationId: string, envelope: OperationEnvelopeInput): Promise<void> {
        try {
          const result = await submitOperation(envelope);
          set((s) => {
            const pending = s.pendingOps[operationId];
            const nextPending = pending
              ? { ...pending, status: (result.status === 'conflict' ? 'conflict' : 'confirmed') as PendingOpStatus, error: undefined }
              : pending;
            const conflicts =
              result.status === 'conflict'
                ? [
                    ...s.conflicts,
                    {
                      operationId,
                      reason: result.reason ?? 'VERSION_MISMATCH',
                      entityType: envelope.entityType,
                      entityId: envelope.entityId,
                      action: envelope.action,
                      at: new Date().toISOString()
                    }
                  ]
                : s.conflicts;
            return {
              records: result.state.records,
              findings: result.state.findings,
              issuanceChecks: result.state.issuanceChecks,
              issuanceMeta: result.state.issuanceMeta,
              chain: result.state.chain,
              chainHeadHash: result.state.chainHeadHash,
              chainValid: result.state.chainValid,
              chainBreakAt: result.state.chainBreakAt,
              migratedCount: result.state.migratedCount,
              pendingOps: nextPending ? { ...s.pendingOps, [operationId]: nextPending } : s.pendingOps,
              conflicts,
              submitting: false
            };
          });
        } catch (error) {
          set((s) => {
            const pending = s.pendingOps[operationId];
            const attempts = (pending?.attempts ?? 1) + 1;
            const retryable = attempts <= MAX_ATTEMPTS;
            return {
              pendingOps: pending
                ? {
                    ...s.pendingOps,
                    [operationId]: { ...pending, status: 'retryable', attempts, error: error instanceof Error ? error.message : String(error) }
                  }
                : s.pendingOps,
            submitting: false
            };
          });
          const pending = get().pendingOps[operationId];
          if (pending && pending.attempts <= MAX_ATTEMPTS) {
            const delay = Math.min(1000 * 2 ** (pending.attempts - 1), 8000);
            setTimeout(() => {
              void dispatchOperation(operationId, envelope);
            }, delay);
          }
        }
      }

      return {
        records: defaultRecords,
        findings: defaultFindings,
        selectedRecordId: 'ACT-0318',
        sampledIds: ['ACT-0318', 'ACT-0337'],
        issuanceChecks: { ...defaultIssuanceChecks },
        issuanceMeta: {},
        chain: [],
        chainHeadHash: '',
        chainValid: true,
        chainBreakAt: null,
        migratedCount: 0,
        pendingOps: {},
        conflicts: [],
        submitting: false,
        hydrated: false,

        hydrate: (data) =>
          set((s) => ({
            records: data.records,
            findings: data.findings,
            issuanceChecks: data.issuanceChecks,
            issuanceMeta: data.issuanceMeta,
            chain: data.chain,
            chainHeadHash: data.chainHeadHash,
            chainValid: data.chainValid,
            chainBreakAt: data.chainBreakAt,
            migratedCount: data.migratedCount,
            pendingOps: s.pendingOps,
            conflicts: s.conflicts,
            hydrated: true
          })),

        selectRecord: (id) => set({ selectedRecordId: id }),
        toggleSample: (id) =>
          set((state) => ({
            sampledIds: state.sampledIds.includes(id) ? state.sampledIds.filter((item) => item !== id) : [...state.sampledIds, id]
          })),

        startCorrection: (id) => commitOperation({ entityType: 'record', entityId: id, action: 'START_CORRECTION', payload: {} }),
        verifyRecord: (id) => commitOperation({ entityType: 'record', entityId: id, action: 'VERIFY', payload: {} }),
        batchVerify: async () => {
          const state = get();
          const eligible = state.records.filter((record) => state.sampledIds.includes(record.id) && record.status !== '需补证');
          for (const record of eligible) {
            await commitOperation({ entityType: 'record', entityId: record.id, action: 'BATCH_VERIFY', payload: {} });
          }
        },
        requestEvidence: (findingId) => commitOperation({ entityType: 'finding', entityId: findingId, action: 'REQUEST_EVIDENCE', payload: {} }),
        closeFinding: (findingId) => commitOperation({ entityType: 'finding', entityId: findingId, action: 'CLOSE_FINDING', payload: {} }),
        toggleIssuanceCheck: (id) => {
          const state = get();
          const next = !state.issuanceChecks[id];
          return commitOperation({ entityType: 'issuance', entityId: id, action: 'TOGGLE_ISSUANCE', payload: { checked: next } });
        },
        reviseValue: (id, value, reason) =>
          commitOperation({ entityType: 'record', entityId: id, action: 'REVISE', payload: { value, reason } }),

        submitIssuance: () =>
          commitOperation({
            entityType: 'issuance',
            entityId: 'readiness',
            action: 'ISSUANCE_SUBMITTED',
            payload: { note: '签发准备提交', checks: { ...get().issuanceChecks } }
          }),

        retryOperation: async (operationId) => {
          const pending = get().pendingOps[operationId];
          if (!pending) return;
          set((s) => ({
            pendingOps: { ...s.pendingOps, [operationId]: { ...pending, status: 'submitting', attempts: 1, error: undefined } }
          }));
          await dispatchOperation(operationId, pending.envelope);
        },

        dismissConflict: (operationId) =>
          set((s) => ({ conflicts: s.conflicts.filter((conflict) => conflict.operationId !== operationId) })),

        tamperChain: () =>
          set((s) => {
            if (s.chain.length === 0) return s;
            const chain = s.chain.map((event, index) =>
              index === s.chain.length - 1 ? { ...event, payload: { ...event.payload, tampered: true } } : event
            );
            const verification = verifyChain(chain);
            return { chain, chainValid: verification.valid, chainBreakAt: verification.breakAt };
          }),

        tamperChainRemove: () =>
          set((s) => {
            if (s.chain.length < 3) return s;
            const chain = s.chain.filter((_, index) => index !== 1);
            const verification = verifyChain(chain);
            return { chain, chainValid: verification.valid, chainBreakAt: verification.breakAt };
          }),

        resyncChain: async () => {
          const data = await fetchEvidence();
          get().hydrate(data);
        },

        resetDemo: async () => {
          const data = await resetEvidence();
          get().hydrate(data);
          set({ pendingOps: {}, conflicts: [] });
        }
      };
    },
    { name: 'yy60-carbon-evidence' }
  )
);
