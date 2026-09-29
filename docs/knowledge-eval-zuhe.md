# 组合标准租户（zuhe）评测案例集：公式 / 图片 / 竖表 / 引用溯源

> 租户：`zuhe`（组合标准，Web 用户 admin3@ragflow.io），数据集**标准库**
> `ec5591d4ac0d11f1b8ab3155a5f51bf7`（14 份 SL 标准 PDF）。
> 问题池取自该租户 chat **"123"**（`7e0a737cac1011f1b8ab3155a5f51bf7`）的会话历史——
> 那是这批用例的一手来源；本文按四类能力整理并给出 DSH 链路的通过断言。
> 锚点探针时间：2026-09-29。多租户配置见 AGENTS.md「RAGFlow 多租户凭据」。

## 0. 租户事实（探针实测）

| 维度 | 值 |
|---|---|
| 数据集 | 标准库 1 个，14 文档（SL_T 720-2026 应急预案编制导则 ×3 份副本、SLT 880-2026 水利数据模型规范、SL∕T 862-2026 数字孪生可视化、SL-T 876-2026 崩岸抢护、SLT 750.4-2026 卫星遥感 等） |
| 重复入库 | SL_T 720-2026 同文 3 份（各 127 chunks）——**同文去重的天然试金石**（F4 回归） |
| chat 123 | 挂标准库；系统提示要求"图片 chunk 的文本内容（图注+图像描述）代表该图全部信息，据此解释示意图" |
| 跨租户隔离 | 实测：tqp key 取 zuhe 文档 → `code:102 document not found`（key 即租户边界成立） |
| 大文件 | 应急预案编制导则原文 26.8MB PDF（document 代理 64MB 上限内，流式慢属预期） |

**E2E 前置**：`knowledge.defaultTenant` 切到 `zuhe`（或宿主 createContext 传
`tenantId:'zuhe'`）；宿主环境变量 `RAGFLOW_API_KEY` 用 **zuhe key**（document/images
代理是单凭据的，见"已知边界"）。

## 1. 用例集（问题全部来自 chat 123 原句）

### Z1 公式渲染（KaTeX）

| # | 问句（chat 123 原句） | 黄金要点 | 通过断言 |
|---|---|---|---|
| Z1-1 | 溃坝波的波形有哪几个公式？ | 命中 SL_T 720-2026 / 崩岸抢护导则中的溃坝波公式片段 | 回答中公式以 `$…$` 行内 / `$$…$$` 块级呈现（genui KaTeX），不是纯文本公式串；出处标注文档名 |
| Z1-2 | 面板折断长度推导 | 面板折断长度公式与推导条件 | 公式渲染 + 推导步骤可读；数值/符号未改写 |
| Z1-3 | 则面板折断的时刻在溃坝发生后的时间AT可按式 | 时间 ΔT 计算式 | 同上；ΔT 符号不被吞成"AT" |
| Z1-4 | CHEN Shengshui 模型 / LILei模型（是什么、如何计算） | 土体本构模型公式 | 公式渲染；模型名大小写保持（CHEN Shengshui / LI Lei） |

### Z2 图片 / 示意图（imageId → 图片代理）

| # | 问句 | 黄金要点 | 通过断言 |
|---|---|---|---|
| Z2-1 | 土体颗粒在坝坡上的受力示意图 | 命中图片 chunk（图注+图像描述） | 回答嵌图：`/api/ragflow/images/<imageId>` 绝对地址可加载（200，image/png）；文字解释受力关系（chat 123 提示词要求的模式） |
| Z2-2 | 混凝土坝垂直局部溃坝示意图 | 图片 chunk + 图注 | 同上 |
| Z2-3 | LILei模型计算简图 | 计算简图快照 | 图片加载 + 计算说明 |
| Z2-4 | 面阵网箱养殖卫星遥感影像 | SLT 750.4 卫星遥感标准中的影像图 | 图片加载；说明这是遥感解译示例 |
| Z2-5 | 水库人员应急转移命令下达和实施流程图 | 流程图图片 chunk | 图片加载；流程顺序叙述与图注一致 |

### Z3 竖表（纵向表格内容还原）

| # | 问句 | 黄金要点 | 通过断言 |
|---|---|---|---|
| Z3-1 | 2.5次抛物线表有哪些数据？ | SL_T 720-2026 中 2.5 次抛物线坐标表（纵表：一列 x/h、一列 y 值逐行） | 数据以**表格**呈现（Markdown 表或 dsh-ui table），行列方向正确（竖表不被拍扁成一行）；数值逐个照抄不改写 |
| Z3-2 | 表6 水库下游洪水淹没区内的人员转移方案 | 表 6：分区域/村落 → 转移去向/负责机构的纵表 | 表头与行对应正确；区域-去向映射不错位；出处带"表6" |

### Z4 引用溯源（citations 围栏 → 原文）

| # | 问句 | 黄金要点 | 通过断言 |
|---|---|---|---|
| Z4-1 | 任一 Z1/Z3 问题（复用） | 依据卡 | citations 围栏解析成功（无降级代码块告警）；条目含 documentId（hex）；`[[N]]` 角标可弹摘录 |
| Z4-2 | 同上 | 「打开原文」 | 经 `/api/ragflow/documents/:id` 拉到 PDF（26.8MB 流式，首次较慢）；positions 有值时 `#page=N` 跳页；无 positions 退化到页码提示 |
| Z4-3 | 溃坝波的二次抛物线（chat 123 变体问句） | 三份同文副本只算一条证据 | 依据卡不出现同名文档重复条目（同文去重生效；rank 行 documentId 唯一） |

## 2. 已知边界（记入本轮 E2E 预期，不算失败）

1. **document/images 代理单凭据**：dsh-ragflow 的 ragflow-documents 行只解析一个
   `RAGFLOW_API_KEY`——多租户下它只服务"该 key 所属租户"的文档（跨租户实测
   code:102）。租户化路由（`/api/ragflow/tenants/{tid}/documents/...` 或会话解析）
   是方案 1 的 genui/dsh-ragflow 联动后续项；本轮 E2E 以 zuhe key 启动宿主规避。
2. **竖表还原质量**：PDF 竖表经 RAGFlow 解析为序列化行，模型转置可能出错——
   Z3 断言"行列方向正确"失败时记录为质量观察项，不算链路故障。
3. **mindmap/graph 面**：标准库未编译 graph/wiki/mindmap artifacts（本租户用例
   不覆盖 knowledge_graph/wiki/mindmap，检索面为主）。

## 3. E2E 实测结果（2026-09-29，DSH web + 浏览器自动化，zuhe 租户）

| 用例 | 结论 | 证据 | 会话来源* |
|---|---|---|---|
| Z1-1 公式 | **通过** | KaTeX 渲染 10 处；溃坝波式(49)-(53) 完整（h=(1/9g)(2√(gH₀)−x/t)² 等）；出处带文档名+chunk+页码（SL/T 720-2026 · 第68页） | 旧会话第 4 轮（新话题） |
| Z1-2 面板折断长度推导 | **公式渲染通过 / 引用卡未出** | KaTeX 69 处；推导链+符号表完整（弯矩平衡→三次方程→牛顿求临界 Ld）；模型把输出预算耗在 mermaid 围栏自纠错上，未发 citations 卡 | 干净新会话 |
| Z2-1 受力示意图 | **文字侧通过 / 嵌图未发生** | 受力分解完整（W/Fd/Fl/R + 临界条件式24）、出处带 chunk+图2+第61页；图片未嵌入——干净会话下模型改为文字转述并主动引用 imageId（数据列已到模型），嵌图行为待模型侧固化 | 干净新会话 |
| Z3-1 竖表 | **通过** | 表2（2.5 次抛物线）Markdown 表还原，9 个 t/T 分点数值齐全无错；模型自创 chart 围栏 JSON 写错被 genui guard 正确拦截（降级代码块+修复提示，守卫符合设计） | 旧会话第 9 轮（污染上下文） |
| Z3-2 表6 人员转移方案 | **通过（范例级）** | 8 列竖表完整转置还原（行政单位/村居/户数/人数/转移路线/责任人），区域-去向映射无错位；截断行如实标注「表格原文此处内容截断」不编造 | 干净新会话 |
| Z4 引用溯源 | **机制链路通过 / id 保真待改进** | citations 卡渲染成功（persona 内联模板生效，无围栏解析错误）；条目含文档名+页码；「打开原文」→ 原文查看器打开 → iframe 命中 `/api/ragflow/documents/<id>#page=61` 代理路由。**缺陷**：Deepseek-v4-flash 转抄 24 位 hex documentId 失真（抄成 32 位不存在 id），代理透传后 RAGFlow 返回 code:102——链条机械可用，id 保真是模型层弱点 | 干净新会话 |
| Z4-3 同文去重 | **通过** | 三份 SL_T 720 同文副本下，引用卡仅 1 条文档条目（无重复）；KaTeX 14 处；模型内联引用了**两个真实** documentId（f17984acbb05…/0b53df68… 前缀与文档清单吻合）。**次级发现**：卡片句柄用了 chunkId → by-chunk 路由 404（该映射只由 dsh-ragflow 自家检索填充，askdata 检索不进 Map）——已把 persona/skill 模板改为 documentId 必填主键、chunkId 降为展示元数据（待复验） | 干净新会话 |

*会话来源如实标注：Z1-1/Z3-1 在带旧上下文的既有会话执行（新话题轮/污染轮），Z2-1/Z4
的最终结论来自干净新会话——正式评测轮次应全部在干净会话重跑后更新本表。

**E2E 过程性发现**（已回修或记录）：

1. **installPreset 幂等跳过**：改 persona 后必须删除 `$DSH_HOME/.agent-presets/askdata*`
   再重启才会重装——本轮曾因旧 persona 未更新而误判模板无效。
2. **persona 内联模板是关键杠杆**：skill 里的完整模板（askdata-query-pattern skill §4）
   模型不主动加载时等于不存在；persona 里的一行紧凑 citations 模板让围栏解析从"每轮必坏"变为"零错误"。
3. **会话上下文污染**：多轮同会话（>300K tok）下小模型倾向复用旧答案模式而不重新调
   工具——评测必须在干净会话进行。
4. **待办（跨仓）**：① documentId 保真——候选方案：工具行同时给出短校验位、或 genui
   guard 对 documentId 做租户侧存在性校验（需宿主接口）、或以 chunkId 反查为主路径；
   ② 图片嵌入行为固化（persona 已有指引，模型遵循度待观察）；③ web-open 限流按会话；
   ④ 文档代理 HEAD/Range 补齐与查看器 PDF.js 化——规格与分阶段计划见
   `docs/original-doc-viewer-spec.md`（P1 代理义务 → P2 探测分派 → P3 跨源网关）。
5. **by-chunk 路由对 askdata 引用不可用**（2026-09-29 复验确认）：chunkId→documentId
   反查 Map 只由 dsh-ragflow 的 ragflow_retrieve 填充；已把 persona/skill 模板改为
   documentId 必填主键规避（干净会话复验待做），长期方案见 ①。
6. **「打开原文」空白/屏蔽页（2026-09-29 两轮定位修复）**：① 主因——Chromium 对插件
   文档（PDF）在 sandbox iframe 里一律拦截（"此页面已被 Chrome 屏蔽"），实测加
   `allow-scripts` 也无效；iframe 的 src 恒为宿主同源代理（自有文档+纯文本错误），
   sandbox 无保护对象 → 已去掉，并加「新标签」按钮兜底。② 代理把业务失败信封
   （200+code:102）透传成近乎空白的 JSON → document.js 转真 404。③ 插件 PDF 的
   iframe `load` 事件不可依赖 → 加载提示 8 秒自撤。④ 内嵌 Chromium 缺 PDF 插件时
   文档体为空 → 查看器检测后显示"不支持内嵌预览，请新标签/下载"的操作提示（IAB
   实测生效；桌面 Chrome 去 sandbox 后可内嵌渲染）。修复后复验：真 documentId 卡
   渲染正常、错句柄显示错误面板、无屏蔽页。
7. **mermaid 画公式推导必翻车 → 配方+校验闭环（2026-09-29 两步走）**：第一步禁令
   止血（persona 禁 mermaid，推导回落 Markdown——同问题复验零降级）；第二步按评审
   方案解禁并建闭环：persona 改"配方（节点≤12/标签纯文字/| 成对/公式在正文）+
   发出前必须 validate_dsh_ui + 图=导航摘要不承载证据"，validate_dsh_ui 接入
   `lintMermaidSource`（逐行 |/括号/引号配对 + 反引号）与 `repairMermaidSource`
   （修复成功直接返源码照抄）。**复验（明确要求画图、干净新会话）：mermaid 成功
   渲染、零降级、KaTeX 29 处、引用卡正常**——模型本轮未调 validate 也一次写对
   （配方已内化；validate 是未调时的兜底网）。
8. **PDF.js 按需取块的带宽陷阱与字节缓存（2026-09-29）**：`disableStream+
   disableAutoFetch` 后 pdf.js 走 64KB 按需 Range，但代理每个 Range 都重新向上游
   拉 26MB 再丢弃到偏移——并发多段带宽互踩，单段 21-34s，30s 预算触发降级。修复：
   document.js 加宿主侧字节缓存（首取全文入缓存，总量 128MB 最旧淘汰；HEAD/Range/
   全量全部内存直出）——深层偏移 Range 从 20-35s 降到 **6ms**，查看器打开后
   canvas 快速渲染（624×883、4946 暗像素、零错误面板）。评审缺陷同步修复：
   content-range NaN（start/end 形态）、客户端中止的上游连接泄漏（三处流循环加
   abort 守卫 + reader.cancel）、PdfJsFrame 卸载销毁、canvas 滚动容器、预检改
   HEAD + 有界缓存。

## 4. 运行方式

- 单测回归：`pnpm vitest run tests/knowledge-tenants.spec.ts tests/knowledge-tools.spec.ts`
- E2E（2026-09-29 执行方式）：home-e2e web（DSH_HOME=E:\dsh\home-e2e）+
  `knowledge.defaultTenant=zuhe` + 宿主 `RAGFLOW_API_KEY=<zuhe key>`，
  浏览器自动化按 §1 问句逐条提问（注意：必须新会话，见 §3 过程性发现 3）。
- 锚点刷新：`scripts/knowledge-eval-probe.ts` 目前**只覆盖 tqp 数据集**（datasetIds
  硬编码）；zuhe/jhq 锚点刷新需改探针参数化或按 §0 的 API 调用手工重取。
