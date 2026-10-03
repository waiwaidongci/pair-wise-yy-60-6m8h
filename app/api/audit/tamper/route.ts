import { NextResponse } from 'next/server';
import { dropMiddleEventForDev, tamperChainForDev } from '@/lib/audit/engine';

// 演示用：篡改末条事件正文（不重算 hash），用于验证签发立即失效与断点指出。
export async function POST(request: Request) {
  let mode = 'tamper';
  try {
    const body = (await request.json()) as { mode?: string };
    mode = body.mode ?? 'tamper';
  } catch {
    // 空 body 默认篡改
  }
  if (mode === 'drop') {
    const seq = await dropMiddleEventForDev();
    return NextResponse.json({ tampered: true, droppedSeq: seq });
  }
  const seq = await tamperChainForDev();
  return NextResponse.json({ tampered: true, seq });
}
