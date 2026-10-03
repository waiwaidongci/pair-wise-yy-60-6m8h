import ky from 'ky';
import { auditEventsSchema, stateViewSchema, type StateViewDTO, type AuditEventsDTO } from './schema';
import type { CommandName, CommandResponse } from './audit/types';

const client = ky.create({ timeout: 10_000, retry: { limit: 1 } });

/** 生成操作号：时间序 + 随机后缀，同一操作的所有重试必须复用同一 opId。 */
export function newOpId(type: string): string {
  const slug = type.replace(/[^a-zA-Z]/g, '-').toLowerCase();
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${slug}`;
}

export interface CommandRequest {
  opId?: string;
  type: CommandName;
  actor?: string;
  expectedVersion?: number;
  targetId?: string;
  payload?: Record<string, unknown>;
}

export async function fetchState(): Promise<StateViewDTO> {
  return stateViewSchema.parse(await client.get('/api/evidence').json());
}

export async function fetchAuditEvents(): Promise<AuditEventsDTO> {
  return auditEventsSchema.parse(await client.get('/api/audit/events').json());
}

export async function resetChain(): Promise<void> {
  await client.post('/api/audit/reset', { json: {} });
}

export async function tamperChain(mode: 'tamper' | 'drop' = 'tamper'): Promise<void> {
  await client.post('/api/audit/tamper', { json: { mode } });
}

/**
 * 提交一条操作。
 * - 同一 opId 重试：服务端返回首次结果（replayed=true），不会产生第二条事件。
 * - 网络/5xx 失败：按原 opId 自动重试，避免超时后重复落账或留下半条链。
 * - 409 conflict / chain-broken 与 400 invalid 属于明确结论，不自动重试。
 */
export async function submitCommand(command: CommandRequest, attempt = 0): Promise<CommandResponse> {
  const opId = command.opId ?? newOpId(command.type);
  try {
    const payload = await client
      .post('/api/evidence', {
        json: {
          opId,
          type: command.type,
          actor: command.actor,
          expectedVersion: command.expectedVersion ?? 0,
          targetId: command.targetId,
          payload: command.payload ?? {}
        }
      })
      .json<CommandResponse>();
    return payload;
  } catch (error) {
    const response = (error as { response?: Response }).response;
    if (response && response.status >= 400 && response.status < 500) {
      // 400/409 也是有效结论（冲突/非法/链断），解析后交给调用方处理。
      return (await response.json()) as CommandResponse;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      return submitCommand({ ...command, opId }, attempt + 1);
    }
    throw error;
  }
}
