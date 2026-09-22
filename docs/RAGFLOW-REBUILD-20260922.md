# ragflow 插件重建记录（2026-09-22 事故 → 当日完成）

examples/ragflow（`@deepseek-ai/dsh-ragflow`）lib/src/配置被外部清空。**当日已完整重建并验证**，本文件从事故交接清单转为重建记录。

## 恢复来源（按层）

1. **src 主件**（tool/provider/types.ts，含 page_num 基座）：本地 master `cee24f575c` 的 `examples/ragflow/src/*`（git 跟踪，幸免于难）。
2. **外围文件**（index/settings/http/config/config-page.ts、package.json、cordis.patch.yml、tsconfig、tsdown.config、README）：GitHub 开源上游 `staff-os/dsh-ragflow`（`https://github.com/staff-os/dsh-ragflow`，浅克隆存 `E:\git\dsh-ragflow-upstream` 备查）。上游版本较旧（无 page_num/引用卡片），仅取其外围。
3. **winfr 恢复（D:\recovered2）**：仅救回 genui 客户端 bundle（`Recovery_*/Misc/mjs/index_14.mjs`），从中确认了路由契约含 `/api/ragflow/web-open/by-chunk/:chunkId`（重建时曾遗漏，已补）；服务端 document.js 未能恢复，按对话记录手写。
4. **部署配置实际值**：`E:\dsh\home-e2e\settings.yaml` 的 `ragflow-http` 段（baseURL `https://labragf.openagp.top:9080`、规程库 datasetId `fda7a510a87c11f1998b3dc126099a8d`）。

## 重建物清单（E:\git\deepseek-harness\examples\ragflow）

- `src/`：master 三件套 + 上游外围，重打 4 补丁：
  a) `projectChunk` 对 `page_num` 判 `!= null`（null 页码不再透出）；
  b) provider `mapRagflowChunk` 加 `normalizePositions`（5 元组净化，`page_num` 改取净化后首元组——RAGFlow 常以 null 页行打头）+ `imageId` 投影；
  c) `execute` 末尾 `registerChunkDocuments(chunks)`（与 document 行共享 Map，经包自引用 `@deepseek-ai/dsh-ragflow/document`，tsdown neverBundle）；
  d) 系统提示强化（documentId 是 hex id 非文件名、positions 原样抄、禁 undefined 字面量、图片用 `http://127.0.0.1:<port>/api/ragflow/images/<id>` 绝对地址，端口经 `ctx.get('webServer')` 注入）。
- `src/settings-compat.ts`：rc.2 shim——`settingsNamespace(id)→{id}`；`installSettingsSection` 泛型降级为 `hooks.setSource(() => config)`。settings/http/tool 的 alpha API 导入全部改经此 shim（rc.2 dsh-settings 无这两个 API）。
- `src/document-self.d.ts`：自引用模块的类型声明（tsc 用）。
- `lib/document.js`（手写，纯 JS）：四条路由挂 `/api/ragflow` 前缀——`documents/:id`（PDF 代理，64MB 流式上限）、`documents/by-chunk/:chunkId`（Map 反查，2048 上限）、`web-open/:id` 与 `web-open/by-chunk/:chunkId`（302 到 RAGFlow web UI，30 次/分钟限流）、`images/:id`（公式/插图快照代理）。id 校验 `/^[0-9a-z][0-9a-z-]{7,127}$/`（穿越→400，未命中→404）。凭据 credentials.resolve→环境变量回退。
- `package.json`：exports 增 `./document` `./settings` `./types`（去掉未构建的 `./config`）。
- `cordis.patch.yml`：4 行装配（ragflow / ragflow-http[baseURL+datasetIds 固化] / tool-ragflow / ragflow-documents）。**rc.2 不挂 ragflow-config**（其依赖 alpha settings API）。
- `tsdown.config.ts`：entry 去掉 config；neverBundle 增自引用 `@deepseek-ai/dsh-ragflow/document`；`clean:false`（防清掉手写 document.js）。
- `tests/rebuild-smoke.mjs`：无宿主冒烟——mock ctx 驱动两行 apply，覆盖投影/净化/四类路由/共享 Map。
- `node_modules/`：清空事故致 devDeps 掏空（目录在、package.json 失踪），已从 profile 农场与根 node_modules 逐包修复（`cp -rL` 解引用）。

## 验证结果（2026-09-22）

- `node tests/rebuild-smoke.mjs`：全部通过（投影省 null page_num、positions 净化、imageId、四路由、by-chunk 共享 Map、web-open 双形态 302）。
- `tsc --noEmit`：0 错误（rc.2 类型）。
- 三链路 E2E（`apps/web/tests/e2e-three-chains.mjs`）：① AGP 取数 ✅ ② ragflow 规程引用 ✅ ③ dsh-ui 图表 ✅ 打开原文按钮/弹层/Esc ✅。
- 真数据代理验证：检索命中规程库（positions `[18,108,255,221,236]`）→ `documents/:id` 200 + application/pdf 3,267,330 字节；`web-open/:id` 302。
- rc.2 启动注意：`cordis` 的 `resolveConfig` 对导出 Config 读 `~standard.validate`（Standard Schema），**普通空对象会炸挂载**——askdata 的 skills 行曾因此 `agent-preset/invalid`（已改 `z.object({})` 修复）。

## 关联修复（askdata 仓）

- `src/dsh/skills.ts`：Config 从 `{}` 改 `z.object({})`（rc.2 cordis 兼容，见上）。
- E2E 脚本补工作区选择流程（选工作区→home）、围栏 id 双形态（snake/camel）取值。

## 启动方式（home-e2e）

`powershell -File E:\dsh\home-e2e\start-web-e2e.ps1`（设 `DSH_HOME=E:\dsh\home-e2e`，从 `E:\dsh\home\.credentials.yaml` 静默注入 RAGFLOW_API_KEY/WEIXIN_LLM_API_KEY/AGP_API_TOKEN/AGP_API_OPENID，脱离会话启动，token 落 `web-run29.log`）。

## 知识面融合 E2E（2026-09-22，graph + wiki）

**背景**：分析 `E:\git\ragflow-import` 的 graph（graphrag_port / build_graph_local.py）与
wiki（wiki_port / build_wiki_local.py）能力后，确认线上 RAGFlow v0.27.x 已开放服务端同构 API
（artifacts 系列），在 dsh-agp-askdata 新增知识面 3 工具（knowledge_search / knowledge_graph /
knowledge_wiki_page）+ resolve_tag 别名归一化 + deep_analysis 知识分支，共 15 工具。

**启动方式（home-e2e）**：`powershell -File E:\dsh\home-e2e\start-web-e2e.ps1`（DSH_HOME=E:\dsh\home-e2e，
3080 端口 token 鉴权；RAGFLOW_API_KEY 经启动环境变量注入，不落盘）。lib/ 由 `pnpm tsdown` 构建。

**E2E 脚本**：`E:\git\deepseek-harness\apps\web\tests\e2e-knowledge-fusion.mjs`（playwright 直驱，
token 自动取最新 web-run*.log）。

**结果（8/8 通过）**：

| 链路 | 断言 | 结果 |
|---|---|---|
| ① 知识取证 | knowledge_search 工具调用在 UI 可见；回答命中汛限水位 786.8（规程库片段） | ✅ |
| ② 图谱关联 | knowledge_graph 调用可见；关联机构命中（灌溉中心/水务局） | ✅ |
| ③ 取数面 | 库容 5720 万m³（TSDB 链路未被融合破坏） | ✅ |
| ④ wiki 页面 | knowledge_wiki_page 调用可见 | ✅ |
| 全局 | 无 >=400 资源；console 干净 | ✅ |

截图：`E:\dsh\home-e2e\shots\kg-{1-knowledge-search,2-knowledge-graph,3-agp-data,4-wiki-page}.png`。

**直连冒烟**（`scripts/live-smoke-knowledge.ts`，真实 API key 打六端点）：searchChunks 22 段
（top 命中"主汛期限制水位 786.80m"规程原文）；subgraph(node) 15 实体/14 关系；
subgraph(keywords) 10 实体；listPages 5 页；getPage 正文 10793 字/出链 101；structure(graph)
259 实体/341 关系。
