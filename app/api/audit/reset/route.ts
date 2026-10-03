import { NextResponse } from 'next/server';
import { resetChainForDev } from '@/lib/audit/engine';

// 仅用于演示/联调：把链重置为旧数据升级后的首版状态。
export async function POST() {
  await resetChainForDev();
  return NextResponse.json({ reset: true });
}
