'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppBar,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography
} from '@mui/material';
import {
  AccountTreeOutlined,
  AssessmentOutlined,
  AssignmentTurnedInOutlined,
  DashboardOutlined,
  FactCheckOutlined,
  FindInPageOutlined,
  Link as LinkIcon,
  MenuOutlined,
  NotificationsNoneOutlined,
  ScienceOutlined,
  TaskAltOutlined
} from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import { submitCommand } from '@/lib/api';
import { useAuditCommand, useAuditState, STATE_KEY, EVENTS_KEY, type CommandOutcome } from '@/lib/useAudit';
import { useIdentity } from '@/lib/identity';
import { eventTypeLabels } from '@/lib/audit/types';
import AuditChainDialog from './AuditChainDialog';

const drawerWidth = 232;
type View = 'overview' | 'verify' | 'issuance';

export default function EvidenceWorkbench({ initialView }: { initialView: View }) {
  const [view] = useState<View>(initialView);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [recordFilter, setRecordFilter] = useState('全部');
  const [selectedId, setSelectedId] = useState('ACT-0318');
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionValue, setCorrectionValue] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [auditOpen, setAuditOpen] = useState(false);
  const [notice, setNotice] = useState<CommandOutcome | null>(null);

  const queryClient = useQueryClient();
  const { data: state, isLoading } = useAuditState();
  const command = useAuditCommand();
  const { actor, setActor } = useIdentity();

  useEffect(() => {
    if (command.data) setNotice(command.data);
  }, [command.data]);

  const records = state?.records ?? [];
  const findings = state?.findings ?? [];
  const checks = state?.checks ?? [];
  const sampledIds = state?.sampledIds ?? [];
  const chainValid = state?.audit.chain.valid ?? true;
  const selected = records.find((record) => record.id === selectedId) ?? records[0];
  const visibleRecords = useMemo(() => recordFilter === '全部' ? records : records.filter((record) => record.status === recordFilter), [recordFilter, records]);
  const openFindings = findings.filter((item) => item.status !== '已关闭');
  const readinessReady = state?.issuance.ready ?? false;

  const run = (req: Omit<Parameters<typeof command.mutate>[0], 'actor'>) => command.mutate({ ...req, actor });

  const quickSampleByAnomaly = async () => {
    const targets = records.filter((item) => Math.abs(item.anomaly) > 5 && !sampledIds.includes(item.id)).map((item) => item.id);
    for (const recordId of targets) {
      await submitCommand({ type: 'sample.toggle', actor, payload: { recordId, add: true } });
    }
    await queryClient.invalidateQueries({ queryKey: STATE_KEY });
    await queryClient.invalidateQueries({ queryKey: EVENTS_KEY });
  };

  const nav = [
    { id: 'overview', label: '监测期总览', href: '/', icon: DashboardOutlined },
    { id: 'verify', label: '证据与抽样核验', href: '/verify', icon: FindInPageOutlined },
    { id: 'issuance', label: '签发准备', href: '/issuance', icon: AssessmentOutlined }
  ];

  const navDrawer = (
    <Box sx={{ width: drawerWidth, bgcolor: '#f8faf9', height: '100%' }}>
      <Box sx={{ p: 2.2, pt: 3 }}>
        <Typography variant="overline" color="text.secondary">当前项目</Typography>
        <Typography fontWeight={800} fontSize={13} mt={.5}>{state?.project.name ?? '加载中…'}</Typography>
        <Typography variant="caption" color="text.secondary">{state?.project.id ?? ''}</Typography>
      </Box>
      <Divider />
      <List sx={{ px: 1, py: 1.2 }}>
        {nav.map(({ id, label, href, icon: Icon }) => (
          <ListItemButton key={id} component={Link} href={href} selected={view === id} sx={{ borderRadius: 1, mb: .4, '&.Mui-selected': { bgcolor: '#e4f1ec', color: '#12664f' } }}>
            <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}><Icon fontSize="small" /></ListItemIcon>
            <ListItemText primary={label} primaryTypographyProps={{ fontSize: 13, fontWeight: view === id ? 750 : 500 }} />
          </ListItemButton>
        ))}
      </List>
      <Box sx={{ p: 2, mt: 2 }}>
        <Box sx={{ p: 1.3, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'white' }}>
          <Stack direction="row" alignItems="center" spacing={1} mb={1}><ScienceOutlined color="primary" fontSize="small" /><Typography fontSize={12} fontWeight={750}>审计链</Typography></Stack>
          <Chip size="small" color={chainValid ? 'success' : 'error'} variant={chainValid ? 'filled' : 'outlined'}
            label={chainValid ? `链完整 · ${state?.audit.chain.eventCount ?? 0} 条事件` : '审计链断点 · 写入冻结'}
            onClick={() => setAuditOpen(true)} clickable sx={{ mb: 1 }} />
          <Typography variant="caption" color="text.secondary" display="block">追加式事件溯源，哈希逐条串联，同号重试取首次结果。</Typography>
        </Box>
      </Box>
    </Box>
  );

  const entityLabels: Record<string, string> = { record: '记录', finding: '发现项', issuance: '签发检查项', sample: '抽样' };
  const conflictBanners = state?.audit.conflicts.map((conflict) => (
    <Alert key={conflict.opId} severity="warning" sx={{ mb: 1 }}
      action={conflict.entity === 'record' ? <Button color="inherit" size="small" onClick={() => setSelectedId(conflict.targetId)}>查看记录</Button> : undefined}>
      <Typography fontSize={12.5} fontWeight={750}>{entityLabels[conflict.entity] ?? conflict.entity} {conflict.targetId} 存在后到冲突</Typography>
      <Typography variant="caption" display="block">
        {conflict.actor} 的操作「{eventTypeLabels[conflict.type] ?? conflict.type}」晚于先到事件 #{conflict.againstSeq}，先到已成立、本条业务数据未变更；请基于当前版本重新操作（会追加新事件）。op {conflict.opId}
      </Typography>
    </Alert>
  )) ?? null;

  const chainBrokenBanner = !chainValid && (
    <Alert severity="error" sx={{ mb: 1.5 }} action={<Button color="inherit" size="small" onClick={() => setAuditOpen(true)}>查看断点</Button>}>
      <Typography fontWeight={750}>审计链缺事件或被改动，所有写入已冻结，签发准备立即失效。</Typography>
      {state?.audit.chain.breaks.map((item, index) => (
        <Typography key={index} variant="caption" display="block">@事件 #{item.atSeq ?? '?'}：{item.message}</Typography>
      ))}
    </Alert>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" elevation={0} sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, bgcolor: '#173a31', borderBottom: '1px solid rgba(255,255,255,.12)' }}>
        <Toolbar sx={{ minHeight: '62px !important', gap: 1.4 }}>
          <IconButton color="inherit" sx={{ display: { md: 'none' } }} onClick={() => setMobileOpen(true)}><MenuOutlined /></IconButton>
          <Box sx={{ width: 36, height: 36, borderRadius: 1, border: '1px solid #80b6a6', display: 'grid', placeItems: 'center' }}>
            <AccountTreeOutlined fontSize="small" />
          </Box>
          <Box>
            <Typography fontSize={15} fontWeight={800}>碳减排项目监测核验</Typography>
            <Typography fontSize={10} color="#a9c5bc">Append-only Audit Chain · Idempotent Operations</Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          <Chip size="small" label={`${openFindings.length} 项发现开放`} sx={{ color: '#ffdda7', borderColor: '#a87935', bgcolor: 'rgba(255,255,255,.05)' }} variant="outlined" />
          {/* 切换操作人：模拟两人同时修改同一条记录的并发场景 */}
          <Select value={actor} onChange={(event) => setActor(event.target.value)} size="small"
            sx={{ color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,.35)' }, '.MuiSvgIcon-root': { color: 'white' }, fontSize: 12 }}>
            {['核验员·沈楠', '复核员·韩跃', '技术评审·徐璐'].map((name) => <MenuItem key={name} value={name} sx={{ fontSize: 12 }}>{name}</MenuItem>)}
          </Select>
          <IconButton color="inherit"><NotificationsNoneOutlined /></IconButton>
          <Avatar sx={{ width: 30, height: 30, bgcolor: '#e1a45d', fontSize: 12 }}>{actor.slice(-2, -1)}</Avatar>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" sx={{ width: drawerWidth, flexShrink: 0, display: { xs: 'none', md: 'block' }, '& .MuiDrawer-paper': { width: drawerWidth, pt: '62px', boxSizing: 'border-box', borderRightColor: '#dce4e0' } }}>{navDrawer}</Drawer>
      <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ display: { xs: 'block', md: 'none' }, '& .MuiDrawer-paper': { width: drawerWidth, pt: '62px' } }}>{navDrawer}</Drawer>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, bgcolor: '#f2f5f3', pt: '62px' }}>
        <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 1640, mx: 'auto' }}>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }} spacing={2} mb={2.4}>
            <Box>
              <Typography variant="overline" color="text.secondary" fontWeight={750}>{state?.project.id ?? 'CN-ER-2026-041'} / {state?.summary.period ?? '第三监测期'}</Typography>
              <Typography variant="h5" fontWeight={850} mt={.3}>{view === 'overview' ? '监测期总览' : view === 'verify' ? '证据与抽样核验' : '签发准备'}</Typography>
              <Typography variant="body2" color="text.secondary" mt={.5}>{view === 'overview' ? '汇总活动数据、排放因子、证据完整度和异常波动。' : view === 'verify' ? '逐项核对来源、单位、时间范围；每次操作带操作号与版本落审计链。' : '审计链完整、门禁全满足才可提交；链断立即失效并指出断点。'}</Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" startIcon={<LinkIcon />} onClick={() => setAuditOpen(true)}>查看审计链</Button>
              {view === 'issuance' && (state?.issuance.submitted ? (
                <Button variant="contained" color="success" startIcon={<AssignmentTurnedInOutlined />} disabled>已于 {state.issuance.submittedAt ? new Date(state.issuance.submittedAt).toLocaleString('zh-CN') : ''} 提交</Button>
              ) : (
                <Button variant="contained" startIcon={<TaskAltOutlined />} disabled={!readinessReady || command.isPending}
                  onClick={() => run({ type: 'issuance.submit' })}>
                  {chainValid ? '提交签发准备' : '签发已失效'}
                </Button>
              ))}
            </Stack>
          </Stack>
          {isLoading && <LinearProgress />}
          {chainBrokenBanner}
          {conflictBanners}

          {view === 'overview' && state && selected && (
            <>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' }, gap: 1.4, mb: 2 }}>
                {[
                  { label: '减排量（链上重放）', value: state.summary.reduction.toLocaleString(), unit: 'tCO₂e', note: '由当前版本记录重放计算' },
                  { label: '证据完整度', value: `${state.summary.evidenceRate}%`, unit: '', note: '5 份证据待补充' },
                  { label: '开放发现项', value: `${openFindings.length}`, unit: '项', note: `${state.audit.conflicts.length} 个未解决冲突` },
                  { label: '抽样任务', value: `${sampledIds.length} / ${state.summary.sampled}`, unit: '', note: '勾选变化均落链' }
                ].map((item) => <Card elevation={0} variant="outlined" key={item.label}><CardContent sx={{ p: 1.8, '&:last-child': { pb: 1.8 } }}><Typography variant="caption" color="text.secondary">{item.label}</Typography><Stack direction="row" alignItems="baseline" spacing={.6} mt={.5}><Typography variant="h5" fontWeight={850}>{item.value}</Typography><Typography fontSize={12} color="text.secondary">{item.unit}</Typography></Stack><Typography fontSize={11} color="text.secondary" mt={.7}>{item.note}</Typography></CardContent></Card>)}
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1.55fr) minmax(300px, .7fr)' }, gap: 1.5 }}>
                <Card elevation={0} variant="outlined">
                  <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 1.6 }}>
                    <Box><Typography fontWeight={800} fontSize={14}>活动数据与计算链</Typography><Typography fontSize={11} color="text.secondary">选择记录查看公式、来源证据和链上版本（业务版本 / 链版本）</Typography></Box>
                    <Tabs value={recordFilter} onChange={(_, value) => setRecordFilter(value)} variant="scrollable"><Tab value="全部" label="全部" /><Tab value="待核验" label="待核验" /><Tab value="需补证" label="需补证" /><Tab value="已核验" label="已核验" /></Tabs>
                  </Stack>
                  <Divider />
                  <Box sx={{ overflowX: 'auto' }}>
                    <Box sx={{ minWidth: 840 }}>
                      <Box sx={{ display: 'grid', gridTemplateColumns: '1.7fr .9fr .8fr 1fr .7fr .7fr', gap: 1, px: 1.7, py: 1, bgcolor: '#f7f9f8', color: 'text.secondary', fontSize: 11, fontWeight: 750 }}>
                        <span>数据来源</span><span>活动数据</span><span>排放因子</span><span>时间范围</span><span>证据</span><span>状态</span>
                      </Box>
                      {visibleRecords.map((record) => (
                        <Box key={record.id} role="button" tabIndex={0} onClick={() => setSelectedId(record.id)} sx={{ display: 'grid', gridTemplateColumns: '1.7fr .9fr .8fr 1fr .7fr .7fr', gap: 1, px: 1.7, py: 1.25, borderTop: '1px solid #e8ecea', cursor: 'pointer', bgcolor: selected.id === record.id ? '#eff7f3' : 'white', '&:hover': { bgcolor: '#f6faf8' } }}>
                          <Box><Typography fontSize={12.5} fontWeight={700}>{record.source}{record.conflict && <Chip size="small" color="warning" variant="outlined" label="冲突" sx={{ ml: .8 }} />}</Typography><Typography fontSize={10} color="text.secondary">{record.id} · {record.owner} · 业务V{record.revision} / 链v{record.version}</Typography></Box>
                          <Box><Typography fontSize={12}>{record.activity.toLocaleString()} {record.unit}</Typography><Typography fontSize={10} color={record.anomaly > 5 ? 'secondary.main' : 'text.secondary'}>异常 {record.anomaly > 0 ? '+' : ''}{record.anomaly}%</Typography></Box>
                          <Typography fontSize={12}>{record.factor} <small>{record.factorUnit}</small></Typography>
                          <Typography fontSize={11}>{record.timeRange}</Typography>
                          <Typography fontSize={12}>{record.evidenceCount} 项</Typography>
                          <Chip size="small" label={record.status} color={record.status === '已核验' ? 'success' : record.status === '需补证' ? 'warning' : 'default'} variant={record.status === '已核验' ? 'filled' : 'outlined'} />
                        </Box>
                      ))}
                    </Box>
                  </Box>
                </Card>
                <Stack spacing={1.5}>
                  <Card elevation={0} variant="outlined"><CardContent><Stack direction="row" justifyContent="space-between" alignItems="center"><Typography fontWeight={800} fontSize={14}>计算链展开</Typography><Chip size="small" label={selected.id} /></Stack><Box sx={{ mt: 1.5, p: 1.3, bgcolor: '#f4f7f5', fontFamily: 'monospace', borderRadius: 1, fontSize: 11 }}>
                    <Box>活动数据 = {selected.activity.toLocaleString()} {selected.unit}</Box>
                    <Box mt={.6}>排放因子 = {selected.factor} {selected.factorUnit}</Box>
                    <Box mt={.6}>换算系数 = 0.001</Box>
                    <Divider sx={{ my: 1 }} />
                    <Box sx={{ color: '#14644f', fontWeight: 800 }}>减排量 = {(selected.activity * selected.factor / 1000).toFixed(2)} tCO₂e</Box>
                  </Box><Stack direction="row" spacing={1} mt={1.5}><Button size="small" variant="outlined" disabled={!chainValid} onClick={() => { setCorrectionOpen(true); setCorrectionValue(String(selected.activity)); setCorrectionReason(''); }}>修订数据</Button><Button size="small" onClick={() => setAuditOpen(true)}>查看证据链</Button></Stack></CardContent></Card>
                  <Card elevation={0} variant="outlined"><CardContent><Typography fontWeight={800} fontSize={14} mb={.5}>核验发现项</Typography>{openFindings.slice(0, 3).map((finding) => <Box key={finding.id} sx={{ py: 1, borderTop: '1px solid #edf0ef' }}><Stack direction="row" spacing={1}><Alert severity={finding.status === '补证中' ? 'warning' : 'error'} sx={{ p: .2, '& .MuiAlert-icon': { mr: .3, fontSize: 17 } }} /><Box><Typography fontSize={12} fontWeight={700}>{finding.title}</Typography><Typography fontSize={10} color="text.secondary" mt={.3}>{finding.assignee} · {finding.due} · 链v{finding.version}</Typography></Box></Stack></Box>)}</CardContent></Card>
                </Stack>
              </Box>
            </>
          )}

          {view === 'verify' && state && (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1fr) 340px' }, gap: 1.5 }}>
              <Card elevation={0} variant="outlined">
                <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} spacing={1} sx={{ p: 1.6 }}>
                  <Box><Typography fontWeight={800} fontSize={14}>证据矩阵与抽样任务</Typography><Typography fontSize={11} color="text.secondary">已抽取 {sampledIds.length} 条高价值记录 · 勾选即落 sample.toggle 事件</Typography></Box>
                  <Stack direction="row" spacing={1}><Button variant="outlined" disabled={!chainValid || command.isPending} onClick={() => void quickSampleByAnomaly()}>按异常抽样</Button><Button variant="contained" disabled={!chainValid || command.isPending} onClick={() => run({ type: 'record.batchVerify', payload: { ids: sampledIds } })}>批量核验</Button></Stack>
                </Stack><Divider />
                {records.map((record) => (
                  <Box key={record.id} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '22px minmax(210px, 1.3fr) .8fr .8fr .8fr auto' }, alignItems: 'center', gap: 1.2, px: 1.6, py: 1.3, borderTop: '1px solid #edf0ef' }}>
                    <input type="checkbox" checked={sampledIds.includes(record.id)} disabled={!chainValid || command.isPending}
                      onChange={() => run({ type: 'sample.toggle', payload: { recordId: record.id, add: !sampledIds.includes(record.id) } })} aria-label={`抽样 ${record.id}`} />
                    <Box><Typography fontSize={12.5} fontWeight={700}>{record.source}{record.conflict && <Chip size="small" color="warning" variant="outlined" label="冲突" sx={{ ml: .8 }} />}</Typography><Typography fontSize={10} color="text.secondary">{record.id} · 证据 {record.evidenceCount} 份 · 链v{record.version}</Typography></Box>
                    <Box><Typography variant="caption" color="text.secondary">来源</Typography><Typography fontSize={11}>原始计量记录</Typography></Box>
                    <Box><Typography variant="caption" color="text.secondary">单位</Typography><Typography fontSize={11}>{record.unit} / {record.factorUnit}</Typography></Box>
                    <Box><Typography variant="caption" color="text.secondary">时间范围</Typography><Typography fontSize={11}>{record.timeRange.includes('至') ? '已覆盖整期' : '待检查'}</Typography></Box>
                    <Stack direction="row" spacing={.7}>
                      <Button size="small" variant="outlined" disabled={!chainValid || command.isPending}
                        onClick={() => run({ type: 'record.startCorrection', targetId: record.id, expectedVersion: record.version })}>复核</Button>
                      <Button size="small" variant="contained" disabled={record.status === '需补证' || !chainValid || command.isPending}
                        onClick={() => run({ type: 'record.verify', targetId: record.id, expectedVersion: record.version })}>通过</Button>
                    </Stack>
                  </Box>
                ))}
              </Card>
              <Stack spacing={1.5}>
                <Card elevation={0} variant="outlined"><CardContent><Typography fontWeight={800} fontSize={14} mb={1.3}>发现项闭环</Typography>{findings.map((finding) => <Box key={finding.id} sx={{ borderTop: '1px solid #edf0ef', py: 1.2 }}><Stack direction="row" justifyContent="space-between"><Typography fontSize={12} fontWeight={700}>{finding.title}</Typography><Chip size="small" label={finding.status} color={finding.status === '已关闭' ? 'success' : finding.status === '补证中' ? 'warning' : 'error'} /></Stack><Typography fontSize={10.5} color="text.secondary" mt={.5}>{finding.detail}（链v{finding.version}）</Typography><Stack direction="row" spacing={.7} mt={1}><Button size="small" disabled={finding.status === '已关闭' || !chainValid || command.isPending} onClick={() => run({ type: 'finding.requestEvidence', targetId: finding.id, expectedVersion: finding.version })}>发起补证</Button><Button size="small" disabled={finding.status === '已关闭' || !chainValid || command.isPending} onClick={() => run({ type: 'finding.close', targetId: finding.id, expectedVersion: finding.version })}>关闭</Button></Stack></Box>)}</CardContent></Card>
                <Alert severity="info">所有操作带操作号与当前链版本提交；两人同改一条时先到成立、后到原样留冲突事件。写入失败会按原操作号自动重试，不产生半条链。</Alert>
              </Stack>
            </Box>
          )}

          {view === 'issuance' && state && (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 380px' }, gap: 1.5 }}>
              <Card elevation={0} variant="outlined">
                <CardContent>
                  <Typography fontWeight={800} fontSize={14}>签发前完整性检查</Typography>
                  <Typography fontSize={11} color="text.secondary" mb={1.5}>所有门禁项必须确认、开放发现项必须关闭、审计链必须完整；勾选变化与业务状态一起落链。</Typography>
                  {!chainValid && state.audit.chain.breaks.map((item, index) => (
                    <Alert key={index} severity="error" sx={{ mb: 1 }}>断点 @事件 #{item.atSeq ?? '?'}：{item.message}</Alert>
                  ))}
                  {checks.map((item) => <Box key={item.id} component="label" sx={{ display: 'flex', gap: 1.3, alignItems: 'flex-start', borderTop: '1px solid #edf0ef', py: 1.5, cursor: chainValid ? 'pointer' : 'not-allowed', opacity: chainValid ? 1 : .6 }}><input type="checkbox" checked={item.checked} disabled={!chainValid || command.isPending}
                    onChange={() => run({ type: 'issuance.toggleCheck', targetId: item.id, expectedVersion: item.version, payload: { checked: !item.checked } })} /><Box><Typography fontSize={12.5} fontWeight={700}>{item.title}</Typography><Typography fontSize={10.5} color="text.secondary" mt={.4}>检查项链版本 v{item.version}</Typography></Box></Box>)}
                </CardContent>
              </Card>
              <Stack spacing={1.5}>
                <Card elevation={0} variant="outlined"><CardContent>
                  <Typography fontWeight={800} fontSize={14}>签发就绪度</Typography>
                  <Stack direction="row" alignItems="baseline" spacing={1} mt={1}>
                    <Typography variant="h4" fontWeight={850} color={readinessReady ? 'success.main' : 'text.primary'}>{Math.round(checks.filter((c) => c.checked).length / Math.max(checks.length, 1) * 70 + (openFindings.length === 0 ? 30 : 0) - (chainValid ? 0 : 30))}%</Typography>
                    <Typography fontSize={11} color="text.secondary">完成度</Typography>
                  </Stack>
                  <LinearProgress variant="determinate" value={Math.max(0, checks.filter((c) => c.checked).length / Math.max(checks.length, 1) * 100 - (chainValid ? 0 : 30))} color={chainValid ? 'primary' : 'error'} sx={{ height: 7, borderRadius: 3, mt: 1 }} />
                  <Typography fontSize={11} color="text.secondary" mt={1.2}>
                    {!chainValid ? '审计链断点：签发准备已失效。' : `还有 ${openFindings.length} 个开放发现项，${checks.filter((c) => !c.checked).length} 个检查项未确认。`}
                  </Typography>
                </CardContent></Card>
                <Card elevation={0} variant="outlined"><CardContent>
                  <Stack direction="row" justifyContent="space-between" mb={.5}><Typography fontWeight={800} fontSize={14}>链状态与未决冲突</Typography><Chip size="small" color={chainValid ? 'success' : 'error'} label={chainValid ? '完整' : '断点'} /></Stack>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ wordBreak: 'break-all' }}>链头 {state.audit.chain.lastHash.slice(0, 18)}… · 事件 {state.audit.chain.eventCount}</Typography>
                  {state.audit.conflicts.length === 0 ? <Typography fontSize={11.5} mt={1}>无未决后到冲突。</Typography> : state.audit.conflicts.map((conflict) => (
                    <Box key={conflict.opId} sx={{ borderTop: '1px solid #edf0ef', py: 1 }}>
                      <Typography fontSize={11.5} fontWeight={700}>{conflict.targetId} · {eventTypeLabels[conflict.type] ?? conflict.type}</Typography>
                      <Typography fontSize={10.5} color="text.secondary">{conflict.actor} 后到，先到 #{conflict.againstSeq} 已成立；op {conflict.opId}</Typography>
                    </Box>
                  ))}
                  <Button size="small" sx={{ mt: 1 }} startIcon={<FactCheckOutlined />} onClick={() => setAuditOpen(true)}>查看完整审计链</Button>
                </CardContent></Card>
                {state.issuance.submitted ? (
                  <Alert severity="success">签发准备已于 {state.issuance.submittedAt ? new Date(state.issuance.submittedAt).toLocaleString('zh-CN') : ''} 提交（签发实体链版本 v{state.issuance.version}）。</Alert>
                ) : (
                  <Alert severity={readinessReady ? 'success' : 'warning'}>{readinessReady ? '门禁全部满足且审计链完整，可提交签发准备。' : chainValid ? '关闭开放发现项并完成所有检查后可提交。' : '审计链缺事件或被改动，签发准备已失效，请先处理断点。'}</Alert>
                )}
                {!readinessReady && state.issuance.invalidReasons.length > 0 && chainValid && (
                  <Card elevation={0} variant="outlined"><CardContent sx={{ pb: '16px !important' }}><Typography fontWeight={750} fontSize={12.5} mb={.5}>未满足项</Typography>{state.issuance.invalidReasons.map((reason) => <Typography key={reason} fontSize={11} color="text.secondary">· {reason}</Typography>)}</CardContent></Card>
                )}
              </Stack>
            </Box>
          )}
        </Box>
      </Box>

      <Tooltip title="打开追加式审计链"><Button sx={{ position: 'fixed', bottom: 18, right: 18, zIndex: 5 }} variant="contained" size="small" startIcon={<FactCheckOutlined />} onClick={() => setAuditOpen(true)}>审计链 {state?.audit.chain.eventCount ?? 0}</Button></Tooltip>

      {correctionOpen && selected && (
        <Box sx={{ position: 'fixed', inset: 0, zIndex: 60, bgcolor: 'rgba(15,25,22,.4)', display: 'grid', placeItems: 'center', p: 2 }} onMouseDown={() => setCorrectionOpen(false)}>
          <Card sx={{ width: 'min(520px, 100%)' }} onMouseDown={(event) => event.stopPropagation()}><CardContent sx={{ p: 2.2 }}>
            <Typography variant="h6" fontWeight={800}>修订活动数据</Typography>
            <Typography variant="body2" color="text.secondary" mt={.5}>当前值 {selected.activity.toLocaleString()} {selected.unit}。修订将基于链版本 v{selected.version} 生成业务 V{selected.revision + 1}，原始版本与本次操作号一同保留在审计链中。</Typography>
            <TextField fullWidth size="small" label={`修订值 / ${selected.unit}`} value={correctionValue} onChange={(event) => setCorrectionValue(event.target.value)} margin="normal" />
            <TextField fullWidth size="small" label="修订原因（随事件正文落链）" multiline rows={3} value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} margin="normal" />
            {!correctionReason.trim() && <Alert severity="warning">必须填写修订原因。</Alert>}
            <Stack direction="row" spacing={1} justifyContent="flex-end" mt={2}>
              <Button onClick={() => setCorrectionOpen(false)}>取消</Button>
              <Button variant="contained" disabled={!correctionReason.trim() || !Number(correctionValue) || command.isPending}
                onClick={() => {
                  run({ type: 'record.revise', targetId: selected.id, expectedVersion: selected.version, payload: { value: Number(correctionValue), reason: correctionReason.trim() } });
                  setCorrectionOpen(false);
                }}>追加修订事件</Button>
            </Stack>
          </CardContent></Card>
        </Box>
      )}

      <AuditChainDialog open={auditOpen} onClose={() => setAuditOpen(false)} />
      <Snackbar open={Boolean(notice)} autoHideDuration={5000} onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={notice ? `${notice.replayed ? '幂等重放：' : ''}${notice.message}` : ''}
        ContentProps={{ sx: { bgcolor: notice?.status === 'conflict' ? '#8a4b12' : notice?.ok ? '#1f6b4f' : '#7a2f2f', color: 'white' } }} />
    </Box>
  );
}
