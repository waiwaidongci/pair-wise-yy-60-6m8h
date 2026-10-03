# pair-wise-yy-60 碳减排项目监测证据核验与签发准备平台

按监测周期完成活动数据、排放因子、证据来源、异常波动和计算链核验。支持抽样任务、版本化数据修订、发现项闭环和签发前完整性检查。

所有核验/修订/签发操作不再只改页面，而是统一落到服务端的**追加式审计链**（事件溯源 + 哈希链），争议时可凭操作号与版本逐条复算。

## 技术栈

Next.js App Router、MUI、TanStack Query、ky、Zod、TypeScript、Node crypto。

## 运行

```bash
npm install
npm run dev      # http://localhost:62060
```

首次启动会把旧业务数据（5 条记录、3 个发现项、抽样集、4 个签发检查项）升级为 13 条带摘要的 `chain.bootstrap` 首版事件，链文件落在 `.audit-data/chain.json`（运行时数据，已 gitignore）。

## 审计链语义（对应核验、修订、签发的接口契约）

- **追加式事件溯源**：业务状态永远由事件重放得到。记录、发现项、签发检查项的任何变化（含勾选）都与业务状态在同一次原子写入（临时文件 + rename）中提交；写入失败按原操作号重试，不存在只改了页面/半条链的情况。
- **操作号幂等**：`POST /api/evidence` 必须带 `opId`。同一操作号的任意重试（含网络超时后的自动重试）直接返回**首次结果**（`replayed: true`），绝不追加第二条事件。
- **版本与并发**：命令带 `expectedVersion`（实体当前链版本）。两人同时修改同一条时先到成立（200 `applied`），后到返回 409 并原样追加一条 `outcome: conflict` 事件，正文记 `conflictOfSeq` 指认先到事件；后到方刷新版本后重新操作即追加新事件，冲突解除。
- **哈希链与断点**：`hash = sha256(规范化 JSON(除 hash 外字段))`，`prevHash` 串联，首条指向 `GENESIS`。断号（缺事件）、prevHash 对不上、内容 hash 对不上（被改动）都会在 `audit.chain.breaks` 中指出具体序号与原因。
- **签发门禁**：`issuance.ready` 同时要求所有检查项勾选、发现项关闭、**审计链完整**。链一旦缺事件或被改动，写入立即冻结、签发准备立即失效，页面与接口都给出断点。
- **旧数据升级**：旧链文件中迁移首版事件若缺 `digest`，启动时按快照补算首版摘要、重算哈希链，并追加一条 `chain.repair` 事件记录修复范围（仅这一种断点允许自愈；内容被改动/断号不在此列）。

### 接口

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/evidence` | 服务端重放得到的当前业务状态 + 链校验结果 + 未决冲突 |
| `POST /api/evidence` | 统一操作入口：`{ opId, type, actor, expectedVersion, targetId, payload }` |
| `GET /api/audit/events` | 只读审计链，逐条核对操作号、版本跃迁、prevHash/hash |
| `POST /api/audit/reset` | 演示用：恢复为旧数据升级后的 13 条首版链 |
| `POST /api/audit/tamper` | 演示用：`{mode:"tamper"}` 篡改末条 / `{mode:"drop"}` 删一条，观察签发失效与断点 |

页面右上角可切换操作人（模拟两人并发），右下角「审计链」弹层可查看全链并做篡改/缺事件演示。
