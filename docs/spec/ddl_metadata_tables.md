# 智能问数 DDL（22 张表 · StarRocks 语法）

> **范围**：智能问数 v3 所需的全部表（11 张 v2/v3 元表 + **11 张源码实证的业务事实表**，见 §16）。
> **目标库**：StarRocks（也兼容 Doris 1.2+，MySQL 需调整部分语法）。
> **字符集**：utf8mb4 / utf8mb4_unicode_ci。
> **部署位置**：`WT_DB`（与现有 WT_DATA 同库），所有表带 `app_id` 列以支持多租户。
> **§16 说明**：WT_CUBE / WT_INVERTER_STATUS 等 11 张表**已由 cus-bole xxl-job 任务在产线写入**（第六轮源码实证），本文件给出其权威 DDL 与枚举口径，问数 Tool 直接查询、**不得重建**。

---

## 0. 数据库初始化

```sql
CREATE DATABASE IF NOT EXISTS WT_DB
DEFAULT CHARACTER SET utf8mb4
DEFAULT COLLATE utf8mb4_unicode_ci;

USE WT_DB;
```

---

## 1. `WT_METRIC_DICT` —— 业务指标字典（v3 必建）

```sql
CREATE TABLE IF NOT EXISTS WT_METRIC_DICT (
    metric_id     BIGINT AUTO_INCREMENT,
    app_id        BIGINT          NOT NULL COMMENT '多租户',
    code          VARCHAR(64)    NOT NULL COMMENT '业务编码,如 HwStringILsl',
    name          VARCHAR(128)   NOT NULL COMMENT '中文名',
    category      VARCHAR(64)    NOT NULL COMMENT 'electricity/dispatch/safety/...',
    formula       VARCHAR(512)               COMMENT '计算公式',
    granularity   VARCHAR(32)                COMMENT 'hour/day/month/year',
    unit          VARCHAR(32)                COMMENT 'kWh/%/m³/min',
    source_tags   ARRAY<VARCHAR(256)>        COMMENT 'tagName 正则数组',
    description   VARCHAR(1024),
    enabled       BOOLEAN         DEFAULT TRUE,
    created_at    DATETIME        DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (metric_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 8
PROPERTIES (
    "replication_num" = "3",
    "enable_persistent_index" = "true",
    "compression" = "LZ4"
);

-- 唯一索引
CREATE UNIQUE INDEX uk_metric_code ON WT_METRIC_DICT(app_id, code);
```

---

## 2. `WT_DEVICE_DIM` —— 实体字典（设备 / 资产 / 对象）

```sql
CREATE TABLE IF NOT EXISTS WT_DEVICE_DIM (
    device_id     BIGINT          NOT NULL,
    app_id        BIGINT          NOT NULL,
    device_code   VARCHAR(64)    NOT NULL,
    device_name   VARCHAR(256)   NOT NULL,
    entity_class  VARCHAR(32)    NOT NULL COMMENT 'WT_EQUIPMENT/WT_ORG/...',
    parent_id     BIGINT          COMMENT '上级设备 ID',
    station_code  VARCHAR(64)    COMMENT '电站编码',
    class_path    VARCHAR(256)               COMMENT '类路径 wt_elm_equipment/...',
    position      VARCHAR(256),
    metadata      JSON                       COMMENT '其他属性 JSON',
    enabled       BOOLEAN         DEFAULT TRUE,
    created_at    DATETIME        DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (device_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 32
PROPERTIES (
    "replication_num" = "3",
    "enable_persistent_index" = "true",
    "compression" = "LZ4"
);

CREATE UNIQUE INDEX uk_device_code ON WT_DEVICE_DIM(app_id, device_code);
CREATE INDEX idx_entity_class ON WT_DEVICE_DIM(app_id, entity_class);
CREATE INDEX idx_parent ON WT_DEVICE_DIM(parent_id);
```

---

## 3. `WT_DYNAMIC_ATTR_MAP` —— ★ v3 动态属性 → 测点映射（必建）

```sql
CREATE TABLE IF NOT EXISTS WT_DYNAMIC_ATTR_MAP (
    map_id          BIGINT AUTO_INCREMENT,
    app_id          BIGINT          NOT NULL,
    entity_class    VARCHAR(64)    NOT NULL COMMENT 'WT_EQUIPMENT 等',
    attr_code       VARCHAR(64)    NOT NULL COMMENT '属性业务编码,temperature',
    attr_display    VARCHAR(64)    NOT NULL COMMENT '中文名,当前温度',
    tag_name_pattern VARCHAR(256)  NOT NULL COMMENT 'tagName 模板,{equipment_code}_temperature_1O_',
    data_type       TINYINT        DEFAULT 2  COMMENT '0=整型/2=双精度',
    unit            VARCHAR(32),
    sampling_rate   INT            DEFAULT 5  COMMENT '采样率(秒)',
    enabled         BOOLEAN        DEFAULT TRUE,
    created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (map_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 8
PROPERTIES (
    "replication_num" = "3",
    "compression" = "LZ4"
);

CREATE UNIQUE INDEX uk_dynamic_attr ON WT_DYNAMIC_ATTR_MAP(app_id, entity_class, attr_code);
```

**示例数据**：

```sql
INSERT INTO WT_DYNAMIC_ATTR_MAP (app_id, entity_class, attr_code, attr_display, tag_name_pattern, unit, sampling_rate) VALUES
(10062, 'WT_EQUIPMENT', 'temperature', '当前温度', '{equipment_code}_temperature_1O_', '°C', 5),
(10062, 'WT_EQUIPMENT', 'pressure',    '当前压力', '{equipment_code}_pressure_1O_',    'MPa', 5),
(10062, 'WT_EQUIPMENT', 'current_power','当前功率', '{equipment_code}_current_power_1O_','kW', 5),
(10062, 'WT_EQUIPMENT', 'running_status','运行状态','{equipment_code}_running_status_2O_',NULL,5);
```

---

## 4. `WT_QUERY_AUDIT` —— 问数审计表（哈希链 + 仅追加）

```sql
CREATE TABLE IF NOT EXISTS WT_QUERY_AUDIT (
    audit_id        BIGINT AUTO_INCREMENT,
    user_id         VARCHAR(64)    NOT NULL,
    app_id          BIGINT          NOT NULL,
    org_id          VARCHAR(64),
    session_id      VARCHAR(64),
    question        VARCHAR(2048)              COMMENT '用户原始问题',
    tool_name       VARCHAR(64)                COMMENT '★ v3: 调用的 Tool 名',
    tool_layer      VARCHAR(16)                COMMENT '★ v3: L1/L2/L3/L4',
    intent_json     VARCHAR(2048)              COMMENT 'LLM 抽取的 Intent',
    sql_text        VARCHAR(4096)              COMMENT '执行的 WT-SQL 或 SQL',
    api_url         VARCHAR(512),
    api_params      VARCHAR(2048),
    row_count       INT,
    execution_ms    BIGINT,
    error_code      VARCHAR(32),
    error_message   VARCHAR(1024),
    result_hash     VARCHAR(64)    NOT NULL COMMENT '★ SHA-256( sql + result_json )',
    prev_hash       VARCHAR(64)                COMMENT '★ 上一条 hash(链式防删)',
    created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (audit_id, created_at)
DISTRIBUTED BY HASH(user_id) BUCKETS 16
PROPERTIES (
    "replication_num" = "3",          -- ★ 至少 3 副本防丢
    "enable_persistent_index" = "true",
    "compression" = "LZ4"
);

-- 业务查询常用索引
CREATE INDEX idx_audit_user_time ON WT_QUERY_AUDIT(user_id, created_at);
CREATE INDEX idx_audit_session ON WT_QUERY_AUDIT(session_id);
```

---

## 5. `WT_FIELD_PERMISSION` —— 字段级权限表（四级权限）

```sql
CREATE TABLE IF NOT EXISTS WT_FIELD_PERMISSION (
    perm_id          BIGINT AUTO_INCREMENT,
    app_id           BIGINT          NOT NULL,
    table_name       VARCHAR(64)    NOT NULL,
    column_name      VARCHAR(64)    NOT NULL,
    permission_level TINYINT        NOT NULL COMMENT '1=平台/2=库/3=分类/4=条目',
    org_id           VARCHAR(64),
    user_id          VARCHAR(64),
    field_owner_org  VARCHAR(64)    COMMENT '★ v3: 字段所有者部门',
    field_class      VARCHAR(32)    COMMENT '★ v3: basic/dynamic/calc/rel/method',
    read             BOOLEAN        DEFAULT TRUE,
    write            BOOLEAN        DEFAULT FALSE COMMENT '智能问数只读,始终 FALSE',
    created_at       DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (perm_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 16
PROPERTIES (
    "replication_num" = "3",
    "compression" = "LZ4"
);

CREATE UNIQUE INDEX uk_field_perm ON WT_FIELD_PERMISSION(app_id, table_name, column_name, org_id, user_id);
```

---

## 6. `WT_TOOL_REGISTRY` —— Tool 注册表（v3 新增）

```sql
CREATE TABLE IF NOT EXISTS WT_TOOL_REGISTRY (
    tool_id         VARCHAR(64)    NOT NULL,
    app_id          BIGINT          NOT NULL DEFAULT 1,
    tool_name       VARCHAR(128)   NOT NULL,
    description     VARCHAR(1024),
    schema_json     VARCHAR(4096),
    interface_layer VARCHAR(16)    NOT NULL COMMENT 'L1/L2/L3/L4',
    enabled         BOOLEAN        DEFAULT TRUE,
    auth_type       VARCHAR(32)    DEFAULT 'open' COMMENT 'whitelist_only/open/restricted',
    created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (tool_id, app_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 4
PROPERTIES ("replication_num" = "3");

-- 17 Tool 注册示例
INSERT INTO WT_TOOL_REGISTRY (tool_id, tool_name, description, interface_layer, auth_type) VALUES
('lookup_metric',     '指标字典查询', '查询 39 个光伏指标字典',                  'L1-metadata',     'open'),
('lookup_entity',     '实体字典查询', '查询 AGP 11 类基础模型实例',                'L1-metadata',     'open'),
('lookup_tag',        '点位字典查询', '查询 WT_TAG 时序点位字典',                  'L1-metadata',     'open'),
('latest_value',      '实时值',       '取 tag 最新值（TSDB HTTP/StarRocks）',       'L1-metadata',     'open'),
('time_series',       '时序明细',     '时序明细查询,按时间桶聚合',                  'L1-metadata',     'open'),
('aggregate',         '时序聚合',     'SQL 端聚合,SUM/AVG/MAX/...',                'L2-base-business','open'),
('aggregate_http',    '高级聚合',     'TSDB HTTP 18 种高级算子',                    'L1-metadata',     'open'),
('wide_history',      '宽表历史',     'TSDB HTTP 宽表,差值电量',                    'L1-metadata',     'open'),
('business_metrics',  '业务事实',     '查 xxl-job 离线计算结果',                    'L4-project',      'whitelist_only'),
('execute_wt_select', '★ WT Select', '★ AGP 中文查询(核心 Tool)',                  'L2-base-business','whitelist_only'),
('query_kg',          '知识图谱',     '实体-关系查询(6 种关系)',                    'L2-base-business','open'),
('search_knowledge',  'RAG 检索',     'RAGFlow 知识库检索',                         'L2-base-business','open'),
('evaluate_rules',    '规则试算',     '★ 业务判定强制走此(水利红线)',                'L3-scenario',     'open'),
('skill',             'Skill 编排',   '场景化能力包调度入口',                       'L3-scenario',     'open'),
('estimate_count',    '安全护栏',     '估算扫描行数,大查询前必调',                  'L1-metadata',     'open');
```

---

## 7. `WT_SKILL_REGISTRY` —— Skill 注册表（v3）

```sql
CREATE TABLE IF NOT EXISTS WT_SKILL_REGISTRY (
    skill_id        VARCHAR(64)    NOT NULL,
    app_id          BIGINT          NOT NULL DEFAULT 1,
    skill_name      VARCHAR(128)   NOT NULL,
    description     VARCHAR(1024),
    trigger_desc    VARCHAR(512)               COMMENT '触发条件(自然语言)',
    tool_ids        ARRAY<VARCHAR(64)>         COMMENT '包含的 Tool 列表',
    prompt_template VARCHAR(4096)              COMMENT 'Skill 专属 system prompt',
    model_class     VARCHAR(64)                COMMENT '★ v3: 绑定实体类',
    enabled         BOOLEAN        DEFAULT TRUE,
    created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (skill_id, app_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 4
PROPERTIES ("replication_num" = "3");

INSERT INTO WT_SKILL_REGISTRY (skill_id, skill_name, description, trigger_desc, tool_ids) VALUES
('intelligent_query', '智能问数',  '通用智能问数入口', '任何取数类问题',
    ['lookup_metric','lookup_entity','aggregate','wide_history','business_metrics','execute_wt_select']),
('water_dispatch',    '防洪调度',  '防洪调度相关查询', '调度/水位/泄洪',
    ['evaluate_rules','lookup_metric','execute_wt_select']),
('emergency_response','应急处置',  '突发事件应急查询',  '报警/应急/事件',
    ['execute_wt_select','search_knowledge','business_metrics']),
('maintenance_guide', '运维规程',  '设备运维相关查询',  '巡检/保养/维修',
    ['execute_wt_select','search_knowledge']);
```

---

## 8. `WT_AGENT_REGISTRY` —— Agent 注册表（v3）

```sql
CREATE TABLE IF NOT EXISTS WT_AGENT_REGISTRY (
    agent_id        VARCHAR(64)    NOT NULL,
    app_id          BIGINT          NOT NULL DEFAULT 1,
    agent_name      VARCHAR(128)   NOT NULL,
    persona         VARCHAR(4096)              COMMENT '角色人设',
    skill_ids       ARRAY<VARCHAR(64)>,
    sub_agent_ids   ARRAY<VARCHAR(64)>,
    enabled         BOOLEAN        DEFAULT TRUE,
    created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (agent_id, app_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 4
PROPERTIES ("replication_num" = "3");

INSERT INTO WT_AGENT_REGISTRY (agent_id, agent_name, persona, skill_ids, sub_agent_ids) VALUES
('query-agent',      '智能问答 Agent', '你是数据查询助手,擅长光伏运维数据查询',
    ['intelligent_query', 'standard_query'], []),
('dispatch-agent',   '调度方案 Agent', '你是调度方案助手',
    ['water_dispatch'],   ['notify-agent']),
('emergency-agent',  '应急处置 Agent', '你是应急指挥员',
    ['emergency_response'], ['notify-agent', 'dispatch-agent']),
('maintenance-agent', '运维规程 Agent', '你是设备运维专家',
    ['maintenance_guide'], ['notify-agent']);
```

---

## 9. `WT_SENSITIVE_TABLES` —— 敏感表白名单（★ v3 必建）

```sql
CREATE TABLE IF NOT EXISTS WT_SENSITIVE_TABLES (
    sensitive_id      BIGINT AUTO_INCREMENT,
    app_id            BIGINT          NOT NULL DEFAULT 1,
    table_name        VARCHAR(64)    NOT NULL,
    reason            VARCHAR(256),
    replacement_tool  VARCHAR(64)               COMMENT '替代 Tool 名',
    enabled           BOOLEAN        DEFAULT TRUE,
    created_at        DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (sensitive_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 4
PROPERTIES ("replication_num" = "3");

CREATE UNIQUE INDEX uk_sensitive ON WT_SENSITIVE_TABLES(app_id, table_name);

INSERT INTO WT_SENSITIVE_TABLES (app_id, table_name, reason, replacement_tool) VALUES
(10062, 'WT_USER_PASSWORD',      '密码字段',          'execute_wt_select(auth_user_safe)'),
(10062, 'WT_PERMISSION',         '权限字段',          'execute_wt_select(权限_公开)'),
(10062, 'WT_AUDIT_LOG_INTERNAL', '内部审计日志',      NULL),
(10062, 'WT_PAYMENT_PRIVATE',    '敏感财务',          'execute_wt_select(财务_汇总)'),
(10062, 'WT_SALARY',             '薪资字段',          'execute_wt_select(薪资_统计)');
```

---

## 10. `WT_KG_NODE` & `WT_KG_EDGE` —— 知识图谱

```sql
-- 节点
CREATE TABLE IF NOT EXISTS WT_KG_NODE (
    node_id     VARCHAR(64)    NOT NULL,
    app_id      BIGINT          NOT NULL,
    node_type   VARCHAR(64)    NOT NULL COMMENT '实体类',
    properties  JSON,
    dataset_id  VARCHAR(64),
    created_at  DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (node_id, app_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 8
PROPERTIES ("replication_num" = "3", "compression" = "LZ4");

-- 边
CREATE TABLE IF NOT EXISTS WT_KG_EDGE (
    from_id     VARCHAR(64)    NOT NULL,
    to_id       VARCHAR(64)    NOT NULL,
    app_id      BIGINT          NOT NULL,
    edge_type   VARCHAR(32)    NOT NULL COMMENT 'is-a/use-a/has-a/contains-a/depends-on/realize',
    properties  JSON,
    weight      DOUBLE         DEFAULT 1.0,
    created_at  DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (from_id, to_id, edge_type, app_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 8
PROPERTIES ("replication_num" = "3", "compression" = "LZ4");
```

---

## 11. `WT_EMERGENCY_PLAN` —— 应急预案（v3）

```sql
CREATE TABLE IF NOT EXISTS WT_EMERGENCY_PLAN (
    plan_id            VARCHAR(64)    NOT NULL,
    app_id             BIGINT          NOT NULL,
    plan_name          VARCHAR(256)   NOT NULL,
    response_level     VARCHAR(8)     NOT NULL COMMENT 'I/II/III/IV',
    trigger_conditions JSON,
    responsible_units  JSON,
    response_steps     JSON,
    resource_list      JSON,
    version            VARCHAR(16)    NOT NULL DEFAULT '1.0',
    enabled            BOOLEAN        DEFAULT TRUE,
    created_at         DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
PRIMARY KEY (plan_id, version, app_id)
DISTRIBUTED BY HASH(app_id) BUCKETS 4
PROPERTIES ("replication_num" = "3", "compression" = "LZ4");
```

---

## 12. 初始化顺序（部署时按此执行）

```bash
# 1. 建库
mysql -h 192.168.101.54 -P 9030 -u root < create_database.sql

# 2. 建表（按顺序：先字典后审计）
for sql in \
    WT_METRIC_DICT.sql \
    WT_DEVICE_DIM.sql \
    WT_DYNAMIC_ATTR_MAP.sql \
    WT_FIELD_PERMISSION.sql \
    WT_SENSITIVE_TABLES.sql \
    WT_QUERY_AUDIT.sql \
    WT_TOOL_REGISTRY.sql \
    WT_SKILL_REGISTRY.sql \
    WT_AGENT_REGISTRY.sql \
    WT_KG_NODE.sql \
    WT_KG_EDGE.sql \
    WT_EMERGENCY_PLAN.sql
do
    mysql -h 192.168.101.54 -P 9030 -u root WT_DB < $sql
done

# 3. 导入业务数据
mysql -h 192.168.101.54 -P 9030 -u root WT_DB < seed_metrics.sql    # 光伏+储能指标（QZXN1–58 族，第六轮源码口径）
mysql -h 192.168.101.54 -P 9030 -u root WT_DB < seed_devices.sql   # 4876 台设备
mysql -h 192.168.101.54 -P 9030 -u root WT_DB < seed_dynamic_attrs.sql
mysql -h 192.168.101.54 -P 9030 -u root WT_DB < seed_permissions.sql
mysql -h 192.168.101.54 -P 9030 -u root WT_DB < seed_sensitive.sql
```

---

## 13. 验证 DDL 是否生效

```sql
USE WT_DB;

-- 应看到 12 张表（11 张智能问数 + 1 张原有 WT_DATA 不计）
SHOW TABLES;

-- 验证 WT_METRIC_DICT
SELECT COUNT(*) FROM WT_METRIC_DICT;

-- 验证 WT_DEVICE_DIM
SELECT entity_class, COUNT(*) FROM WT_DEVICE_DIM GROUP BY entity_class;

-- 验证 WT_DYNAMIC_ATTR_MAP
SELECT entity_class, COUNT(*) FROM WT_DYNAMIC_ATTR_MAP GROUP BY entity_class;

-- 验证 WT_QUERY_AUDIT 已存在
SHOW CREATE TABLE WT_QUERY_AUDIT;
```

---

## 14. 11 张表的整体关系

```
┌──────────────────────────┐
│  WT_METRIC_DICT           │  业务指标字典
└──────────┬───────────────┘
           │ (LLM 反查业务名)
           ▼
┌──────────────────────────┐
│  WT_DEVICE_DIM            │  实体字典(11 类基础模型)
└──────────┬───────────────┘
           │ (动态属性 → tagName)
           ▼
┌──────────────────────────┐
│  WT_DYNAMIC_ATTR_MAP     │  ★ v3 动态属性映射表
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  WT_DATA (已存在)          │  时序主表
└──────────────────────────┘

┌──────────────────────────┐
│  WT_FIELD_PERMISSION       │  四级权限
└──────────┬───────────────┘
           │ (校验层注入 WHERE)
           ▼
┌──────────────────────────┐
│  WT_SENSITIVE_TABLES       │  ★ 敏感表黑名单
└──────────────────────────┘

┌──────────────────────────┐
│  WT_QUERY_AUDIT           │  ★ 审计(哈希链 + 仅追加)
└──────────────────────────┘

┌──────────────────────────┐
│  WT_TOOL_REGISTRY           │  17 Tool 元数据
│  WT_SKILL_REGISTRY          │  场景化能力包
│  WT_AGENT_REGISTRY          │  Agent 元数据
└──────────────────────────┘

┌──────────────────────────┐
│  WT_KG_NODE / WT_KG_EDGE   │  知识图谱
│  WT_EMERGENCY_PLAN         │  应急预案
└──────────────────────────┘
```

---

## 15. 关键 takeaway

1. **11 张表覆盖 v3 全部需求**——字典、权限、审计、知识图谱、应急预案、Skill/Agent
2. **`WT_DYNAMIC_ATTR_MAP` 是 v3 必建**——是 LLM 从"业务名"映射到"tagName"的关键
3. **`WT_QUERY_AUDIT` 必须 3 副本 + 哈希链**——满足"零外传"红线
4. **`WT_SENSITIVE_TABLES` 必填 replacement_tool**——LLM 被拒后能自动换 Tool 重试
5. **所有表带 `app_id`**——支持多租户
6. **DDL 与 AGP 的 WT_QUERY 接口标准兼容**——前端 AGP 后端都能直接消费

---

## 16. ★ 产线业务事实表（第六轮源码实证 · cus-bole xxl-job 已在写入）

> **来源**：`src/main/java/com/talent/job/executor/task/*.java` 的全部 SQL 字面量。
> **问数约定**：这些表**只读查询**（`business_metrics` Tool 路由目标），全部 idempotent（delete-then-insert 重算），写入方为 `guangfu-job-executor`。

### 16.1 `WT_CUBE` —— 聚合立方（核心中间表，cubeType 权威枚举 1–20）

```sql
-- 权威 DDL（源码 insert 列序还原；生产表勿改）
CREATE TABLE IF NOT EXISTS WT_CUBE (
    device       VARCHAR(64)  NOT NULL COMMENT '设备编码(tagName 第4段)',
    tagCode      VARCHAR(64)  NOT NULL COMMENT '离散率等派生码(zcdllsl/NBQDLLSD2...)',
    cubeType     INT          NOT NULL COMMENT '见下方枚举',
    `timestamp`  DATETIME     NOT NULL COMMENT '统计时间(date_trunc 后)',
    granularity  INT          NOT NULL COMMENT '1=Hour 2=Day 3=Month 4=Year 5=Week',
    value        DOUBLE                COMMENT '主值(离散率/电量差/汇总)',
    avgValue     DOUBLE                COMMENT '均值',
    maxValue1    DOUBLE                COMMENT '最大值',
    minValue1    DOUBLE                COMMENT '最小值',
    sumValue     DOUBLE                COMMENT '累计',
    countValue   BIGINT                COMMENT '样本数'
) ENGINE=OLAP
DUPLICATE KEY(device, tagCode, cubeType, `timestamp`)
DISTRIBUTED BY HASH(device) BUCKETS 32
PROPERTIES ("replication_num"="3", "compression"="LZ4");
```

**★ cubeType 权威枚举**（源码 `task/vo/CubeType.java`，修正第五轮 docx 草稿错位）：

| cubeType | 语义 | cubeType | 语义 |
|---|---|---|---|
| 1 / 2 | 华为组串电流 / 电压汇总 | 9 / 10 | **华为**组串电流 / 电压离散率 |
| 3 / 4 | 阳光组串电流 / 电压汇总 | 11 / 12 | **阳光**组串电流 / 电压离散率 |
| 5 / 6 | 华为 / 阳光**逆变器电流**汇总 | 13 / 14 | 华为 / 阳光**逆变器电流离散率** |
| 7 / 8 | 华为 / 阳光**逆变器电量值** | 15 / 16 | 华为 / 阳光**逆变器电量离散率** |
| 17 / 18 | 储能放电量 / 充电量 | 19 / 20 | 储能上网量 / 下网量 |

tagCode 对照：`zcdllsl`↔9/11、`ZCDYLSV`↔10/12、`NBQDLLSD1`↔13/14、`NBQDLLSD2`↔15/16（同码双 cubeType 靠 1/3 号源区分厂家）。注意 `HWNBYC163`=华为逆变器电网 A 相电流（非箱变电流）。

### 16.2 `WT_INVERTER_STATUS` —— 逆变器运行状态（极性已归一化）

```sql
CREATE TABLE IF NOT EXISTS WT_INVERTER_STATUS (
    device       VARCHAR(64) NOT NULL,
    `timestamp`  DATETIME    NOT NULL,
    granularity  INT         NOT NULL COMMENT '1=小时 2=天',
    status       INT         NOT NULL COMMENT '统一口径: 1=停机 0=运行 3=零电流(离网)',
    type         INT         NOT NULL COMMENT '1=华为 2=阳光'
) ENGINE=OLAP
DUPLICATE KEY(device, `timestamp`)
DISTRIBUTED BY HASH(device) BUCKETS 16
PROPERTIES ("replication_num"="3");
```

> 问数规则：**"多少逆变器停机/并网/离网"必须查此表**，禁止从原始点位 `HWNBYC003/YGNBYC003` 自算（两厂家原始极性相反：华为 1=开机、阳光 1=停机，写入前已归一）。零电流判定源=组串电流离散率 cubeType 9/11 无值且状态表无记录。

### 16.3 其余 8 张表（源码所见列）

| 表 | 关键列 | 作用 / 问数口径 |
|---|---|---|
| **WT_BAD_PVS** | device, tagCode | 坏组串黑名单——离散率/低效组串计算已排除，问数答"排除坏串后" |
| **WT_LOW_STRINGS** | day, device, tagCode, type(1华为/2阳光), value, **score** | 低效组串日清单；score=z-score，阈值 −2（pvConfig"低效组串score阈值"） |
| **WT_RESTRICT_INFO** | day, type, sumValue, **sampleSumValue, sampleAvgValue, fullSumValue, lossSumValue**, deviceCount | 限电损失：lossSumValue = sampleAvgValue×deviceCount − sumValue（样板机外推法，样板机=pvConfig 5 台） |
| **WT_INVERTER_FAILURE** | day, failureType, inverterId, value(损失电量), duration(h), **period**("t1,t2;t3,t4" GroupPeriod UDF 输出), type | 故障损失段；仅统计 8–20 点、状态段>7200s 视为断数截断 |
| **WT_DUST** | timestamp, radiaValue, theoreValue, fullSumValue, **fullRatio, actualSumValue, actualCountValue, actualRatio** | 灰尘检测（5 分钟探针 min_by，理论/实际比） |
| **WT_PCS_TIMES** | （CSV StreamLoad 写入：device, status, start, end…） | PCS 状态时段明细（状态 1–7），由 BE:8040 `_stream_load` 写入 |
| **WT_DEVICE_DATA_STAT** | device, day, granularity, name, value | **设备每日采集条数**（采集完整率考核源；保留 10 天） |
| **WT_DEVICE_TAG_STAT** | device, tagCode, timestamp, granularity, name, value | 设备×点位每日条数（同上，点位粒度） |
| **WT_ALL_DEVICES** | device, name | 全设备维表——cross join 补零（无数据设备计 0 条） |

### 16.4tagName 四段式（所有表 tagName 的统一编码，lookup_tag 正则模板依据）

```
tagName = [前缀]_tagCode_粒度段_device
  粒度段首位 = 点类型：1=模拟量 ANALOG，2=状态量 DIGIT/STATUS
  粒度段末位 = 粒度：O=原始 H=小时 D=天 M=月 Y=年
实例：HWNBYC174_1O_DEV001(模拟量原始) / HWNBYC042_2O_DEV001(状态量) / zcdllsl_1H_100620000005933(小时派生)
★ StarRocks 解析：split(tagName,'_') 数组 1 基——[1]=tagCode、[3]=device（NL2SQL 禁用 0 基下标）
```

### 16.5 已注册 StarRocks UDF（问数 SQL 可直接复用）

- **GroupPeriod(fromStatus, toStatus, startTime, endTime)** → `"t1,t2;t3,t4"` 字符串：同设备同状态连续时段合并（WT_INVERTER_FAILURE.period 由它生成）。

### 16.6 数据流（问数可解释性）

```
WT_DATA 原始(_1O_/_2O_, bitand(quality,128)!=128 过滤)
  → WT_CUBE 小时(cubeType 1–8, max/min/sum/count/avg 五列)
  → WT_CUBE 天/月/年(自下层 cube 汇总)
  → WT_DATA 派生点写回(quality=0, concat(tagCode_1H/1D_device))
```

> ★ **答案一致性注意**：重算为 delete-then-insert；但 `CnDianLiangTask.deletePcsData` 对 WT_DATA 的 delete 被注释——**WT_DATA 派生点（_1H_/_1D_）重算后可能叠加重复行**，count 类问数需先 `max_by(timestamp)` 或注明口径。同一指标"准实时算过+离线 02:00 又重算"在补数窗口内结果会波动。
