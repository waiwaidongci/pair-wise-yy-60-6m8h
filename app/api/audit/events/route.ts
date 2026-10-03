import { NextResponse } from 'next/server';
import { getEvents } from '@/lib/audit/engine';

export const dynamic = 'force-dynamic';

// 只读审计链：供页面逐条核对操作号、版本跃迁与哈希。
export async function GET() {
  const { events, chain } = await getEvents();
  return NextResponse.json({ events, chain });
}
