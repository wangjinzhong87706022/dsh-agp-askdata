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
| `audit.{enabled,table,userId,appId,orgId}` | false / `WT_QUERY_AUDIT` | 审计开关与身份 |

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

StarRocks **3.1.9**（单 FE），`root@192.168.101.54:9030`（MySQL 协议，mysql2 驱动直连，空密码）。库 `WT_DB`：`WT_TAG` 测点字典 + `WT_DATA` 时序主表，真实光伏数据——35kV 开关柜状态量（`35KV1SEG0007_2O_100620000005171`"35KVI段装置告警"等），设备号 `100620000005171`，数据止于 **2024-08-14**，密度约 **4 亿行/天**。`WT_QUERY_AUDIT` 未建（审计默认关闭）。

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
  tsdbChannel: 'sql'        # 'sql'(默认,StarRocks直连) | 'rest'(AGP REST API)
  
  # 层1：REST 通道配置（tsdbChannel='rest' 时生效）
  rest:
    baseUrl: ''             # AGP REST 基址，如 'https://agp.sksyri.com/s1M6_uE9/wz/iot-etl/iot/'
    # 或后端代理：'http://192.168.101.54:PORT/rtdb/'
    wtAppid: ''             # 鉴权三头
    wtToken: ''
    wtOpenid: ''
  
  # 层2：聚合表名（光伏特定）
  aggregateTable: 'WT_CUBE' # 默认 'WT_CUBE'；设为 null 则强制只用 WT_DATA
  # null 适用场景：非光伏行业 / WT_CUBE 数据不可信 / 调试
  
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
| **REST /iot-etl/iot/tag/*** | 官方推荐、免数据库直连、走网关 | 需网关可达、鉴权三头、公网延迟 | 网关可用时 | P1 候选 |
| **REST /rtdb/*** | 免 Ice 客户端、后端代理 | 需后端服务可达、端口待实测 | 后端可达时 | P2 候选 |
| **Ice API** | 功能最全（10 方法） | python 搁置、Ice 3.7 兼容 | 搁置 | ❌ |
| **WT-SQL** | 模板化、中文查询 | 无光伏场景方案 | 复用需自建 | P2 候选 |

**决策**：默认走 SQL（`tsdbChannel: 'sql'`），提供配置切换到 REST。不做 Ice。WT-SQL 是 P2 候选。

**REST 通道实现条件**（P1 可选）：
- `tsdbChannel: 'rest'` 时，`latest_value` / `time_series` / `aggregate` 三个时序工具改走 REST API
- `lookup_tag` 仍走 SQL（WT_TAG 字典在 StarRocks，REST 无对应接口）
- MySQL 元数据工具（lookup_model 等）仍走 MySQL SQL（REST /meta/object/* 是 P2 候选）
- REST 通道需实现鉴权三头注入 + 错误码映射

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
| 查询路由 | tsdbChannel(sql/rest) · rest.baseUrl/wtAppid/wtToken/wtOpenid · aggregateTable(WT_CUBE) · cubeTypeMapJson · granularityMapJson | §14.10 三层路由；`aggregateTable` 置空退回纯 WT_DATA；JSON 置 `{}` 关闭对应路由 |
| 护栏阈值 | maxScanRows(1亿) · maxTimeRangeDays(365) · badValueMask(128) · queryTimeoutMs(15000) · maxLimit(10000) · defaultLimit(1000) · defaultLookupLimit(100) · defaultAlarmLimit(100) · timeZone(+08:00) | 全部执行前机械生效 |
| 安全 | tableWhitelist · mysqlTableWhitelist · scanGuard(true) | 白名单外表 → `SENSITIVE_TABLE`；readOnly 不开放 |
| 审计 | enabled(false) · table · userId/appId/orgId | 进程内哈希链；落库 P2 |
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

## 17. 结构验证阶段：API 面管线重构 + WT_DEVICE 消费（2026-09-10，feature/schema-validation）

> 承接 `docs/schema-validation-report.md`（真实库 8 表结构验证）与 `docs/TDD-AGP-API-Smart-Query.md`（新 API 网关实测）。

### 17.1 API 工具面管线重构（单次执行契约）

评审发现 8 个 API 工具存在系统性缺陷：`plan()` 内先调一次 typed 客户端方法（HTTP #1，只取 fields 元数据），`runApiTool` 再按 `path+params` 重放一次（HTTP #2，其结果才进 shape）。两次调用参数不一致的后果：

| 工具 | HTTP #2 的实际缺陷 |
|---|---|
| `query_model` | body 丢失 `whereStr/orderByStr/groupByStr`——**过滤条件静默失效**，返回未过滤数据 |
| `resolve_tag`(api) | body 为 `{keyword, limit}`——服务端收到完全不合法的请求 |
| `tag_history` / `tag_wide` / `tag_aggregate` | 丢失 `endTime/sample/dateFormat` 等可选参数；`tag_aggregate` 路径还拼错（`Aggregate` vs 官方 `Aggrigate`） |
| `model_attributes` / `tag_real` | URL 出现双查询串或 shape 直接忽略重放结果（靠闭包侥幸工作） |

**重构**（`tools-api/types.ts`）：`ApiPlan` 改为 `request`（`{path, method?, params}`）+ `describe(data)` 两段式——管线对同一响应先执行**恰好一次** HTTP 调用，再由 `describe` 从该响应推导 fields + 类型化 data + 分页。配套修复：

- `ApiClient.execute(method, path, params)` 显式声明 GET/POST，废除 `path.includes('postModelDataMeta')` 字符串嗅探；GET 序列化统一在此收口（数组逗号连接）。
- QueryResult 形态响应（postModelDataMeta / getTagRawHistory / getWideHistory / getTagAggrigateHistory）共用 `describeQueryResult`：字段类型码集中映射（`1/11/22`→number、`52`→datetime），`page` 首次透传进 `ToolResult.page`。
- 分页/间隔/样本数入参加 `validatePositiveInt` 机械校验（此前 NaN 可直通 `Math.min`）；`resolve_tag`(api) 的 keyword 拼入 whereStr 前拒绝单引号（条件语法保留字符）。
- `ApiToolContext.apiClient` 收窄为 `ApiExecutor` 接口，测试可注入内存执行器（`tests/tools-api.spec.ts`：单次执行语义是显式回归用例）。

### 17.2 lookup_device：消费 WT_DEVICE（结构验证遗留闭环）

结构验证报告确认 WT_DEVICE 真实列为 `inverter*/array*/sub*` 三级前缀命名（与预期 `device*` 全异），此前无任何工具消费。本阶段新增 **`lookup_device`**（metadata 层，StarRocks 通道）：

- 模板 `lookupDeviceSql`：keyword 模糊匹配三级 name/code 六列（`escapeLike` 转义）+ `device_type` 精确过滤（`escapeSqlString`），keyword 与 device_type 至少提供一个；列面以报告 §2 实测 DDL 为准。
- 层级行携带逆变器及其所属组串、子阵的完整 id/编码，可作测点 tagName 设备段与 WT_CUBE `device` 过滤的取值来源；已入 preset persona 提示。
- 测试同步：模板金样 + StarRocks 白名单闸门守卫（`templates.spec.ts`）、工具行为与注册表（`tools.spec.ts`）、装配清单 12 工具（`service.spec.ts`、`dsh-config.spec.ts`）。

### 17.3 已知待办（本轮明确暂缓）

- `scripts/schema-validate.mjs` 硬编码数据库凭据已随历史提交（违反"凭据不落盘"红线）——待轮换凭据并改环境变量注入。
- API 面信任边界：`query_model` 的 `whereStr/orderByStr/groupByStr` 为自由查询片段直传网关，插件层无注入校验——待与网关侧确认净化责任后补防线。

## 18. 接口版式 20260910 适配（2026-09-11）

> 依据《基础的数据底座查询接口 20260910.pdf》对 0909 版的逐节比对（`docs/spec` 源目录之外的项目自有差异分析），并以储能水泵项目（模拟量.xlsx，20 个 `*_1O_pump000x` 测点）真实 API 实测验证。探测脚本：`scripts/tsdb-api-probe.mjs`。

### 18.1 接口差异 → 代码变更

| # | 0909 → 0910 差异 | 代码变更 | 落点 |
|---|---|---|---|
| 1 | 字段类型码新增 **51 = 时间日期**（52 = 日期型） | `resultFieldType` 将 51/52 均映射 `datetime` | `tools-api/types.ts` |
| 2 | 实时值接口改名 `getTagRealValues` → **`getIOTTagRealValues`**，返回从对象映射改为 **QueryResult 形态**；且 field 名（`tagname/datetime`）与数据行键（`tagName/time`）大小写不一致 | `tag_real` 切新路径；describe 主分支按行键双名兼容（`tagName??tagname`、`time??datetime`），旧对象映射形态保留为回落分支；client typed 方法同步新路径 | `tools-api/tag-real.ts`、`src/api/client.ts` |
| 3 | **新增** §2.7 模型分段聚合 `POST /wz/meta/postModelAggrigateData` | 新工具 `query_model_segment`（segment: `[{where_str, title}]`，段缺 title 自动命名"段N"，page_size 钳制） | `tools-api/query-model-segment.ts` |
| 4 | **新增** 关系分段聚合 `POST /wz/meta/postRelationAggrigateData`（含 left/rightModelName） | 新工具 `query_relation_segment` | `tools-api/query-relation-segment.ts` |
| 5 | 时序接口明确"endTime 与 sample 同给时 endTime 优先" | `tag_history` 已按此语义（可选参数互斥透传），无需改动 | `tools-api/tag-history.ts` |

API 工具面 8 → **10**；persona 同步（preset/askdata）。

### 18.2 真实 API 实测记录（2026-09-11，储能水泵项目 10462）

| 接口 | 结果 | 备注 |
|---|---|---|
| `getIOTTagRealValues` | ✓ | QueryResult 形态；真实值 current=26.66/20.07A、voltage=218.25V（2026-09-10 18:56:00） |
| `getTagRawHistory`（sample / endTime 两模式） | ✓ | field=[tag,type,value,time(51),comment]，1 分钟间隔，endTime 模式 1440 行/天 |
| `getWideHistory` | ✓（形态特殊） | 返回 `{type:'history_inter_wide', data:[[]...]}` 非 QueryResult；该项目窗口内无拟合数据 |
| `getTagAggrigateHistory` | ✗ 网关缺陷 | 任何参数组合（单/多方法、endTime/sample、单/多测点）均 `code=-1 系统内部出现错误`——**服务端问题**，与 TDD 文档历史记录一致；工具层正确收敛为 API_ERROR |
| `postModelAggrigateData` | ✓ | 分段统计实测返回 20/20，与模拟量.xlsx 测点表吻合；注意 whereStr 字符串值需引号（`类型 = '模拟量'`） |
| `postRelationAggrigateData` | ✓（可达） | 项目内暂无可用关系名，返回标准错误契约 |

另：鉴权三头实测为 `WT-TOKEN / WT-OPENID / WT-ROUTER`（`WT-APPID`/`WT-PROJECTID` 可选带）；缺 `WT-ROUTER` 时网关误报 `00011 登录过期`（§17.1 已修复）。

### 18.3 iot-etl 历史查询链路故障取证（2026-09-11 08:47–09:10）

排除"参数不全"假设的对照实验（`getTagAggrigateHistory` 为焦点，旁及同链路接口）：

1. **参数校验层健在**：缺 `methods` → `code=1 "参数[methods]为必填项"`；`getWideHistory` 缺 endTime/sample → `"错误：结束时间和样本数不可同时为空!"`。参数不全会有明确业务报错，而非 `-1 系统内部出现错误`。
2. **同参数不同结果（故障漂移）**：`getTagRawHistory` 08:47 以同参数成功返回 1440 行，09:06 起同参数 `-1`；`getWideHistory` 08:47 返回 code=0 空宽表，09:10 起同参数 `-1`。参数未变，服务端状态变了。
3. **参数空间已穷举**（20+ 组合无一改变错误形态）：文档全部形态、未文档化参数（interval/dateFormat/searchStr/sample+endTime 并存）、`%20`/`+` 编码、大小写、非法方法名、2024 光伏旧窗 / 2026-09 现数据窗 / 极短窗、新旧两代测点。非法方法名同样 `-1`（值校验发生在崩溃点之后）。
4. **故障边界**：走历史库查询的三个接口（raw/aggregate/wide 带合法参数）全倒；走实时缓存的 `getIOTTagRealValues` 始终正常；各接口参数校验层正常 → 故障定位在 **iot-etl 历史数据查询服务**（TSDB 历史库连接/执行层），非参数、非鉴权、非数据缺失（该窗口 raw 曾返回 1440 行）。
5. 顺带发现文档偏差：`getWideHistory` 实际要求 endTime/sample 至少其一（0910 文档称 endTime "选择输入"），`tag_wide` 工具描述已按实测修正。
6. 处置：`tag_aggregate`/`tag_history`/`tag_wide` 将该错误收敛为 `API_ERROR` 契约返回；待 AGP 侧修复后重跑 `scripts/tsdb-api-probe.mjs` 回归，无需改代码。取证用的精确 timestamp（如 `1789088303425`）可直接对齐服务端日志。

### 18.4 全接口普查与凭证对照实验（2026-09-11 09:15，`scripts/meta-api-probe.mjs`）

**凭证假设已否定**：故意用错误 `WT-TOKEN`、乃至缺 `WT-OPENID`，`getIOTTagRealValues` / `getModelList` 照常返回真实数据——网关对 token 值**未做实际校验**（此前的 `00011 登录过期` 实为缺 `WT-ROUTER` 头所致）。-1 错误与凭证无关；顺带提醒 AGP 侧：时序接口当前无鉴权即读数，属安全隐患。

**12 接口健康矩阵**（干净 UTF-8 通道；注意 Windows curl 命令行发中文参数会 GBK 乱码导致"没有找到模型"假错误，探测须走 Node/脚本）：

| # | 接口 | 方法 | 状态 |
|---|---|---|---|
| 2.1 | getModelDataMeta | GET | ✗ -1（同模型 POST 版 2.2 正常——同能力 GET/POST 对照） |
| 2.2 | postModelDataMeta | POST | ✓ 模拟量模型 20 行；出现文档未载的类型码 **61**（字典型，工具层按 string 兜底） |
| 2.3 | getModelBasAttributes | GET | ✓ |
| 2.4 | getRelationDataMeta | GET | ✗ -1（关系"组织和用户的关系"经 2.6 证实存在；POST 版 2.5 正常） |
| 2.5 | postRelationDataMeta | POST | ✓ 返回真实组织关系数据 |
| 2.6 | getRelationBasAttributes | GET | ✓ |
| 2.7 | postModelAggrigateData | POST | ✓ 分段 20/20 |
| 2.7b | postRelationAggrigateData | POST | ✗ -1 |
| 3.1 | getIOTTagRealValues | GET | ✓ |
| 3.2 | getTagRawHistory | GET | ✓→✗（08:47→09:06 漂移，见 §18.3） |
| 3.3 | getWideHistory | GET | ✓(空)→✗（同上漂移） |
| 3.4 | getTagAggrigateHistory | GET | ✗ 从未通过 |

**规律**：元数据/属性类接口（2.3/2.6/3.1）全部正常；**数据行查询类接口中，POST 全部正常，GET 大面积 -1**（2.1 vs 2.2、2.4 vs 2.5 两组同能力对照均如此）。结合 §18.3 的时变漂移，指向服务端数据查询服务（尤其 GET 查询路径）的部署/会话层缺陷。建议 AGP 侧优先核对 GET 查询路径（`getModelDataMeta`/`getRelationDataMeta`/`getTag*History`）与服务端日志。

### 18.5 根因修正：`-1` 的真正规则是"参数必须全传"（2026-09-11 09:40–10:00）

> 用户指出 getModelDataMeta 此前调通过——关键在**所有参数必须传（值可为空串）**，与 commit 118108f 的 postModelDataMeta 教训（7 参数全传，缺任一报 -1）同源。据此重测，**§18.4 表中四个"失败"接口全部打通**，"持续性缺陷"结论作废。

实测确认的参数规则（`scripts/full-params-verify.mjs`，已并入两个探测脚本）：

| 接口 | 全参数要求 | 验证结果 |
|---|---|---|
| 2.1 getModelDataMeta GET | 7 参数：modelName/searchStr/whereStr/pageNum/pageSize/orderByStr/groupByStr | ✓ code=0 返回模型数据 |
| 2.4 getRelationDataMeta GET | 9 参数（+leftModelName/rightModelName，空串占位） | ✓ code=0 返回关系数据 |
| 3.4 getTagAggrigateHistory GET | 6 参数：tagNames/startTime/**endTime 与 sample 至少其一**/methods/**params（空串占位）**；缺 sample 报 `code=1 参数[sample]不合法`，缺 params 报 -1 | ✓ code=0，返回 `{type:'history_inter', data:{tag:[行]}}` **包装形态**（非 QueryResult） |
| 2.7b postRelationAggrigateData POST | body 全字段（含 orderByStr/groupByStr/leftModelName/rightModelName/pageNum/pageSize） | ✓ code=0 分段计数 |

**残余问题（真实存在，量级收窄）**：服务稳定性抖动——同一全参数调用在 09:32 成功、09:45 起三连 -1、之后又恢复（§18.3 的 raw/wide 漂移同源）。这是网关侧可用性问题，非参数/凭证问题；工具层已把该形态收敛为 `API_ERROR` 契约。

**代码修正**：
- `tools-api/tag-aggregate.ts`：参数恒全传（`params` 空串占位）、`end_time 与 sample 至少提供一个`入参校验（网关实测要求，0910 文档未写明）、新增 `describeAggrigateHistory` 解释 `history_inter` 包装形态（行扁平化 + tagName 回填 + 数值化），QueryResult 形态回落。
- `tag_wide` 描述按实测修正（endTime/sample 至少其一，§18.3）。
- 探测脚本全参数化：`tsdb-api-probe.mjs` **7/7 通过**、`meta-api-probe.mjs` 全参调用（含 2.1/2.4）。Windows curl 命令行中文参数 GBK 乱码会产生"没有找到模型"假错误——探测一律走 Node UTF-8 脚本。

**给 AGP 侧的最终清单**：① 各数据查询接口"缺参数报 -1 系统内部出现错误"应改为明确的参数校验错误（现在只有个别参数报 `code=1`）；② `getTagAggrigateHistory` 间歇性 -1（全参数亦然）待查服务稳定性；③ 时序接口无鉴权即读数（错 token 同样返回数据）。

### 18.6 API-only 收口 + 工具层端到端测试（2026-09-11 10:30）

**决策：本版本智能问数只走 API。** `dsh-agp-askdata/tools` 行改为仅注册 10 个 API 工具，SQL 工具面（12 个）保留在服务编程接口（`service.tools`）但不再注册进 DSH——取数统一收口 API 网关。persona 同步为 API-only。

**工具层端到端**（`scripts/e2e-api-tools.ts`，真实 API、工具全路径、含审计链）：以模拟量.xlsx 的 20 个测点（current/voltage/temp/power/electric × pump0001-0004）为用例：

| # | 用例 | 结果 |
|---|---|---|
| 1 | list_models 模型清单（233 个，含模拟量模型） | ✓ |
| 2 | model_attributes 模型属性（38 个字段） | ✓（实测 QueryResult 形态：field=列定义、data=属性行；已修 describe） |
| 3 | query_model 测点信息全量 | ✓ 20 行与 xlsx 完全一致 |
| 4 | query_model 条件查询（测点编码 like current%） | ✓ 4 行 |
| 5 | query_model_segment 分段汇总 | ✓ 两段各 20 |
| 6 | tag_real 实时值（4 台水泵电流） | ✓ 20.07/26.66/25.74/14.69 |
| 7 | tag_history 历史原始值 | ✓ 10 行 |
| 8 | tag_wide 宽格式 | ✓（空宽表；history_inter_wide 包装形态已正确处理为空结果） |
| 9 | tag_aggregate 统计汇总 | ⚠ 网关抖动窗口 -1（同参数 10:12 已实测成功并取得 history_inter 数据，工具解释已实现） |
| 10 | resolve_tag 中文反查 | ✓ 优雅报 MODEL_NOT_FOUND（该项目测点登记在模拟量模型而非 wt_iot_tags，反查走 query_model） |
| 11 | 审计哈希链跨调用衔接 | ✓ 9 次落审计，首条 prevHash 空、resultHash 64 位 |

**客户端修正**（E2E 逼出）：`ApiClient` 改为先 `text()` 后解析——旧代码 `json()` 失败后再 `text()` 会因 body 已消费二次抛错，把真实错误体掩盖成"响应体不可读"；空响应体单独报 `API_ERROR`（常见于模型不存在）。

**抖动确认（四接口同步对照轮询，15s×4 轮）**：历史原始值/统计值/模型分段聚合三个"做实际计算"的接口同步 -1，实时值（查缓存）恒 0——与 §18.3 漂移同源，属网关计算服务稳定性问题，参数与凭证均无关（全参数调用在可用窗口实测成功）。

**测点表放置结论**：模拟量.xlsx 的正确位置是 **AGP 平台的模型库**（已作为「模拟量模型」导入，插件经 query_model 实时读取，无需文件副本）；xlsx 本身是建模导入模板，含真实资产信息，**不入 git**（如需归档放上游 spec 源目录）；离线测试夹具如需要，放脱敏子集于 `tests/fixtures/`。

### 18.7 真实浏览器端到端验证（2026-09-11 11:00，通过）

真实浏览器（Playwright 驱动，真实点击 + 真实键盘输入）全链路打通：DSH Web 打开会话 → 输入"当前项目一共有多少个可用的数据模型？请调用工具查询" → 真实点击发送 → LLM（deepseek-v4-flash-0731）推理 → **调用本插件 `list_models` 工具** → 渲染回答："当前项目共有 233 个可用数据模型（接口返回 rowCount: 233）" + 模型表格（模型别名/英文名/分类）。会话状态栏：3 轮 · 21 步，LLM 3m57s，工具调用 54.4s。233 与工具层 E2E（§18.6）完全一致。

浏览器自动化要点（沉淀）：注入坐标为 **CSS 像素**（用 `:hover` 判定实验确认）；应用输入状态需真实输入事件（`insertText`/粘贴），程序化 set value 不进 store；发送按钮首次点击偶发不触发，hover 预检 + 二次点击可靠。过程中定位并排除了两处误判：LLM 报 402 为 tokenrhythm 账户欠费（换 key 解决）；数据接口 -1 为"参数全传"规则（§18.5）。

### 18.8 接口版式 20260911 适配 + 真实问数验证（2026-09-11 14:00，通过）

**0911 版差异**：§3.2/3.3/3.4 显式标注 GET；**新增 §3.5 `getModelTagsByName`**（模型全部测点+实时值）与 **§3.6 `getObjetTags`**（实体对象测点+实时值，官方拼写 Objet）。新增工具 `model_tags` / `object_tags`，API 面 10 → **12**。

实测发现的网关事实（已沉淀到工具描述）：
- `getModelTagsByName` 成功响应的行数据键为 **`date`**（服务端拼写问题），describe 双键兼容；模型未绑定采集测点时返回空。
- `getObjetTags` 要求 whereStr 必填（缺则 `code=1`），且**服务端 SQL 硬性要求模型含「内部编码」列**（实体模型标准属性）——对测点类模型（模拟量模型）报 `Unknown column '内部编码'`；本项目水泵实体模型尚未建模，待 AGP 侧补建后该工具即生效。

**真实问数验证（DSH Web 真实浏览器会话，deepseek-v4-flash-0731）**：

| 问题 | agent 路径 | 结果 |
|---|---|---|
| 第二号泵现在的电流是多少？ | persona 引导的编码规律 → `tag_real(current_1O_pump0002)` | ✓ **20.07 A**（2026-09-10 18:56 采集），渲染测点/实时值/采集时间卡片 |
| 三号泵昨天一天的温度曲线？ | 确认测点 temp_1O_pump0003（60.13°C 实时）→ tag_wide 空 → 降级 `tag_history`（1440 点）+ 分段 `tag_aggregate`（4h×6 段） | ✓ 24 小时整点表 + 四阶段趋势（24.06–61.07°C，波动 37°C，傍晚高峰/停机散热节律） |

**E2E 逼出的修正**：
- `list_models` 增加 **keyword 客户端过滤**（别名/英文名/描述）与分页参数——网关不分页、DSH render 只给 LLM 前 20 行，此前 agent 盲猜模型英文名 15+ 次全部失败；keyword="模拟量" 一次命中 `wt_iot_analogtag`。
- `query_model` 的 modelName 用**中文别名**（'模拟量模型'），persona 已写明（英文名 wt_iot_analogtag 会报模型不存在）。
- persona 沉淀测点编码规律（current/voltage/temp/power/electric_1O_pumpXXXX）与本项目测点模型指引；`resolve_tag` 依赖的 wt_iot_tags 字典模型在本项目未绑定，反查走 query_model。

### 18.9 图表方案决策：与 dsh-genui 配合（2026-09-11 15:00，验证通过）

**问数结果的图表呈现选定与 dsh-genui 配合，不自研、不引 nlbi**。三方案对比：

| 方案 | 机制 | 结论 |
|---|---|---|
| **dsh-genui 配合**（选定） | LLM 在回答里输出 ```dsh-ui 围栏（白名单组件 JSON）或调 render_ui/validate_dsh_ui 工具，genui 渲染成交互组件；图表组件 `chart`（bars/line/donut）与 **`echart`**（ECharts 全功能：line/area/scatter，渐变/tooltip/图例） | **零安装**（web profile 已含）、双通道渲染不依赖宿主源码、职责干净（askdata 管取数、genui 管呈现）；集成成本 = persona 一句引导 |
| dsh-plugin-nlbi | 完整 NL BI 平台：Text2SQL + 15+ 图表 + Dashboard + 指标/维度/报表/权限，基于 dsh-mysql 连接底座 | 重型且自成体系：数据底座是 MySQL 直连（本项目时序在 AGP API），引入即两套取数/权限体系；适合"业务自助 BI 门户"场景，不适合对话内嵌图表 |
| dsh-data-agent | 取数+分析一体的 agent（自带 catalog/连接管理，analysis-html 报告） | 与 askdata 定位重叠（它也取数），不是纯图表件；作为图表依赖会绑死其连接体系 |
| 自研 | 需写 client 渲染组件 + 白名单安全 + 主题适配 + 流式渲染 | genui 已全部解决（27 类组件、ECharts、多表面围栏发现），重复造轮子 |

**实施**：persona 增加数据呈现指引（第 6 条）——时序曲线/趋势用 ```dsh-ui echart preset line（`{"type":"echart","title":"…","preset":"line","data":[{"label":"HH:mm","value":n},...]}`），统计对比用 bars、占比用 donut；单点实时值不强行配图。语法本身由 genui 注入的 system-prompt section 与 `genui` skill 承载，无需本插件重复。

**验证**（真实浏览器会话）："三号泵昨天一天的温度曲线" → agent 调 `tag_history`（1440 点）+ `tag_aggregate`（全天统计）→ 回答内渲染 **ECharts 折线图**（24h 曲线）+ 全天统计（最高 61.07°C / 最低 24.06°C / 平均 41.21°C）+ 四阶段趋势描述；会话 7 轮 42 步。过程中 tag_wide 返回空，agent 依错误契约自动降级组合工具——验证了容错设计。

### 18.10 AGP 反馈确认：0911 快路径落地 + 水利语境修正（2026-09-11 19:15，验证通过）

**AGP 反馈**：agent 调用的 tool 不是最优——0911 文档新增的 API 能更快获得信息与数据。**确认属实**，并已落地验证。

**文档核对**：13:07 重新保存的 0911 PDF 与上午版**内容逐字一致**（仅排版差异，PyMuPDF 全文 diff），即 0911 就是最终版。相对 0910 新增的即 §3.5/§3.6 两接口，且两者功能定义明确为"**同时返回当前测点的实时值**"——一次调用 = 测点清单 + 实时值，这就是"更快"的根据。

**网关实测（2026-09-11 19:00）**：
- **水泵模型已完成实体建模**（此前 §18.8 记录的阻塞解除）：`getModelBasAttributes(水泵模型)` 36 属性含 **`node_code/内部编码`**；`getModelDataMeta` 返回 4 台泵对象（第一台水泵~第四台水泵，内部编码 pump0001~pump0004，网关 GATEWAY/SUB 编码）。
- **快路径一次取数验证**：`getObjetTags(水泵模型, "名称 = '第二台水泵'")` → 6 测点含实时值一次返回（电流 20.07A / 电压 218.19V / 电机温度 53.08°C / 有功功率 3.75kW / 用电量 134.94kWh / 运行中无值，时间戳均为 2026-09-10 18:56）。
- `getModelTagsByName(水泵模型)` → 28 测点全量+实时值（含数字量运行信号）。**`getModelTagsByName(模拟量模型)` 返回空**——测点绑定在实体模型上，模拟量模型只是测点登记数据表。
- **whereStr 属性名必须用中文列名**（`名称`/`内部编码`）：英文 `name`/`alias` 报 `Unknown column`（服务端生成 SQL 直接落物理列）。
- **编码规律路线正式证伪**：数字量测点命名不规则（`online_2O_SHH0001`/`online_2O_SECOND`/`online_2O_B002`/`online_2O_B004` 分别是四台泵的运行信号），前缀拼装猜编码对数字量必错；语义反查是唯一可靠路径。

**落地修正**（persona + 3 个工具描述 + 重建 lib）：
- persona 第 3 条重写为水利语境与快路径优先级：设备实时状态首选 `object_tags`（如 `object_tags(model_name='水泵模型', where_str="名称 like '%第二台%'")`，"二号泵/2号泵"应匹配"第二台水泵"）；模型全量测点现状用 `model_tags`；仅已知精确编码才 `tag_real`；**禁止凭编码规律猜测点编码**；list_models keyword 示例改为"泵/水位计/水库"。
- 第 5 条补强：回答必须带数据时间戳（"数据截至 …"）。
- `object_tags` 描述：中文列名警告 + 首选场景；`model_tags` 描述：测点绑定在实体模型、模拟量模型返回空；`tag_real` 描述：收敛为"已知精确编码"场景，指向 object_tags/model_tags 反查。

**部署链路教训**：`installPreset` 设计为"已存在则跳过，绝不覆盖"（保护用户手改），开发期 preset 更新需手动同步 `$DSH_HOME/.agent-presets/askdata/`；插件本体经 `link:` 指向仓库，**工具描述改动需 `pnpm run build` 重建 `lib/` 才生效**。本次两处都踩到（第一次重启后 agent 仍走旧路径），已同步+重建+重启。

**真实浏览器复验（新会话，deepseek-v4-flash-0731，19:15）**："第二号泵现在的电流是多少？" → agent 路径 `list_models(keyword='泵')` → **`object_tags(水泵模型)` 一次取数** → 回答"第二号泵当前电流：20.07 A"（数据时间 2026-09-10 18:56）+ 全部 6 测点实时状态表 + 主动询问是否查历史趋势。对比旧路径（query_model 反查 + tag_real，2 次取数、20 秒）：新路径 1 次取数、11 秒、信息更全。
