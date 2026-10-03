'use client';

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material';
import {
  ExpandMoreOutlined,
  GppBadOutlined,
  GppGoodOutlined,
  LinkOffOutlined,
  RefreshOutlined,
  WarningAmberOutlined
} from '@mui/icons-material';
import { useCarbonStore } from '@/lib/store';

function shortHash(hash: string): string {
  if (!hash) return '—';
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

const ACTION_LABEL: Record<string, string> = {
  GENESIS: '首版',
  VERIFY: '核验通过',
  START_CORRECTION: '发起复核',
  BATCH_VERIFY: '批量核验',
  REVISE: '修订数据',
  REQUEST_EVIDENCE: '发起补证',
  CLOSE_FINDING: '关闭发现项',
  TOGGLE_ISSUANCE: '勾选签发项',
  ISSUANCE_SUBMITTED: '提交签发准备',
  CONFLICT_REJECTED: '冲突驳回'
};

export default function AuditChainPanel() {
  const chain = useCarbonStore((s) => s.chain);
  const chainValid = useCarbonStore((s) => s.chainValid);
  const chainBreakAt = useCarbonStore((s) => s.chainBreakAt);
  const migratedCount = useCarbonStore((s) => s.migratedCount);
  const tamperChain = useCarbonStore((s) => s.tamperChain);
  const tamperChainRemove = useCarbonStore((s) => s.tamperChainRemove);
  const resyncChain = useCarbonStore((s) => s.resyncChain);
  const resetDemo = useCarbonStore((s) => s.resetDemo);
  const [open, setOpen] = useState(false);

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Stack direction="row" spacing={1} alignItems="center">
          {chainValid ? <GppGoodOutlined color="success" fontSize="small" /> : <GppBadOutlined color="error" fontSize="small" />}
          <Typography fontWeight={800} fontSize={14}>审计链</Typography>
          <Chip size="small" label={`${chain.length} 事件`} variant="outlined" />
          {migratedCount > 0 && <Chip size="small" label={`已补首版 ${migratedCount}`} color="info" variant="outlined" />}
        </Stack>
        <Stack direction="row" spacing={0.5}>
          <Tooltip title="重新同步审计链"><IconButton size="small" onClick={() => void resyncChain()}><RefreshOutlined fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="展开 / 收起"><IconButton size="small" onClick={() => setOpen((v) => !v)}><ExpandMoreOutlined fontSize="small" sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} /></IconButton></Tooltip>
        </Stack>
      </Stack>

      {!chainValid && chainBreakAt && (
        <Alert severity="error" icon={<LinkOffOutlined />} sx={{ mt: 1 }}>
          <Typography fontSize={12.5} fontWeight={700}>审计链断点 · 签发准备已失效</Typography>
          <Typography fontSize={11.5} sx={{ mt: 0.3 }}>
            断点位置：第 {chainBreakAt.seq} 号事件（{chainBreakAt.eventId}）。{chainBreakAt.reason}
          </Typography>
        </Alert>
      )}

      <Collapse in={open}>
        <Divider sx={{ my: 1 }} />
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          <Button size="small" variant="outlined" color="warning" startIcon={<WarningAmberOutlined />} onClick={tamperChain}>
            模拟篡改事件
          </Button>
          <Button size="small" variant="outlined" color="warning" startIcon={<LinkOffOutlined />} onClick={tamperChainRemove}>
            模拟缺事件
          </Button>
          <Button size="small" variant="outlined" onClick={() => void resetDemo()}>重置演示</Button>
        </Stack>
        <Box sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
          {chain.length === 0 && <Typography fontSize={11} color="text.secondary" sx={{ p: 1.5 }}>暂无事件。</Typography>}
          {chain.map((event) => (
            <Box key={event.eventId} sx={{ px: 1.2, py: 0.9, borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 'none' }, bgcolor: event.action === 'CONFLICT_REJECTED' ? '#fff7ed' : event.action === 'GENESIS' ? '#f0f7ff' : 'white' }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Chip size="small" label={`#${event.seq}`} sx={{ height: 20, fontSize: 10, fontFamily: 'monospace' }} />
                <Typography fontSize={12} fontWeight={700}>{ACTION_LABEL[event.action] ?? event.action}</Typography>
                <Typography fontSize={11} color="text.secondary">{event.entityType}:{event.entityId}</Typography>
                <Typography fontSize={10.5} color="text.secondary">· {event.actor}</Typography>
                <Typography fontSize={10.5} color="text.secondary">· {new Date(event.timestamp).toLocaleTimeString()}</Typography>
              </Stack>
              <Stack direction="row" spacing={1} sx={{ mt: 0.4, fontFamily: 'monospace', fontSize: 10, color: 'text.secondary' }}>
                <span>prev {shortHash(event.prevHash)}</span>
                <span>→</span>
                <span>hash {shortHash(event.hash)}</span>
              </Stack>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
