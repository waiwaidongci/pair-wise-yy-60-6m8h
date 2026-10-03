import { NextResponse } from 'next/server';
import { appendCommand, getStateView } from '@/lib/audit/engine';

export const dynamic = 'force-dynamic';

// 业务状态（含审计链校验结果）一律以服务端重放结果为准。
export async function GET() {
  const state = await getStateView();
  return NextResponse.json(state);
}

// 所有操作走统一入口：必须带 opId（操作号）与 expectedVersion（版本）。
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const { httpStatus, body: result } = await appendCommand(body);
  return NextResponse.json(result, { status: httpStatus });
}
