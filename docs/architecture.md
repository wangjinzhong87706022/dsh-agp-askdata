# dsh-agp-askdata 架构设计

AGP TSDB / Database 智能问数的 DSH 插件。本文是实现的共同基线；上游需求与规格来自 WISETao 设计文档（`docs/spec/`，源目录 `D:\svn\WISETao_custom_demo\docs`）。

## 1. 定位与范围

**定位**：在 DSH（DeepSeek Harness，"一切皆插件"的 LLM 调度层）上，为 AGP 光伏平台提供合规的智能问数能力。业务人员用自然语言提问，系统经由**固定语义的模板化 Tool** 查询 StarRocks TSDB 与业务库，返回带字段元数据的结构化结果与审计记录。

**安全红线（来自 0824/0903 会议纪要，不可妥协）**：

1. AI 不能直接拼裸 SQL——一切取数走封装 Tool；
2. 数据源必须限制在基础库白名单内；
3. 机理判定强制走 `evaluate_rules`，禁止 LLM 自由生成结论（P2）；
4. DML 拦截率 100%；
5. 每个回答强制溯源 ≥2 条引用（P2）。

**阶段路线**：

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| P0 | StarRocks TSDB 面：`lookup_tag` / `estimate_count` / `latest_value`(兜底路) / `time_series` / `aggregate` + 校验层 + 扫描护栏 + 审计链 | ✅ 已实现并在真实库验证（§13） |
| P1 | **DSH 接线（✅ 本节）**：cordis 宿主行 + 工具行 + preset 挂载；**11 工具已接线**（P0 五 + P1 六，§14.2）。TSDB HTTP 网关、WT Select、HTML 报告待接 | 基本完成（P1 六工具待真实 MySQL 联调，见 §15） |
| P2 | `evaluate_rules` 强制路由、四级权限 + 字段权限、哈希链审计落库、强制溯源 | 未开始 |
| P3 | `search_knowledge`（RAGFlow）、`query_kg`、`skill` 场景编排 | 未开始（RAGFlow 先用 DSH MCP 桥直连，独立能力插件另立决策见 §9） |

## 2. 全局架构

```
┌────────────────────────────────────────────────────────────┐
│                        DSH (车架子)                          │
│   agent-loop · 会话 · 审批/sandbox · 工具注册 · preset       │
└───────────────▲────────────────────────────────────────────┘
                │ 工具调用（P0 后为直接注册；P1 走 patch+preset）
┌───────────────┴────────────────────────────────────────────┐
│                   dsh-agp-askdata 插件                       │
│                                                            │
│  工具面 tools/         校验层 sql/whitelist    审计 audit.ts │
│  ├ lookup_tag    ──►  只读分类+白名单闸门  ──►  WT_QUERY_AUDIT│
│  ├ estimate_count     (DML/敏感表/多语句)      (哈希链, P0尽力) │
│  ├ latest_value                                            │
│  ├ time_series        模板层 sql/templates                  │
│  └ aggregate          (三件套: LEFT JOIN + ^regexp          │
│                        + bitand(quality,128)!=128)          │
└───────────────┬────────────────────────────────────────────┘
                │ mysql CLI（MYSQL_PWD 环境变量注入，凭据不进 argv）
┌───────────────▼────────────────────────────────────────────┐
│              StarRocks FE (MySQL 协议, :9030)                │
│   WT_TAG(测点字典)   WT_DATA(时序主表)   [P1+] WT_CUBE 等事实表 │
└────────────────────────────────────────────────────────────┘
   P1+: TSDB HTTP 网关(RTDQuery/getAggregateHistory/getWideHistory)
        AGP /wtSelect 接口 · RAGFlow MCP(:9382) · xxl-job 事实表
```

## 3. P0 工具面

| Tool | 层级 | 语义 | 后端 |
| --- | --- | --- | --- |
| `lookup_tag` | metadata | WT_TAG 字典反查（业务名 ↔ tagName） | StarRocks SQL |
| `estimate_count` | metadata | 区间扫描行数估算，超 `maxScanRows`（默认 1 亿）拒绝 | StarRocks `COUNT(*)` |
| `latest_value` | metadata | 一批 tag 最新值；先存在性预检，全缺失 → `TAG_NOT_FOUND` | P0: `max_by` 兜底路；P1: TSDB HTTP RTDQuery 主路 |
| `time_series` | base_business | 时序明细 / 时间桶（raw/1m/5m/15m/1h/1d） | StarRocks `time_slice` / `date_trunc` |
| `aggregate` | base_business | SUM/AVG/MAX/MIN/COUNT/STDDEV/VAR × 分组（none/device/tagcode/桶） | StarRocks |

调用顺序约定（写入 preset persona）：字典 → 护栏 → 取数。

## 4. 安全模型（红线 → 机制）

| 红线 | P0 机制 | 落点 |
| --- | --- | --- |
| 禁裸 SQL | LLM 只能调 Tool；Tool 入参经 `sql/validate.ts` 校验后进模板；无任何"执行用户 SQL"工具 | `tools/`、`src/sql/templates.ts` |
| 只读 | `classifyStatement` + 派发前 `assertSafeToExecute` 闸门；`security.readOnly` 配置在 P0 恒为 true（关闭即配置错误）。**闸门在服务执行器咽喉点统一收口（`src/index.ts` gate）**，工具层调用点的闸门为纵深防御 | `src/sql/whitelist.ts`、`src/index.ts` |
| 基础库白名单 | `extractTables` 提取 FROM/JOIN 表名，逐一命中 `security.tableWhitelist`，否则 `SENSITIVE_TABLE` | 同上 |
| 扫描护栏 | 区间查询前强制 `estimate_count`（`security.scanGuard`，默认开），超限 → `EXCEED_LIMIT`；`aggregate` 命中 WT_CUBE 路由时跳过（实际扫描的是预聚合表，非 WT_DATA 大区间） | `tools/time-series.ts`、`tools/aggregate.ts` |
| 质量过滤 | 所有时序 SQL 强制 `bitand(quality, 128) != 128`（掩码可配）；`decodeQuality` 供答案解释 | `src/sql/quality.ts` |
| 审计 | 每次调用（成功/失败）构建 `WT_QUERY_AUDIT` 行，`result_hash=SHA256(sql‖result)`，`prev_hash` 链式；**P0/P1 链仅在进程内维护**（行构建 + 宿主闭包游标），落库为 P2（需旁路写账号）；审计失败不阻断查询。`insertAuditSql` 是规格要求的 INSERT 模板，仅供旁路写通道使用，绝不进入取数面 | `src/audit.ts`、`tools/types.ts` |

输入校验（《规范》§1.1）：ISO8601 时间（start<end、≤365 天）、过滤串 ≤1024 且禁 `;`/`--`/`/*`、tagName 数组 1-1000 去重、limit 1-10000。

## 5. 执行层选型

**双通道，默认 mysql2 驱动直连**（`src/clients/starrocks-mysql2.ts`，`connection.driver: 'mysql2' | 'cli'`）：

- **mysql2（默认）**：StarRocks 兼容 MySQL 线协议，驱动直连 FE 查询端口（默认 9030）。刻意使用 text protocol（`conn.query()` 而非 `conn.execute()`）规避 StarRocks 服务端 prepared statement 的版本差异；`dateStrings: true` 让 datetime 以字符串返回，与 AGP fields 契约一致；错误按 `code`/`sqlState` 映射为 `BACKEND_DOWN` / `WT_SQL_PARSE_ERROR`。P0 每查询独立建连，连接池是 P1 优化项。
- **cli（回落）**：外部 `mysql` 客户端，密码经 `MYSQL_PWD` 环境变量注入（不进 argv/日志）。适用场景：目标环境不允许出站驱动连接之外的依赖安装、或需要与其他 dsh-data-agent 类插件的通路保持同构（其 Doris 类型即 `MYSQL_COMMON_ARGS` + mysql CLI，已验证该协议通路）。

两通道共享同一 `SqlExecutor` 接口（`execute(sql) → {columns, rows}`），工具层与模板层完全无感；凭据约定一致：密码只在进程内传给驱动或环境变量，不进日志、错误消息与测试快照。

tagName 四段式在 SQL 侧统一使用 StarRocks **1 基** `split(tagName,'_')[n]`（`[1]`=tagCode、`[3]`=device，禁止 0 基）；JS 侧 `parseTagName` 仅用于解释。

## 6. AGP 返回契约

`ToolResult`（《规范》§1.2）：`success / toolName / apiOrSql / params / fields / data / rowCount / executionMs / auditId / citations / errorMessage / errorCode / page`。`fields`+`data` 供前端直接渲染；`citations` P0 恒空，P2 强制 ≥2 条。

错误码（《规范》§1.4）：`INVALID_PARAM / PERMISSION_DENIED / SENSITIVE_TABLE / DML_FORBIDDEN / EXCEED_LIMIT / BACKEND_DOWN / WT_SQL_PARSE_ERROR / TAG_NOT_FOUND`，每个码带 LLM 处置提示（`src/errors.ts`）。

## 7. 配置参考

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `connection.{host,port,user,password,database}` | — | StarRocks FE；密码进程内使用，不落盘 |
| `connection.driver` | `mysql2` | 执行通道：`mysql2` 驱动直连 / `cli` 外部 mysql 客户端 |
| `connection.cliPath` | `mysql` | 仅 `driver: 'cli'` 时使用；SQL 经 stdin 送达，不进 argv |
| `mysqlConnection.{host,port,user,password,database}` | 空 | MySQL 业务库；留空则 P0 面可用、P1 元数据/告警工具在调用期报 `BACKEND_DOWN` |
| `tables.{tag,data}` | `WT_TAG` / `WT_DATA` | 表名可按部署覆盖 |
| `system.maxScanRows` | 1 亿 | 扫描护栏阈值 |
| `system.maxTimeRangeDays` | 365 | 单次查询时间跨度上限 |
| `system.badValueMask` | 128 | 质量位坏值掩码 |
| `system.queryTimeoutMs` | 15000 | 单条 SQL 超时 |
| `system.maxLimit` | 10000 | 返回行数上限 |
| `system.defaultLimit` | 1000 | 时序/聚合工具默认返回行数 |
| `system.defaultLookupLimit` | 100 | 字典/设备反查工具默认返回行数 |
| `system.defaultAlarmLimit` | 100 | 告警工具默认返回行数 |
| `system.timeZone` | `+08:00` | 时间字面量统一按 ±HH:MM 偏移换算为墙钟（非法格式在加载期报错；CLI 通道另以 init-command 设置会话时区） |
| `security.tableWhitelist` | `['WT_TAG','WT_DATA','WT_CUBE','WT_DEVICE']` | 基础库白名单 |
| `security.mysqlTableWhitelist` | `['wisetao_meta.meta_class_info', …]` | MySQL 白名单（跨库全限定格式） |
| `security.scanGuard` | true | 区间查询前强制估算 |
| `audit.{enabled,table,userId,appId,orgId}` | true / `WT_QUERY_AUDIT` | 审计开关与身份（哈希链默认开启：进程内行构建 + 宿主游标；落库为 P2，需旁路写账号） |

## 8. DSH 接线（P1，已实现）

工程骨架遵循 DSH 插件约定（对齐 dsh-data-agent 的双行模式）：

**宿主行 `dsh-agp-askdata`**（`src/dsh/plugin.ts`，包主入口）：

- `Config`（schemastery）：`connection`（host/port 必填，driver 默认 mysql2）、`tables`、`system`、`security`、`audit`、`installPreset`、`presetId`——loader 应用默认值后交 `resolveConfig` 二次校验，配置错误在加载期失败；
- `apply()`：`createAskdataService` 装配 → `ctx.provide('askdata', service)`（声明合并进 cordis Context）→ `installPreset`；
- `installPreset`：拷贝 `preset/askdata/` 到 `$DSH_HOME/.agent-presets/askdata/`，幂等（目标存在即跳过，绝不覆盖用户改动），失败仅告警不阻断启动。

**工具行 `dsh-agp-askdata/tools`**（`src/dsh/tools.ts`，`inject = ['tools', 'askdata']`）：

- 由 `preset/askdata/agent.cordis.yml` 挂载（同 `dsh-tool-str-replace-editor` 的 preset 行模式），只消费宿主服务，满足 preset 守卫；headless 组合不挂本行、无工具副作用；
- 每个框架无关 `AskdataTool` 经 `adaptAskdataTool`（`src/dsh/adapter.ts`）转为 DSH 工具定义：parameters/output.schema 为 JSON Schema（required 提升、additionalProperties:false）、`execute` 抛错即失败（携带规范错误码）、`output.render` 输出 fields+前 20 行预览、presentCall/presentResult 用 generic 卡片；
- 取消信号（`exec.signal`）与审计哈希链游标（prev_hash 闭包）逐调用注入工具上下文；执行层（mysql2/cli 双通道）收到中止立即销毁连接/杀进程。

**与 dsh-tools 的关系**：工具定义不经由 `@deepseek-ai/dsh-tools` 的 `defineTool`——其 npm RC 依赖链（`dsh-type-meta`）暂不可安装；适配器直接产出 `ToolDefinition` 形状（以 harness `packages/core/tools` 为准），`ctx.tools` 用结构化视图桥接、不做模块声明合并。dsh-tools 可安装后可替换获得宿主级参数校验。

**安装（目标机器）**：`pnpm run build` 后把本包链入 DSH 的插件解析路径（npm link 或安装包），DSH 加载 `cordis.patch.yml` 的 `askdata` 行；Web/TUI 选"AGP问数" preset 即得五工具。

### 8.1 取消语义

`SqlExecutor.execute(sql, { signal })` 贯穿三层：runSqlTool 预检 aborted → mysql2 通道 abort 即 `conn.destroy()` → CLI 通道 abort 即 SIGKILL 子进程；超时与取消共用同一销毁路径。

## 9. RAGFlow 整合（P3 前置决策）

检索是可复用能力，不并入本插件：先以 DSH MCP 桥直连 RAGFlow MCP（:9382，零代码）验证；当需要 KB-01~06 路由、溯源规范化（source_id/page/chunk_id → ≥2 引用）、知识库权限过滤时，另立 `dsh-ragflow-kb` 能力插件，本插件的 `search_knowledge` 作为 Consumer 调用。

## 10. 目录结构

```
src/            服务核心（sql 校验/模板/白名单、执行层、审计；适配器在 src/dsh）
  dsh/plugin.ts    宿主行：schemastery Config + 服务装配 + preset 安装（包主入口）
  dsh/tools.ts     工具行：AskdataTool → DSH 工具注册（由 preset 挂载）
  dsh/adapter.ts   AskdataTool → ToolDefinition 适配（JSON Schema/render/取消信号）
  clients/         mysql2（默认）/ mysql CLI（回落）双通道执行器
tools/          P0 工具面（框架无关 AskdataTool）
preset/askdata/   "AGP问数" preset（persona 约束 + askdata-tools 行）
scripts/          smoke.mjs（连通）· e2e-p0.ts（工具链）· ask-smoke.ts（LLM 问数）
docs/spec/      上游 WISETao 规格副本（源：D:\svn\WISETao_custom_demo\docs）
tests/          vitest：校验层/四段式/质量位/模板金样/TSV 解析/审计链/工具行为/DSH 适配器
```

## 11. 测试策略

纯函数穷举（校验、转义、分类、解码）+ 模板金样断言 + **每个模板产物必须通过白名单闸门**（守卫生成面与闸门面的同步）+ 工具行为测试（内存执行器：TAG_NOT_FOUND、EXCEED_LIMIT 不触达主查询、审计链 prev_hash 衔接）。真实 StarRocks 连通性测试属 e2e（需环境），不在单测范围。

## 12. 开放问题

- **estimate 精度**：P0 用谓词内 `COUNT(*)`（StarRocks 列存下可接受）；若大区间估算本身成为瓶颈，切 `SHOW DATA`/元数据近似，接口不变。
- **时区**：会话级 `init-command SET time_zone`，写入侧若为本地时区裸时间需在 P1 与 AGP 采集侧对齐口径。
- **TSDB HTTP 网关**：`latest_value` 主路、`aggregate_http`、`wide_history` 依赖网关地址与鉴权参数，等实施前置资料确认后接入（见《实施前置资料清单》）。
- **WT_QUERY_AUDIT 写权限**：问数账号需要对该表的 INSERT 权限；只读账号部署时审计改由旁路账号写入。

## 13. 验证记录（2026-09-07，真实环境）

### 13.1 环境与数据画像

StarRocks **3.1.9**（单 FE），`root@192.168.101.54:9030`（MySQL 协议，mysql2 驱动直连，空密码）。库 `WT_DB`：`WT_TAG` 测点字典 + `WT_DATA` 时序主表，真实光伏数据——35kV 开关柜状态量（`35KV1SEG0007_2O_100620000005171`"35KVI段装置告警"等），设备号 `100620000005171`，数据止于 **2024-08-14**，密度约 **4 亿行/天**。`WT_QUERY_AUDIT` 未建（审计链默认在进程内构建 + 宿主游标维护；落库为 P2，需旁路写账号）。

### 13.2 工具链 e2e（scripts/e2e-p0.ts，1 小时窗口）

| 工具 | 结果 | 耗时 | 备注 |
| --- | --- | --- | --- |
| lookup_tag | ✓ | 165ms | 业务名反查命中 |
| estimate_count | ✓ | 1.7s | 2016 万行/小时窗口 |
| latest_value | ✓ | 2.0s | `max_by` 兜底路返回真实最新值 |
| time_series | ✓ | 6.1s | 5m 桶真实数据 |
| aggregate | ✓ | 6.4s | device 分组（1 基 split[3]） |

**护栏实测**：1 天窗口估算 3.99 亿行 > 1 亿上限，`time_series`/`aggregate` 正确拒绝并返回 `EXCEED_LIMIT`；查询超时自管定时器在 15s 档精确切断（15226ms 实测）。

### 13.3 e2e 逼出的缺陷与修复（均已带回归测试）

1. **`maxValue` 撞保留字**：MySQL 系保留字 `MAXVALUE` 使 `AS maxValue` 语法报错 → 全部列别名加反引号，GROUP/ORDER BY 用表达式不用别名。
2. **ISO 字面量破坏分区裁剪**：`'…T….…Z'` 原文使 `COUNT` 全表扫 182s → `toSqlTimestamp` 统一规范化为 `'YYYY-MM-DD HH:MM:SS'`（按 `system.timeZone` 偏移换算）。
3. **mysql2 `timeout` 选项不可靠**：182s 未触发 → 适配器自管定时器 + `conn.destroy()`。
4. **FE planner 瞬态超时**（memo 阶段 >3s，"Hive external table fetch metadata"提示）→ 对 `/planner use long time|memo phase/i` 自动重试一次，重试后 46ms 成功。

### 13.4 智能问数冒烟（scripts/ask-smoke.ts）

形态：DeepSeek 兼容端点（`DEEPSEEK_BASE_URL` 中转，`LLM_MODEL=glm-5.3`）+ function calling；LLM 只暴露 P0 五工具，**无任何 SQL 工具**；系统提示词即 `preset/askdata` 的硬性约束。

- **问 1**"35KVI段装置告警这个测点最新的值是多少？"：7 次工具调用。字典查出**两个同名测点**（0007/0914）→ `latest_value` 双测点超时 → **LLM 自主降级**：estimate 锚定窗口后改用 `time_series` raw 兜底 → 结论含两测点全名、值、质量码，并提示数据止于 2024-08-14。
- **问 2**"2024-08-14 全天 35KVI段开入13 的趋势？"：9 次调用。全天窗口触发 `EXCEED_LIMIT` → **LLM 自行切 6h 段**，撞边界的段再切 3h → 汇总 19 条记录恒为 0，识别"定时快照+变位记录"模式并指出 18:13 后数据缺口。

成本约 2 万 token/问。结论均引用测点全名与时间范围（提示词约束，非机制强制——强制溯源在 P2）。

### 13.5 遗留观察（转后续优化）

- `latest_value` 双测点计划不稳定（单点 2s / 双点曾 30s+），P1 接 TSDB HTTP RTDQuery 主路后退居兜底。
- 扫描护栏为**全表口径**（不含 tag 过滤），单测点全天查询也会被拦、靠 LLM 切窗——符合规范保守取值，P1 可评估按 tagIndex 估算的细化口径。
- 现以 root 空密码验证连通；生产前必须建只读账号并撤权（P1 部署清单项）。

## 14. P1 扩展架构决策（2026-09-08，基于 §一~§十六 素材）

> **素材基线**：`docs/spec/光伏深度分析-WT_TAG与TSDB查询大全.md` §一~§十六，含 295 模型清单、11 WT-SQL 方案、15 StarRocks 表、205 万测点分布、11489 行告警、设备树 6 层拓扑、华为逆变器四层查询实证。

### 14.1 决策汇总

| # | 决策点 | 选定方案 | 否决方案 |
|---|---|---|---|
| D1 | P1 新增工具 | 6 个：lookup_model / lookup_object / lookup_tag_definition / resolve_tag / query_alarm / query_alarm_config | 全量扩展（不加 aggregate_cube，P2 再考虑） |
| D2 | 中文→测点映射 | 一个 resolve_tag 工具（中文设备名+中文测点名+粒度→tagName+tagIndex） | 拆两步（LLM 易拼错）/ 复用 lookup_tag LIKE（精度差） |
| D3 | WT_DATA 查询优化 | 改 time_series/aggregate 内部：先查 WT_TAG→tagIndex，再用 tagIndex 过滤 WT_DATA；aggregate 自动路由 WT_CUBE | 加新工具（接口重复）/ 暂不优化 |
| D4 | MySQL 通道 | 复用 mysql2 + Config 加 mysqlConnection 字段 + 新增 mysqlExecutor | 独立执行器（改动大） |
| D5 | 模型过滤 | Config 加 appId=10062，元数据查询强制过滤 | LLM 自选（易查到 260 个无关模型） |

### 14.2 P1 工具面（扩展后 11 工具 = P0 五 + P1 六）

| Tool | 层级 | 语义 | 后端 | 新增 |
|---|---|---|---|---|
| `lookup_tag` | metadata | WT_TAG 字典反查 | StarRocks | P0 |
| `estimate_count` | metadata | 区间扫描行数估算 | StarRocks | P0 |
| `latest_value` | metadata | 一批 tag 最新值 | StarRocks | P0 |
| `time_series` | base_business | 时序明细/时间桶 | StarRocks（**内部改 tagIndex 过滤**） | P0（P1 优化） |
| `aggregate` | base_business | 聚合×分组 | StarRocks（**内部路由 WT_CUBE**） | P0（P1 优化） |
| `lookup_model` | metadata | 模型清单（meta_class_info，app_id 过滤） | MySQL | **P1** |
| `lookup_object` | metadata | 设备查询（wt_elm_equipment，按 class__path/node_name/parent_id） | MySQL | **P1** |
| `lookup_tag_definition` | metadata | 动态属性定义（meta_classtagmodel，tagCode+中文名+类型） | MySQL | **P1** |
| `resolve_tag` | metadata | **中文→tagName 映射链**（设备名+测点名+粒度→tagName+tagIndex） | MySQL+StarRocks | **P1** |
| `query_alarm` | base_business | 告警记录（wt_bas_alarmrecord，按时间/级别/设备/测点） | MySQL | **P1** |
| `query_alarm_config` | metadata | 告警配置（bole.wt_cus_alarmdynamicconfig，按设备类/测点） | MySQL | **P1** |

### 14.3 resolve_tag 工具规格（中文→测点映射链）

```
输入：
  deviceName: string   // 中文设备名，如"1号箱变1号逆变器"
  tagNameCn: string    // 中文测点名（必须严格等于 meta_classtagmodel.name），如"总发电量"
  granularity: enum    // 粒度：1O(原始) / 2O(状态量) / 1H(时) / 1D(日) / 1M(月) / 1Y(年)

内部链路（5 步，2026-09-09 真实库全链路验收通过 §16）：
  1. MySQL wisetao_meta.wt_elm_equipment WHERE node_name=? AND deleted=0 → id, class__path
  2. MySQL wisetao_meta.meta_classtagmodel WHERE name=? AND master_class_id=(SELECT id FROM meta_class_info WHERE class_path=step1.class__path) → tag_code
  3. 拼 tagName = `${tagCode}_${granularity}_${deviceId}`（规格顺序：tagCode_粒度_deviceId；
     WT_TAG 实测样例 HWNBYC174_1D_100620000015524）
  4. MySQL wisetao_meta.wt_iot_tags WHERE tagname=? AND deleted=0 → 确认存在 + alias
  5. StarRocks WT_DB.WT_TAG WHERE tagName=? → tagIndex

输出：
  tagName: string      // 如"HWNBYC174_1D_100620000015521"
  tagIndex: number     // 如1961441（WT_TAG 实测值）
  alias: string        // 如"总发电量日统计测点"
  deviceId: number     // 如100620000015521
  tagCode: string      // 如"HWNBYC174"

错误码：
  OBJECT_NOT_FOUND（step1 未命中设备名）
  TAG_DEFINITION_NOT_FOUND（step2 未命中测点名；可能原因：① 中文名未与 meta_classtagmodel.name 严格相等
                            → 先 lookup_tag_definition；② 测点定义不在该设备 class__path 下）
  TAG_NOT_REGISTERED（step4 tagName 在 wt_iot_tags 不存在；可能原因：tagCode 与 deviceId 隶属关系不一致）
  TAG_NOT_IN_TSDB（step5 tagName 在 WT_TAG 不存在）
```

### 14.4 time_series / aggregate 内部优化（D3）

**time_series 优化**（对 LLM 接口不变）：
```
当前：SELECT ... FROM WT_DATA WHERE tagName IN (...) ...
优化后：
  1. SELECT tagName, tagIndex FROM WT_TAG WHERE tagName IN (...)  -- 一次批量查
  2. SELECT ... FROM WT_DATA WHERE tagIndex IN (...) ...          -- int 过滤比 varchar 快
```

**aggregate 自动路由**（对 LLM 接口不变）：
```
当聚合类型 ∈ {SUM, AVG, MAX, MIN, COUNT} 且分组维度 ∈ {device, tagcode, none} 且时间粒度 ∈ {1H, 1D, 1M, 1Y}：
  → 路由到 WT_CUBE（2553 万行，预聚合，含 value/avgValue/maxValue1/minValue1/sumValue/countValue）
否则：
  → 回退到 WT_DATA 全聚合（带扫描护栏）
```

### 14.5 Config 扩展（D4 + D5）

```yaml
# 新增字段
mysqlConnection:       # MySQL 业务库连接（元数据 + 告警 + 配置）
  host: '192.168.101.54'
  port: 3306
  user: 'root'
  password: ''         # 进程内使用，不落盘
  database: 'wisetao_meta'  # 默认元数据库；告警配置查 bole 库时跨库引用
appId: 10062           # 光伏应用 ID（D5 模型过滤）

# 安全白名单扩展
security:
  tableWhitelist:      # StarRocks 白名单（已有）
    - 'WT_TAG'
    - 'WT_DATA'
    - 'WT_CUBE'        # 新增
    - 'WT_DEVICE'      # 新增
  mysqlTableWhitelist: # MySQL 白名单（新增）
    - 'wisetao_meta.meta_class_info'
    - 'wisetao_meta.meta_classtagmodel'
    - 'wisetao_meta.meta_class_link_info'
    - 'wisetao_meta.wt_elm_equipment'
    - 'wisetao_meta.wt_iot_tags'
    - 'wisetao_meta.wt_bas_alarmrecord'
    - 'bole.wt_cus_alarmdynamicconfig'
```

### 14.6 数据通道架构（扩展后）

```
┌────────────────────────────────────────────────────────────┐
│                   dsh-agp-askdata 插件                       │
│                                                            │
│  工具面 tools/（11 = P0 五 + P1 六）                        │
│  ├ lookup_tag ──────────────────────────────────────────────│
│  ├ estimate_count ─────────────────────────────────────────│
│  ├ latest_value ───────────────────────────────────────────│
│  ├ time_series ──► (P1: 先查 WT_TAG→tagIndex) ─────────────│
│  ├ aggregate ────► (P1: 自动路由 WT_CUBE) ─────────────────│
│  ├ lookup_model ──┐                                        │
│  ├ lookup_object ─┤                                        │
│  ├ lookup_tag_def �┤──► mysqlExecutor ──► MySQL 3306       │
│  ├ resolve_tag ───┤    (wisetao_meta + bole)               │
│  ├ query_alarm ───┤                                        │
│  └ query_alarm_cfg┘                                        │
│                                                            │
│  执行层 clients/                                           │
│  ├ starrocks-mysql2.ts (已有) ──► StarRocks 9030 (WT_DB)  │
│  └ mysql-mysql2.ts (新增) ─────► MySQL 3306 (业务库)      │
│                                                            │
│  校验层 sql/whitelist.ts (扩展：双白名单)                   │
│  模板层 sql/templates.ts (扩展：6 个 MySQL 模板)            │
└────────────────────────────────────────────────────────────┘
```

### 14.7 新增 MySQL 模板（sql/templates.ts 扩展）

| 模板 | SQL（全部参数化，走白名单闸门） |
|---|---|
| `lookup_model` | `SELECT class_alias, class_name, class_path, level FROM wisetao_meta.meta_class_info WHERE app_id=? ORDER BY class_path` |
| `lookup_object` | `SELECT id, node_code, node_name, class__path, parent_id, tree_level, position FROM wisetao_meta.wt_elm_equipment WHERE deleted=0 AND app_id=? AND (class__path LIKE ? OR node_name LIKE ? OR parent_id=?) LIMIT ?` |
| `lookup_tag_definition` | `SELECT t.tag_code, t.name, t.tag_type, t.calculated, t.in_out FROM wisetao_meta.meta_classtagmodel t JOIN wisetao_meta.meta_class_info c ON t.master_class_id=c.id WHERE c.class_path=? AND t.deleted=0 ORDER BY t.tag_code` |
| `query_alarm` | `SELECT id, alarm_title, alarm_time, alarm_level, alarm_status, entity_name, tag_code, description FROM wisetao_meta.wt_bas_alarmrecord WHERE deleted=0 AND app_id=? AND (alarm_time BETWEEN ? AND ?) AND (alarm_level=? OR 1=?) ORDER BY alarm_time DESC LIMIT ?` |
| `query_alarm_config` | `SELECT tag_code, tag_comment, cus_class_path, alarm_type, alarm_level, alarm_classify, is_white, status FROM bole.wt_cus_alarmdynamicconfig WHERE deleted=0 AND app_id=? AND (cus_class_path=? OR 1=?) ORDER BY tag_code` |
| `resolve_tag` step1 | `SELECT id, class__path FROM wisetao_meta.wt_elm_equipment WHERE node_name=? AND deleted=0 AND app_id=? LIMIT 1` |
| `resolve_tag` step2 | `SELECT t.tag_code FROM wisetao_meta.meta_classtagmodel t JOIN wisetao_meta.meta_class_info c ON t.master_class_id=c.id WHERE t.name=? AND c.class_path=? AND t.deleted=0 LIMIT 1` |
| `resolve_tag` step4 | `SELECT alias FROM wisetao_meta.wt_iot_tags WHERE tagname=? AND deleted=0 LIMIT 1` |
| `resolve_tag` step5 | `SELECT tagIndex FROM WT_DB.WT_TAG WHERE tagName=? LIMIT 1`（走 StarRocks） |

### 14.8 不做的事（P1 范围外）

| 不做 | 原因 | 阶段 |
|---|---|---|
| `aggregate_cube` 独立工具 | D3 决定 aggregate 内部自动路由，无需独立工具 | — |
| Ice API 通道 | python 接口暂不考虑（用户决策） | 搁置 |
| REST 代理 /rtdb/* / /iot-etl/iot/tag/* | 后端服务部署主机/端口未实测 | P2 候选 |
| WT-SQL 模板查询 /meta/model/queryByGenericSql | 11 个方案全系统级，无光伏场景方案；复用需自建 | P2 候选 |
| `evaluate_rules` 强制路由 | 机理判定 | P2 |
| `search_knowledge` RAGFlow | 知识检索 | P3 |
| 写操作（告警处理/配置修改） | 只读红线 | 永不做 |

### 14.9 验证计划

P1 实现完成后，用 `scripts/e2e-p1.ts` 验证以下场景（§16 实测验收 8/8 通过）：

| 场景 | 工具链 | 实测结果（2026-09-09 真实库） |
|---|---|---|
| "有哪些光伏设备模型" | lookup_model | 35 行 / 345ms |
| "1号箱变1号逆变器"（具体设备反查） | lookup_object(node_name='1号箱变1号逆变器') | 20 行 / 25ms |
| "华为逆变器有哪些测点" | lookup_tag_definition(class_path='wt_elm_equipment/wt_iot_huaweisun2000') | 221 行 / 73ms |
| "1号箱变1号逆变器 总发电量 1D 粒度的 tagName" | resolve_tag | tagName=HWNBYC174_1D_100620000015521, tagIndex=1961441, alias=总发电量日统计测点 / 112ms |
| "上述 tagName 在 TSDB 的最新值" | latest_value（兜底路） | 当前集群负载下 30s+（与 §13.5 遗留相符；真实有数据时 2s 内返回） |
| "上述 tagName 13 天日均" | aggregate（cube 路由 WT_CUBE） | AVG=1665.5 / 12 样本 / 104ms |
| "最近有什么告警" | query_alarm(2024-06-16~10-10) | 5 行 / 13ms（真实最新 11619 条告警事件） |
| "AGC 设备的告警配置" | query_alarm_config(cus_class_path='wt_elm_equipment/wt_iot_agc_adb3be1a') | 0 行（AGC 子类未独立配置；正常） |
| "全 app_id 的告警配置" | query_alarm_config() | 379 行 / 14ms |

**实测发现的两点修正**：
- `class_path` 真实形态为 `wt_elm_equipment/wt_iot_huaweisun2000`（华为逆变器）等以表名打头并由 `meta_class_info.parent_class_id` 串联的多级路径——§14.2 文档原描述的 `wisetao.pv.inverter` 形态是上游规格愿景，联调库尚未迁移；工具 SQL 按 `class_path = ?` 精确匹配工作正常。
- `meta_classtagmodel.name` 是规格中文名（如"总发电量"、"逆变器电流离散度"），与设备 `node_name` 同样是上游录入的中文，必须严格相等；LLM 调用 resolve_tag 前应先调 lookup_tag_definition 确认精确中文名。

### 14.10 查询通道与聚合路由配置（性能优化 + 通用/特定分离）

> **调研依据**：`scripts/agg-probe.mjs` 实测 + `D:\svn\...\task\vo\CubeType.java` + `Granularity.java` 反编译。

#### 14.10.1 性能结论

| 问题 | 结论 | 依据 |
|---|---|---|
| MySQL wt_iot_tags 205 万行查 tagName 慢吗？ | **不慢** | `tagname` 列有**唯一索引**（`unique_index_wt_iot_tags_tagname5651`），精确查找 O(log N) ≈ 几毫秒 |
| WT_DATA 能直接查聚合粒度吗？ | **不能** | 实测 `HWNBYC174_1H/1D/1M/1Y` 的 tagIndex 在 WT_DATA 中都是 0 行；**只有 1O（原始）粒度有数据** |
| 聚合数据在哪？ | **WT_CUBE** | 2553 万行，含 `value/avgValue/maxValue1/minValue1/sumValue/countValue` 6 种聚合值 |
| WT_CUBE 是通用的吗？ | **不是** | `cubeType` 1-20 全是光伏特定（华为/阳光 × 组串/逆变器 × 电流/电压/电量 × 汇总/离散率 + 储能 4 种） |
| Granularity 是通用的吗？ | **是** | Hour(1)/Day(2)/Month(3)/Year(4)/Week(5)，任何行业通用 |

#### 14.10.2 CubeType 枚举（光伏特定，20 种）

| cubeType | 枚举名 | 语义 | 行数 |
|---|---|---|---|
| 1 | HwStringI | 华为组串电流汇总值 | 324 万 |
| 2 | HwStringU | 华为组串电压汇总值 | 382 万 |
| 3 | YgStringI | 阳光组串电流汇总值 | 769 万 |
| 4 | YgStringU | 阳光组串电压汇总值 | 859 万 |
| 5 | HwInverterI | 华为逆变器电流汇总值 | 14 万 |
| 6 | YgInverterI | 阳光逆变器电流汇总值 | 31 万 |
| 7 | HwInverterQ | 华为逆变器电量值 | 22 万 |
| 8 | YgInverterQ | 阳光逆变器电量值 | 48 万 |
| 9-12 | *StringILsl/*StringULsl | 组串电流/电压离散率 | 各 14-31 万 |
| 13-16 | *InverterILsl/*InverterQLsl | 逆变器电流/电量离散率 | 各 1-3 万 |
| 17-20 | CnFdl/CnCdl/CnSwl/CnXwl | 储能放电/充电/上网/下网量 | 各 1-3 万 |

#### 14.10.3 三层查询路由架构

```
用户问数请求
     │
     ▼
┌─────────────────────────────────────────────────────┐
│ 层1：通道路由（query.tsdbChannel）                    │
│   'sql'  → StarRocks SQL 直连（默认，已验证）        │
│   'rest' → AGP REST API（/iot-etl/iot/tag/* 或 /rtdb/*）│
│   配置项：query.tsdbChannel                          │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 层2：聚合表路由（query.aggregateTable）               │
│   'WT_CUBE' → 优先查聚合表（光伏特定，快）           │
│   null      → 强制只查 WT_DATA（通用，慢但通用）     │
│   配置项：query.aggregateTable                       │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 层3：粒度路由（tagName 粒度后缀）                     │
│   1O → WT_DATA（原始数据，tagIndex 过滤）            │
│   1H/1D/1M/1Y → 聚合粒度：                           │
│     a. 先查 WT_DATA 该粒度 tagIndex（通常 0 行）     │
│     b. 若 WT_DATA 无数据且 aggregateTable≠null：     │
│        → 查 WT_CUBE（cubeType + granularity 映射）   │
│     c. 若 aggregateTable=null 或 WT_CUBE 无数据：    │
│        → 回退 WT_DATA 1O 粒度 + 应用层聚合           │
└─────────────────────────────────────────────────────┘
```

#### 14.10.4 Config 新增配置项

```yaml
query:
  # 层1：时序数据查询通道
  tsdbChannel: 'sql'        # 'sql'(默认,StarRocks直连) | 'rest'(TSDB HTTP 网关实时值)
  
  # 层1：REST 通道配置（tsdbChannel='rest' 时生效；baseUrl 必填，加载期校验）
  rest:
    baseUrl: ''             # 网关基址，如 'http://192.168.101.54:8040/iot-etl/iot'
    wtAppid: ''             # 鉴权三头
    wtToken: ''             # 密文（页面 secret 角色）
    wtOpenid: ''
    fallbackToSql: true     # REST 失败（不可达/响应不合法）自动回落 SQL；false = 直接失败
  
  # 层2：预聚合路由开关 + 聚合表名（光伏特定）
  useAggregateTable: true   # false = 强制只用 WT_DATA 全聚合（非光伏行业/口径存疑/调试）
  aggregateTable: 'WT_CUBE' # 聚合表名；置空串等效关闭路由
  
  # 层2：cubeType 映射（光伏特定，从 CubeType.java 枚举提取）
  cubeTypeMap:
    1: '华为组串电流汇总值'
    2: '华为组串电压汇总值'
    # ... 1-20 全量见 §14.10.2
    17: '储能放电量'
    20: '储能下网量'
  # cubeTypeMap 为空 → 不做 cubeType 路由，只按 granularity 查 WT_CUBE
  
  # 层3：粒度后缀 → granularity 值映射
  granularityMap:
    '1H': 1   # Hour
    '1D': 2   # Day
    '1M': 3   # Month
    '1Y': 4   # Year
```

#### 14.10.5 API vs SQL 通道选型

| 通道 | 优势 | 劣势 | 适用场景 | 状态 |
|---|---|---|---|---|
| **StarRocks SQL** | 最快、最灵活、已 P0 验证、免鉴权 | 需数据库直连、需白名单维护 | 默认通道 | ✅ P0 |
| **REST /iot-etl/iot/tag/*** | 官方推荐、免数据库直连、走网关 | 需网关可达、鉴权三头、公网延迟 | latest_value 主路已实现（`iotRealTimeValue`，失败按 `fallbackToSql` 回落 SQL）；**网关 2026-09-09 实测未部署**（ECONNREFUSED/404） | ✅ 代码就绪 |
| **REST /rtdb/*** | 免 Ice 客户端、后端代理 | 需后端服务可达、端口待实测 | 后端可达时 | P2 候选 |
| **Ice API** | 功能最全（10 方法） | python 搁置、Ice 3.7 兼容 | 搁置 | ❌ |
| **WT-SQL** | 模板化、中文查询 | 无光伏场景方案 | 复用需自建 | P2 候选 |

**决策**：默认走 SQL（`tsdbChannel: 'sql'`），提供配置切换到 REST。不做 Ice。WT-SQL 是 P2 候选。

**REST 通道实现条件**（P1 可选）：
- `tsdbChannel: 'rest'` 时，`latest_value` / `time_series` / `aggregate` 三个时序工具改走 REST API
- `lookup_tag` 仍走 SQL（WT_TAG 字典在 StarRocks，REST 无对应接口）
- MySQL 元数据工具（lookup_model 等）仍走 MySQL SQL（REST /meta/object/* 是 P2 候选）
- REST 通道需实现鉴权三头注入 + 错误码映射
- **分层豁免**：当前 REST 仅覆盖 `latest_value` 主路，REST 调用必须在工具 plan 阶段发起才能接住"失败回落 SQL"，故 `tools/latest-value.ts` 运行时 import `src/clients/tsdb-rest.ts`——这是全库唯一的 tools→clients 运行时依赖，属刻意设计权衡；扩展 REST 覆盖面（time_series/aggregate）时应把通道选择下沉到执行器/路由层，恢复工具层通道无关

#### 14.10.6 通用 vs 光伏特定的分离原则

| 层 | 通用（任何行业） | 光伏特定（app_id=10062） |
|---|---|---|
| 通道 | SQL / REST（可配置） | — |
| 粒度路由 | 1O→WT_DATA，1H/1D/1M/1Y→聚合表或回退 | — |
| 聚合表 | `aggregateTable: null` 时走 WT_DATA 全聚合 | `aggregateTable: 'WT_CUBE'` 时走预聚合 |
| cubeType | `cubeTypeMap: {}` 空时不做 cubeType 路由 | `cubeTypeMap` 填 1-20 映射 |
| 业务派生表 | 不路由 | WT_LOW_STRINGS/WT_DUST/WT_INVERTER_FAILURE 等（P2 按需加工具） |
| 模型过滤 | `appId` 可配 | 默认 10062 |

> **核心原则**：通用层通过 `aggregateTable=null` + `cubeTypeMap={}` 退化为"只用 WT_DATA + 应用层聚合"的纯通用实现。光伏特定层通过填充配置项启用预聚合路由。**LLM 不感知路由细节**，只调工具，工具内部按配置决定查哪张表。

#### 14.10.7 DSH 配置页（已实现，2026-09-09）

**模式选型**（参照 harness examples 的两个插件）：

| 参照 | 模式 | 取舍 |
|---|---|---|
| `examples/knowledge` | schemastery `Config` schema 即设置页——DSH 自动渲染，部署默认值走 cordis.yml，运行时另有 `resolveConfig` 合并钳制 | ✅ 采用。零自建 UI 成本，与本项目既有 cordis.patch 接线形态吻合 |
| `examples/ragflow` | 第三方插件进不了宿主 Settings 白名单（`WEB_SETTINGS_NAMESPACES`），故自建 loopback 配置页（`ctx.webServer` + `ctx.settings` + `ctx.credentials`） | P2 备选：仅当目标部署的 Settings 不渲染第三方插件、或需要 credential-reference 管理密码时启用 |

**实现**（`src/dsh/plugin.ts`）：

- **分组**：七个嵌套 object（StarRocks 连接 / MySQL 业务库 / 表名映射 / 查询路由 / 护栏阈值 / 安全 / 审计 + 安装），每组 `.collapse()` 可折叠并带中文说明；
- **描述**：全部字段 `.description()`，说明后果而非重复字段名（如 MySQL host "留空则 P0 面可用、P1 元数据/告警工具不可用"）；
- **密文**：三个密码/token 走 `.role('secret')`（页面遮蔽回显；进程内使用，不落盘不进日志）；
- **JSON 映射**：`cubeTypeMapJson` / `granularityMapJson` 用 `.role('textarea')` 呈现 JSON 文本，`toRuntimeConfig()` 在加载期 parse + 校验（坏 JSON 报错并带字段名）；cordis.yml 部署默认值可直接给对象（两形态都收）；
- **校验**：`timeZone` 带 `.pattern(±HH:MM)`、端口 `.min(1).max(65535)`、超时 `.min(1000)`；`host/database` `.required()`；最终仍过 `resolveConfig` 统一校验（fail loud）；
- **红线不进页面**：`security.readOnly` 不出现在 schema（P0 恒 true，只能由 yml 显式给出且会被 `resolveConfig` 拒绝 false）；
- **默认映射常量**（cubeType/granularity/mysql 白名单）从 `src/config.ts` 导出共用，页面与运行时无第二套拷贝。

**页面分组与字段一览**：

| 分组 | 字段（默认值） | 说明要点 |
|---|---|---|
| StarRocks 连接 | host* · port(9030) · user(askdata_ro) · password · database* · driver(mysql2/cli) · cliPath | P0 必配；生产必须只读账号 |
| MySQL 业务库 | host('') · port(3306) · user('') · password · database(wisetao_meta) | 留空则 P1 六工具调用期报 `BACKEND_DOWN` |
| 业务范围 | appId(10062) · tables.tag/data/cube/device | 模型与告警的过滤范围；表名按部署改 |
| 查询路由 | tsdbChannel(sql/rest，取数通道优先级) · rest.baseUrl/wtAppid/wtToken/wtOpenid/**fallbackToSql** · **useAggregateTable(是否使用 WT_CUBE)** · aggregateTable(WT_CUBE) · cubeTypeMapJson · granularityMapJson | §14.10 三层路由；rest 通道 latest_value 走网关实时值，失败按 fallbackToSql 回落 SQL；`useAggregateTable=false` 或 `aggregateTable` 置空 → 只用 WT_DATA；JSON 置 `{}` 关闭对应路由 |
| 护栏阈值 | maxScanRows(1亿) · maxTimeRangeDays(365) · badValueMask(128) · queryTimeoutMs(15000) · maxLimit(10000) · defaultLimit(1000) · defaultLookupLimit(100) · defaultAlarmLimit(100) · timeZone(+08:00) | 全部执行前机械生效 |
| 安全 | tableWhitelist · mysqlTableWhitelist · scanGuard(true) | 白名单外表 → `SENSITIVE_TABLE`；readOnly 不开放 |
| 审计 | enabled(true) · table · userId/appId/orgId | 进程内哈希链（默认开启）；落库 P2 |
| 安装 | installPreset(true) · presetId(askdata) | 幂等安装，绝不覆盖用户改动 |

> **密码安全**：`.role('secret')` 在 DSH 页面遮蔽回显，进程内传入驱动连接参数，不落盘、不进日志、不进测试快照（AGENTS.md 红线）。P2 可按 ragflow 模式接 `@deepseek-ai/dsh-credentials` 做 credential-reference。

> **测试**：`tests/dsh-config.spec.ts`——schema 默认值可全程装配（Config → toRuntimeConfig → createAskdataService）、JSON 映射四形态解析（字符串/对象/空/坏值）、页面元数据断言（secret/textarea 角色、collapse 分组、description、timeZone pattern、readOnly 缺席）。

## 15. 评审修复记录（2026-09-09）

> 对照评审（参考 dsh-data-agent）发现 P1 代码三处真实库级缺陷 + 若干加固项，本轮全部修复；真实 DDL 以 StarRocks 实测为准（WT_TAG 样例 `HWNBYC174_1D_100620000015524`；WT_CUBE 列 `device/tagCode/cubeType/timestamp/granularity/value/avgValue/maxValue1/minValue1/sumValue/countValue`）。

| # | 缺陷 / 隐患 | 修复 | 落点 |
|---|---|---|---|
| 1 | resolve_tag tagName 拼接顺序颠倒（`deviceId_tagCode_粒度`），真实格式为 `tagCode_粒度_deviceId`（§14.3 规格 + WT_TAG 实测一致），每次调用必然 TAG_NOT_REGISTERED；旧测试把错误顺序固化 | 改为 `${tagCode}_${granularity}_${deviceId}`，测试金样同步 | `tools/resolve-tag.ts` |
| 2 | aggregate 优化路径（tagIndex IN 子查询版）分组列仍引用已删除的 `b.tagName` 别名 → device/tagcode 分组必出非法 SQL | device/tagcode 分组回退 LEFT JOIN 版模板（e2e 实证路径）；其余维度走 IN 子查询版 | `tools/aggregate.ts` |
| 3 | aggregateCubeSql 引用 WT_CUBE 上不存在的列（`tagIndex` 子查询、`quality` 位过滤），cube 路由整体不可用；且 STDDEV/VAR 违反 D3 也被路由 | 改为 tagCode(+device)+granularity 等值过滤（真实列），去掉 quality 过滤；STDDEV/VAR 不路由；新增 **cubeType 唯一性预检**（实测存在 1 个 tagCode 对 2 个 cubeType 的口径歧义，不唯一即回退 WT_DATA）；分组用表自带 device/tagCode 列 | `src/sql/templates.ts`、`tools/aggregate.ts` |
| 4 | SQL 字符串转义只双写引号不转反斜杠：regexp 串里 `\d` 会被 MySQL 转义规则吞成 `d`、尾部 `\` 吃掉闭合引号 | 统一 `escapeSqlString`（先反斜杠后引号 doubling），regexp/LIKE/精确匹配全走它 | `src/sql/templates.ts` |
| 5 | 白名单闸门存在调用点旁路（latest_value 存在性预检、扫描护栏估算直接执行） | 闸门下沉到服务执行器咽喉点统一收口；工具层闸门保留为纵深防御 | `src/index.ts` |
| 6 | P1 六工具未接线（service 只暴露 p0Tools、persona 只列五工具） | `createAskdataService` 暴露 11 工具；persona/ask-smoke 提示词同步 | `src/index.ts`、`preset/askdata/agent.cordis.yml` |
| 7 | timeZone 非 ±HH:MM 格式静默按 UTC 换算；纯日期输入被 Date.parse 按 UTC 解析使"全天"窗口平移数小时 | 加载期校验 ±HH:MM；纯日期按会话时区零点取墙钟 | `src/config.ts`、`src/sql/validate.ts` |
| 8 | mysqlConnection 默认值烙印内网 IP + root | 默认留空（P0 面不受影响，P1 工具调用期报明确 BACKEND_DOWN）；patch 文件标注 DEV-ONLY | `src/config.ts`、`src/dsh/plugin.ts`、`cordis.patch.yml` |
| 9 | CLI 通道 SQL 走 argv `-e`（进程列表可见、受命令行长度限制） | SQL 改经 stdin 送达（对齐 dsh-data-agent 通道约定） | `src/clients/starrocks.ts` |
| 10 | 工具内嵌第二套默认行数（违反"阈值全走 config"约定）；词法预处理先剥注释后剥字符串（串内 `--`/`#` 干扰闸门视角） | defaultLimit/defaultLookupLimit/defaultAlarmLimit 入配置；字符串先于注释剥离 | `src/config.ts`、`src/sql/whitelist.ts` |
| 11 | WT_TAG 字典过滤用 `regexp()` 全表扫（236 万行，负载下 6.7s~30s+），是 aggregate/time_series 每次调用的前置步骤 | 可解析前缀（`^tagCode_粒度_[device]`）改用等值（唯一索引，30ms）/ LIKE 前缀（86ms），regexp 仅作非保守形态兜底（`tagFilterPredicate`） | `src/sql/templates.ts` |

**遗留（转后续）**：
- `docs/spec/tools_v3.json` 未含 P1 六工具——规格副本须从 `D:\svn\WISETao_custom_demo\docs` 源目录同步（AGENTS.md 规矩，本仓库不手改 spec）。
- WT_CUBE `value` 列的口径（该粒度下测点汇总值）在离散率类 cubeType 上的 AVG/SUM 语义需与 AGP 采集侧核对；`aggregateTable: ''` 可一键关闭路由退回 WT_DATA。
- time_series 对 1H/1D/1M/1Y 粒度 tagName 在 WT_DATA 无数据（§14.10.1），趋势类问题应使用 1O tag + 聚合桶，persona 已提示。
- 审计哈希链落库（旁路账号）与 preset 升级机制（包自带预设自动更新）为 P2 项。
- §14.10.2 列的 WT_CUBE cubeType 1-20 映射是基于反编译推导，联调库尚未确认全部 20 类均有数据；当前实测仅 cubeType=7（华为逆变器电量值，HWNBYC174）一类走通 cube 路由。

## 16. P1 真实数据验收（2026-09-09）

> 与 §13 P0 真实库验收对齐：MySQL 5.7.38 @ 192.168.101.54:3306（root/Aa123456.，wisetao_meta + bole）；StarRocks 3.1.9 @ 192.168.101.54:9030（WT_DB）。执行 `MY_PASSWORD='Aa123456.' npx tsx scripts/e2e-p1.ts`，11 工具中 8 个 P1 相关调用 8/8 通过。

| # | 工具 | 用例（用户问题 / LLM 决策） | 实测 |
|---|---|---|---|
| 1 | `lookup_model` | "有哪些光伏设备模型" | 35 行 / 345ms；含 wt_iot_huaweisun2000、wt_iot_sungrowsg、wt_iot_padmounted 等 |
| 2 | `lookup_object` | "1号箱变1号逆变器"（模糊匹配） | 20 行 / 25ms；`class__path=wt_elm_equipment/wt_iot_huaweisun2000`，`id=100620000015521` |
| 3 | `lookup_tag_definition` | "华为逆变器有哪些测点" | 221 行 / 73ms；如 HWNBYC174=总发电量、HWNBYC004=组串电压高 |
| 4 | `resolve_tag` | "1号箱变1号逆变器 总发电量 1D" | 1 行 / 112ms；`tagName=HWNBYC174_1D_100620000015521`，`tagIndex=1961441`，`alias=总发电量日统计测点` |
| 5 | `latest_value` | 同上 tagName 兜底路 | 30s+ 超时（与 §13.5 遗留相符；今日集群负载高，09-07 实测单点 2s） |
| 6 | `aggregate`（cube 路由） | 13 天日均（2024-08-01~08-14） | `FROM WT_CUBE a` / 104ms；AVG=1665.5、12 样本（cubeType=7，唯一性预检通过） |
| 7 | `query_alarm` | "最近有什么告警"（2024-06-16~10-10） | 5 行 / 13ms；真实最新告警事件 `Ⅰ-#7B储能电池堆8号簇 单体温差过高一级报警 @ 2024-10-09 21:35:50` |
| 8a | `query_alarm_config` | "AGC 设备的告警配置" | 0 行 / 7ms（AGC 子类无独立配置属正常） |
| 8b | `query_alarm_config` | 无过滤全量 | 379 行 / 14ms；覆盖 6 类设备（储能 Bank/Rack/Pack/AGP、箱变、防孤岛等） |

**典型 SQL 样例**（来自 `e2e-p1.ts` 运行输出）：

```sql
-- resolve_tag step5
SELECT tagIndex FROM WT_TAG WHERE tagName = 'HWNBYC174_1D_100620000015521'

-- aggregate cube 路由
SELECT 'all' AS `bucket`, AVG(a.`value`) AS `aggValue`, COUNT(*) AS `sampleCount`
FROM WT_CUBE a
WHERE a.`timestamp` >= '2024-08-01 00:00:00' AND a.`timestamp` < '2024-08-14 00:00:00'
  AND a.`tagCode` = 'HWNBYC174' AND a.`device` = 100620000015521 AND a.`granularity` = 2
LIMIT 1000

-- query_alarm
SELECT id, alarm_title, alarm_time, alarm_level, alarm_status, entity_name, tag_code, description
FROM wisetao_meta.wt_bas_alarmrecord
WHERE deleted = 0 AND app_id = 10062
  AND alarm_time >= '2024-06-16 00:00:00' AND alarm_time < '2024-10-10 00:00:00'
ORDER BY alarm_time DESC LIMIT 5
```

**验收揭示的文档偏差**（已并入 §14.3 / §14.9）：
- `class_path` 真实形态是 `wt_elm_equipment/wt_iot_huaweisun2000`（以表名打头的多级路径），不是 §14.2 早期描述的 `wisetao.pv.inverter` 形式（上游规格愿景）。
- `meta_classtagmodel.name` 是规格中文名（如"总发电量"），必须严格相等匹配——LLM 在调用 resolve_tag 前应先用 lookup_tag_definition 确认精确中文名。
- `wt_elm_equipment.class__path` 当前存的是 `wt_elm_equipment` 表名字符串而非真实模型路径，与 `lookup_object` 的 LIKE 过滤兼容性尚可（设备行同样存此值）。

## 17. 与 DSH 扩展机制集成（skill / subagent）

> DSH 提供三类扩展机制来增强插件在 Agent 中使用：tool（每次自动注入）、skill（按需加载的手册）、subagent（独立工作流）。askdata 同时使用三种机制——模型常用基础工具、用户/复杂场景用 skill 查阅手册、整句自然语言用 deep_analysis 走子 agent 流水线。

### 17.1 工具层（已完成，P0 + P1 + subagent-style + 知识面 + 值班报告面共 18 个）

| 层 | 工具 | 说明 |
|---|---|---|
| P0 | `lookup_tag` / `estimate_count` / `latest_value` / `time_series` / `aggregate` | 基础取数链 |
| P1 | `lookup_model` / `lookup_object` / `lookup_tag_definition` / `resolve_tag` / `query_alarm` / `query_alarm_config` | 元数据/告警 |
| **subagent-style** | **`askdata_deep_analysis`** | **自然语言问数入口：内部按关键词自动编排 lookup → resolve → 取数流水线并返回带溯源的合成结果** |
| P2 知识面 | `knowledge_graph` / `knowledge_search` / `knowledge_wiki_page` / `knowledge_mindmap` | RAGFlow 知识库：实体关系子图 / 原文取证（元数据过滤+标签回显）/ 百科页面 / 脑图层级（§18） |
| 值班报告面 | `list_duty_stations` / `generate_duty_report` | 防汛值班报告：台账投影 / AGP API 取数+规则研判+8 段 HTML 落盘（§19） |

`askdata_deep_analysis`（`tools/deep-analysis.ts`）是 DSH subagent one-shot 委派的 in-process 等价物：它把"自主完成多步任务 + 给出完整结论"的子 agent 行为封装在一个工具调用里，避免调用方自己编排 N 次工具。本插件不依赖宿主 `@deepseek-ai/dsh-agents` runtime，故采用工具内 pipeline 实现。关键词分支：

| 关键词 | 走哪条路径 |
|---|---|
| "最新/当前/现在" | lookup_object → resolve_tag → latest_value |
| "趋势/波形/曲线/时序/小时/分钟" | lookup_object → resolve_tag → time_series（默认 1h 桶） |
| "日均/月均/累计/总[量发]/平均值/均值/avg" | lookup_object → resolve_tag → aggregate（默认 AVG） |
| "告警/报警/故障/异常" | query_alarm（默认 7 天窗） |
| "告警配置/规则" | query_alarm_config |
| "有哪些模型/型号/类型" | lookup_model |
| 默认 | lookup_tag（按关键字反查字典） |

设备解析链：问句正则提取的设备片段先经 `lookup_object` 模糊命中，后续 `resolve_tag` 使用**精确命中的 node_name**（而非问句原始片段），避免模糊片段残缺导致 tagName 解析链断裂。

测试：`tests/deep-analysis.spec.ts` 9 个用例覆盖 5 类分支 + 设备精确名传递 + 失败兜底。

### 17.2 Skill 层（已完成，5 个聚合手册）

`src/dsh/skills.ts` 通过 cordis 单独行 `dsh-agp-askdata/skills` 注入到 `ctx.skills`，5 个 skill 覆盖五类正交主题：

| Skill 名 | 一行描述 | 何时调用 |
|---|---|---|
| `askdata-troubleshoot` | 问数链路出问题时的标准化排查（连接 / 凭据 / 白名单 / 超时 / 路由） | 错误码排查、性能调优、部署环境事实 |
| `askdata-tagname` | tagName 四段式编码、粒度段、tagCode/tagIndex 解析规则 | 解释 tagName 全名、累计量 vs 瞬时量粒度选择、cubeType 一一对应 |
| `askdata-query-pattern` | 典型问数工作流：从自然语言到工具调用的标准 5 步模板 | 新查询不知先调哪个工具、串成可复用流水线 |
| `askdata-config` | 运行时配置（密码、连接、超时、cube 路由、REST 通道）的修改与生效路径 | 改数据库密码、切换 cube/原始表、启用 TSDB 网关、加白名单 |
| `askdata-duty-report` | 防汛值班报告工作流（台账→AGP API→研判→8 段 HTML） | 用户要"值班报告/防汛报告"、generate_duty_report 传参、报告缺口解释（§19） |

调用策略 `modelInvocable=true` + `userInvocable=true`：模型可调用（自动加载）+ 用户可调用（`/skill` 显式手势）双入口。

**真实 DSH web 环境实测缺口**：`@deepseek-ai/dsh-tool-skill`（消费方，把 skill 渲染到目录消息与工具面板）当前未挂载到 web profile。代码路径完全正确（164 测试覆盖、cordis 注入 OK），目录消息渲染需宿主提供 `dsh-tool-skill`。若生产部署需此功能，在 web profile 的 `package.json` 添加 `@deepseek-ai/dsh-tool-skill` 后重启即可生效。

测试：`tests/skills.spec.ts` 9 个用例覆盖：常量校验（name/description/4 个主题/whenToUse）、cordis 行形态（name/inject）、`apply` 行为（注册 4 个 + 双 invocation + disposer）、宿主缺席优雅跳过。

### 17.3 Subagent 层（占位）

`@deepseek-ai/dsh-subagent` 提供 one-shot 委派接口（`SubagentProvider.start(request)` 返回 `SubagentRun`）。本插件未注册自己的 provider——`askdata_deep_analysis` 已经覆盖了"自然语言问数入口"的语义需求，实现成本远低于一个完整 subagent runtime（无需 host agent 上下文 + turn 循环 + model 调用 + tool registry 投影）。

若未来需要**长期驻留的子智能体**（continuable child，支持 followup/interrupt/reportFrom），按以下路径扩展：

1. 在 `src/dsh/subagent.ts` 实现 `SubagentProvider` 接口（`name: 'askdata-explorer'`，`capabilities: { outputSchema, depthLimit, toolFilter, persona: true }`）。
2. 在 cordis 行 `dsh-agp-askdata/subagent` 注册（`inject: ['subagents', 'askdata']`），用 `ctx.subagents.registerProvider(...)`。
3. persona 通过 `request.persona` 字段注入（如 askdata-explorer persona = "我是光伏数据探索子 agent..."），与顶层 AGP问数 persona 区分。

### 17.4 用户使用路径速查

| 用户场景 | 推荐入口 |
|---|---|
| 单步精确查询（已知 tagName） | 基础 11 工具（让 LLM 编排） |
| 一句话问数、不想参与流程 | **`askdata_deep_analysis`** 工具 |
| 用户想深入了解某工具用法或某错误码处理 | `/skill askdata-troubleshoot` 显式加载 |
| 模型自身需要时（自动） | skill 目录消息自动注入 |
| 上线后频繁跨多个设备的批量问数 | **P2 subagent**（continuable）|


## 18. RAGFlow 知识面（P2，2026-09-22：graph + wiki 融合）

> 来源：`E:\git\ragflow-import` 项目（桃曲坡水库知识库 RAGFlow 导入工具链）的 graph 与 wiki 能力分析。
> 结论：两能力的服务端同构 API 已在线上实例开放（v0.27.x 实证），融合 = 在 askdata 内新增
> RAGFlow 知识面（3 工具），与取数面互补，不触碰 SQL 取数链路与只读红线。

### 18.1 ragflow-import 的 graph / wiki 功能分析（本地构建侧）

| 能力 | 核心模块 | 产物 | 服务端同构面 |
|---|---|---|---|
| graph（经典 GraphRAG light） | `src/graphrag_port/`（extractor / light_extractor / graph_prompt / llm_adapter）+ `build_graph_local.py` | `knowledge_graph_<ds>.json`（`{graph:{nodes:[{id,entity_type,description}],edges:[{source,target,weight,description,keywords,source_id}]},mind_map}`）+ vis-network HTML | `GET /datasets/{id}/artifacts/graph`、`GET /datasets/{id}/artifacts/structure?kind=graph` |
| wiki（百科页面 + 互链） | `src/wiki_port/`（scenario_config / page_synthesizer / crosslinker）+ `build_wiki_local.py` | `wiki_<场景>.json`（entities/relations/pages/link_graph/reverse_index）+ 双 Tab HTML 查看器；三场景：regulation（法规页+事项→条款反查）/ topology（河网拓扑 canvas）/ case（洪水案例页+时间线） | `GET /datasets/{id}/artifacts`（清单）、`GET /datasets/{id}/artifacts/{page_type}/{slug}`（页面全文） |

本地构建链（拉 chunks → LLM 抽取 → 合并消歧 → 页面合成 → 互链）与 ragflow-import 的
`DomainKnowledgeDict` 别名归一，是服务端 wiki/graph 编译管线的同源能力；服务端已编译的
产物优先直接消费（零 LLM 成本），本地工具链留作离线重建手段。

### 18.2 融合设计（为什么这样融）

问数的两个数据源各答一半问题：**TSDB 回答"数值是多少"，RAGFlow 知识库回答"依据是什么"**
（规程条款、防洪标准、洪水过程、工程参数口径）。融合点三处：

1. **知识面工具（新增 3 个，tools/knowledge-*.ts）**——不过 SQL 闸门（载体是 HTTP 只读检索），
   但同样过 `runKnowledgeTool` 管线（ok/fail + 审计落行，`sqlText`/`apiUrl` 记 API URL）：
   - `knowledge_search`：`POST /datasets/search` 原文片段取证（契约与 dsh-plugins/lingzhi-knowledge-tool 的 searchDatasets 一致：HTTP 200 + code≠0 = 业务失败；命中正文字段 content_with_weight）；
   - `knowledge_graph`：`GET /datasets/{id}/artifacts/graph` 实体关系子图（node 中心扩展一跳 / keywords 概览；多数据集合并 + 悬空边过滤）；
   - `knowledge_wiki_page`：`GET /datasets/{id}/artifacts` 清单 + `/{page_type}/{slug}` 页面全文（content_md_rendered + outlinks + related_kb_pages）。
2. **resolve_tag 别名归一化（tools/resolve-tag.ts）**——设备名未命中 `wt_elm_equipment` 时，
   查 `knowledge_graph` 拿标准实体名与别名重试一次（服务端同构的 DomainKnowledgeDict）；
   知识面不可用/超时静默降级，不影响原 OBJECT_NOT_FOUND 错误语义。
3. **askdata_deep_analysis 知识分支（tools/deep-analysis.ts）**——classify 增加
   `knowledgeOnly`（纯知识问题只取证不取数）/ `knowledgeFirst`（取数问题先取证再取数）；
   知识面未装配时分支整体关闭，问句按原取数面规则分类（融合是增强不是依赖）。

红线符合性：知识面全部是 GET/POST 检索类调用（无写）；API Key 只进 Authorization 头
（Config `.role('secret')` + 环境变量 RAGFLOW_API_KEY 回退，不落盘不进日志）；
核心零 npm 运行时依赖（Node 22 内置 fetch + AbortSignal.any）。

### 18.3 配置（knowledge 段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `ragflowBaseUrl` | `https://labragf.openagp.top:9080` | 实例基址（不含 /api/v1，客户端拼接） |
| `ragflowApiKey` | 空 → 环境变量 `RAGFLOW_API_KEY` | Bearer 凭据，进程内使用 |
| `datasetIds` | 空（知识工具调用期明确报错，取数面不受影响） | 检索目标数据集；加载期校验 id 形态（禁特殊字符，防 URL 路径注入） |
| `timeoutMs` | 20000 | 单次知识调用超时（与调用方 signal 合并中断） |
| `maxChunks` / `maxGraphEntities` | 8 / 60 | 返回量预算（后者服务端上限 1024） |

### 18.4 验证记录（2026-09-22）

- 线上 API 契约实证：`/datasets`（20 库）、`/artifacts`（规程与预案 436 页，洪水资料 0 页）、
  `/artifacts/graph`（node 模式实体+关系；概览模式 top_n 生效）、`/artifacts/structure?kind=graph`、
  `/artifacts/{pt}/{slug}`（content_md_rendered / outlinks / source_chunk_ids 投影）。
- 测试：`tests/ragflow-client.spec.ts`（18 例：code≠0、投影、多数据集合并、悬空边过滤、
  取消/超时、slug 工具函数）+ `tests/knowledge-tools.spec.ts`（11 例：三工具行为 +
  deep_analysis 知识融合 + 未装配降级）；`tests/dsh-config.spec.ts` 补知识面装配/校验用例。
  全套 208 例通过，`tsc --noEmit` 0 错误。
- E2E：dsh web（DSH_HOME=E:\dsh\home-e2e，3080 端口 token 鉴权）三链路——
  知识取证（问汛限水位依据 → knowledge_search 命中规程片段）、取数（库容/电流）、
  图谱（实体关联）；详见 docs/RAGFLOW-REBUILD-20260922.md 的 E2E 章节。

### 18.5 检索增强与缺陷修复（2026-09-22 追加）

对 RAGFlow 全功能面（检索参数 / 编译工件 / chunk 层 / 导航）做过一轮盘点后落地三项增强，
并修复首轮融合的两个实证缺陷：

**缺陷修复（线上响应契约对拍发现）**：

1. 出处字段丢失——线上 `/datasets/search` 响应用 `doc_id` / `docnm_kwd`（实测
   `docnm_kwd: '03-汛期调度运用计划.pdf'`），首轮客户端读 `document_id` /
   `document_keyword`（lingzhi 旧契约），导致 documentId/documentName 恒空、引用溯源断。
   现双契约都认（`doc_id || document_id`，`docnm_kwd || document_keyword || document_name`）。
2. top_k 未客户端封顶——`top_k` 只是 kNN 候选池，返回条数由服务端 page_size（默认 30）
   控制，请求 topK=2 实收 30 条，`knowledge.maxChunks` 预算失效。现返回前按 topK 截断。

**P0-1 mindmap 脑图融合**：`knowledge_mindmap` 工具 + 客户端 `mindmap()` 森林构建。
数据源 `GET /datasets/{id}/artifacts/structure?kind=mindmap`；relations 的谓词回退 `type`
字段（has_branch / has_sub_branch 父子边）；central_topic 为根、无父节点兜底、环/悬空边
安全跳过、节点数受 `knowledge.maxGraphEntities` 封顶。规程与预案库已编译 44 节点
（应急响应分级、险情种类与危害、物资保障等分支），零服务端投入。与 knowledge_graph
（关系网络）互补：脑图答"分层结构"，图谱答"关联网络"。

**P0-2 元数据硬过滤**：`knowledge_search` 增 `meta_filter` 参数（裸数组或
`{conditions, logic}` 形态，客户端归一为 RAGFlow `meta_data_filter` 全量契约；
条件逐条净化，非法条件整体忽略不过滤）。洪水资料库已挂 `flood_event`（2021-09/2021-10）、
`doc_type`（文本/表格）、`quality` 等元数据——"2021 年 9 月那场洪水的降雨量"按场次
过滤后取证不再被其它场次片段稀释。

**P0-3 标签分布回显**：`/datasets/search` 响应顶层 `labels`（标签库软重排命中计数，
实测 `{"2021-09":2,"洪水资料":1}`）此前被丢弃；现投影为 `KnowledgeLabels` 并在工具
输出渲染 rank=0 汇总行，模型引用时可带"该片段属于哪场洪水/哪类资料"的分类标注。

**工具面**：15 → 16（新增 knowledge_mindmap）。测试 225 例通过（新增 17 例：出处双契约、
top_k 封顶、labels、meta_filter 归一/非法条件、mindmap 森林/环安全/预算/keywords）。
线上直连冒烟（scripts/live-smoke-knowledge.ts + 探针）：出处 `03-汛期调度运用计划.pdf`
（doc_id 同步带出）、topK=5 实收 5 条、mindmap 44 节点单树（9 个一级分支）、
meta_filter 场次限定生效。dsh web E2E 10/11（六条功能链路全过；唯一未过项为 genui
对模型某轮 dsh-ui 围栏的解析警告，客户端容错行为，与知识工具无关），
详见 docs/RAGFLOW-REBUILD-20260922.md。

## 19. 防汛值班报告面（2026-09-23）

> 来源：《防汛值班报告 Agent 规划清单-20260910》（TNAGT 灵知AI 平台规划）在本仓库的
> 落地——按本插件"工具内 pipeline + 单 Agent"模式实现规划清单的场景 A（轻量单
> Agent 快速上线）；规划中的多 Agent 协同（S6 编排 Skill + 5 子体）属 TNAGT 平台侧
> 能力，本仓库以 `generate_duty_report` 单工具编排等价覆盖其数据流（采集→研判→
> 引用→渲染→校验→交付），与 deep-analysis 的 subagent-style 先例（§17.1）同构。

### 19.1 能力与边界

| 项 | 内容 |
|---|---|
| 工具 | `list_duty_stations`（台账投影，澄清槽位）+ `generate_duty_report`（编排入口），工具面 16 → **18** |
| 数据源 | **AGP API 实时值（不走 SQL）**：POST `{rest.baseUrl}/tag/realtime` 主路（MetaTagValueController 官方形态）→ 失败回落 GET `/iotRealTimeValue`；鉴权三头 WT-APPID/WT-OPENID/WT-TOKEN，openid/token 留空回退环境变量 `AGP_API_OPENID`/`AGP_API_TOKEN` |
| 规则研判 | 阈值判超引擎（`src/duty/rules.ts`）：duty.stations 配置的阈值档 → 命中/等级/建议全由确定性代码产生，**LLM 不自算等级**；等级映射固定（保证/校核→红、警戒→橙、汛限→黄、其余→蓝） |
| 规程引用 | citations 入参（LLM 先 knowledge_search 取证）优先；缺省工具内自动检索一次（top3）；失败/未装配记缺口不阻断 |
| 产物 | 8 段单文件 HTML（报告头/测站汇总/阈值对照/预警研判/建议/规程依据/通知报讯/缺口交接）：内联 CSS、零外链（离线可开/打印/归档）、内嵌 `<script id="duty-fact-pack">` 机器可读事实包；落盘 `duty.outputDir`（缺省 `$DSH_HOME/outputs`） |
| 事实包 | `src/duty/fact-pack.ts`：hard（telemetry/thresholds/ruleHits/constraints/advice/citations/reporting）参与 pack_hash（SHA-256 前 16 hex，键排序 canonical JSON）；soft（claims）与 shell（标题/编制时间/交接 notes）不参与——对话摘要、HTML 页脚、内嵌包三者同源 |
| 出闸校验 | `validateDutyReportHtml`：8 段齐全、页脚/内嵌包 hash 一致、advice 全量（禁压缩）、**无操作令**（开闸/关闸/启泵等命令式措辞，禁则声明块与内嵌 JSON 豁免）→ 失败抛新错误码 `REPORT_INVALID` |
| 缺测语义 | AGP API 失败/测点无值 → abstentions[]（`DATA_MISSING`/`KNOWLEDGE_UNAVAILABLE` + 规范错误码），报告照常产出且第 8 段列明，**缺测不编造、不邻站填空、不回落 SQL** |
| 红线符合性 | 只读红线约束 SQL 写语句；报告 HTML 文件是工具交付物本身（规划清单明确"写入沙盒文件"），只写 duty.outputDir 解析目录，不触碰数据库 |

### 19.2 配置（duty 段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `duty.project` | 空 | 工程/河段名（报告头） |
| `duty.outputDir` | 空 | 产物目录；空 = `$DSH_HOME/outputs` 再退 `./outputs` |
| `duty.stations[]` | 空（面不可用，调用期明确提示） | 测站台账：id/name/metrics[]；metric = {metric 键, label, unit, **tagName（AGP 测点全名）**, decimals, thresholds[]}；threshold = {level, value, op?（缺省 >=）}，无 thresholds = 只汇总不研判 |
| `duty.reporting[]` | 空 | 报讯路径（第 7 段）：{object, channel?, frequency?}，配置化不由 LLM 生成 |

台账/阈值是工程专属部署事实，不内嵌默认值；演示台账（桃曲坡 3 站）在 `cordis.patch.yml`
（DEV-ONLY 标注）。DSH 配置页同步渲染 duty 分组（`src/dsh/plugin.ts`）。

### 19.3 工具入参速查（generate_duty_report）

`shift_start`/`shift_end`（必填，ISO8601 或 YYYY-MM-DD，过 validateTimeRange 护栏）、
`shift_name`（缺省按 8-20 点推断白/夜班）、`station_ids`（台账子集）、`title`、`notes`
（交接事项，shell 层）、`citations[]`（{document, snippet, page?, chunk_id?}）、`kb_query`。

### 19.4 测试与验证记录（2026-09-23）

- 单测 225 → **262 例全绿**（新增 37：规则研判/等级映射/多档取最高/缺测语义/低于型阈值、
  pack_hash 确定性与 hard/soft 分层、渲染 8 段/转义/内嵌包还原/出闸校验三反面、
  工具行为（mock fetch：POST 主路/GET 回落/全缺口渲染/citations 优先/环境变量凭据回退/
  台账与时段校验）、duty 配置装配与非法台账报错）；`tsc --noEmit` 0 错误。
- 工具级 E2E（`scripts/e2e-duty-report.ts` + `scripts/mock-agp-api.mjs`，mock 网关 8410）：
  **14/14 通过**——台账投影、AGP API 取数（executor 零调用）、超警戒命中、8 段落盘、
  离线单文件、内嵌包重渲染幂等。
- **Playwright DSH web 端到端 15/15 通过**（`E:\git\deepseek-harness\apps\web\tests\e2e-duty-report.mjs`，
  web 3080 + `--patch duty-e2e.patch.yml` 把 AGP API 指向 mock）：对话发起 →
  模型四步流程（list_duty_stations → knowledge_search 取证 → generate_duty_report →
  出闸校验说明）→ 产物落盘 `$DSH_HOME/outputs` → 对话 pack_hash 与 HTML 页脚一致 →
  file:// 离线打开渲染（截图 `E:\dsh\home-e2e\shots\duty-*.png`）。规程引用命中真实
  RAGFlow 规程库（《03-汛期调度运用计划.pdf》主汛期限制水位 786.80m 原文）。
- 环境事实：E2E profile 中 `@changfenhuang/dsh-genui` 包损坏（lib/ 仅剩 assets、
  cordis.patch.yml 缺失，manifest 声明强制 → 启动失败），已从 home-e2e web profile 的
  bundles 摘除（值班报告链路不依赖 dsh-ui）；`dsh web` 子命令不接受 `--patch`，须用
  `dsh --profile web --patch <file>` 启动器形态。

## 20. 关系图谱（模型关系链，2026-09-23）

> 来源：《基础的数据底座查询接口 20260913》§2.9（getRelationsByModel）。在 AGP 问数助手里
> 以工具 + skill（关系图谱）形态落地；树形图用 dsh-genui 的 `type:'echart'` 围栏渲染
> （ECharts tree，option 直通）。

### 20.1 接口与实现（线上实证，与 PDF 文档的差异）

| 项 | PDF 文档 | 线上实证（openagp.top 10462 项目） |
|---|---|---|
| 路径 | `/s1M6_uE9/wz/meta/getRelationsByModel` | 同左（前端在 `/v7i0_wG9/`，后端 API 段是 config.js 的 `backSuffix=/s1M6_uE9` + `serviceWz=/s1M6_uE9/wz`） |
| modelName | "模型名称"（中文） | **实际匹配 class_path**（如 `wt_elm_equipment/wt_10462_shuibengmoxing`）——中文名必须先经 `POST /meta/model/queryByGenericSql`（查 meta_class_info.class_alias）解析 |
| 编码 | — | Content-Type 声称 UTF-8 实际发 GBK 字节——工具按 UTF-8 严格解码失败回退 GBK |
| 信封 | code 数字 / message | getRelationsByModel 同 PDF；queryByGenericSql 返回 code:"0" 字符串 + msg 字段——两种形态都收 |
| 数据 | — | 关系行含 relation_description（关系中文名）、leftModelName/rightModelName（对端模型中文名），可直接组树 |

工具实现：`tools/model-relation-graph.ts`（两步：中文名→class_path→关系链；入参含 "/" 时视为
class_path 直传）。渲染指引作为数据末行返回，模型按 `askdata-relation-graph` skill 的
echart tree 模板输出 ```dsh-ui 围栏。工具面 18 → **19**；skill 5 → **6**。

### 20.2 模型字段构成（model_field_list，2026-09-24）

> 来源：同 PDF §2.3（getModelBasAttributes）。背景实证：只有关系图谱工具时，模型对
> "设备参数列模型的字段构成"这类下钻问题只能去 RAGFlow 撞运气并如实报告查不到
> （知识库是业务规程文档，没有建模字典）——需要专门的字段查询工具。

| 项 | 线上实证（openagp.top 10462 项目，2026-09-24 实测） |
|---|---|
| 路径 | `GET /s1M6_uE9/wz/meta/getModelBasAttributes?modelName=<中文模型名>` |
| modelName | **直接收中文模型名**（如 设备参数列模型、水泵模型）——与 §2.9 的 class_path 行为不同 |
| 信封 | 同构：`data.field`=列定义，`data.data`=属性行（field_name/field_description/field_type） |
| 语义 | 屏蔽"不显示"属性、含计算属性、继承重载取后者（PDF §2.3）；field_type 为类型码 |

工具实现：`tools/model-field-list.ts`（主路中文名直查；报「模型不存在」类错误时回落
queryByGenericSql 解析 class_path 重试一次，复用 §20.1 的两步辅助）。查关系链与查
字段构成在两个工具的 description 里互设交叉引用，模型路由不迷路。

### 20.3 凭证与地址（记忆位）

- 网关：`https://www.openagp.top:9080`（项目 10462；前端前缀 `/v7i0_wG9`，后端 `/s1M6_uE9`）
- 凭据：`E:\dsh\home\.credentials.yaml` 的 `AGP10462_API_TOKEN / AGP10462_API_OPENID`（机器本地，不入 git）
- home-e2e overlay（`E:\dsh\home-e2e\duty-e2e.patch.yml`）的 query.rest 已指向该网关真实凭证

### 20.4 meta 数据查询族（恢复自事故丢失的 tools-api 面，2026-09-24）

**考古结论**（pickaxe 全历史实证，2026-09-24）：本插件曾在 §18.x 时期（09-10/09-11，
提交 118108f..3f27672）实现过 PDF §2 接口族的完整工具面 `tools-api/`（14 文件：
list-models / model-attributes / query-model / query-model-segment /
query-relation-segment / model-tags / object-tags / resolve-tag / tag-real /
tag-history / tag-wide / tag-aggregate + src/api/client.ts + tests/tools-api.spec.ts，
§18.6 API-only 收口 + §18.7 真实浏览器 E2E 通过）。09-22 文件丢失事故中该目录从
工作区消失（无删除提交），事故后重建（104c1f3/2a363fb，parent=3b75110）基于的树里
已无此目录——主线的现行 `tools/` 面是并行演化的另一实现（测点/时序/聚合已覆盖），
meta 数据查询族自此断档。

**2026-09-24 恢复**（现行契约重写，语义自 3f27672 移植 + 当日真实网关复测）：

| 工具 | PDF 接口 | 说明 |
|---|---|---|
| `model_field_list` | §2.3 getModelBasAttributes | 模型字段构成（中文名直查；"模型不存在"回落 class_path） |
| `relation_field_list` | §2.6 getRelationBasAttributes | 关系字段构成（返回列含所属模型 model_name） |
| `query_model` | §2.2 postModelDataMeta | 模型业务数据行（参数全传语义；**search_str 禁止 `*`**——服务端展开含物理表不存在的列报 Unknown column，2026-09-24 实测） |
| `query_model_segment` | §2.7 postModelAggrigateData | 模型分段聚合统计（segment: [{where_str,title}]） |
| `query_relation_segment` | §2.8 postRelationAggrigateData | 关系分段聚合（relationName + 可选左右继承模型） |

共享件 `tools/meta-common.ts`：动态 fields（响应 field 数组 → ResultField）、
类型码映射（1/11/22→number，52→datetime）、分页透传（page）、pageSize 上限
`query.rest.maxPageSize`（默认 1000，AGP 要求 <1000）、parseSegments、agpPost。
推荐调用链：关系链（model_relation_graph）→ 字段构成（*_field_list）→
数据/聚合（query_*）。类型码全集与信封差异同 §18.4/§18.5 记录。
未恢复：list-models/model-tags/object-tags（现行 lookup_model/lookup-tag 面已覆盖）、
§2.4/§2.5 关系数据明文查询（旧面亦未实现，需求出现再加）。

#### 20.4.1 预览与完整性契约（分场景设计，2026-09-24）

背景实证：设备参数列模型有 51 条关系，全局 20 行预览截断后模型只拿到 20 条——
有界清单的截断不是省 token，是**让模型给出自信的错答案**。设计原则：分页是人的
交互概念；Agent 工具第一原则是**单次自完备 + 显式总量**，翻页只留给真正无界的数据
（一整轮 LLM 调用的成本远高于多给几十行短字段）。

| 场景 | 工具 | 设计 |
|---|---|---|
| 有界元数据清单 | model_relation_graph / model_field_list / relation_field_list | `previewLimit: 300`（安全上限，超限 complete=false）；模型面全量返回；关系行带 `direct` 标记（查询模型是端点=直接关系，API 会返回经链路展开的间接关系）；关系数 >40 时渲染指引切换为"直接展开 + 间接按对端模型聚合计数" |
| 无界业务数据 | query_model | 保留分页；`page.itemTotal` 顶层透出为 `total`，单页即全量时 `complete=true`；description 教"total 超一页先收窄 where_str 或改用 query_model_segment，不要逐页翻" |
| 聚合统计 | query_model_segment / query_relation_segment | 输出天然小，同样透出 total/complete |

机制：`ToolResult.total/complete`（模型可见的完整性契约，adapter 顶层透出）+
`AskdataTool.previewLimit`（工具自声明的模型/前端预览上限，缺省仍 20——SQL 行
查询面不受影响）。反面清单：不给元数据工具暴露分页参数（诱导翻页循环）；不为
"完整性"把几千宽行灌进上下文（那才是 token 预算敏感区）。

#### 20.4.2 点击下钻交互（默认关，chartDrillInteraction，2026-09-24）

点击节点 → `[genui-action]` → 模型回 `drillPatch` 增量并入原图（协议见
dsh-genui actionTemplate/drill 字段）。每次下钻是一整轮 LLM 调用（数十秒 +
token），且单击语义与浏览冲突、误触成本高——**默认关闭**
（`query.chartDrillInteraction: false`，settings 页"查询路由"组）。

- 关（默认）：首图模板不带 drill/actionTemplate，图照常渲染（配色/roam/保存图片），
  点击无任何副作用；dsh-genui 的下钻机制保留但字段不出现即完全惰性。
- 开（`chartDrillInteraction: true`）：模板携带 drill.key/actionTemplate +
  patch 响应协议（幂等检查 → 只发新增子树 → 并入首图），客户端乐观占位 +
  单飞串行队列（chips 可取消）生效。
- 语义隔离：开启时模板显式 `expandAndCollapse:false`（单击=下钻，不再兼职
  收起）；关闭时 echarts 默认 true（单击收起/展开照常可用）。

## 21. 工具组开关与双 preset（部署形态隔离，2026-09-23）

**背景**：云端网关（openagp.top 10462 项目）与内网 SQL 库（StarRocks/MySQL 10062 光伏）
是两个不连通的数据世界。全量工具面在云端部署时，persona 静态提及的 SQL 工具名会诱发
模型工具名幻觉（实测：模型自述"我只有光伏域的 lookup_model/lookup_object…"并编造
list_models/object_tags 等不存在的工具）。

**机制**：`toolsets` 三布尔配置（settings 页"工具组开关"组）：

| 开关 | 工具组 | 缺省 |
|---|---|---|
| `toolsets.sql` | P0 五 + P1 六 + askdata_deep_analysis（内网 SQL 取数面） | true |
| `toolsets.api` | generate_duty_report / list_duty_stations / model_relation_graph / model_field_list / relation_field_list / query_model / query_model_segment / query_relation_segment（AGP REST） | true |
| `toolsets.knowledge` | RAGFlow 知识面四工具 | true |

默认全开 = 现状 24 工具；**云端 API 部署：`toolsets:{sql:false}` + `presetId:'askdata-api'`**
→ 工具面 12 个（API 八 + 知识四），persona 为纯 API 版（preset/askdata-api，不提及任何
SQL 工具名）。插件启动时双 preset 都安装（installPreset 幂等），部署按 presetId 选用；
home-e2e 的 settings.yaml `agent-presets.default` 也需同步指定。

**实测**（Playwright，云端网关）：新会话 preset 显示"AGP问数（API）"，问"查看水泵模型的
关系图谱"→ 2 次工具调用（中文名解析 + 关系链）→ 回复零 SQL 工具名 → echart 树形图
完整渲染（11 条关系）。19 秒 / 19.5K tok。
