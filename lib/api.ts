import ky from 'ky';
import { evidenceResponseSchema } from './schema';

const client = ky.create({ timeout: 10_000, retry: { limit: 1 } });

export async function fetchEvidence() {
  const payload = await client.get('/api/evidence').json<unknown>();
  return evidenceResponseSchema.parse(payload);
}

export async function submitEvidenceCorrection(payload: { recordId: string; value: number; reason: string; actor: string }) {
  const response = await client.post('/api/evidence', { json: payload }).json<{ accepted: boolean; revision: number; recordedAt: string }>();
  return response;
}
