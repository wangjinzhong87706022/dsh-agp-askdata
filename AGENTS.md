# AGENTS.md

本仓库是 dsh-agp-askdata：AGP TSDB/Database 智能问数的 DSH 插件。

## 硬性约束

- **只读系统**：任何代码不得生成或执行写语句（INSERT/UPDATE/DELETE/DDL）。`security.readOnly` 在 P0 不允许关闭。
- **模板化 SQL**：LLM 可见的取数面只有 `tools/` 下的固定语义工具；新增取数能力 = 新增模板 + 新增工具，绝不加"自由 SQL"工具。
- **安全红线来自 `docs/spec/`**（WISETao 设计）：基础库白名单、扫描护栏、质量过滤三件套、审计哈希链是规格不是优化项；改行为必须先改规格并同步 `docs/architecture.md`。
- **凭据不落盘**：密码只在进程内使用（mysql2 连接参数 / CLI 通道 `MYSQL_PWD` 环境变量），不进日志、错误消息、测试快照。
- **双执行通道**：默认 mysql2 驱动直连（text protocol，规避服务端 prepared statement 差异）；`connection.driver: 'cli'` 回落外部 mysql 客户端。两通道共用 `SqlExecutor` 接口，工具层不得感知通道差异。

## 工程约定

- ESM（`"type": "module"`），本地相对导入带 `.ts` 扩展名；核心（`src/`）保持零 npm 运行时依赖。
- 所有可调阈值走 `src/config.ts` 配置，禁止实现内嵌第二套默认值。
- SQL 模板的每个产物必须能通过 `src/sql/whitelist.ts` 闸门——`tests/templates.spec.ts` 里有守卫用例，改模板必须同步。
- 错误一律抛 `AskdataError`（规范错误码 + LLM 处置提示），禁止裸 Error 逃出工具边界。
- `pnpm run test` + `pnpm run typecheck` 是本地最低验证线；行为变更同步 vitest 用例。
- 上游规格文档在 `docs/spec/`，源目录 `D:\svn\WISETao_custom_demo\docs`；规格变更从源目录拷贝，不在此手改。
