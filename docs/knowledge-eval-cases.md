# 知识面评测案例集（RAGFlow graph / wiki / mindmap / 原文检索）

> 目的：给 `knowledge_search` / `knowledge_graph` / `knowledge_wiki_page` / `knowledge_mindmap`
> 四工具及组合链路一套**锚定线上真实产物**的评测用例。所有黄金值来自 2026-09-28
> 探针实测（`scripts/knowledge-eval-probe.ts`，见文末维护说明），不是构造的假想数据。
>
> 范围：工具行为 + 证据正确性 + 模型转述纪律（出处标注、不编造、截断透明）。

## 1. 锚点快照（2026-09-29 实测刷新）

| 维度 | 实测值 | 说明 |
|---|---|---|
| 数据集 | `fda7a510…`（规程与预案）+ `fdfee2e4…`（洪水资料） | tenants.tqp 的 datasetIds |
| structure(graph) | 259 实体 / 351 关系 | 类型分布 org=90 / location=55 / product=40 / person=37 / regulation=28 / other=9 |
| subgraph(node=桃曲坡水库) | 30 实体 / 29 关系（top_n=30） | 中心权重 101；**谓词全空**（wiki-graph 端点特性，关联串只有方向箭头） |
| wiki 页面 | `entity/桃曲坡水库` 正文 10793 字 / 出链 101 条 | 清单含机构、人员（秦鹏/杨一波/党焕宁/田荣/刘根战）、联防指挥部等页 |
| mindmap | 44 节点全展开（incomplete=false），1 个中心主题 9 主分支 | 「桃曲坡水库防洪抢险应急预案」；只在规程库编译 |
| **structure(timeline)** | **413 实体 / 274 关系（全 `ordered`）——仅在洪水资料库** | 实体 type=timestamp，name=时间串（粒度混杂：`1983`/`2021-10-05`/`2013-07-22 13:30`），description=事件摘要（报汛流量/库水位/洪峰等）；keywords 过滤可用（`2021`→4 实体/3 关系）；**含抽取噪声**（非时间名混入，如"红星水库溢洪道…受损"） |
| structure(session_essence / session_graph) | 两库均空 | 未编译，无评测面 |

**结构性锚点优先于计数锚点**：服务端重编译会改变实体/关系/节点数量（历史值
341→351 关系即漂移过），断言应优先用稳定结构（中心主题名、分支名、黄金文档名、
数值口径），计数只做软断言。

## 2. 运行方式（三级）

| 层级 | 命令 | 覆盖 |
|---|---|---|
| 单测回归（离线，mock） | `pnpm vitest run tests/ragflow-client.spec.ts tests/knowledge-tools.spec.ts tests/knowledge-tenants.spec.ts` | 契约、失败语义、截断标注、去重、租户路由（F 组） |
| 直连探针（真实实例，只读） | `RAGFLOW_API_KEY=<tqp key> pnpm tsx scripts/knowledge-eval-probe.ts tqp` | 刷新本文档锚点快照（timeline/session 需按 §1 的 API 手工补测） |
| E2E（DSH web 全链路） | home-e2e web + 浏览器自动化（tqp 为 defaultTenant） | 模型选路、工具调用可见性、dsh-ui 渲染 |

## 3. 用例集

### A. knowledge_search（原文取证）

| # | 问句 / 参数 | 黄金要点 | 通过断言 |
|---|---|---|---|
| A1 | query="桃曲坡水库主汛期的汛限水位是多少" | top1 命中 `03-汛期调度运用计划.pdf`：主汛期（7、8、9 月）汛限 **786.80m**，次汛期（6、10 月）**788.00m**（§2.5 分期汛限） | 回答含 786.80 并标注该文档出处；同时给出次汛期 788.00 更佳 |
| A2 | query="水库的防洪标准是多少年一遇" | top1 命中 `01-防洪抢险应急预案.pdf`：**100 年一遇设计 / 1000 年一遇校核**，最高允许洪水位 **790.5m** | 数值与出处均正确；不得把设计标准与校核标准混答 |
| A3 | query="应急响应分为几级" | 命中 `04-大坝安全管理应急预案.pdf` / `01-防洪抢险应急预案.pdf`；正确答案 **4 级（I/II/III/IV）**，与 mindmap D2 交叉验证 | 回答 4 级并给出处；此问句建议改走 knowledge_mindmap（见 E 组选路） |
| A4 | query="2021年9月洪水的降雨量情况" | top1 命中 `9-15强降雨工作汇报.doc`（9.15-9.20 连阴雨过程）；labels 回显 `{2021-09, 2021-10, 洪水资料}` | 引用时带标签分类标注（哪场洪水/哪类资料） |
| A5 | query="2021年9月洪水降雨量" + meta_filter=`[{key:"flood_event",op:"=",value:"2021-09"}]` | 过滤后命中 `9-15强降雨工作汇报.doc`、`较大洪水统计表.xls`（洪水编号 210925，洪峰 267 m³/s）；非 2021-09 场次片段被排除 | meta= 出现在 apiOrSql；不得混入其它场次证据 |
| A6 | query=冷门问句（如"水库藻类治理规程"） | 无命中 → 返回"资料不足"指引行 | 模型明说「现有资料无法支撑该问题」，**不得编造**出处 |

### B. knowledge_graph（实体关系子图）

| # | 参数 | 黄金要点 | 通过断言 |
|---|---|---|---|
| B1 | entity="桃曲坡水库" | 中心展开：铜川市(w=46)、柳林水文站、溢洪道闸门、桃曲坡水库调度规程、concept 节点（汛限水位/防洪标准/洪水调度原则/生态流量）等 | 中心实体排第一；关联实体 ≥10；机构/设施/概念三类都有 |
| B2 | entity="桃曲坡水库" | wiki-graph 端点**谓词为空** → 关联串形态为 `→铜川市`（方向有、无谓词括号） | 关联串带方向箭头；谓词为空时不出现空括号 `()` |
| B3 | keywords="防洪调度" | 概览命中：溢洪道、低放水洞、流域概况、马栏河引水、省/市防汛抗旱指挥部、防汛调度等 | 实体 ≥8；返回防汛业务域实体而非无关词 |
| B4 | entity="桃曲坡水库", top_n=200 | 大预算下每实体关联边按 30 条封顶并标注总数 | 出现「共 N 条关联，仅列前 30 条」注记；上下文占用可控 |
| B5 | entity="不存在实体XYZ" | 图谱未覆盖 → 返回"没有检索到相关实体"指引 | 不编造实体；建议模型换全称或转 knowledge_search |
| B6 | structure 面观察 | structure(graph) 类型分布含 person（赵军政/王军政）、org（华能（铜川照金）电厂、铜川市公安局耀州分局）、regulation（SL252-2000 等） | （探针级）类型分布健康，无单一类型占满 |

### C. knowledge_wiki_page（百科页面）

| # | 参数 | 黄金要点 | 通过断言 |
|---|---|---|---|
| C1 | slug="entity/桃曲坡水库" | title=桃曲坡水库，topic=桃曲坡水库运行管理，正文含"位于陕西省铜川市沮水河流域…综合利用中型水库" | 摘要/正文关键字段命中；正文 >4000 字时带「原文共 N 字」截断注记 |
| C2 | keywords="桃曲坡水库联防指挥部" | 关键词定位命中该页（跨部门联合指挥机构，铜川市设立） | 返回联防指挥部页而非桃曲坡水库页（定位精确性） |
| C3 | slug="entity/桃曲坡水库" | 出链 101 条（如 `entity/陕西省桃曲坡水库灌溉中心`、`concept/1000年一遇洪水`、`entity/水库允许最高洪水位`）；关联页含《防洪标准》（GB50201-94）等 | 出链/关联页超 30 条时带「共 N 条」计数注记 |
| C4 | slug="concept/24小时工作人员值班制" | concept 类型页存在且可直取 | 非 entity 前缀的 slug 路由正确 |
| C5 | slug="entity/不存在" | 未找到 → 指引行 | 提示换全称或先 knowledge_search，不编造页面内容 |

### D. knowledge_mindmap（脑图层级）

| # | 参数 | 黄金要点 | 通过断言 |
|---|---|---|---|
| D1 | （留空全量） | 中心主题「桃曲坡水库防洪抢险应急预案」，9 主分支：总则/工程概况/工程险情及危害性分析/险情监测与报告/应急响应/险情处置与人员转移/应急保障/后期处置/宣传培训演练 | level=0 节点唯一且为中心主题；主分支名与黄金清单一致（≥8/9） |
| D2 | keywords="应急响应" | 分支「应急响应」下 **I/II/III/IV 级响应** 4 个子分支 | path 形如 `…> 应急响应 > I级响应`；回答"分几级"= 4 |
| D3 | keywords="应急保障" | 子分支：通信保障/队伍保障/物资保障/组织保障 | 4 类齐全；path 层级正确 |
| D4 | keywords="险情" | 命中「工程险情及危害性分析 > 险情种类与危害 / 险情因素」及四层深路径「…> 大坝溃决分析 > 溃坝洪水演进」 | 深层路径（level=3）不被预算砍掉（44 节点 < 默认预算 60） |
| D5 | 预算观察 | maxGraphEntities 调小于 44 时 apiOrSql 出现「仅展开 N/44 节点…」 | 截断透明（回归 2026-09 修复项） |

### E. 组合链路（跨工具）

| # | 场景 | 期望链路 | 通过断言 |
|---|---|---|---|
| E1 | "汛限水位是多少？当前库水位是否超汛限" | knowledge_search（A1 取证）→ latest_value（取数） | 结论=数值(工具)+依据(文档)；缺一即失败 |
| E2 | 生成值班报告前先取证规程 | knowledge_search → citations 入参 generate_duty_report | 报告第 9 段引用《汛期调度运用计划》且数值与 A1 一致（786.80m 阈值口径） |
| E3 | "规程里怎么规定"（纯知识问句，走 deep_analysis） | askdata_deep_analysis → knowledgeOnly 分支只调 knowledge_search | 工具序列= ['knowledge_search']，无 SQL 面工具 |
| E4 | 选路纪律 | 结构化分层问题（分几级/有哪些类型）应走 mindmap 而非 search 撞运气 | A3 问句在模型层应改道 knowledge_mindmap（skill 手册已指引） |
| E5 | 引用溯源闭环（citations 围栏） | knowledge_search 取证 → 模型按 askdata-query-pattern skill §4 模板输出 citations 围栏（n/doc/page/quote/chunkId/documentId/positions 照抄工具行）→ genui 依据卡渲染 | 围栏解析成功（无降级代码块告警）；`[[N]]` 角标可弹 popover；条目带 documentId 时「打开原文」经 `/api/ragflow/documents/:id` 出 PDF（documentId 直取链路，不依赖 by-chunk 会话映射）；positions 跳页正确 |

### T. timeline 时间线（knowledge_timeline 已实现——工具/编排器/单测齐备；直答选路率待积累）

> 2026-09-29 实现：`RagflowClient.timeline()`（时间归一排序+undated 剔除）+
> `knowledge_timeline` 工具（keywords 过滤+预算封顶标注+previewLimit 1024）+
> deep_analysis 编排器 timelineHit 路由 + persona/skill 选路句。单测 4 例全过。
> **直答 E2E（tqp）**：模型未选 knowledge_timeline，用 8 步 search 手工拼出
> 顺序正确的时间线表（9-25 22:30 低洞加压 → 9-25 23:30 柳林洪峰 217 m³/s →
> 9-26 02:00 入库 267 m³/s → 9-27 收尾）——内容可用但未走结构化轴；选路率
> 与 ②③ 同一观察，缓解同源（deep_analysis 编排器已修，直答靠 persona 积累）。

| # | 问句 / 参数 | 黄金要点 | 通过断言 |
|---|---|---|---|
| T1 | keywords="2021-09"（问"2021年9月那场洪水的时间线"） | 命中 2021-09 时段 timestamp 实体（探针：`2021`→4 实体/3 关系；`2021-09` 更收敛） | 按时间排序的事件表（时间/事件摘要/出处 chunk）；时间不乱序 |
| T2 | keywords="2021-10" | 2021-10 场次（与 2021-09 同年相邻场次） | 与 T1 结果不混淆（场次隔离） |
| T3 | 留空（全量概览） | 413 实体受 maxGraphEntities 预算封顶 + truncated 标注 | apiOrSql 出现「仅展开 N/413…」；模型声明时间线被截断 |
| T4 | 数据质量 | name 含非时间噪声（如"红星水库溢洪道…受损"） | 工具层归一：可解析时间排序；不可解析的归入"未定时"附注（granularity=未定时），不混入时间轴 |
| T5 | 粒度混杂 | name 粒度从 `1983`（年）到 `2013-07-22 13:30`（分钟） | 排序按可解析时间值（粗粒度不拆不编）；展示保留原始 name |
| T6 | 编排器路由（deep_analysis） | 问句含"时间线/时间顺序"→ timelineHit → 只调 knowledge_timeline | 单测覆盖；直答场景模型自选工具不经过 classify |

### F. 失败语义与回归（离线单测已覆盖，列此供 E2E 对照）

| # | 场景 | 期望行为 | 对应用例 |
|---|---|---|---|
| F1 | knowledge.datasetIds 未配置 | 工具明确失败（BACKEND_DOWN，提示装配），取数面不受影响 | knowledge-tools.spec「知识面未装配」 |
| F2 | RAGFlow 业务失败（HTTP 200 + code≠0，如 key 失效） | **报错**，不冒充"页面不存在/未找到" | ragflow-client.spec「全部数据集业务失败」 |
| F3 | 多数据集部分失败 | 整体成功但 apiOrSql 标注「N/M 数据集失败，结果可能不完整」 | knowledge-tools.spec「部分数据集失败」 |
| F4 | 同文异 id 重复片段 | 去重保首见，topK 预算花在真不同证据 | ragflow-client.spec「同文去重」 |
| F5 | 调用超时 / 取消 | 中文分流消息（"RAGFlow 调用超时（timeoutMs=…）"/"已被取消"），不透英文 abort 原文 | ragflow-client.spec「超时与取消消息分流」 |
| F6 | mindmap 节点预算截断 | apiOrSql 注明「仅展开 N/M 节点」 | knowledge-tools.spec「节点预算截断」 |

## 4. 评分标准

### 4.1 E2E 实测记录（2026-09-29，tqp 租户，五场景）

| 场景 | 结果 | 现场证据 |
|---|---|---|
| ① 图谱（B1） | **通过** | knowledge_graph 被调用；实体清单带类型与说明（铜川市/柳林水文站/沮河/溢洪道闸门…），并对输水工程/通讯成员单位做了准确归类注解 |
| ② wiki（C2） | **内容通过 / 选路偏差** | 灌溉中心全景正确（事业单位/防汛/灌溉/运行管理），但模型走 search+graph 组合，knowledge_wiki_page 未被选路 |
| ③ mindmap（D2） | **内容通过 / 选路偏差** | 应急响应 4 级（Ⅰ/Ⅱ/Ⅲ/Ⅳ）+ 启动主体 + 最高级说明全中，但走 knowledge_search 而非 knowledge_mindmap |
| ④ 溯源（E5） | **链路通过 / 模型 id 保真失手** | 786.80 命中 + 引用卡 + 打开原文；模型围栏里 documentId 失真（且文件名被改写为"03-水利枢纽汛期整体调度运用计划.pdf"）→ 404 错误面板（诚实报错）；用真实 id（ac25bcaa…）直打代理 200/PDF 1.4MB——机械链路完好 |
| ⑤ timeline（T1） | **缺口行为实证** | 无 knowledge_timeline 可调；模型用多轮 search 手工拼时间线（7 步/179K tok，产出 2021-09-15~28 时序并自行处理年份标签矛盾）——内容可用但成本高出一个量级，且时序结构（ordered 边）完全未利用 |

**两条横向发现**：(a) 自由问答下 Deepseek-v4-flash 明显偏爱 knowledge_search，
wiki/mindmap 专用工具选路率低（结构化价值未被利用；缓解候选：deep_analysis
编排器加规则、或接受 search-first——内容正确性未丢）；(b) documentId 保真
在 tqp 复现（zuhe 曾见 32 位变造 id）——治理候选仍是 T 组旁登记的三方案。

- **P0（必须全过，任一失败即该用例不通过）**：黄金数值/结构正确；出处文档名正确；无编造（检索为空时明说资料不足）。
- **P1（质量分）**：标签/元数据标注、层级路径形态、方向箭头语义、次汛期等旁证信息完整性。
- **观察项（不计分，记录趋势）**：相似度分数量纲（不同问句 sim 尺度不同，0.49 与 7.4 并存——rerank 分数与相似度混布，**禁止用绝对阈值断言排序质量**，只断言 top1 文档）；检索噪声（见下）。

## 5. 已知噪声与陷阱

1. **mindmap 编译产物混入检索**："应急响应分为几级"的 searchChunks 会返回
   `{"type": "has_sub_branch", "source": "应急响应", …}` 这类编译 JSON 片段——它是
   知识面自身的产物回灌，不是业务证据。评测时不得将其计为黄金命中；模型转述时
   也不得把 JSON 字段当正文引用。
2. **xls 表格片段**：`2010年下泄水量统计.xls` 等表格文档的分片是序列化 JSON 行
   （timestamp/描述），引用时出处文档名正确但正文可读性差——属预期行为。
3. **谓词为空**：wiki-graph 端点关系不带谓词（实测 29/29 全空），关联串是
   `→对端` 形态；谓词只在 structure 类端点（mindmap 的 has_branch 等）出现。
   评测 B2 按"有方向、无谓词"断言。
4. **计数漂移**：实体/关系/节点数随服务端重编译变化，只有结构性锚点（§1）可长期复用。

## 6. 维护说明

- **刷新锚点**：服务端重编译 wiki/graph/mindmap 后，重跑
  `RAGFLOW_API_KEY=… pnpm tsx scripts/knowledge-eval-probe.ts`（只读端点），
  用输出更新 §1 快照与受影响黄金值；A/B/C/D 组中随编译变化的计数同步修订。
- **黄金值来源**：本文档 2026-09-28 首版全部取自探针实测输出；新增用例必须先探针
  取真值再写入，禁止凭记忆或推测填黄金值。
- **与单测的关系**：F 组行为已由 vitest 固化；本文档的增量价值在真实数据面
  （A-E 组）与模型转述纪律——E2E 才能评的部分。
