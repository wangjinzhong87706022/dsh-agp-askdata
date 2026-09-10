# TDD：基于 AGP REST API 的智能问数系统

> 文档版本：V1.0 | 日期：2026-09-09 | 作者：CodeArts
> 项目：dsh-agp-askdata-api | 关联文档：`基础的数据底座查询接口 20260909.pdf`

---

## 1. 概述

### 1.1 背景与动机

当前 `dsh-agp-askdata` 通过 mysql2 驱动直连 StarRocks/MySQL 执行模板 SQL 实现智能问数。该方案存在以下约束：

- **网络约束**：需打通 DSH 宿主到 StarRocks(9030)/MySQL(3306) 的网络通路，生产环境需暴露数据库端口
- **凭据约束**：数据库密码需注入插件配置，与"凭据不落盘"红线冲突
- **SQL 适配约束**：StarRocks 与 MySQL 方言差异需在模板层处理，WT_CUBE/WT_DEVICE 表结构变更需同步改代码
- **权限约束**：直连数据库难以做行级/列级权限控制，只读账号管理依赖 DBA

AGP 平台已提供标准 REST API 查询面（`/s1M6_uE9/wz/`），通过 HTTP 调用可规避上述全部约束：认证走 Token、不暴露数据库、方言由后端处理、权限由 AGP 项目级管控。

### 1.2 设计目标

| 目标 | 描述 |
|------|------|
| **API 优先** | 所有取数走 AGP REST API，不直连数据库 |
| **工具化** | LLM 可见的取数面只有固定语义工具，每个工具封装 1-2 个 API 调用 |
| **统一返回** | 工具返回统一 `AskdataToolValue` 结构，对齐 DSH 工具注册表 |
| **配置化** | API 地址、Token、项目 ID 走配置，不内嵌 |
| **只读保证** | API 本身只提供查询接口，无写操作 |

### 1.3 与现有方案的对比

| 维度 | 现有方案（直连 SQL） | 新方案（REST API） |
|------|----------------------|---------------------|
| 数据通道 | mysql2 → StarRocks/MySQL | HTTP → AGP REST API |
| 认证 | 数据库账号密码 | WT-TOKEN / WT-OPENID |
| SQL 生成 | 客户端模板生成 | 后端处理，客户端只传参数 |
| 表结构依赖 | 强依赖（改表需改代码） | 弱依赖（API 屏蔽表结构） |
| 权限控制 | 数据库只读账号 | AGP 项目级 Token 管控 |
| 网络要求 | 需通数据库端口 | 只需通 HTTPS 443/9080 |
| 延迟 | 低（直连） | 中（HTTP 往返） |
| 功能覆盖 | 全部 SQL 能力 | API 暴露的查询面 |

---

## 2. AGP REST API 接口清单

### 2.1 公共信息

**Base URL**：`https://www.openagp.top:9080`

**API 前缀**：`/s1M6_uE9`（后端接口前缀，区别于 `/v7i0_wG9` 前端前缀）

**认证请求头**：

| 请求头 | 说明 | 来源 |
|--------|------|------|
| `WT-TOKEN` | 用户鉴权令牌 | 前端 URL 参数或登录接口 |
| `WT-OPENID` | 用户 ID | 前端 URL 参数 |
| `WT-PROJECTID` | 项目 ID | 前端 URL 路径（如 10462） |

**统一返回结构**：

    {
      "code": 0,            // 0 正常, -1 错误, 1 参数错误, 00010 未登录, 00011 Token 过期
      "message": "success",
      "data": {
        "field": [           // 字段列定义
          { "name": "字段名", "title": "提示", "type": "3" }
        ],
        "data": [            // 数据行
          { "字段名": 值 }
        ],
        "page": {            // 分页
          "pageNum": 1, "pageSize": 20, "pageTotal": 5, "itemTotal": 100
        }
      },
      "timestamp": 1788918045500,
      "executeTime": 108
    }

**字段类型编码**：`3`=字串, `1`=长整数, `11`=整数, `22`=浮点数, `52`=时间日期

### 2.2 数据模型查询接口（6 个）

| # | 接口 | 路径 | 方式 | 必填参数 |
|---|------|------|------|----------|
| 2.1 | 查询模型数据 | `/s1M6_uE9/wz/meta/getModelDataMeta` | GET | modelName, searchStr |
| 2.2 | 查询模型数据 | `/s1M6_uE9/wz/meta/postModelDataMeta` | POST | modelName, searchStr |
| 2.3 | 模型基本属性 | `/s1M6_uE9/wz/meta/getModelBasAttributes` | GET | modelName |
| 2.4 | 查询关系数据 | `/s1M6_uE9/wz/meta/getRelationDataMeta` | GET | relationName, searchStr |
| 2.5 | 查询关系数据 | `/s1M6_uE9/wz/meta/postRelationDataMeta` | POST | relationName, searchStr |
| 2.6 | 关系基本属性 | `/s1M6_uE9/wz/meta/getRelationBasAttributes` | GET | relationName |

**通用可选参数**：

| 参数 | 说明 |
|------|------|
| `searchStr` | 查询内容，支持中文属性名，如 `姓名,年龄+10 as 新年龄`，全部用 `*` |
| `whereStr` | 查询条件，如 `年龄 > 30` |
| `pageNum` / `pageSize` | 分页（pageSize < 1000） |
| `orderByStr` | 排序 |
| `groupByStr` | 分组 |
| `leftModelName` / `rightModelName` | 关系查询的左右继承模型 |

**额外发现的接口**（PDF 文档未定义）：

| 接口 | 路径 | 说明 |
|------|------|------|
| 模型列表 | `/s1M6_uE9/wz/meta/getModelList` | 返回所有模型（167 个），含 class_name/class_alias/class_path |

### 2.3 时序数据库查询接口（4 个）

| # | 接口 | 路径 | 必填参数 | 可选参数 |
|---|------|------|----------|----------|
| 3.1 | 测点实时值 | `/s1M6_uE9/wz/iot-etl/iot/getTagRealValues` | tagNames | — |
| 3.2 | 历史原始值 | `/s1M6_uE9/wz/iot-etl/iot/getTagRawHistory` | tagNames, startTime | endTime, sample |
| 3.3 | 宽格式历史 | `/s1M6_uE9/wz/iot-etl/iot/getWideHistory` | tagNames, startTime, interval | endTime, sample, dateFormat |
| 3.4 | 历史统计值 | `/s1M6_uE9/wz/iot-etl/iot/getTagAggrigateHistory` | tagNames, startTime, methods | endTime, sample, params |

**tagNames**：多个测点用逗号分隔，如 `Quantity_1O_YQJL-1#-11F-1,Quantity_1O_YQJL-1#-11F-2`

**时间格式**：`2023-12-30 01:22:22`

**统计方法**（16 种）：

| 方法 | 说明 |
|------|------|
| `max` / `min` | 最大值 / 最小值 |
| `mean` | 算术平均值 |
| `rms` | 均方根 |
| `count` | 计数值 |
| `skewness` / `kurtosis` | 偏度 / 峰度 |
| `percentile100` / `percentile50` / `percentile10` / `percentile4` | 百分位数 |
| `percentile` | 任意分位数（需 params） |
| `stddeviation` | 标准方差 |
| `geometrimean` | 几何平均值 |
| `populationvariance` | 总体方差 |
| `elementat` | 某下标的数据（params 是下标） |
| `valueindex` | 数据下标 |
| `duration` | 持续时间（params 是条件） |

---

## 3. 系统架构

### 3.1 整体架构

    ┌─────────────────────────────────────────────────────┐
    │                    DSH 宿主                          │
    │  ┌─────────────┐    ┌──────────────────────────┐   │
    │  │  LLM Agent   │───▶│   askdata-api 工具行      │   │
    │  │  (AGP问数)   │    │  ┌────────────────────┐  │   │
    │  └─────────────┘    │  │  Tool 1: list_models│  │   │
    │                      │  │  Tool 2: query_model│  │   │
    │                      │  │  Tool 3: model_attrs│  │   │
    │                      │  │  Tool 4: query_rel   │  │   │
    │                      │  │  Tool 5: tag_real    │  │   │
    │                      │  │  Tool 6: tag_history │  │   │
    │                      │  │  Tool 7: tag_wide    │  │   │
    │                      │  │  Tool 8: tag_aggr    │  │   │
    │                      │  │  Tool 9: resolve_tag │  │   │
    │                      │  └────────────────────┘  │   │
    │                      │         │                  │   │
    │                      │  ┌──────▼──────┐          │   │
    │                      │  │ ApiClient   │          │   │
    │                      │  │ (fetch+认证) │          │   │
    │                      │  └──────┬──────┘          │   │
    │                      └─────────┼──────────────────┘   │
    └────────────────────────────────┼─────────────────────┘
                                      │ HTTPS
                    ┌─────────────────▼─────────────────┐
                    │       AGP REST API Server          │
                    │  www.openagp.top:9080/s1M6_uE9/wz  │
                    │  ┌──────────┐  ┌──────────────┐   │
                    │  │ meta-svc │  │ iot-etl-svc  │   │
                    │  └────┬─────┘  └──────┬───────┘   │
                    │       │               │            │
                    │  ┌────▼─────┐  ┌──────▼───────┐   │
                    │  │ MySQL    │  │ StarRocks    │   │
                    │  │wisetao   │  │ WT_DB        │   │
                    │  └──────────┘  └──────────────┘   │
                    └───────────────────────────────────┘

### 3.2 模块划分

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| `ApiClient` | HTTP 请求封装、认证头注入、错误码处理 | `src/api/client.ts` |
| `Tools` | LLM 可见的固定语义工具（9 个） | `tools/` |
| `Adapter` | API 返回 → `AskdataToolValue` 适配 | `src/dsh/adapter.ts` |
| `Config` | API 地址、Token、项目 ID 配置 | `src/config.ts` |
| `DSH Plugin` | 宿主行 + 工具行 + preset 安装 | `src/dsh/plugin.ts`, `src/dsh/tools.ts` |

### 3.3 数据流

    用户提问："查所有水库的当前水位"
        │
        ▼
    LLM 决策：调用 resolve_tag(keyword="水位")
        │
        ▼
    resolve_tag → ApiClient → GET /wz/meta/getModelDataMeta
        │             ?modelName=测点基础模型&searchStr=*&whereStr=tagname LIKE '%水位%'
        ▼
    返回 tagName 列表：["Quantity_1O_SKZH-1#-01F-1", ...]
        │
        ▼
    LLM 决策：调用 tag_real(tagNames=["Quantity_1O_SKZH-1#-01F-1", ...])
        │
        ▼
    tag_real → ApiClient → GET /wz/iot-etl/iot/getTagRealValues
        │             ?tagNames=Quantity_1O_SKZH-1#-01F-1,...
        ▼
    返回实时值 → 渲染给用户

---

## 4. 工具设计（8 个，P1 已移除 query_relation）

### 4.1 `list_models` — 列出所有模型

| 属性 | 值 |
|------|------|
| **API** | `GET /wz/meta/getModelList` |
| **参数** | 无 |
| **返回** | 模型列表（id, class_alias, class_path, class_description） |
| **LLM 提示** | "列出当前项目中所有可用的数据模型，返回模型名称和路径" |

**返回字段**：

    { id, class_alias, class_name, class_path, class_description, classify_tag }

### 4.2 `model_attributes` — 查询模型属性

| 属性 | 值 |
|------|------|
| **API** | `GET /wz/meta/getModelBasAttributes` |
| **参数** | `modelName`（必填，从 list_models 获取） |
| **返回** | 属性列表（field_name, field_description, field_type） |
| **LLM 提示** | "查询某个模型的可用属性列表，用于了解模型有哪些字段可查" |

### 4.3 `query_model` — 查询模型数据

| 属性 | 值 |
|------|------|
| **API** | `POST /wz/meta/postModelDataMeta` |
| **参数** | `modelName`(必填), `searchStr`(必填), `whereStr`, `pageNum`, `pageSize`, `orderByStr`, `groupByStr` |
| **返回** | field 定义 + data 行 + page 分页 |
| **LLM 提示** | "查询模型数据，支持中文属性名。searchStr 为查询字段(如 *), whereStr 为条件(如 年龄>30)" |
| **护栏** | pageSize 上限 1000；searchStr 禁止 DML 关键字 |

**实现说明**：当前全部用 POST 请求。GET/POST 自适应（URL > 2000 字符切 POST）为 P2 优化项。

### 4.4 `tag_real` — 测点实时值

| 属性 | 值 |
|------|------|
| **API** | `GET /wz/iot-etl/iot/getTagRealValues` |
| **参数** | `tagNames`（必填，逗号分隔） |
| **返回** | 每个 tagName 的实时值 |
| **LLM 提示** | "查询一个或多个测点的实时值。tagName 格式为 前缀_粒度_设备" |
| **前置** | 不确定 tagName 时先调 resolve_tag |

### 4.5 `tag_history` — 测点历史原始值

| 属性 | 值 |
|------|------|
| **API** | `GET /wz/iot-etl/iot/getTagRawHistory` |
| **参数** | `tagNames`(必填), `startTime`(必填), `endTime`, `sample` |
| **返回** | 不等间距时间序列 |
| **LLM 提示** | "查询测点的历史原始值（不等间距）。需指定起始时间，可选结束时间或样本数" |
| **约束** | endTime 和 sample 互斥（填了 endTime 则 sample 无效） |

### 4.6 `tag_wide` — 宽格式历史数据

| 属性 | 值 |
|------|------|
| **API** | `GET /wz/iot-etl/iot/getWideHistory` |
| **参数** | `tagNames`(必填), `startTime`(必填), `interval`(必填,秒), `endTime`, `sample`, `dateFormat` |
| **返回** | 等间距拟合值（宽格式：时间 + 各 tagName 列） |
| **LLM 提示** | "查询等间距的历史数据（宽格式），适合画曲线图。interval 为采样间隔(秒)" |

### 4.7 `tag_aggregate` — 测点历史统计值

| 属性 | 值 |
|------|------|
| **API** | `GET /wz/iot-etl/iot/getTagAggrigateHistory` |
| **参数** | `tagNames`(必填), `startTime`(必填), `methods`(必填), `endTime`, `sample`, `params` |
| **返回** | 统计值（按 methods 分列） |
| **LLM 提示** | "查询测点的历史统计值。methods 可选: max/min/mean/rms/count/stddeviation/percentile50 等" |
| **methods 校验** | 枚举 16 种统计方法，拒绝未知方法 |

### 4.8 `resolve_tag` — 测点名解析

| 属性 | 值 |
|------|------|
| **API** | `POST /wz/meta/postModelDataMeta` (modelName=wt_iot_tags) |
| **参数** | `keyword`(必填), `limit` |
| **返回** | 匹配的 tagName 列表 |
| **LLM 提示** | "用中文关键字反查 tagName。如 keyword='水位' 返回所有含'水位'的测点" |
| **实现** | 调 `queryModelData`，whereStr = `tagname LIKE '%keyword%' OR alias LIKE '%keyword%'` |

**注意**：`wt_iot_tags` 是测点基础模型，需确保 API 中已暴露该模型。若 API 未暴露，可回退到 MySQL `wt_iot_tags` 表查询。

---

## 5. 核心模块设计

### 5.1 ApiClient

    // src/api/client.ts
    export class ApiClient {
      private baseUrl: string
      private token: string
      private openid: string
      private projectId: string

      constructor(config: ApiConfig) {
        this.baseUrl = config.baseUrl    // https://www.openagp.top:9080
        this.token = config.token
        this.openid = config.openid
        this.projectId = config.projectId
      }

      async get<T>(path: string, params?: Record<string, string>): Promise<T> {
        const qs = params ? '?' + new URLSearchParams(params) : ''
        const url = `${this.baseUrl}/s1M6_uE9${path}${qs}`
        const resp = await fetch(url, {
          headers: this.headers(),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        return this.handleResponse<T>(resp)
      }

      async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
        const url = `${this.baseUrl}/s1M6_uE9${path}`
        const resp = await fetch(url, {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        return this.handleResponse<T>(resp)
      }

      private headers(): Record<string, string> {
        return {
          'WT-TOKEN': this.token,
          'WT-OPENID': this.openid,
          'WT-PROJECTID': this.projectId,
        }
      }

      private async handleResponse<T>(resp: Response): Promise<T> {
        const j = await resp.json()
        if (j.code === 0) return j.data as T
        if (j.code === '00010') throw askdataError('AUTH_REQUIRED', 'API 未登录，请检查 Token')
        if (j.code === '00011') throw askdataError('AUTH_EXPIRED', 'Token 已过期，请重新获取')
        if (j.code === 1) throw askdataError('INVALID_PARAM', j.message)
        throw askdataError('API_ERROR', `API 错误: ${j.message}`)
      }
    }

### 5.2 配置设计

    // src/config.ts
    export interface ApiConfig {
      baseUrl: string           // AGP 平台地址
      apiPrefix: string         // API 前缀，默认 /s1M6_uE9
      token: string             // WT-TOKEN
      openid: string            // WT-OPENID
      projectId: string         // WT-PROJECTID
      timeoutMs: number         // 请求超时，默认 15000
      maxPageSize: number       // 分页上限，默认 1000
    }

    const DEFAULT_CONFIG = {
      baseUrl: 'https://www.openagp.top:9080',
      apiPrefix: '/s1M6_uE9',
      timeoutMs: 15000,
      maxPageSize: 1000,
    }

**cordis.patch.yml 配置**：

    - insert:
        - id: askdata
          name: 'dsh-agp-askdata-api'
          config:
            api:
              baseUrl: 'https://www.openagp.top:9080'
              apiPrefix: '/s1M6_uE9'
              token: ''              # 从环境变量 ASKDATA_TOKEN 注入
              openid: ''             # 从环境变量 ASKDATA_OPENID 注入
              projectId: '10462'
              timeoutMs: 15000
              maxPageSize: 1000

### 5.3 工具适配器

每个工具的 `run` 方法调用 ApiClient，将 API 返回转换为统一的 `AskdataToolValue`：

    interface AskdataToolValue {
      success: boolean
      toolName: string
      apiOrSql: string       // API 路径（替代 SQL）
      fields: unknown[]      // API field 定义
      data: unknown[]        // API data 行
      rowCount: number
      executionMs: number
      auditId: string
    }

### 5.4 DSH 插件结构

    dsh-agp-askdata-api/
    ├── package.json              # dsh.bundle 声明
    ├── cordis.patch.yml          # 宿主行配置（api 配置）
    ├── dsh-plugin.json           # DSH 插件清单
    ├── preset/askdata/
    │   ├── preset.yml            # preset 名称和描述
    │   └── agent.cordis.yml      # persona + askdata-tools 行
    ├── src/
    │   ├── api/
    │   │   └── client.ts         # ApiClient
    │   ├── config.ts             # 配置
    │   ├── dsh/
    │   │   ├── plugin.ts         # 宿主行
    │   │   ├── tools.ts          # 工具行
    │   │   └── adapter.ts        # 适配器
    │   ├── errors.ts             # 错误码
    │   └── index.ts              # createAskdataService
    ├── tools/
    │   ├── list-models.ts        # Tool 1
    │   ├── model-attributes.ts   # Tool 2
    │   ├── query-model.ts        # Tool 3
    │   ├── query-relation.ts     # Tool 4
    │   ├── tag-real.ts           # Tool 5
    │   ├── tag-history.ts        # Tool 6
    │   ├── tag-wide.ts           # Tool 7
    │   ├── tag-aggregate.ts      # Tool 8
    │   ├── resolve-tag.ts        # Tool 9
    │   ├── types.ts              # 共享类型
    │   └── index.ts              # 导出
    └── tests/
        └── *.spec.ts

---

## 6. 错误处理

### 6.1 API 错误码映射

| API code | 错误码 | 说明 | LLM 处置 |
|----------|--------|------|----------|
| `0` | — | 成功 | — |
| `1` | `INVALID_PARAM` | 参数错误 | 检查参数后重试 |
| `-1` | `API_ERROR` | 系统内部错误 | 报错，等用户确认 |
| `00010` | `AUTH_REQUIRED` | 未登录 | 检查 Token 配置 |
| `00011` | `AUTH_EXPIRED` | Token 过期 | 重新获取 Token |

### 6.2 网络错误

| 场景 | 错误码 | 处置 |
|------|--------|------|
| 连接超时 | `API_TIMEOUT` | 重试 1 次后报错 |
| DNS 解析失败 | `API_UNREACHABLE` | 报错，检查 baseUrl |
| TLS 证书错误 | `API_TLS_ERROR` | 报错，检查证书 |

### 6.3 业务校验

| 校验 | 错误码 | 说明 |
|------|--------|------|
| pageSize > 1000 | `LIMIT_EXCEEDED` | 分页上限 |
| methods 不在枚举 | `INVALID_METHOD` | 统计方法校验 |
| tagName 格式不合法 | `INVALID_TAGNAME` | 格式校验 |
| searchStr 含 DML | `WRITE_REJECTED` | 只读保证 |

---

## 7. 安全设计

### 7.1 认证安全

- **Token 不落盘**：Token 从环境变量 `ASKDATA_TOKEN` 注入，不写配置文件
- **Token 轮换**：Token 有过期时间，需定期从前端获取新 Token
- **项目隔离**：`WT-PROJECTID` 确保数据隔离，只能查当前项目数据

### 7.2 查询安全

- **只读保证**：API 本身只提供 GET 查询接口，无写操作
- **分页限制**：pageSize 上限 1000，防止全表扫描
- **参数校验**：searchStr/whereStr 检查 DML 关键字（INSERT/UPDATE/DELETE/DROP）
- **超时控制**：每个 API 调用有 15s 超时，防止长查询阻塞

### 7.3 网络安全

- **HTTPS**：所有请求走 HTTPS，TLS 加密
- **不暴露数据库**：API 服务器代理数据库查询，客户端无需直连
- **证书校验**：生产环境开启证书校验（开发环境可跳过）

---

## 8. 与现有 dsh-agp-askdata 的迁移策略

### 8.1 共存模式

两个插件可共存于同一 DSH profile：

| 插件 | preset | 通道 | 适用场景 |
|------|--------|------|----------|
| `dsh-agp-askdata` | AGP问数(SQL) | 直连 StarRocks/MySQL | 内网环境，低延迟 |
| `dsh-agp-askdata-api` | AGP问数(API) | REST API | 外网环境，无需数据库 |

### 8.2 迁移路径

1. **阶段 1**：新插件 `dsh-agp-askdata-api` 独立开发，与现有插件共存
2. **阶段 2**：内网环境用 SQL 插件，外网环境用 API 插件
3. **阶段 3**：如 API 性能满足要求，可逐步替代 SQL 插件

### 8.3 复用代码

以下模块可直接复用：

| 模块 | 复用方式 |
|------|----------|
| `src/errors.ts` | 错误码体系完全复用 |
| `src/dsh/adapter.ts` | 适配器结构复用（output schema 已修复） |
| `src/dsh/plugin.ts` | 宿主行结构复用（Config 改为 ApiConfig） |
| `tools/types.ts` | AskdataTool/ToolResult 类型复用 |

---

## 9. 测试策略

### 9.1 单元测试

| 测试项 | 说明 |
|--------|------|
| ApiClient | Mock fetch，验证认证头、错误码映射、超时 |
| 工具参数校验 | 验证必填参数、枚举值、格式校验 |
| 适配器 | API 返回 → AskdataToolValue 转换 |

### 9.2 集成测试

| 测试项 | 说明 |
|--------|------|
| list_models | 验证返回 167 个模型 |
| model_attributes | 验证返回属性列表 |
| query_model | 验证查询数据（用"设备基础模型"） |
| tag_real | 验证返回实时值 |
| tag_aggregate | 验证 16 种统计方法 |

### 9.3 E2E 测试

通过 DSH Web UI 在 AGP问数(API) preset 中对话验证：

| # | 场景 | 期望工具 |
|---|------|----------|
| 1 | "有哪些数据模型？" | `list_models` |
| 2 | "设备模型有哪些属性？" | `model_attributes` |
| 3 | "查所有设备" | `query_model` |
| 4 | "水位测点的实时值" | `resolve_tag` → `tag_real` |
| 5 | "水位最近 24 小时曲线" | `resolve_tag` → `tag_wide` |
| 6 | "水位昨日平均值" | `resolve_tag` → `tag_aggregate` |

---

## 10. 部署配置

### 10.1 DSH profile 集成

**web profile package.json**：

    {
      "dependencies": {
        "dsh-agp-askdata-api": "file:../../git/dsh-agp-askdata-api"
      },
      "dsh": {
        "bundle": ["dsh-agp-askdata-api"]
      }
    }

**环境变量**：

    ASKDATA_TOKEN=6f7463585c85ab0f...24d85
    ASKDATA_OPENID=8a8579cc1ff6b73429670e4;92edc93f71

### 10.2 preset 安装

    preset/askdata-api/
    ├── preset.yml          # name: askdata-api, description: AGP问数(API)
    └── agent.cordis.yml    # persona + askdata-api-tools 行

---

## 11. API 测试验证结果（2026-09-09）

| 接口 | 路径 | 结果 | 备注 |
|------|------|------|------|
| 模型列表 | `/wz/meta/getModelList` | ✅ 成功 | 167 个模型 |
| 模型属性 | `/wz/meta/getModelBasAttributes` | ✅ 成功 | 返回 field_name/field_description/field_type |
| 模型数据 | `/wz/meta/postModelDataMeta` | ✅ 成功 | POST + 7 参数全传（modelName/searchStr/whereStr/pageNum/pageSize/orderByStr/groupByStr），缺任一参数报"系统内部出现错误" |
| 测点实时值 | `/wz/iot-etl/iot/getTagRealValues` | ✅ 成功 | 返回 tagName |
| 历史原始值 | `/wz/iot-etl/iot/getTagRawHistory` | ⚠️ 校验通过，查询报错 | 项目 10462 无时序数据；需 sample 或 endTime 参数 |
| 宽格式历史 | `/wz/iot-etl/iot/getWideHistory` | ⚠️ 校验通过，查询报错 | 同上；需 interval 参数 |
| 历史统计值 | `/wz/iot-etl/iot/getTagAggrigateHistory` | ⚠️ 校验通过，查询报错 | 同上；需 methods + endTime 或 sample 参数 |

**认证信息**：
- 平台地址：`https://www.openagp.top:9080`
- API 前缀：`/s1M6_uE9`（后端）
- 项目 ID：10462（灵知AI测试项目，水利）
- 请求头：`WT-TOKEN` / `WT-OPENID` / `WT-PROJECTID`（3 个即可）
- Token 来源：前端 URL 参数 `WT-TOKEN`

**关键发现**：
1. `postModelDataMeta` 必须 POST，7 个参数全传（值可空字符串），缺任一参数报"系统内部出现错误"
2. 时序接口（getTagRawHistory/getTagAggrigateHistory/getWideHistory）为 GET only，校验层通过但查询报"系统内部出现错误"——项目 10462 无时序数据
3. `searchStr` 可空（返回字段定义 + 0 行数据），`modelName` 必填

---

## 12. 后续工作

| 优先级 | 工作项 | 说明 |
|--------|--------|------|
| ✅ | ApiClient + 8 个 API 工具 | list_models, model_attributes, query_model, tag_real, tag_history, tag_wide, tag_aggregate, resolve_tag |
| ✅ | DSH 插件集成 | 宿主行 + 工具行 + preset + cordis.patch.yml + agent.cordis.yml |
| ✅ | postModelDataMeta 接口调通 | 7 参数全传（值可空） |
| ⚠️ | DSH web 端到端验证 | node_modules 需网络恢复后重装 |
| P1 | 时序接口端到端验证 | 需有真实时序数据的项目 |
| P2 | Token 自动刷新 | 探索登录接口，实现 Token 自动获取 |
| P2 | 性能优化 | API 响应缓存、批量请求 |
| P3 | 关系查询补充 | 探索关系列表接口 |