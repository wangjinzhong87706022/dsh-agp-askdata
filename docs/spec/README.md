# WISETao_custom_demo · 智能问数 / 智能体平台设计文档

> 本目录包含两个层次的设计文档：
> 1. **通用智能问数**（v1）—— 与项目无关、与行业无关
> 2. **智能体平台整合**（v2）—— 把智能问数嵌入"灵知"智能体平台的 16 周实施计划

## 文档结构

```
docs/
├── README.md                                  # 本文（索引）
│
│   ★ 核心设计（4 份）
├── 架构设计-智能问数与智能体.md               # 4 层架构 + 17 Tool 骨架
├── 工具实现规范.md                            # 17 Tool SQL 模板 + 校验 + 错误码（v3）
├── tools_v3.json                              # 17 Tool OpenAI Function Calling schema
├── llm_system_prompt_v3.md                   # System Prompt（WT Select + 11 类 + 5 属性 + 6 关系）
│
│   ★ 落地实现（4 份）
├── Java接口骨架.md                            # ToolExecutor + Backend + Orchestrator 接口
├── application-bole.yml.sample                # application.yml 配置样例
├── ddl_metadata_tables.md                     # 11 张表 DDL（WT_METRIC_DICT / WT_QUERY_AUDIT 等）
├── 单元测试样例.md                            # 17 Tool 单元测试 + Orchestrator 集成测试
├── 实施前置资料清单.md                        # ★ 实施前必须确认的资源/数据/决策清单
├── 光伏深度分析-WT_TAG与TSDB查询大全.md       # ★ WT_TAG/WT_DATA 字段+SQL 模板+TSDB HTTP/Ice API 全集
├── 光伏目录剩余资料挖掘清单.md                # ★ AGP 元模型表/计量属性/producer_api/部署配置等 8 大类新发现
├── 光伏目录第三轮深挖-平台工程文档与外部系统.md # ★ 平台 REST API 文档/6 张衍生表 DDL/压测实测/无人机·红外·灰尘接口
├── 智能体平台目录第四轮深挖-AGP接口契约与本地模型部署参数.md # ★ AGP 元接口契约/11 维度模型种子/Qwen3.8-27B 部署参数
├── 光伏目录第五轮深挖-TSDB厂商手册与指标体系与考核细则.md # ★ 质量位解码/Lua 实时方程式/34 项指标口径/两个细则规则库/cubeType 映射/24 测点模板
├── 项目源码第六轮深挖-CubeType权威枚举与算法公式与AGP-Java-SDK.md # ★ 源码级：CubeType 1-20 枚举/tagName 四段式/六大算法公式/9 张新表/AGP Java SDK 全集
├── 项目源码第七轮深挖-FdDianLiangTask破密恢复与补数幂等开关与版本资产考古.md # ★ 收官：FdDianLiangTask 破密恢复(r2738)/DLP 加密定性/kaig 幂等开关/装机 600MW/信创五库矩阵/版本资产红线
│
│   ★ 背景与分析（3 份）
├── 数据来源-完整版.md                          # 5 类数据来源
├── 读了解模型后的设计补强.md                   # 实体建模补强
├── 会议视频与纪要借鉴分析.md                   # 3 场会议提炼
│
│   基础设计（2 份）
├── 通用智能问数设计方案.md                    # v1：通用框架（10 Tool）
├── 智能体平台整合设计方案.md                   # v2：嵌入智能体平台
│
│   实现参考（2 份）
├── llm_system_prompt.md                       # System Prompt v1 通用模板
├── tools.json                                  # Tool schema (v1)
│
└── 智能体平台参考/                              # 11 份原始文档提取
    ├── 01-AGP层次架构和实体模型.txt
    ├── 02-AGP接口体系.pdf.txt
    ├── 03-灵知-AI智能体框架.txt
    ├── 04-灵知开发进度V1.8.txt
    ├── 05-灵智菜单设计建议.txt
    ├── 06-qwen3-8-27B优化.pdf.txt
    ├── 07-桃曲坡Agentic知识库需求V0.1.txt
    ├── 08-了解模型-实体建模工具.txt
    ├── 09-0824会议纪要-知识库与智能体开发交流.txt
    ├── 10-0826会议纪要-AGP实体对象模型组织讲解.txt
    └── 11-0903会议纪要-AGP接口体系架构设计讲解.txt
```

## 30 秒理解

**v1（通用）**：业务人员问一句自然语言 → LLM 选择 10 个 Tool 之一 → 后端查 TSDB / StarRocks / 字典表 → LLM 合成答案。

**v2（智能体平台）**：在 v1 之上加 4 个关键能力——
- `search_knowledge`（RAG 检索 + 引用溯源）
- `query_kg`（知识图谱查询）
- `evaluate_rules`（业务规则试算，机理判定强制走此）
- `skill`（Skill/Agent 编排入口）

并加上**四级权限 + 仅追加哈希链审计 + 敏感表白名单 + 强制溯源**等合规能力。

## 三步接入

### v1 通用问数（任何项目）

1. 配置 `application.yml` 的 `system` 段
2. 导入业务字典（指标 / 实体 / 业务事实表）
3. 接入 LLM 客户端，加载 `tools.json` 和 `llm_system_prompt.md`

### v2 智能体平台（基于 v1）

1. 完成 v1 三步
2. **新增 4 张元数据表**：`WT_QUERY_AUDIT` / `WT_FIELD_PERMISSION` / `WT_TOOL_REGISTRY` / `WT_SKILL_REGISTRY`
3. **新增 4 个 Tool**：`search_knowledge` / `query_kg` / `evaluate_rules` / `skill`
4. **部署 v2 系统 prompt**（system_prompt_v2）
5. **接入 Skill / Agent 注册中心**（与 DSH 集成）

## 与智能体平台真实需求的对齐

| 智能体平台需求（来自灵知 V1.8） | 本设计响应 |
|---|---|
| 16 周路线图 | v2 = G3 阶段（智能问数 W9-W11）+ G4 Agent（W12-W14） |
| RDBMS + TSDB + DFS 三层 | v1 三层抽象直接对应 |
| 智能问数（NL2SQL/NL2API 横向大项） | v1 + v2 是核心交付 |
| 校验层（白名单/字段权限/禁 DML）| ✅ v1 强制，v2 加强到四级权限 |
| 审计可溯源 | ✅ v2 升级为"仅追加 + 哈希链 + 3 年保留" |
| 强制规则判定 | ✅ v2 新增 `evaluate_rules` Tool |
| 知识库 6 类（KB-01~KB-06）| v2 字典表支持任意 KB-0X |
| 业务规则库（flood_dispatch/emergency/maintenance）| v2 字典 + `evaluate_rules` |
| 应急预案结构化 | v2 推荐 `WT_EMERGENCY_PLAN` 表 |
| 知识图谱 | v2 新增 `query_kg` Tool |
| Skill / Agent 编排 | v2 新增 `skill` 元工具 + Skill/Agent 注册中心 |
| 四级权限体系 | ✅ v2 显式建模 |
| 强制溯源（≥2 条引用）| ✅ v2 每个 Tool 返回必带引用字段 |

## 六轮深挖修订合并状态（2026-09-06）

六轮资料挖掘（5 轮文档 + 1 轮源码）累计 84 项修订，核心 4 份设计文档已完成合并：

| 文档 | 合并内容 |
|---|---|
| `ddl_metadata_tables.md` | +§16 产线业务事实表权威 DDL（WT_CUBE cubeType 1-20 枚举 / WT_INVERTER_STATUS 归一化状态 / 8 张事实表 / tagName 四段式 / GroupPeriod UDF / 数据流与重算警示） |
| `工具实现规范.md` | +§1.3 质量位 4-nibble 解码；+§1.3.1 tagName 四段式；lookup_tag 补正则模板与 tagCode 语义族；lookup_metric 补六大算法公式 seed；business_metrics 补限电损失路由与口径速查；evaluate_rules 补两个细则首批 8 条规则+免考核；+§8.2 口径溯源三来源；estimate_count 补重算警示 |
| `tools_v3.json` | lookup_tag/aggregate/business_metrics/wide_history/evaluate_rules 五个 Tool description 注入编码规则、去重警示、口径枚举与规则源 |
| `llm_system_prompt_v3.md` | +§2.5 tagName 四段式；+§2.6 口径溯源三来源；行为约束 +3 条（状态表强制/重算波动/离散率≠偏离度）；渲染示例补 8 张事实表与指标公式速查 |

未合并的低优先级项（已登记在各轮深挖文档 §修订表，按需取用）：组件契约封装问数结果卡、热斑问数 hotsoptblock 映射、Jython 计算方法接口、Grafana 曲线补充、演示 P0 场景清单。

## 关键 takeaway

1. **本项目（WISETao_custom_demo）只是"示例"**：用于理解"智能问数在真实业务里的用法"，为后续真正的智能体平台项目打基础。
2. **v1 已覆盖 80% 需求**：10 个 Tool + SystemMetadata 占位符 + 三层抽象 + 质量过滤 + 写禁用 + 限速——这些是**通用且成熟**的部分。
3. **v2 补 4 个关键缺口**：RAG/知识图谱/规则引擎/Skill 编排——这些是**智能体平台特有**的部分，必须新增。
4. **强约束：evaluate_rules 优先**：智能体平台的"水利红线"决定了机理判定类问题必须强制走 `evaluate_rules`，禁止 LLM 自由生成。
5. **G3 阶段（9-11 周）是智能问数落地的关键**：3 周时间交付智能问数引擎 V1.0（NL2SQL + NL2API + 时序问数 + 审计），准确率 ≥ 85%，越权/DML 拦截率 100%。

## 文档阅读顺序

1. **数据来源-完整版.md**（先读）—— 智能问数从 5 个通道取数（含被 v1/v2 漏掉的 AGP 元库 + 业务库）
2. **架构设计-智能问数与智能体.md** —— 模块划分、接口契约、数据流时序图，是后续所有实现的共同基线
3. **读了解模型后的设计补强.md** —— 实体建模补强分析（11 类基础模型 / 五类属性 / 六种关系 → v3 Tool 集合）
4. **会议视频与纪要借鉴分析.md** —— 3 场会议核心设计决策（DSH 选型 / WT Select 中文查询 / 接口 4 层 / Magic API / AI 安全红线）
5. **通用智能问数设计方案 v1** —— 10 个 Tool 的功能定义与 SQL 模板
6. **智能体平台整合设计方案 v2** —— v2 新增 4 个 Tool + 9 张元表 + Skill/Agent
7. **llm_system_prompt.md / tools.json** —— LLM 实现参考

## 参考

| 文档 | 路径 |
|---|---|
| ★ 数据来源完整版（5 通道）| `docs/数据来源-完整版.md` |
| ★ 架构设计骨架（17 Tool）| `docs/架构设计-智能问数与智能体.md` |
| ★ 实体建模补强（v3 Tool）| `docs/读了解模型后的设计补强.md` |
| ★ 会议借鉴（DSH / WT Select / 4 层接口）| `docs/会议视频与纪要借鉴分析.md` |
| ★ 工具实现规范 v3（17 Tool）| `docs/工具实现规范.md` |
| ★ Tools schema v3（OpenAI function calling）| `docs/tools_v3.json` |
| ★ System Prompt v3（含占位符 + 示例）| `docs/llm_system_prompt_v3.md` |
| ★ Java 接口骨架 | `docs/Java接口骨架.md` |
| ★ application.yml 配置样例 | `docs/application-bole.yml.sample` |
| ★ 11 张表 DDL | `docs/ddl_metadata_tables.md` |
| ★ 17 Tool 单元测试样例 | `docs/单元测试样例.md` |
| ★ 实施前置资料清单（启动前必读）| `docs/实施前置资料清单.md` |
| ★ 光伏深度分析（WT_TAG/SQL/API 全集）| `docs/光伏深度分析-WT_TAG与TSDB查询大全.md` |
| ★ 光伏剩余资料挖掘清单（AGP 元库/API 注册表等 8 类）| `docs/光伏目录剩余资料挖掘清单.md` |
| ★ 光伏第三轮深挖（接口文档/衍生表 DDL/压测/外部系统）| `docs/光伏目录第三轮深挖-平台工程文档与外部系统.md` |
| ★ 智能体平台第四轮深挖（AGP 元接口契约/Qwen 部署参数）| `docs/智能体平台目录第四轮深挖-AGP接口契约与本地模型部署参数.md` |
| ★ 光伏第五轮深挖（TSDB 厂商手册/指标口径/两个细则/测点字典）| `docs/光伏目录第五轮深挖-TSDB厂商手册与指标体系与考核细则.md` |
| ★ 项目源码第六轮深挖（CubeType 枚举/算法公式/AGP Java SDK）| `docs/项目源码第六轮深挖-CubeType权威枚举与算法公式与AGP-Java-SDK.md` |
| ★ 项目源码第七轮深挖（FdDianLiangTask 恢复/幂等开关/版本考古）| `docs/项目源码第七轮深挖-FdDianLiangTask破密恢复与补数幂等开关与版本资产考古.md` |
| 通用智能问数设计方案 v1 | `docs/通用智能问数设计方案.md` |
| 智能体平台整合设计方案 v2 | `docs/智能体平台整合设计方案.md` |
| 灵知开发进度 V1.8（16 周计划）| `docs/智能体平台参考/04-灵知开发进度V1.8.txt` |
| 灵知立项报告 | `docs/智能体平台参考/03-灵知-AI智能体框架.txt` |
| 桃曲坡知识库需求 V0.1 | `docs/智能体平台参考/07-桃曲坡Agentic知识库需求V0.1.txt` |
| 实体建模工具方法论 | `docs/智能体平台参考/08-了解模型-实体建模工具.txt` |
| 0824 会议纪要（DSH 选型）| `docs/智能体平台参考/09-0824会议纪要-知识库与智能体开发交流.txt` |
| 0826 会议纪要（实体模型）| `docs/智能体平台参考/10-0826会议纪要-AGP实体对象模型组织讲解.txt` |
| 0903 会议纪要（接口架构）| `docs/智能体平台参考/11-0903会议纪要-AGP接口体系架构设计讲解.txt` |
| System Prompt v1 模板 | `docs/llm_system_prompt.md` |
| Tools schema v1 | `docs/tools.json` |
| 光伏示例素材 | `D:/doc/taineng/光伏/智道/docs/` |
