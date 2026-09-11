# dsh-agp-askdata

AGP TSDB / Database 智能问数的 DSH 插件（P0：StarRocks TSDB 面）。

> **本分支（feature/schema-validation）智能问数只走 AGP REST API**（`/s1M6_uE9/wz/`，10 个 API 工具：模型查询/分段聚合/测点实时与历史/统计值）。SQL 工具面（StarRocks/MySQL 直连 12 工具）保留在服务编程接口（`service.tools`）中，但**不在 DSH 注册**——取数统一收口 API 网关。

自然语言提问 → LLM 选择固定语义 Tool（模板化 SQL，禁止自由拼 SQL）→ 基础库白名单校验 → 扫描护栏 → StarRocks 查询 → AGP 标准结构化返回 + 审计哈希链。

## 状态：P0 + P1

已实现 **11 个语义工具**：P0（StarRocks TSDB 面）`lookup_tag` / `estimate_count` / `latest_value` / `time_series` / `aggregate`（自动路由 WT_CUBE），P1（MySQL 业务库面）`lookup_model` / `lookup_object` / `lookup_tag_definition` / `resolve_tag`（中文→tagName 映射链）/ `query_alarm` / `query_alarm_config`。校验层（只读 + 白名单 + 注入特征拒绝，闸门在服务执行器咽喉点收口）、质量位过滤（`bitand(quality,128)!=128`）、tagName 四段式解析、WT_QUERY_AUDIT 哈希链（进程内，落库 P2）。路线图见 [docs/architecture.md](docs/architecture.md) §1、§14、§15。

## 快速开始

```sh
pnpm install
pnpm run test          # vitest 单测（无需数据库）
pnpm run typecheck
```

编程接口：

```ts
import { createAskdataService } from './src/index.ts'

const service = createAskdataService({
  connection: { host: 'fe.example.com', port: 9030, user: 'askdata_ro', password: process.env.MYSQL_PWD!, database: 'agp' },
  mysqlConnection: { host: 'meta.example.com', port: 3306, user: 'askdata_ro', password: process.env.MYSQL_PWD!, database: 'wisetao_meta' },
})
const ctx = service.createContext()
const result = await service.tools.find(t => t.name === 'lookup_tag')!
  .run({ keyword: '组串电流' }, ctx)
// result.fields / result.data / result.errorCode —— AGP 标准契约
```

真实库验收（§13 / §16）：

```sh
pnpm run test          # vitest 单测（无需数据库，135 个）
pnpm run typecheck
npx tsx scripts/e2e-p0.ts           # P0 五工具在 StarRocks 上端到端
MY_PASSWORD='...' npx tsx scripts/e2e-p1.ts  # P1 六工具在 MySQL+StarRocks 上端到端
```

要求：`pnpm install` 即可（默认走 mysql2 驱动直连 StarRocks，兼容 MySQL 协议）。若设 `connection.driver: 'cli'` 回落外部客户端，则需本机装有 `mysql`。建议 StarRocks 侧账号使用 `mysql_native_password` 认证插件。

## 上游规格

`docs/spec/` 收录 WISETao 设计文档副本（17 Tool 规范、SQL 模板、tagName 编码、质量位、WT_TAG/WT_DATA DDL）；源目录 `D:\svn\WISETao_custom_demo\docs`，变更时同步。

## 许可

MIT
