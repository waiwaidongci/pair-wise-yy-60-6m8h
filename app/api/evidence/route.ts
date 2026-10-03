import { NextResponse } from 'next/server';
import { evidenceResponseSchema, operationEnvelopeSchema } from '@/lib/schema';
import { applyOperation, ensureInitialized, getEvidenceState, resetForDemo } from '@/lib/server-state';

const project = {
  id: 'CN-ER-2026-041',
  name: '临港工业园区能效提升项目',
  methodology: 'CMS-052-V01',
  vintage: '2026 监测年度',
  verifier: '华碳认证 · 核验组 B'
};

const summary = {
  period: '2026 年第三监测期',
  reduction: 18426,
  evidenceRate: 92,
  openFindings: 3,
  sampled: 18
};

export async function GET() {
  ensureInitialized();
  const state = getEvidenceState();
  return NextResponse.json(evidenceResponseSchema.parse({ project, summary, ...state }));
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = operationEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ accepted: false, error: 'INVALID_ENVELOPE', details: parsed.error.flatten() }, { status: 400 });
  }
  const result = applyOperation(parsed.data);
  return NextResponse.json({
    status: result.status,
    reason: result.status === 'conflict' ? result.reason : undefined,
    event: result.event,
    state: result.state
  });
}

/** 演示用：重置审计链到初始状态。 */
export async function DELETE() {
  const state = resetForDemo();
  return NextResponse.json(evidenceResponseSchema.parse({ project, summary, ...state }));
}
