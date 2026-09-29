# AGENTS.md

本仓库是 dsh-agp-askdata：AGP TSDB/Database 智能问数的 DSH 插件。

## Git 推送规则

- **本仓库**推 `origin` = `https://github.com/wangjinzhong87706022/dsh-agp-askdata.git`。
- **姊妹仓 dsh-genui**（E:\git\dsh-genui，genui 渲染插件）推 `fork` = `https://github.com/wangjinzhong87706022/dsh-genui.git`；其 `origin`（omdsh-dev/dsh-genui）是上游、无写权限（403），**永不向 origin 推送**。
- 推送走代理 `HTTPS_PROXY=http://127.0.0.1:7897` + `http.sslBackend=schannel`；代理节点对上传流会停摆（GET 正常、push 卡死），用重试循环：`timeout 100 git -c http.sslBackend=schannel -c http.lowSpeedLimit=1 -c http.lowSpeedTime=45 push <remote> main`，失败重试，最多 6 次。
- 两仓联动：askdata 的渲染协议改动（dsh-ui 围栏/drill 字段）必须与 genui 同步，提交推送成对进行。

## RAGFlow 多租户凭据（lab 实例 labragf.openagp.top:9080，DEV-ONLY）

配置面：`knowledge.tenants[]`（方案 1，API key 即租户边界）+ `knowledge.defaultTenant`；key 留空走环境变量 `RAGFLOW_API_KEY_<ID大写>` 回退。**以下 key 是 lab 实例开发凭据，进 git 仅为联调便利；生产部署必须轮换全部 key 并改环境变量注入。**

| 租户 id | 用途 | Web 用户名（密码统一 admin） | API Key | datasetIds |
|---|---|---|---|---|
| `tqp` 桃曲坡 | 规程预案/洪水资料，graph+wiki+mindmap 已编译 | admin@ragflow.io | `ragflow-EFGXYcdQ1KSyNn39-dFAlYW4kVe1BPG_Lg4pasv-sRQ` | `fda7a510a87c11f1998b3dc126099a8d`（规程与预案）、`fdfee2e4a87c11f1998b3dc126099a8d`（洪水资料） |
| `jhq` 泾惠渠 | 泾惠渠三处资料库 | admin4@ragflow.io | `ragflow-uOrnjzXTOWTYvzDwkiJorGD3hEciAB3-jo8ofWpSBu8` | `7a96e5eab69211f18f992bf5359454d9`（计划处）、`7a92958ab69211f18f992bf5359454d9`（工程建设处）、`7a8d7082b69211f18f992bf5359454d9`（工程管理处） |
| `zuhe` 组合标准 | 公式/图片/竖表/引用溯源演示（chat "123" 挂标准库，测试案例源） | admin3@ragflow.io | `ragflow--twE5HXaVPAkXlzRcmGXNhWsTkgDL1mWW0rQvnEbZsE` | `ec5591d4ac0d11f1b8ab3155a5f51bf7`（标准库，14 份 SL 标准 PDF；chat id `7e0a737cac1011f1b8ab3155a5f51bf7`） |

- 租户切换：①**环境变量 `DSH_ASKDATA_TENANT=<id>`**（进程级覆盖，每次工具调用注入 tenantId，优先于 defaultTenant——E2E/单租户临时切换用这个，不改配置）；②`knowledge.defaultTenant`（部署默认）；③宿主把会话身份映射后经 `createContext({tenantId})` 注入（终态，待接线）。未解析到租户时 fail loud（绝不静默落别的租户）。
- 引用溯源「打开原文」查看器：同源 P0（无 sandbox + 错误面板 + 新标签）与 **P1（代理 HEAD/Range/Disposition，已落地）+ P2（PDF.js canvas 按页渲染 + cmaps + 预检分派，已落地）** 规格与验收记录见 `docs/original-doc-viewer-spec.md`；P3（跨源租户网关/签名 URL）待方案 2 立项。
- 组合标准租户的评测用例见 `docs/knowledge-eval-zuhe.md`（公式/图片/竖表/引用溯源，问题池取自 chat 123 会话历史）；锚点探针已参数化：`RAGFLOW_API_KEY=<租户key> pnpm tsx scripts/knowledge-eval-probe.ts <tqp|jhq|zuhe>`。

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
