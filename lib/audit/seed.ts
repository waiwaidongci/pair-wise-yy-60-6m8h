// 初始（旧系统遗留）业务数据。首次启动时由链引擎把这些旧数据升级为
// 带摘要的首版事件（chain.bootstrap），之后业务状态一律由事件重放得到。

export const projectSeed = {
  id: 'CN-ER-2026-041',
  name: '临港工业园区能效提升项目',
  methodology: 'CMS-052-V01',
  vintage: '2026 监测年度',
  verifier: '华碳认证 · 核验组 B'
};

export const summarySeed = {
  period: '2026 年第三监测期',
  reduction: 18426,
  evidenceRate: 92,
  openFindings: 3,
  sampled: 18
};

export interface SeedRecord {
  id: string;
  source: string;
  activity: number;
  unit: string;
  factor: number;
  factorUnit: string;
  timeRange: string;
  evidenceCount: number;
  anomaly: number;
  owner: string;
  status: string;
  revision: number;
}

export const recordSeeds: SeedRecord[] = [
  { id: 'ACT-0318', source: '电表 E-17 / 四号压缩机组', activity: 428650, unit: 'kWh', factor: 0.5568, factorUnit: 'tCO2/MWh', timeRange: '2026-07-01 至 07-31', evidenceCount: 4, anomaly: 2.3, owner: '项目现场 O2', status: '复核中', revision: 3 },
  { id: 'ACT-0321', source: '蒸汽流量计 ST-04', activity: 2038.4, unit: 'GJ', factor: 0.1100, factorUnit: 'tCO2/GJ', timeRange: '2026-07-01 至 07-31', evidenceCount: 3, anomaly: 0, owner: '能源中心', status: '已核验', revision: 2 },
  { id: 'ACT-0325', source: '柴油消耗台账 / 应急泵', activity: 1846, unit: 'L', factor: 2.68, factorUnit: 'kgCO2/L', timeRange: '2026-07-01 至 07-31', evidenceCount: 2, anomaly: 8.6, owner: '设备保障部', status: '需补证', revision: 4 },
  { id: 'ACT-0331', source: '光伏逆变器阵列 PV-2', activity: 182460, unit: 'kWh', factor: 0.5568, factorUnit: 'tCO2/MWh', timeRange: '2026-07-01 至 07-31', evidenceCount: 5, anomaly: -1.2, owner: '新能源运维', status: '已核验', revision: 1 },
  { id: 'ACT-0337', source: '天然气流量计 NG-02', activity: 62.8, unit: 'kNm3', factor: 2.1622, factorUnit: 'tCO2/kNm3', timeRange: '2026-07-01 至 07-31', evidenceCount: 1, anomaly: 12.4, owner: '热力站', status: '待核验', revision: 1 }
];

export interface SeedFinding {
  id: string;
  recordId: string;
  type: string;
  title: string;
  detail: string;
  assignee: string;
  due: string;
  status: string;
}

export const findingSeeds: SeedFinding[] = [
  { id: 'F-104', recordId: 'ACT-0337', type: '缺失证据', title: '缺少天然气流量计校验证书', detail: '计量记录已提交，但校准有效期证明不足。', assignee: '热力站 · 韩跃', due: '09-30', status: '开放' },
  { id: 'F-105', recordId: 'ACT-0325', type: '异常波动', title: '柴油消耗较上期上升 18.6%', detail: '项目方尚未说明测试运行时长变化。', assignee: '设备保障部 · 姜婷', due: '10-02', status: '补证中' },
  { id: 'F-106', recordId: 'ACT-0318', type: '单位不一致', title: '原始表单位为 MWh，台账记录为 kWh', detail: '需补充单位换算链并保留原始记录。', assignee: '项目现场 · 徐璐', due: '09-30', status: '开放' }
];

export const checkSeeds = [
  { id: 'evidence', title: '证据与计算链完整', checked: false },
  { id: 'calculation', title: '计算过程复核通过', checked: true },
  { id: 'revisions', title: '历史修订未覆盖原始数据', checked: true },
  { id: 'methodology', title: '方法学与监测计划匹配', checked: false }
];

export const sampledSeed = ['ACT-0318', 'ACT-0337'];
