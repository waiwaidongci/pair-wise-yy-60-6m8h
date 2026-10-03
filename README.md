# pair-wise-yy-60 碳减排项目监测证据核验与签发准备平台

按监测周期完成活动数据、排放因子、证据来源、异常波动和计算链核验。支持抽样任务、版本化数据修订、发现项闭环和签发前完整性检查。

## 技术栈

Next.js App Router、MUI、Zustand、TanStack Query、ky、Zod、TypeScript。

## 运行

```bash
npm install
npm run dev
```

访问 `http://localhost:62060`。`/api/evidence` 提供分页场景所需的本地 REST 数据接口。

```bash
npm run build
```
