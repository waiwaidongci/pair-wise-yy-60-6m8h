'use client';

import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import VerifiedIcon from '@mui/icons-material/Verified';
import { useQueryClient } from '@tanstack/react-query';
import { resetChain, tamperChain } from '@/lib/api';
import { useAuditEvents, STATE_KEY, EVENTS_KEY } from '@/lib/useAudit';
import { eventTypeLabels } from '@/lib/audit/types';

function shortHash(value: string): string {
  return value === 'GENESIS' ? 'GENESIS' : `${value.slice(0, 10)}…`;
}

function formatTime(at: string): string {
  return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export default function AuditChainDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useAuditEvents(open);

  const refresh = async () => {
    await refetch();
    await queryClient.invalidateQueries({ queryKey: STATE_KEY });
  };

  const demoAction = async (mode: 'tamper' | 'drop' | 'reset') => {
    if (mode === 'reset') await resetChain();
    else await tamperChain(mode);
    await refresh();
  };

  const events = [...(data?.events ?? [])].reverse();
  const valid = data?.chain.valid;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {valid === false ? <WarningAmberIcon color="warning" /> : <VerifiedIcon color="success" />}
        <Box sx={{ flex: 1 }}>
          <Typography fontWeight={850}>追加式审计链</Typography>
          <Typography variant="caption" color="text.secondary">
            {data ? `共 ${data.chain.eventCount} 条事件 · 链头摘要 ${shortHash(data.chain.lastHash)}` : '加载中…'}
          </Typography>
        </Box>
        <Tooltip title="重新校验"><IconButton size="small" onClick={() => void refresh()}><RefreshIcon fontSize="small" /></IconButton></Tooltip>
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {valid === false && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            <Typography fontWeight={750}>签发准备已立即失效，断点如下：</Typography>
            {data?.chain.breaks.map((item, index) => (
              <Typography key={index} variant="body2" sx={{ fontFamily: 'monospace', mt: .4 }}>
                @事件 #{item.atSeq ?? '?'}（{item.kind}）：{item.message}
              </Typography>
            ))}
          </Alert>
        )}
        {valid === true && (
          <Alert severity="success" sx={{ mb: 1.5 }}>哈希链完整：事件无缺失、无改动；首版事件均带旧数据摘要。</Alert>
        )}
        {isLoading && <Typography variant="body2" color="text.secondary">校验中…</Typography>}

        <Box sx={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {events.map((event) => (
            <Box key={`${event.seq}-${event.opId}`} sx={{ py: 1.1, borderBottom: '1px solid #edf0ef' }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={`#${event.seq}`} sx={{ fontFamily: 'monospace' }} />
                <Typography fontSize={12.5} fontWeight={750}>{eventTypeLabels[event.type] ?? event.type}</Typography>
                <Chip size="small" color={event.outcome === 'applied' ? 'success' : 'warning'} variant="outlined"
                  label={event.outcome === 'applied' ? '成立' : `后到冲突（先到 #${event.conflictOfSeq}）`} />
                {event.migrated && <Chip size="small" variant="outlined" label="旧数据首版" />}
                {event.type === 'chain.repair' && <Chip size="small" variant="outlined" color="info" label="升级补摘要" />}
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" color="text.secondary">{formatTime(event.at)} · {event.actor}</Typography>
              </Stack>
              <Typography variant="caption" sx={{ display: 'block', mt: .4, color: 'text.secondary', wordBreak: 'break-all' }}>
                op {event.opId} · 对象 {event.targetId ?? event.entity} · 版本 {event.fromVersion}→{event.toVersion}
                （携带 {event.expectedVersion || '无版本'}）
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', fontFamily: 'monospace', color: '#846', wordBreak: 'break-all' }}>
                prev {shortHash(event.prevHash)} → hash {shortHash(event.hash)}
              </Typography>
            </Box>
          ))}
        </Box>

        <Divider sx={{ my: 1.5 }} />
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button size="small" variant="outlined" color="warning" onClick={() => void demoAction('tamper')} disabled={isFetching}>演示：篡改一条事件</Button>
          <Button size="small" variant="outlined" color="warning" onClick={() => void demoAction('drop')} disabled={isFetching}>演示：删掉一条事件</Button>
          <Button size="small" variant="text" onClick={() => void demoAction('reset')} disabled={isFetching}>恢复为初始链</Button>
          <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>仅本地演示用：篡改/删除后可观察签发门禁立即失效与断点定位。</Typography>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
