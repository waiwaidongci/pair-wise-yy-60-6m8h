import ky from 'ky';
import { evidenceResponseSchema, operationEnvelopeSchema, operationResultSchema, type OperationEnvelopeInput } from './schema';

const client = ky.create({ timeout: 10_000, retry: { limit: 0 } });

export async function fetchEvidence() {
  const payload = await client.get('/api/evidence').json<unknown>();
  return evidenceResponseSchema.parse(payload);
}

/**
 * 提交一个操作信封。
 * - operationId 是幂等键：同号重试服务端取首次结果（duplicate），不重复追加事件；
 * - expectedVersion 是乐观并发令牌：不匹配时服务端追加冲突事件并返回 conflict。
 */
export async function submitOperation(envelope: OperationEnvelopeInput) {
  const parsed = operationEnvelopeSchema.parse(envelope);
  const response = await client.post('/api/evidence', { json: parsed }).json<unknown>();
  return operationResultSchema.parse(response);
}

/** 演示用：重置服务端审计链。 */
export async function resetEvidence() {
  const payload = await client.delete('/api/evidence').json<unknown>();
  return evidenceResponseSchema.parse(payload);
}
