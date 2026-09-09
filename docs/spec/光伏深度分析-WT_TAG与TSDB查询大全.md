# 光伏项目深度分析 — WT_TAG 字段定义、WT_DATA 查询 SQL 与 TSDB API 全集

> **资料来源**：`D:/doc/taineng/光伏/` 全目录（智道 docs / 部署文档 / 点位表 / `AT_RTDB_API_ice.py` / `query.py` / `FdDianLiangTask.java` / `WT_TAG_202406160942.csv` / `all_devices.csv`）
> **本文定位**：智能问数系统访问 TSDB 的**完整技术参考**——每个字段什么含义、每种查询 SQL 怎么写、每个 API 怎么调。
> 与 `docs/工具实现规范.md`（17 Tool 设计）配合使用：本文是 Tool 实现时 SQL/HTTP/Ice 三通道的"字典"。

---

## 一、WT_TAG 表：测点字典（全部字段定义）

### 1.1 DDL（`部署时序数据库.txt` L103-120）

```sql
CREATE TABLE WT_TAG (
    tagName   varchar(256)  NOT NULL COMMENT "",   -- 测点全名（主键）
    tagIndex  int(11)       NOT NULL COMMENT "",   -- 测点数字索引（WT_DATA 外键）
    dataType  tinyint(4)    NOT NULL COMMENT "",   -- 数据类型枚举
    comment   varchar(1024) NOT NULL COMMENT ""    -- 测点中文描述
) ENGINE=OLAP
PRIMARY KEY(tagName)
DISTRIBUTED BY HASH(tagName) BUCKETS 32
ORDER BY(tagName)
PROPERTIES ("replication_num"="1", "enable_persistent_index"="true",
            "replicated_storage"="true", "compression"="LZ4");
```

### 1.2 逐字段含义（DDL + Ice 定义 + 真实数据三方印证）

| 字段 | 类型 | 含义 | 工程事实 |
|---|---|---|---|
| **tagName** | varchar(256) | 测点唯一名，**自描述三元组** `{业务编码}_{粒度码}_{设备ID}`（详见第二节） | 主键；StarRocks 查询全靠它 regexp/split |
| **tagIndex** | int | 测点的数字索引，WT_DATA / WT_STRINGDATA 通过它与 WT_TAG JOIN | Ice `ATRTDBTagItem.tagIndex` 是 long；由 TSDB 服务端分配（样本中最大 196 万+），**不连续、无语义**，禁止自行推导 |
| **dataType** | tinyint | 测点数据类型，枚举见 1.3 | 决定该测点数据写 `WT_DATA`（数值）还是 `WT_STRINGDATA`（字符串） |
| **comment** | varchar(1024) | 测点中文描述 | **智能问数"中文→测点"检索的主要入口**（`comment LIKE '%发电%'`）；样本中带"时/日/月/年统计测点"后缀的约定见 1.4 |

### 1.3 dataType 枚举（`AT_RTDB_API_ice.py:37-46`，权威定义）

| 值 | 枚举名 | 含义 | 存储表 |
|---|---|---|---|
| 0 | Scaled | 缩放整型（原始值×系数） | WT_DATA |
| 1 | SingleFloat | 单精度浮点 | WT_DATA |
| **2** | **DoubleFloat** | **双精度浮点** | **WT_DATA** |
| 3 | SingleInteger | 32 位整型（遥信/状态） | WT_DATA |
| 4 | DoubleInteger | 64 位整型 | WT_DATA |
| 5 | FixedString | 定长字符串 | WT_STRINGDATA |
| 6 | VariableString | 变长字符串 | WT_STRINGDATA |
| 7 | Blob | 二进制 | （不走 SQL 通道） |
| 8 | Time | 时间型 | WT_DATA |
| 9 | SwitchValue | 开关量（布尔） | WT_DATA |

**真实分布**（`WT_TAG_202406160942.csv`，1,975,575 行实测）：

| dataType | 行数 | 占比 | 对应测点 |
|---|---|---|---|
| 2 (DoubleFloat) | 1,629,096 | 82.5% | 全部 `1O/1H/1D/1M/1Y` 电量、电流、电压、温度等模拟量 |
| 3 (SingleInteger) | 346,479 | 17.5% | 全部 `2O` 保护信号/遥信/刀闸位置 |

> **问数含义**：字符串测点（5/6）在该项目为 0——保护信号也用整型存。查询时 `2O` 测点仍走 WT_DATA（数值 0/1），不走 WT_STRINGDATA。

### 1.4 comment 命名约定（真实样本归纳）

```
QZYC21_1O_100620000002881,1959298,2,"全站当日发电量"              ← 1O：原始累计值
QZYC21_1H_100620000002881,1959294,2,"全站当日发电量时统计测点"      ← 1H：…时统计测点
QZYC21_1D_100620000002881,1959295,2,"全站当日发电量日统计测点"      ← 1D：…日统计测点
QZYC21_1M_100620000002881,1959296,2,"全站当日发电量月统计测点"      ← 1M：…月统计测点
QZYC21_1Y_100620000002881,1959297,2,"全站当日发电量年统计测点"      ← 1Y：…年统计测点
HWNBYC174_1O_100620000015544,970163,2,"3号箱变4号逆变器总发电量"   ← 设备级原始值
35KV1SEG0002_2O_100620000005171,2,3,"35KVI段远方触发录波"          ← 保护信号
```

**派生测点命名规律**：`{comment去掉"时/日/月/年统计测点后缀"} = {comment}` 同业务编码同设备。智能问数可以把 `1O` 的 comment 当作"指标中文名"，把 1H/1D/1M/1Y 当作该指标在四种粒度上的"已预算结果"——**优先查预算测点（一次等值查询），而不是现算差值**。

### 1.5 tagName 三段分布实测

| 中段 | 数量 | dataType | 语义 |
|---|---|---|---|
| `1O` | 1,538,379 | 2 | 实时瞬时/累计原始值（Original） |
| `2O` | 346,559 | 3 | 实时状态/遥信/保护信号 |
| `1H` | 22,445 | 2 | 小时统计（由任务写入） |
| `1D` | 22,445 | 2 | 日统计 |
| `1M` | 22,445 | 2 | 月统计 |
| `1Y` | 22,445 | 2 | 年统计 |

> 22,445 个"指标×设备"组合拥有完整的 H/D/M/Y 四粒度派生测点（如 `QZXN6_发电量`、`QZXN27_理论发电量`、`CNPCSYC52_累计充电量`）。

---

## 二、tagName 命名规则（自描述元数据）

```
tagName = {businessCode}_{typeCode}_{equipmentId}
           QZXN6       _  1D    _ 100620000002881
           ↑指标编码    ↑粒度       ↑设备/电站 ID（15 位）
```

| 段 | 例 | 说明 |
|---|---|---|
| businessCode | `QZXN6` / `HWNBYC174` / `YGNBYC054` / `QZYC21` / `CNPCSYC52` / `35KV1SEG0002` | 业务指标编码。前缀约定：`QZ`=全站、`HW`=华为、`YG`=阳光、`CN`=储能；同业务编码跨厂商共用（华为方阵/阳光方阵模型映射到同一指标） |
| typeCode | `1O` `2O` `1H` `1D` `1M` `1Y` | `1O`=实时原始、`2O`=实时遥信、`1H/1D/1M/1Y`=时/日/月/年统计 |
| equipmentId | `100620000002881`(电站) / `100620000015544`(逆变器) | 对应 `wt_elm_equipment.id` / `all_devices.csv.设备编号`；电站级测点用 stationCode |

**StarRocks 拆解**（数组下标 **1-based**）：

```sql
split(tagName,'_') as tagNames   -- ['QZXN6','1D','100620000002881']
tagNames[1]  -- 业务编码 tagCode
tagNames[2]  -- 粒度码
tagNames[3]  -- 设备 ID device
```

---

## 三、WT_DATA / WT_STRINGDATA：时序数据表

### 3.1 DDL（`部署时序数据库.txt` L123-160）

```sql
-- 数值时序主表（所有 dataType≠5/6 的测点）
CREATE TABLE WT_DATA (
    tagIndex  int(11)     NOT NULL COMMENT "",   -- → WT_TAG.tagIndex
    timestamp datetime    NOT NULL COMMENT "",   -- 采集/统计时间
    quality   smallint(6) NOT NULL COMMENT "",   -- 质量码（bit 掩码）
    value     double      NOT NULL COMMENT ""    -- 工程量值
) ENGINE=OLAP
UNIQUE KEY(tagIndex, timestamp)                          -- ★ 同 tag 同时刻唯一（幂等写）
PARTITION BY time_slice(timestamp, 15, 'day', 'floor')   -- ★ 15 天滚动分区
DISTRIBUTED BY HASH(tagIndex) BUCKETS 1000               -- 按 tagIndex 分桶 1000
PROPERTIES ("replication_num"="1", "enable_persistent_index"="true",
            "replicated_storage"="true", "compression"="LZ4");

-- 字符串时序主表（dataType=5/6）
CREATE TABLE WT_STRINGDATA (
    tagIndex  int(11) NOT NULL,
    timestamp datetime NOT NULL,
    quality   smallint(6) NOT NULL,
    value     varchar(65533) NULL
) ENGINE=OLAP
UNIQUE KEY(tagIndex, timestamp)
PARTITION BY time_slice(timestamp, 5, 'day', 'floor')    -- 5 天分区（字符串量大）
DISTRIBUTED BY HASH(tagIndex) BUCKETS 100;
```

**设计要点（影响所有查询写法）**：
1. **UNIQUE KEY(tagIndex, timestamp)** → 同一测点同一时刻重复写会覆盖（模型为 UPSERT）。补数/重算是安全的。
2. **15 天分区** → 时间条件必须写成 `timestamp >= ? AND timestamp < ?`（左闭右开），让优化器做分区裁剪；`BETWEEN` 也能裁剪但代码一律用 `>=`/`<`。
3. **查任何业务字段都要先 JOIN WT_TAG**——WT_DATA 只有 tagIndex 没有名字。
4. 写入派生数据时代码一律 `quality=0`（GOOD）。

### 3.2 quality 质量码

**文档枚举**（`AT_RTDB_API_ice.py:1063-1084` ATRTDBOriginalStatus）：

| 值 | 枚举 | 含义 |
|---|---|---|
| 0 | GOOD | 正常 |
| 1 | NODATA | 无数据 |
| 2 | CREATED | 已建点未采集 |
| 3 | SHUTDOWN | 停机 |
| 4 | CALCOFF | 计算退出 |
| 5 | BAD | 坏值 |
| 6 | DIVBYZERO | 除零 |
| 7 | REMOVED | 已移除 |
| 8 | DISABLED | 已禁用 |

**工程实际约定（bit 掩码，以代码为准）**：

```sql
and bitand(quality, 128) != 128   -- bit7=128 表示"不可用"，出现于 CnDianLiangTask.java:303,391
```

> 文档枚举最大 8，但工程用 bit7 过滤——实际 quality 是**位掩码**（低 4 位存 OriginalStatus，高位存工程扩展标志）。**智能问数所有数值聚合必须带 `bitand(quality,128) != 128`**，这是坏值过滤的硬约定。另见电量查询附加 `value > 0`（剔除反向走字）。

### 3.3 配套工程表（计算任务自建，非 TSDB 原生）

| 表 | 结构 | 用途 |
|---|---|---|
| **WT_CUBE** | `device, tagCode, cubeType, timestamp, granularity, value, avgValue, maxValue1, minValue1, sumValue, countValue` | 中间聚合立方体：先按设备×指标×粒度聚合，再由它生成 WT_DATA 派生测点与电站汇总。`cubeType`/`granularity` 见 3.4 |
| WT_INVERTER_STATUS | `device, timestamp, status, granularity` | 逆变器运行状态（status=0 运行中），离散率计算用它过滤停机时段 |
| WT_BAD_PVS | `device, tagCode` | 坏组串黑名单，离散率计算排除 |
| WT_DEVICE | `device, subId` | 设备→发电单元归属（两级聚合用） |

### 3.4 CubeType / Granularity 枚举（`task/vo/CubeType.java`、`Granularity.java`）

**Granularity**（WT_CUBE.granularity / date_trunc 单位）：

| 值 | 名称 | date_trunc 描述 |
|---|---|---|
| 1 | Hour | hour |
| 2 | Day | day |
| 3 | Month | month |
| 4 | Year | year |
| 5 | Week | week |

**CubeType**（WT_CUBE.cubeType，20 种）：

| 值 | 枚举 | 含义 | 值 | 枚举 | 含义 |
|---|---|---|---|---|---|
| 1 | HwStringI | 华为组串电流汇总 | 11 | YgStringILsl | 阳光组串电流离散率 |
| 2 | HwStringU | 华为组串电压汇总 | 12 | YgStringULsl | 阳光组串电压离散率 |
| 3 | YgStringI | 阳光组串电流汇总 | 13 | HwInverterILsl | 华为逆变器电流离散率 |
| 4 | YgStringU | 阳光组串电压汇总 | 14 | YgInverterILsl | 阳光逆变器电流离散率 |
| 5 | HwInverterI | 华为逆变器电流汇总 | 15 | HwInverterQLsl | 华为逆变器电量离散率 |
| 6 | YgInverterI | 阳光逆变器电流汇总 | 16 | YgInverterQLsl | 阳光逆变器电量离散率 |
| 7 | HwInverterQ | 华为逆变器电量值 | 17 | CnFdl | 储能放电量 |
| 8 | YgInverterQ | 阳光逆变器电量值 | 18 | CnCdl | 储能充电量 |
| 9 | HwStringILsl | 华为组串电流离散率 | 19 | CnSwl | 储能上网量 |
| 10 | HwStringULsl | 华为组串电压离散率 | 20 | CnXwl | 储能下网量 |

---

## 四、SQL 模板库：查"特定测点特定时间"的全部写法

> 以下模板全部提炼自本项目真实代码（`CnDianLiangTask.java` / `FdLiSanLuTask.java` / `FdDianLiangTask.java`），可直接作为智能问数 Tool 的 SQL 底稿。`?` 为 JDBC 参数占位。

### 4.0 基础款：按测点名查任意时间段原始值（问数最高频）

```sql
-- ① 精确一个测点、一个时间段（明细）
SELECT b.tagName, b.comment, a.timestamp, a.value, a.quality
FROM WT_DATA a
LEFT JOIN WT_TAG b ON a.tagIndex = b.tagIndex
WHERE b.tagName = 'HWNBYC174_1O_100620000015544'
  AND a.timestamp >= '2024-06-01 00:00:00'
  AND a.timestamp <  '2024-06-02 00:00:00'
  AND bitand(a.quality, 128) != 128
ORDER BY a.timestamp;

-- ② 取某测点"特定时刻"的值（整点值，最接近的一条）
SELECT b.tagName, a.timestamp, a.value
FROM WT_DATA a JOIN WT_TAG b ON a.tagIndex = b.tagIndex
WHERE b.tagName = 'QZYC21_1O_100620000002881'
  AND a.timestamp >= '2024-06-01 00:00:00' AND a.timestamp < '2024-06-01 00:05:00'
ORDER BY a.timestamp LIMIT 1;

-- ③ 取某测点最新一条（当前值）
SELECT a.timestamp, a.value
FROM WT_DATA a JOIN WT_TAG b ON a.tagIndex = b.tagIndex
WHERE b.tagName = 'HWNBYC174_1O_100620000015544'
ORDER BY a.timestamp DESC LIMIT 1;

-- ④ 中文模糊找测点（comment 检索 → tagName）
SELECT tagName, tagIndex, dataType, comment
FROM WT_TAG
WHERE comment LIKE '%总发电量%' AND tagName LIKE '%_1O_%'
LIMIT 100;
```

### 4.1 按设备/设备集合查（regexp + split 标准 CTE 骨架）

```sql
-- 某类指标、所有设备、按小时聚合（CnDianLiangTask.java:300 标准 CTE）
WITH baseView AS (
    SELECT tagNames[1] AS tagCode, tagNames[3] AS device, hour, value, timestamp
    FROM (
        SELECT split(tagName,'_') AS tagNames, a.tagIndex,
               date_trunc('hour', timestamp) AS hour, timestamp, value
        FROM WT_DATA a
        LEFT JOIN WT_TAG b ON a.tagIndex = b.tagIndex
        WHERE a.`timestamp` >= ?          -- 开始
          AND a.`timestamp` <  ?          -- 结束
          AND regexp(tagName, ?)          -- 如 '^HWNBYC174_1O_' （参数化前缀）
          AND bitand(quality, 128) != 128
          AND value > 0
    ) temp
)
SELECT device, tagCode, hour, value FROM baseView;
```

**regexp 速查**：

| 意图 | 正则 |
|---|---|
| 某指标全部设备的实时值 | `'^HWNBYC174_1O_'` |
| 某指标全粒度 | `'^QZXN6_'` |
| 某设备全部测点 | `'_[12]O_100620000015544$'` |
| 华为+阳光逆变器电量 | `'^HWNBYC174_1O_'` OR `'^YGNBYC054_1O_'`（代码用两个 regexp OR，FdDianLiangTask.java:1641） |
| 电站级统计测点 | `'^QZYC21_1[HD]_100620000002881$'` |

### 4.2 差值电量（累计值→区间电量）两大写法

**写法 A：SQL 端 max-min（日粒度，`CnDianLiangTask.handleDaylyCubeSumData`:386 / `FdDianLiangTask.getSingleResult`:1637）**

```sql
WITH baseView AS (
    SELECT tagNames[1] AS tagCode, tagNames[3] AS device, day, value, timestamp
    FROM (
        SELECT split(tagName,'_') AS tagNames, a.tagIndex,
               date_trunc('day', timestamp) AS day, timestamp, value
        FROM WT_DATA a LEFT JOIN WT_TAG b ON a.tagIndex = b.tagIndex
        WHERE a.`timestamp` >= '2024-06-01 00:00:00'
          AND a.`timestamp` <  '2024-07-01 00:00:00'
          AND ( regexp(tagName,'^HWNBYC174_1O_') OR regexp(tagName,'^YGNBYC054_1O_') )
    ) temp
),
powerView AS (
    SELECT device, tagCode, day, max(value) - min(value) AS value   -- ★ 当日头尾差 = 日电量
    FROM baseView GROUP BY device, tagCode, day
)
SELECT sum(value) AS value FROM powerView;   -- 全站合计
```

**写法 B：SQL 端 ROW_NUMBER 取小时首尾（`CnDianLiangTask.handleAllPcsExt`:298，含跨小时断点保护）**

```sql
INSERT INTO WT_CUBE(device,tagCode,cubeType,`timestamp`,granularity,value)
WITH baseView AS ( /* 同 4.1，粒度=hour */ ),
RankedValues AS (
    SELECT device, tagCode, rn_asc, rn_desc, hour, timestamp, value
    FROM (
        SELECT device, tagCode, timestamp, value, hour,
               ROW_NUMBER() OVER (PARTITION BY device,tagCode,hour ORDER BY timestamp ASC)  AS rn_asc,
               ROW_NUMBER() OVER (PARTITION BY device,tagCode,hour ORDER BY timestamp DESC) AS rn_desc
        FROM baseView
    ) rn WHERE rn_asc = 1 OR rn_desc = 1          -- 每小时首尾两条
),
temp1 AS (
    SELECT device, tagCode, hour,
           date_diff('hour', lastHour,  hour) AS lastDiff,
           date_diff('hour', firstHour, hour) AS firstDiff,
           lastValue  - value AS lastValue,
           firstValue - value AS firstValue
    FROM (
        SELECT device, tagCode, timestamp, hour, rn_asc, value,
               lead(hour,1)  OVER (PARTITION BY device,tagCode ORDER BY timestamp) AS firstHour,
               lead(value,1) OVER (PARTITION BY device,tagCode ORDER BY timestamp) AS firstValue,
               lead(hour,2)  OVER (PARTITION BY device,tagCode ORDER BY timestamp) AS lastHour,
               lead(value,2) OVER (PARTITION BY device,tagCode ORDER BY timestamp) AS lastValue
        FROM RankedValues
    ) rn WHERE rn_asc = 1
),
powerView AS (
    SELECT device, tagCode, hour,
           CASE WHEN firstDiff = 1  THEN firstValue     -- 正常：本小时首 - 上小时首
                WHEN lastDiff  = 1  THEN lastValue      -- 补偿：下一小时首 - 本小时首
                WHEN firstDiff <= 1 THEN firstValue
                ELSE 0 END AS value                     -- 断点>1小时丢弃，防止累计值回绕误算
    FROM temp1
)
SELECT device, '{origTagCode}' AS tagCode, {cubeType} AS cubeType, hour, 1 AS granularity, value
FROM powerView WHERE hour >= ? AND hour < ?;
```

**HTTP 端写法（推荐，服务端算）**：`getWideHistory` 按 `interval=86400` 取每日 0 点宽表 → 次日0点 − 当日0点 = 日电量（见 5.1）。

### 4.3 离散率（组串电流一致性，`FdLiSanLuTask.handleHourPvLsl`:177）

```sql
INSERT INTO WT_CUBE(device,tagCode,cubeType,`timestamp`,granularity,value,avgValue,maxValue1,minValue1,sumValue,countValue)
WITH baseView AS (
    SELECT tagNames[1] AS tagCode, tagNames[3] AS device, hour, value
    FROM (
        SELECT split(tagName,'_') AS tagNames, a.tagIndex,
               date_trunc('hour', timestamp) AS hour, value
        FROM WT_DATA a LEFT JOIN WT_TAG b ON a.tagIndex = b.tagIndex
        WHERE a.`timestamp` >= ? AND a.`timestamp` < ? AND regexp(tagName, ?)
    ) temp
),
noBadPvView AS (                       -- ① 排除坏组串
    SELECT a.* FROM baseView a
    WHERE NOT EXISTS (SELECT 1 FROM WT_BAD_PVS b WHERE b.device=a.device AND b.tagCode=a.tagCode)
),
baseView1 AS (                         -- ② 只留运行中的逆变器（status=0）
    SELECT * FROM noBadPvView b
    WHERE EXISTS (SELECT 1 FROM WT_INVERTER_STATUS wis
                  WHERE wis.device=b.device AND wis.timestamp=b.hour AND status=0
                    AND granularity=? AND wis.`timestamp`>=? AND wis.timestamp<?)
),
lslView AS (                           -- ③ 按逆变器×小时汇聚组串
    SELECT device, tagCode, hour,
           max(value) AS maxValue1, min(value) AS minValue1,
           sum(value) AS sumValue,  count(value) AS countValue,
           avg(value) AS value
    FROM baseView1 GROUP BY device, tagCode, hour
)
SELECT device, tagCode, {cubeType} AS cubeType, hour, {granularity} AS granularity,
       0 AS value, value AS avgValue, maxValue1, minValue1, sumValue, countValue
FROM lslView;

-- 第二级：逆变器→离散率（(max-min)/avg，公式来自指标字典#1）
INSERT INTO WT_CUBE(...)
SELECT device, '{tagCode}' AS tagCode, {lslCubeType} AS cubeType, `timestamp`, {granularity},
       (max(avgValue) - min(avgValue)) / avg(avgValue) AS value,   -- ★ 离散率
       avg(avgValue), max(avgValue), min(avgValue), sum(sumValue), sum(countValue)
FROM WT_CUBE
WHERE granularity=? AND cubeType=? AND `timestamp`>=? AND `timestamp`<? 
GROUP BY device, `timestamp`;
```

**离散率评级（问数回答时套用）**：≤5% 运行稳定；5–10% 良好；10–20% 待提高；>20% 必须改进。

### 4.4 派生测点回写 WT_DATA（`CONCAT` 拼名 + JOIN 反查 tagIndex）

```sql
-- 计算结果写回时序库的标准姿势（FdLiSanLuTask.insertLslData:219 / CnDianLiangTask:164）
INSERT INTO WT_DATA (tagIndex, timestamp, quality, value)
WITH baseView AS (
    SELECT CONCAT('{tagCode}','_1H_', device) AS tagName, `timestamp`, value  -- 拼出派生测点名
    FROM WT_CUBE wc
    WHERE wc.granularity=? AND wc.cubeType=? AND wc.`timestamp`>=? AND wc.`timestamp`<?
)
SELECT b.tagIndex, `timestamp`, 0 AS quality, value              -- 派生数据 quality 恒写 0
FROM baseView a JOIN WT_TAG b ON a.tagName = b.tagName
WHERE value IS NOT NULL;
```

### 4.5 多指标并列（UNION ALL 逐 tag 列转行，`CnDianLiangTask.handleEPIOfStation`:184）

```sql
SELECT timestamp, sum(swdl) swdl, sum(xwdl) xwdl, sum(zyd) zyd, sum(fdl) fdl, sum(cdl) cdl
FROM (
    SELECT timestamp, value AS swdl, 0,0,0,0 FROM WT_DATA a LEFT JOIN WT_TAG b ON a.tagIndex=b.tagIndex
     WHERE a.timestamp>=? AND a.timestamp<? AND b.tagName=?
    UNION ALL SELECT timestamp, 0, value,0,0,0 FROM WT_DATA a LEFT JOIN WT_TAG b ON a.tagIndex=b.tagIndex
     WHERE a.timestamp>=? AND a.timestamp<? AND b.tagName=?
    UNION ALL ...   -- 每个指标一段
) temp GROUP BY timestamp;
```

### 4.6 预算测点直查（最快路径——优先用）

```sql
-- "6月发电量" → 直接查 1M 测点（无需现算）
SELECT a.timestamp, a.value
FROM WT_DATA a JOIN WT_TAG b ON a.tagIndex = b.tagIndex
WHERE b.tagName = 'QZXN6_1M_100620000002881'
  AND a.timestamp >= '2024-06-01 00:00:00' AND a.timestamp < '2024-07-01 00:00:00'
ORDER BY a.timestamp;
-- 对应："全站当日发电量"=QZYC21、"理论发电量"=QZXN27、"发电量"=QZXN6、"累计充电量"=CNPCSYC52
```

### 4.7 两级聚合滚动汇总（WT_CUBE 自聚合：时→日→月→年）

```sql
-- 小时→天（CnDianLiangTask.handleCubeSumData:407）
INSERT INTO WT_CUBE(device,tagCode,cubeType,`timestamp`,granularity,value)
SELECT device, tagCode, cubeType,
       date_trunc('day', timestamp) AS timestamp, 2, sum(value) AS value
FROM WT_CUBE
WHERE cubeType=? AND granularity=1 AND `timestamp`>? AND `timestamp`<?
GROUP BY device, tagCode, date_trunc('day', timestamp), cubeType;
-- 月/年同理：date_trunc('month'/'year', ...)，从 granularity=2 聚到 3、3 聚到 4
-- 重算前先删：DELETE FROM WT_CUBE WHERE cubeType=? AND granularity=? AND timestamp>=? AND timestamp<?
```

### 4.8 电站级汇总回写（`handleSumDataExt`:370）

```sql
INSERT INTO WT_DATA (tagIndex, timestamp, quality, value)
WITH baseView AS (
    SELECT '{stationTagCode}_1H_{stationCode}' AS tagName, timestamp, sum(value) AS value
    FROM WT_CUBE
    WHERE `timestamp`>=? AND `timestamp`<? AND cubeType=? AND granularity=?
    GROUP BY timestamp
)
SELECT b.tagIndex, timestamp, 0 AS quality, value
FROM baseView a JOIN WT_TAG b ON a.tagName = b.tagName;
```

---

## 五、TSDB HTTP API（对外网关，来自《示例_计算的内容说明.txt》）

**Base URL**：`https://agp.sksyri.com/s1M6_uE9/wz/iot-etl/iot/`（nginx 反代到 TSDB 数据存取服务）

**公共请求头**（三个都必须）：

| Header | 值 | 说明 |
|---|---|---|
| `WT-APPID` | `10062` | 应用 ID（固定值，跨项目会变） |
| `WT-OPENID` | 登录后获得的 OPENID | 开发者身份 |
| `WT-TOKEN` | 登录后获得的 token | 会话令牌 |

### 5.1 `getWideHistory` — 宽格式历史数据（差值电量专用）

```
GET {base}/getWideHistory
Query:
  tagNames  = TAG1,TAG2,TAG3            -- 逗号分隔，可多个
  startTime = 2024-06-01 00:00:00
  endTime   = 2024-07-01 00:00:00
  interval  = 86400                     -- 采样间隔（秒）；86400=每天取 0 点值
返回：每个 tag 在每个整点的值（宽表：timestamp + 各 tag 一列）
```

**官方差值电量算法**：
- 日电量 = 次日 0 点值 − 当日 0 点值
- 月电量 = 7 月 1 日 0 点 − 6 月 1 日 0 点

### 5.2 `getTagAggrigateHistory` — 历史统计聚合（18 种算子）

```
GET {base}/getTagAggrigateHistory
Query:
  tagNames  = TAG1,TAG2
  startTime = 2024-06-01 00:00:00
  endTime   = 2024-06-01 01:00:00     -- 与 sample 二选一：填了 endTime 就不填 sample
  sample    = 50                      -- 采样个数（没填 endTime 时必填）
  methods   = max,min,mean            -- 逗号组合；* = 全部
  param1    = 5                       -- 附加参数（elementat 的下标等）
```

**methods 算子全集（18 种，文档原文）**：

| 算子 | 含义 | 算子 | 含义 |
|---|---|---|---|
| `max` / `min` | 最大 / 最小 | `variance` | 方差 |
| `mean` | 算术平均 | `sumsquare` | 平方和 |
| `rms` | 均方根（平方平均） | `sum` | 合计 |
| `count` | 计数 | `stddeviation` | 标准差 |
| `skewness` | 偏度 | `geometrimean` | 几何平均 |
| `kurtosis` | 峰度 | `populationvariance` | 总体方差 |
| `percentile100/50/10/4` | 百/五十分位/十分位/四分位 | `percentile` | 任意分位（配 param1） |
| `elementat` | 取某下标值（配 param1） | `valueindex` | 数据下标 |

**均值的高阶语义（文档原文）**：均值可分层预算——先算每小时均值（保留 c1..c5 计数与 VG1..VG5 均值），总计 = `Σ(VGi×ci) / Σci` 加权。**问数系统"任意粒度均值"直接查 TSDB 即可，无需重扫明细。**

### 5.3 工程同源的 tag 服务 API（`tagService`，Java metatag-sdk）

计算任务里使用的等价服务层接口（与 HTTP 网关同为 TSDB 的上层封装）：

| 方法 | 参数 | 含义 |
|---|---|---|
| `getTagRealtimeValue(tagNames)` | List\<String\> | 实时值（Map\<tagName, MetaTagValueVO{value,time}\>） |
| `historyWrite(appId, metaTagValues[])` | appId + MetaTagValue{tagName,type=ANALOG,time,value} | 批量写历史（派生测点入库） |
| `historyRawQuery(appId, query)` | MetaTagValueQuery{tags[], timeStart, timeEnd} | 原始历史查询（Map\<tag, MetaTagValue[]\>） |
| `historyInterQuery(appId, query)` | 同上 | 插值历史查询（对齐整点） |

---

## 六、Ice API 全集（`AT_RTDB_API_ice.py`，ANTAI.ATRTDBAPI，56 方法）

### 6.0 连接方式（`query.py:275-289`）

```python
initData = Ice.InitializationData()
initData.properties = Ice.createProperties()
initData.properties.setProperty("Ice.Default.EncodingVersion", "1.0")   # 必须 1.0
initData.properties.setProperty("Ice.MessageSizeMax", "102400000")      # 100MB 大消息
communicator = Ice.initialize(initData)
base = communicator.stringToProxy("ATRTDBServer:default -h {ip} -p {port} -z")
rtdb = ANTAI.ATRTDBAPIPrx.checkedCast(base)
```

### 6.1 时间格式：OLE 日期（关键！）

Ice 通道所有 `timestamp` 是 **double 型 OLE 时间** = 自 **1899-12-30** 起的天数（含小数）：

```python
def local_time_to_ole_time(s):  # '2024-06-01 00:00:00' → 45444.0
    local = datetime.strptime(s, '%Y-%m-%d %H:%M:%S')
    delta = local - datetime(1899, 12, 30)
    return delta.days + delta.seconds / 86400
# 反向：datetime(1899,12,30) + timedelta(days=ole)
```

而 HTTP 通道与 SQL 通道用普通 `'yyyy-MM-dd HH:mm:ss'` 字符串——**两通道时间语义不同，封装 Backend 时必须隔离转换**。

### 6.2 查询参数结构体

```python
ATRTDBQueryParam {                    # 单批统一参数
    type: ATRTDBHDQueryType,          # RawByTime=0 / RawByNumber=1 / Interpolated=2 / Trend=3
    tagNames: string[],               # 测点名列表
    startTime: string,                # 'yyyy-MM-dd HH:mm:ss'
    endTime:   string,
    intervalByMS: int,                # 插值间隔毫秒；-1 = 不插值（原样返回）
    numberOfSamples: int              # 采样个数；-1 = 不限；5000 = 分页批量
}
ATRTDBQueryParamEx2Item {             # v2：每个 tag 独立时间段
    tagName, startTime, endTime, intervalByMS, numberOfSamples
}
ATRTDBQueryParamEx2 { type, paramList: Ex2Item[] }
ATRTDBQueryReverseParam { tagName, startTime, endTime, numberOfSamples }  # 倒序查
```

**HDQueryType 四种模式**：

| 值 | 模式 | 行为 |
|---|---|---|
| 0 | RawByTime | 按时间段取原始值（最常用；配 intervalByMS=-1, numberOfSamples=-1 取全部原始点，`query.py:949-958`） |
| 1 | RawByNumber | 按条数取原始值（分页游标：每次 numberOfSamples 条，推进 startTime 到上批最后时刻+1秒，`query.py:96-147`） |
| 2 | Interpolated | 按 intervalByMS 等间隔插值 |
| 3 | Trend | 趋势压缩（抽稀） |

### 6.3 返回数据结构

```python
ATRTDBDataItem       { tagName, quality:short, timestamp:double(OLE), value:double }
ATRTDBStringDataItem { tagName, quality:short, timestamp:double(OLE), value:string }
ATRTDBTagItem        { tagName, tagIndex:long, dataType, comment }
ATRTDBTagItemEx      { ...TagItem + upLimit, downLimit, threshold }   # 含告警限值
WideDataResultItem   { timestamp:double, valueList:double[] }          # 宽表行：一行多 tag 值
NormalStatisticsItem { tagName, count:long, sum, max, min }            # 四项统计
```

### 6.4 方法全集（按功能分组）

**系统 / 测点管理（TAG_）**

| 方法 | 签名要点 | 用途 |
|---|---|---|
| `APIVersion()` | → string | 服务版本 |
| `TAGLicensedCount()` / `TAGActualCount()` | → (int, err) | 授权点数 / 实际点数 |
| `TAGAdd(tags[])` / `TAGAlter(tags[])` | ATRTDBTagItem[] → (int, errs) | 建 / 改测点（每批 ≤500，`query.py:341`） |
| `TAGDelete(names[])` | → (int, errs) | 删测点 |
| `TAGQuery(mask)` | 通配符如 `*` → (tags, errs) | 模糊查 |
| `TAGQueryByNames(names[])` | 每批 ≤2000 → (tags, errs) | 精确批量查 |
| `TAGQueryEx(mask)` | → (tags, errs, remain, fetchId) | **分页**模糊查 |
| `TAGFetch(fetchId)` | → (tags, errs, remain) | 拉下一页 |
| `TAGArchivedSetting/Query(names, options)` | ARCHIVED / REALTIMEONLY | 归档开关 |
| `TAGCompressionSetting/Query(names, options)` | Enable/DisableCompress | 压缩开关 |
| `TAGStepSetting/Query(names, stepValues)` | StepValue{OFF/ON, compdev} | 阶跃开关（开关量插值是否保持台阶） |
| `TAGFactorSetting/Query(names, factors)` | TagFactor{scale, offset} | 工程量系数（原始值=采集值×scale+offset） |
| `NAMEQuery(type)` / `NAMEFetch(fetchId, type)` | NameType{TAGALM, TAGNotArchived, TAGNotCompress, TAGStep, TAGSpecialFactor, RTDSubscribe, EQ} | 按类别列测点名 |

**实时数据（RTD_）**

| 方法 | 签名要点 | 用途 |
|---|---|---|
| `RTDQuery(names[])` | → (ATRTDBDataList, err) | **取实时值**（缓存层快照，微秒级） |
| `RTDQueryEx(names[])` | → (DataList, errs) | 同上带逐点错误 |
| `RTDWrite(dataList)` / `RTDWriteEx` | → (err/errs, int) | 写实时值 |
| `RTDQueryString(names[])` / `RTDWriteString` | StringDataItem | 实时字符串 |
| `RTDSubscribe(item)` | SubscribItem{tagName, type=TIMETYPE/COUNTTYPE/BOTH/EITHER, count, time} → bool | **订阅推送**（按时间/条数/两者/其一触发） |
| `RTDCancelSubscribe(tagName)` | → bool | 退订 |
| `RTDSubscribeQuery(names)` | → (SubscribItem[], errs) | 查订阅 |
| `RTDRemove(names)` | → (errs, int) | 清实时快照 |

**历史数据（HD_）——问数核心**

| 方法 | 签名要点 | 用途 |
|---|---|---|
| `HDQuery(param)` | ATRTDBQueryParam → (count, DataList, err) | **历史原始/插值/趋势查询**（RawByTime 全量 / RawByNumber 分页） |
| `HDQueryEx(param)` | 同上 + 分页字段 | 分页版 |
| `HDQueryEx2(param)` |QueryParamEx2 → (counts[], DataList, err, remain, fetchId) | **每 tag 独立时间段** |
| `HDFetch(fetchId)` | → (DataList, err, remain) | 历史下一页 |
| `HDWrite(dataList)` / `HDWriteEx` | → (err/errs, count) | 写历史（补数/迁移） |
| **`HDQueryWideHistory(param)`** | → (WideDataResultList, err) | **宽表历史**：N 个 tag 按时间对齐成行（= HTTP getWideHistory 的 Ice 原型） |
| `HDQueryWideHistoryEx` / `HDWDFetch` | 分页版 | 宽表分页 |
| **`HDStatistics(param, type)`** | type: ATRTDBStatisticsType → (double[], err) | **服务端统计聚合**（15 种，见 6.5） |
| `HDNormalStatistics(param)` | → (NormalStatisticsItem[], errs) | 一次返回每 tag 的 count/sum/max/min |
| `HDQueryReverse(params[])` | → (DataList, errs, …) | 倒序取最近 N 条 |
| `HDRemove(names, startTime, endTime, up, down)` | double up/down 值域 → (err) | **删除**指定 tag×时间×值域的数据 |
| `HDQueryString(names, start, end)` | → (StringDataList, remain, fetchId, errs) | 历史字符串（分页） |
| `HDWriteString` / `HDFetchString` | 同上 | 历史字符串写/续拉 |

**告警（ALM_）**

| 方法 | 用途 |
|---|---|
| `ALMSetting(configs)` / `ALMSettingEx(configs)` | 设阈值：ATRTDBAlarmCnfg{tagName, type=Disable/Switch/Analog/Integer, dAlarm 死区, noChange 不变化时限, lowOver2/lowOver1/upOver1/upOver2 双限}; Ex 版多 alarmScript |
| `ALMQuery(names)` | → (AlarmCnfgEx[], confirmList, errs) |
| `ALMConfirm(tags, confirmList)` | 告警确认 |
| `ALMMessage()` | → (DataList, CurStatusList, err) 拉告警消息；CurStatus: STSTUSNORMAL/ALOWOVER2/ALOWOVER1/AUPOVER1/AUPOVER2/DALARM/ANOCHANGE/ALARMCONFIRM/NOTGOOD/HITALARMSCRIPT |

**计算公式（EQ_，TSDB 内置 scripting）**

| 方法 | 用途 |
|---|---|
| `EQTest(eq, timeoutByS)` | 试算：Equation{tag, script, trigger=TriggerSetting{RealTimeData/Timer, triggerTag, intervalByS}} → 单点结果 |
| `EQAdd(eq)` / `EQDelete(tag)` | 注册 / 删除派生点公式 |
| `EQStart(tag, start, end, initValue)` | 对历史区间回算公式 |
| `EQQuery(names)` | → (EquationInfo[]{eq, start, end, status=Ready/Running/Suspend/Complete}) |

### 6.5 ATRTDBStatisticsType 15 种统计（Ice 聚合算子）

| 值 | 名称 | 含义 | 问数场景 |
|---|---|---|---|
| 0 | SUM | 合计 | 发电量合计 |
| 1 | MAX / 2 MIN | 极值 | 峰值/低谷 |
| 3 | AVG | 平均（按压缩块优化） | 平均功率 |
| 4 | VAR / 5 VARP | 样本/总体方差 | 波动分析 |
| 6 | STDEV / 7 STDEVP | 样本/总体标准差 | 离散率 |
| 8 | COUNT | 计数 | 采集条数 |
| 9 | AVTIME | 时间加权平均 | 平均电压（按停留时间） |
| 10 | INTACC | **时间区间积分累加** | 功率→电量（∫P dt） |
| 11 | VCOUNT | 有效值计数 | 有效样本 |
| 12 | VTIME | 有效时间 | 运行时长 |
| 13 | AVGRATIO | 平均比值 | 比率类 |
| 14 | MINRATIO | 最小比值 | 比率类 |

> **`INTACC` 与 `AVTIME` 是 SQL 端很难写对的两个**（积分/加权）——问数遇到"按功率积算电量""加权平均"应优先走 Ice/HTTP 聚合，而不是自己 SQL 逼近。

### 6.6 Ice 客户端典型查询代码（`query.py` 提炼）

```python
# ① 取某测点某时段全部原始值
param = ANTAI.ATRTDBQueryParam()
param.type = ANTAI.ATRTDBHDQueryType.RawByTime
param.startTime = '2020-07-01 00:00:00'
param.endTime   = '2020-07-02 00:00:00'
param.tagNames  = [tagName]
param.intervalByMS = -1      # -1,-1 = 原始全量
param.numberOfSamples = -1
count, dataList, error = rtdb.HDQuery(param)
for d in dataList:
    print(ole_time_to_local_time(d.timestamp), d.value, d.quality)

# ② 大时间段分页（RawByNumber 游标推进）
param.type = ANTAI.ATRTDBHDQueryType.RawByNumber
param.numberOfSamples = 5000
while begin < dbEnd:
    count, dataList, error = rtdb.HDQuery(param)
    lastTime = dataList[-1].timestamp
    begin = lastTime + 1.0/86400.0        # OLE 1 秒 = 1/86400 天

# ③ 遍历全部测点（分页）
count, tags, errors, remain, fetchId = rtdb.TAGQueryEx('*')
while remain > 0:
    count, tags, errors, remain = rtdb.TAGFetch(fetchId)
```

---

## 七、三通道对比与问数选型

| 通道 | 端点 | 时间格式 | 优势 | 局限 | 问数 Tool 选择 |
|---|---|---|---|---|---|
| **StarRocks SQL 直连** | `jdbc:mysql://FE:9030/WT_DB` | datetime 字符串 | 任意 CTE/JOIN/窗口/跨表；WT_CUBE 可复用 | 需自己写对 quality/分区/差值 | `latest_value` `time_series` `aggregate` `estimate_count` 及全部字典 Tool |
| **HTTP 网关** | `/iot-etl/iot/getWideHistory`、`getTagAggrigateHistory` | 字符串 | 18 种高级算子；宽表对齐；服务端压缩块聚合优化 | GET 传参、tag 多时 URL 长；需 WT-APPID/OPENID/TOKEN | `aggregate_http` `wide_history`（差值电量） |
| **Ice (ZeroC)** | `ATRTDBServer:default -h ip -p port -z` | **OLE double** | 全功能 56 方法；实时值/订阅/告警/公式/批量写；大吞吐 | 二进制协议、需 SDK、时间要转换 | 实时值兜底 `RTDQuery`；订阅推送；`INTACC/AVTIME` 等特殊统计 |

**选型决策树（问数意图 → 通道）**：

```
用户问题
├─ "当前/最新值"        → RTDQuery (Ice) 或 latest SQL (tagIndex 倒序)
├─ "某时刻/明细曲线"     → SQL 直查 WT_DATA（4.0）
├─ "小时/日/月/年电量"   → ① 预算测点直查 1H/1D/1M/1Y（4.6，最快）
│                        ② getWideHistory interval=86400 差值（5.1）
│                        ③ SQL max-min（4.2A，兜底）
├─ "均值/最值/标准差"    → aggregate_http methods=…（5.2）或 SQL（4.1）
├─ "离散率/一致性"       → SQL 模板 4.3（需 WT_INVERTER_STATUS/WT_BAD_PVS）
├─ "加权平均/积分电量"   → Ice HDStatistics AVTIME / INTACC（6.5）
└─ "跨设备对比/排名"     → SQL split+regexp（4.1）+ ROW_NUMBER
```

---

## 八、智能问数 30 个典型场景 → SQL/API 映射速查

| # | 用户问题 | 映射 | 写法 |
|---|---|---|---|
| 1 | 3号箱变4号逆变器现在发电量多少 | RTD/SQL | `comment='3号箱变4号逆变器总发电量'` 找 tagName → ORDER BY timestamp DESC LIMIT 1（4.0③） |
| 2 | 昨天全站发电量 | 预算测点 | `QZXN6_1D_{station}` 取昨天那条（4.6） |
| 3 | 6月发电量 | 预算测点 | `QZXN6_1M_{station}`（4.6） |
| 4 | 华为逆变器昨天总发电 | 差值 | regexp `^HWNBYC174_1O_` + max-min per device per day，sum（4.2A） |
| 5 | 某逆变器今天每小时发电 | 差值 | 同上但 date_trunc('hour')（4.2B 完整版） |
| 6 | 理论发电量 | 预算测点 | `QZXN27_1D/1M/1Y_{station}`（comment="理论发电量…统计测点"） |
| 7 | 逆变器效率 | 公式 | 逆变器输出电量/输入电量（`QZXN61_1D_` 样本，FdDianLiangTask:312） |
| 8 | 方阵效率 | 公式 | 逆变器输入电量/理论发电量（`QZXN60_1D_`，FdDianLiangTask:313） |
| 9 | 厂用电率 | 公式 | 厂用电量/发电量（FdDianLiangTask:325） |
| 10 | 等效利用小时数 | 公式 | 发电量/装机容量（派生测点：电量/60，FdDianLiangTask:1267） |
| 11 | 3号逆变器组串电流离散率 | SQL | 模板 4.3，regexp `^HWZC…_1O_{deviceId}$` → (max-min)/avg |
| 12 | 离散率评级 | 同上+规则 | 算出值套 5%/10%/20% 四档 |
| 13 | 昨天停机的逆变器 | 状态表 | `WT_INVERTER_STATUS WHERE status!=0 AND timestamp IN 昨天` |
| 14 | 35KVI段母线电压 | 1O 测点 | comment LIKE '%母线%电压%' + `35KV1SEG` 前缀（样本 `35KV1SEG0791_1O_`） |
| 15 | 保护动作记录 | 2O 测点 | dataType=3，`'^35KV1SEG_2O_'`，value=1 触发，取 timestamp |
| 16 | 储能今天充电量 | 预算测点 | `CNPCSYC52_1D_{device}`（comment="累计充电量日统计测点"） |
| 17 | 储能充放电曲线 | CubeType | WT_CUBE cubeType=17(放电)/18(充电) 直查 |
| 18 | 全站当月上网电量 | 预算测点 | 上网电量 tagCode `_1M_{station}` |
| 19 | 哪台逆变器发电量最低 | SQL | 4.2A 去掉 sum，ORDER BY value ASC LIMIT 1 |
| 20 | 各方阵发电量排行 | SQL | 4.2A 按 device 分组 ORDER BY DESC |
| 21 | 两组串电流对比曲线 | 宽表 | getWideHistory tagNames=串A,串B interval=900 |
| 22 | 昨天平均气温 | SQL/HTTP | comment 环境温度 → mean（5.2 methods=mean） |
| 23 | 昨天最大风速及时间 | SQL | max(value) + arg_max（max_by(value,timestamp)） |
| 24 | 辐照总量 | 预算测点 | 总辐射 1D 累计值测点 |
| 25 | 日照小时数 | 定义 | 辐照度≥120W/m² 的时长：value>=120 的 count × 采样间隔 |
| 26 | 功率积算电量 | Ice | HDStatistics INTACC |
| 27 | 电压加权平均 | Ice | HDStatistics AVTIME |
| 28 | 今年比去年发电量 | 对比 | 两个 `1Y` 预算测点相减 |
| 29 | 某天数据缺失检查 | 审计 | count(*) per hour，找 date_diff 空洞（模板 4.2B 的 lastDiff 变体） |
| 30 | 手动补算 6.28 10:00-13:00 | 规范 | 触发对应计算 Task，参数 `'2024-06-28 10:00:00,2024-06-28 13:00:00'`（指标计算规范#3） |

---

## 九、智能问数实现必须遵守的 10 条硬约定

1. **quality 过滤**：所有 WT_DATA 聚合带 `bitand(quality,128) != 128`；电量类再加 `value > 0`。
2. **时间条件左闭右开**：`>= start AND < end`，命中 15 天分区裁剪；禁用函数包裹 timestamp（如 `date(timestamp)` 会全表扫）。
3. **先预算后现算**：1H/1D/1M/1Y 测点存在时直查，禁止重算差值（结果可能因补数不一致）。
4. **写派生数据 quality=0**，tagName 必须先在 WT_TAG 存在（JOIN 不到即静默丢数——写前确认测点已建）。
5. **tagIndex 无语义**：永远通过 WT_TAG JOIN / TAGQuery 获取，禁止拼数字。
6. **Ice 时间是 OLE double**（1899-12-30 起的天数），HTTP/SQL 是字符串——Backend 层封装转换，Tool 层统一 `yyyy-MM-dd HH:mm:ss`。
7. **UNIQUE KEY 幂等**：同 tag 同时刻重写覆盖。补数安全，但"追加写"语义不存在。
8. **分页协议**：Ice 用 remain/fetchId 续拉（TAGFetch/HDFetch/HDWDFetch/HDFetchString）；SQL 用 LIMIT+timestamp 游标。
9. **appId 多租户**：HTTP 头 `WT-APPID`、服务层 `historyWrite(appId,…)` 都带 appId——问数系统不能硬编码 10062。
10. **表达式测点**（EQ_）存在意味着部分 1H/1D/1M/1Y 测点由 TSDB 公式自动计算——写值前先 `EQQuery` 确认，避免双写冲突。

---

## 十、来源文档索引

| 关注点 | 文件 | 位置 |
|---|---|---|
| WT_TAG/WT_DATA/WT_STRINGDATA DDL | `智道/部署文档/部署时序数据库.txt` | L103-160 |
| WT_TAG 真实样本 197 万行 | `智道/WT_TAG_202406160942.csv` | 全文件 |
| 设备清单 4875 台 | `智道/all_devices.csv` | 全文件 |
| HTTP API（getWideHistory/getTagAggrigateHistory） | `智道/docs/示例_计算的内容说明.txt` | 全文 |
| Ice API 完整定义（56 方法+枚举+结构体） | `智道/AT_RTDB_API_ice.py` | L24-1194（类型）、L1896-2839（Prx 方法+Operation 签名） |
| Ice 客户端用法（连接/分页/时间转换） | `智道/query.py` | L11-30（OLE 时间）、L275-323（连接+遍历）、L949-958（RawByTime 参数） |
| 差值电量 SQL + WT_CUBE + ROW_NUMBER/lead | 本工程 `CnDianLiangTask.java` | L153-170、L289-415 |
| 离散率两级聚合 SQL | 本工程 `FdLiSanLuTask.java` | L172-228 |
| 电量任务 Java 侧实现 + tagService API | `智道/FdDianLiangTask.java` | L39-70、L1633-1662 |
| CubeType/Granularity 枚举 | 本工程 `task/vo/CubeType.java`、`Granularity.java` | 全文 |
| 39 指标字典 | `智道/docs/示例_指标字典xlsx.txt` | 全文 |
| 4 行总公式 + 层次架构 | `智道/docs/示例_博乐发电项目的计算要求.txt` | 全文 |
| 计算任务 6 条规范（json 配置/补数格式） | `智道/docs/示例_指标计算规范.txt` | 全文 |
| 点表原始定义（104 规约侧） | `智道/点表及对应关系/*.csv`、`智道/点位表/*.xlsx` | huawei/yangguang/pcs 列：序号,设备,地址,名称,单位,系数,遥测/遥信 |
| 模拟数据清理 | `智道/部署文档/时序库服务器模拟数据生成与清除.txt` | 全文 |
| AGP nginx 路由 | `智道/docs/示例_AGP部署操作手册.txt` | 全文 |
| WISETao Web 工程（AlarmController + DataSource 们） | `E:\src\WISETao_custom_demo` | `cn.wisetao.bole` 包，37 java |
| WISETao 离线任务工程（IMetaTagService + JdbcTemplate 调用） | `D:\svn\WISETao_custom_demo` | `com.talent.job.executor` 包，52 java |

---

## 十一、MySQL 业务数据接口全集（Web 工程 `E:\src\WISETao_custom_demo`）

> **背景**：前文 §一~§十 只覆盖 TSDB（StarRocks/Ice/HTTP）取数通道。但智能问数还有一类问题走 **MySQL 业务库**（告警记录、设备元数据、告警配置、类路径信息）。本节梳理 `E:\src\WISETao_custom_demo`（`cn.wisetao.bole` Web 工程）的全部数据获取入口。
>
> **数据源配置**（`DruidSource.java`）：
> - `dataSource` → 元数据库（生产 `wisetao_meta`，测试 `wisetao_metatest`）：wt_iot_tags / wt_elm_equipment / wt_bas_alarmrecord / meta_classtagmodel 等
> - `customDataSource` → 业务库（`bole`）：wt_cus_alarmdynamicconfig 等定制配置
> - `DataSources.java` 继承 `AbstractRoutingDataSource`，通过 `ThreadLocal<Stack>` 支持运行时切换；`MagicDynamicDataSourceConfig.java` 给 magic-api 用

### 11.1 REST 接口（AlarmController，9 个 GET）

| 路径 | 方法 | 数据源 | 语义 | 底层实现 |
|---|---|---|---|---|
| `/alarm/count` | GET | **MySQL 元数据库** | 告警按类路径+类型分组统计 | `IAlarmInfoServiceImpl.getAlarmCount` → `listByParams` 查 `wt_bas_alarmrecord` + `IClassInfoService.detail` 查类路径中文名 |
| `/alarm/hotCameraAlarmState` | GET | **TSDB Ice** + MySQL | 热斑相机告警状态（32 位 bitmask 解析） | `HotCameraAlarmTableSource` → `IObjectService.queryObjectBaseAttributeList` 查设备 + `IMetaTagService.getTagRealtimeValue` 取实时值 |
| `/alarm/handler` | GET | **MySQL 元数据库** | 处理告警（**写操作**，问数系统禁用） | `IAlarmInfoServiceImpl.handlerAlarm` → `updateByIdSelective` |
| `/alarm/getTagAlarmStatus` | GET | **Redis** | 测点告警状态（key `tag_alarm_{tagName}`） | `IAlarmInfoServiceImpl.getTagAlarmStatus` → `redissonClient.getBucket` |
| `/alarm/alarmInfoWatch` | GET | TSDB + MySQL | 测试接口（定时任务触发） | `AlarmInfoWatchTask` 调度 |
| `/alarm/nbqGlpcTable` | GET | **TSDB Ice** + MySQL | 逆变器功率偏差曲线（实际值 vs 目标值 vs 偏差） | `NbqGlValueListDataSource` → `historyInterQuery` 插值查询 |
| `/alarm/nbqGlpcRankTable` | GET | **TSDB Ice** + MySQL | 逆变器功率偏差排名（实时值） | `NbqGlValueRankDataSource` → `getTagRealtimeValue` 实时查询 |
| `/alarm/dmbMonthTable` | GET | **TSDB Ice** + MySQL | 月报表（逆序查询，支持年/月下钻） | `DmbMonthTableDataSource` → `historyQueryReverse` 逆序查询 + `tagBook` 测点字典 |
| `/alarm/dmbMonthTableV2` | GET | **TSDB Ice** + MySQL | 月报表 V2（插值查询，仅月逐日） | `DmbMonthTableV2DataSource` → `historyInterQuery` 插值查询 + `tagBook` 测点字典 |

### 11.2 IMetaTagService 调用点（TSDB Ice 通道，Web 工程侧）

| 调用方法 | 调用位置 | 语义 | 入参要点 |
|---|---|---|---|
| `historyInterQuery(0L, query)` | `NbqGlValueListDataSource:242`、`DmbMonthTableV2DataSource:159` | 插值历史查询 | `MetaTagValueQuery{tags, timeStart, timeEnd?, sample, interval?}` |
| `historyQueryReverse(0L, query)` | `DmbMonthTableDataSource:207` | **逆序历史查询**（取最近 N 个点） | 同上，时间起止可互换表示逆序 |
| `getTagRealtimeValue(tagNames)` | `NbqGlValueRankDataSource:168,172`、`HotCameraAlarmTableSource:90` | 实时值查询 | `List<String>` tagNames → `Map<String, MetaTagValueVO>` |
| `tagBook(0L, tagnames)` | `DmbMonthTableDataSource:339`、`DmbMonthTableV2DataSource:296` | **测点字典查询**（取 comment 中文名） | `String[]` tagnames → `MetaTagBook` |
| `historyRawQuery(0, query)` | `NbqGlValueRankDataSource:203`（**已注释**） | 原始历史查询（被逆序/插值替代） | — |

> **appId 硬编码 0L**：Web 工程所有 Ice 调用第一个参数都是 `0L`，与离线任务工程（`D:\svn` 用 `appId=10062L`）不同。问数系统需注意多租户隔离。

### 11.3 IObjectService 调用点（MySQL 元数据通道）

| 调用方法 | 调用位置 | 语义 | 查的表 |
|---|---|---|---|
| `queryObjectBaseAttributeList(query)` | 6 个 DataSource 都用 | 按条件查设备/对象基础属性 | `wt_elm_equipment`（设备树）+ 任意 classPath 表 |

**查询模式**（`ObjectBaseAttributeQueryEntity`）：
- `classPath`：类路径，如 `wt_elm_equipment`、`wt_elm_equipment/wt_iot_hotsoptcam`
- `conditionGroups`：条件组（AND/OR），支持 `=`/`like`/`in` 等
- `selectFields`：投影字段，常见 `id, node_name, node_code, class__path, parent_ids, position`
- `useDistinct`：去重

### 11.4 MyBatis-Plus 间接查询（`IAlarmInfoServiceImpl` 继承 `MetaObjectServiceImpl<AlarmRecord>`）

| 方法 | 数据源 | 查的表 | 语义 |
|---|---|---|---|
| `listByParams(queryParam)` | MySQL 元数据库 | `wt_bas_alarmrecord` | 按条件查告警记录列表 |
| `getById(id)` | MySQL 元数据库 | `wt_bas_alarmrecord` | 按 id 查单条告警 |
| `updateByIdSelective(entity)` | MySQL 元数据库 | `wt_bas_alarmrecord` | **更新告警（写操作）** |

> **未找到 MyBatis Mapper XML**：`E:\src\WISETao_custom_demo\src\main\resources` 下无 `*.xml`。推测用 MyBatis-Plus 注解模式或上游 jar 里的 Mapper。

### 11.5 离线任务工程（`D:\svn\WISETao_custom_demo`）的数据获取

| 通道 | 实现类 | 用途 |
|---|---|---|
| **JdbcTemplate**（`timeDatasource`=StarRocks 9030） | `BasicTask` / `CnDianLiangTask` / `FdLiSanLuTask` 等 | 大量 `jdbcTemplate.query/update`，读 WT_CUBE/WT_DATA 算派生值后写回 |
| **StarRocksStreamLoad** | `StarRocksStreamLoad.java` | `PUT http://{host}:8040/api/{db}/{table}/_stream_load` 写 WT_DATA |
| **IMetaTagService** | `BasicTask` 等 | `historyRawQuery` / `historyInterQuery` / `historyWrite` / `realtimeWrite` |
| **HTTP 网关**（被注释） | `BasicTask.getWideHistory` | `GET {pvConfig.url}/getWideHistory` + 三头鉴权，测试环境未部署 |

### 11.6 智能问数通道选型建议

| 问题类型 | 走哪个通道 | 理由 |
|---|---|---|
| "某测点某时段的历史曲线" | TSDB Ice `historyInterQuery` 或 StarRocks SQL | Web 工程生产用 Ice；本插件 P0 已实现 StarRocks SQL |
| "某测点最新值" | TSDB Ice `getTagRealtimeValue` | 实时性要求高，Ice 单点查询快 |
| "某测点的中文名/描述" | TSDB Ice `tagBook` 或 MySQL `wt_iot_tags.comment` | tagBook 一次查多个；MySQL 适合 LIKE 模糊检索 |
| "某设备的告警记录" | MySQL `wt_bas_alarmrecord` | 告警存 MySQL，TSDB 不存告警 |
| "某类路径下的所有设备" | MySQL `wt_elm_equipment` via `IObjectService` | 设备树在 MySQL |
| "告警配置" | MySQL `wt_cus_alarmdynamicconfig`（bole 库） | 定制配置在业务库 |
| "月报表（最近 N 天）" | TSDB Ice `historyQueryReverse` | 逆序查询，避免拉全月再截断 |
| "逆变器功率偏差排名" | TSDB Ice `getTagRealtimeValue` + 应用层排序 | 实时值 + 内存排序 |

> **关键约束**：本插件是**只读系统**（AGENTS.md 红线），`/alarm/handler`、`updateByIdSelective`、`historyWrite`、`realtimeWrite`、StreamLoad 等写接口**禁止接入**。问数系统只暴露上述查询接口。

---

## 十二、补充勘误与深挖（第二轮扫描遗漏项）

> 本节是对 §十一 的补充，覆盖第一轮扫描遗漏的：定时任务、RabbitMQ 消费者、外部 HTTP API、Ice 订阅通道、16 个离线 Task、StarRocks UDF、pvConfig.json 全量、application-dev.yml 全量、Entity 表名确认、StarRocks 派生表清单。

### 12.1 E:\src 遗漏的定时任务与消费者（3 个）

| 类 | 类型 | 数据通道 | 语义 |
|---|---|---|---|
| `AlarmInfoWatchTask` | @Component 定时任务 | Ice `getTagRealtimeValue` + MySQL `IObjectService`/`IAlarmInfoService` + JdbcTemplate `batchUpdate` | 告警数据监控：查告警配置 → 查设备 → 查测点实时值 → 判断告警 → 写 `wt_bas_alarmrecord` + 查告警白名单 `wt_10062_gaojingbaimingdanpeizhimoxing` |
| `ArrayAlarmInfoWatchTask` | @Component 定时任务 | Ice `getTagRealtimeValue`/`realtimeWrite`/`historyRawQuery` + MySQL `IObjectService` + **外部 HTTP**（无人机） | 方阵离散度告警监控：查方阵/箱变/逆变器 → 查离散率测点 → 查无人机热斑 → 写告警测点 + 查方阵告警配置 `wt_10062_fangzhengaojingpeizhibiao` |
| `CusTagAlarmConsumer` | RabbitMQ 消费者（extends `RabbitConsumer`） | Redis `redissonClient` + MySQL `IAlarmInfoService` + **Ice 订阅** `RTDBClient.Config.valueSubscribe` | 告警事件消费：监听告警产生/恢复 → Redis 状态机（次数/时长校验）→ 写 `wt_bas_alarmrecord` → 订阅测点实时值恢复 |

### 12.2 外部 HTTP API（新通道，§十一 未覆盖）

| API | 调用位置 | 用途 | 鉴权 |
|---|---|---|---|
| `POST http://123.60.30.34:90/uavserver/admin/login` | `ArrayAlarmInfoWatchTask:173` | 无人机服务登录，返回 token | body `{"username":"GF_TNKJ","password":"abc123!@#"}`（配置可覆盖） |
| `GET http://123.60.30.34:90/uavserver/uvaInspection/data/center/countByArray?stationId=5&planId=-1` | `ArrayAlarmInfoWatchTask:195` | 查热斑告警方阵 | header `{tokenName: tokenValue}` |
| `PUT http://{host}:8040/api/{db}/{table}/_stream_load` | `StarRocksStreamLoad:35` | StarRocks Stream Load 写入 | Basic Auth `root:` |

> **无人机 API 配置来源**：`ArrayAlarmConfig` 实体从 MySQL 表 `wt_10062_fangzhengaojingpeizhibiao` 读取（字段 `wrj_ip`/`account`/`passwd`），硬编码默认值 `123.60.30.34:90` / `GF_TNKJ` / `abc123!@#`。

### 12.3 Ice 订阅通道（新，§十一 未覆盖）

| 方法 | 调用位置 | 语义 |
|---|---|---|
| `RTDBClient.Config.valueSubscribe(0, item)` | `CusTagAlarmConsumer:232` | 订阅测点实时值变化（告警恢复检测），`ATRTDBSubscribItem{tagName, count, time, type}` |

> 这是 Ice API 的**订阅模式**（push），与 §六 的查询模式（pull）不同。问数系统用不到订阅，但需知道告警恢复是靠订阅触发的。

### 12.4 D:\svn 离线任务工程 16 个 Task 类全集

| Task 类 | 业务语义 | Ice 读 | Ice 写 | JdbcTemplate（StarRocks） | 写入表 |
|---|---|---|---|---|---|
| `BasicTask` | 基类 | `historyRawQuery`/`historyInterWideQuery` | `historyWrite` | — | — |
| `BasicXjdTask` | 差值电量基类 | `historyInterWideQuery`/`getTagRealtimeValue` | — | — | — |
| `XjdTask` | 差值电量（阳光/华为/PCS） | `getTagRealtimeValue`/`historyInterQuery` | `realtimeWrite`/`historyWrite` | — | — |
| `FdDianLiangTask` | 发电量任务 | `historyInterWideQuery` | `historyWrite` | — | — |
| `FdNengHaoTask` | 能耗任务（34 指标） | `historyRawQuery` | `historyWrite`（×14） | — | — |
| `FdGuiFanHuaTask` | 规范化指标任务 | `historyRawQuery` | `historyWrite` | — | — |
| `FdTaiYangNengTask` | 太阳能量任务（风速/气温/湿度/辐射/日照） | `historyInterQuery` | `historyWrite` | — | — |
| `FdSeBeiyxspTask` | 设备效率任务（方阵/逆变器效率） | `historyRawQuery` | `historyWrite` | — | — |
| `ZuiDaChuLiTask` | 最大出力任务 | `getTagRealtimeValue`/`historyInterQuery` | `historyWrite` | — | — |
| `FdLiSanLuTask` | 离散率任务（1283 行） | — | `historyWrite` | `update`（×16） | `WT_CUBE` |
| `CnDianLiangTask` | 差值电量任务（556 行） | `historyInterWideQuery` | `historyWrite` | `query`/`update`（×13） | `WT_CUBE` |
| `PCSOperatingTimeTask` | PCS 运行时间任务（1689 行） | `historyRawQuery` | `historyWrite`（×6） | `query`/`update`（×8） | `WT_CUBE` |
| `DataCalcTask` | 数据采集统计 | — | — | `update`（×4） | `WT_DEVICE_DATA_STAT`/`WT_DEVICE_TAG_STAT` |
| `DustDetectionTask` | 灰尘检测 | — | — | `update` | `WT_DUST` |
| `LowStringsTask` | 低效组串 | — | — | `update` | `WT_LOW_STRINGS` |
| `RestrictedTask` | 限电损失 | — | — | `update` | `WT_RESTRICT_INFO` |
| `FailureLossTask` | 故障损失 | — | — | `update` | `WT_INVERTER_FAILURE` |
| `SumTask` | 汇总基类 | — | — | `update` | `WT_CUBE` |

> **关键观察**：离线任务工程是**写密集型**——17 个 Task 中 14 个有 `historyWrite`/`realtimeWrite`，13 个有 JdbcTemplate `update`。问数系统**只读**，这些 Task 的价值在于：
> 1. 揭示了**派生测点的计算逻辑**（1H/1D/1M/1Y 测点怎么来的）——问数回答"这个指标怎么算"时引用
> 2. 揭示了**StarRocks 派生表清单**（见 12.7）——问数查汇总数据时走这些表
> 3. 揭示了 **pvConfig.json 的 tagCode 字典**（见 12.5）——问数"中文→测点"映射的权威来源

### 12.5 pvConfig.json 全量（133 行，`D:\svn\...\resources\pvConfig.json`）

**鉴权三头**：
- `wtAppid`: `10062`
- `wtToken`: `6f7463585c85ab0f...`（256 字符）
- `wtOpenid`: `7e50e4b1b02f04d8791415eb88f442fb`
- `url`: `https://agp.sksyri.com/s1M6_uE9/wz/iot-etl/iot/`
- `stationCode`: `100620000002881`

**classPaths（11 个设备类路径）**：

| 中文名 | classPath |
|---|---|
| 华为逆变器 | `wt_elm_equipment/wt_iot_huaweisun2000` |
| 阳光逆变器 | `wt_elm_equipment/wt_iot_sungrowsg` |
| 华为箱变 | `wt_elm_equipment/wt_iot_padmounted` |
| 阳光箱变 | `wt_elm_equipment/wt_iot_sungrowpadmounted` |
| 华为方阵 | `wt_elm_equipment/wt_iot_huaweiarray` |
| 阳光方阵 | `wt_elm_equipment/wt_iot_sungrowarray` |
| 中皂光线路模型 | `wt_elm_equipment/wt_iot_zhongzao` |
| 站用变模型 | `wt_elm_equipment/wt_iot_ownsubstation` |
| 中集光线路模型 | `wt_elm_equipment/wt_iot_zhongji` |

**tags（~80 个测点编码映射）** — 涵盖全部指标，摘录关键：

| 中文描述 | tagCode | 类别 |
|---|---|---|
| 华为逆变器当天发电量 | `HWNBYC173` | 电量 |
| 华为逆变器总发电量 | `HWNBYC174` | 电量 |
| 阳光逆变器日发电量 | `YGNBYC053` | 电量 |
| 阳光逆变器总发电量 | `YGNBYC054` | 电量 |
| 华为逆变器电网A相电流 | `HWNBYC163` | 电流 |
| 组串电流离散率 | `zcdllsl` | 离散率 |
| 逆变器电流离散率 | `NBQDLLSD1` | 离散率 |
| 逆变器电量离散率 | `NBQDLLSD2` | 离散率 |
| 水平面总辐射量 | `QZXN11` | 气象 |
| 平均风速 | `QZXN1` | 气象 |
| 平均气温 | `QZXN2` | 气象 |
| 综合发电效率PR | `QZXN26` | 效率 |
| 等效利用小时数 | `QZXN9` | 效率 |
| 厂用电率 | `QZXN17` | 损耗 |
| 厂损率 | `QZXN21` | 损耗 |
| 上网电量 | `QZXN4` | 电量 |
| 故障损失电量计算开始小时 | `8` | **配置值** |
| 故障损失电量计算结束小时 | `20` | **配置值** |
| 低效组串score阈值 | `-2` | **配置值** |
| 箱变样板机 | `100620000005933,...` | **配置值** |
| 华为组串电流正则表达式 | `^HWNBYC(1(29|3[0-9]|4[0-9]|5[0-6]))_1O_*` | **正则** |

> **问数价值**：pvConfig.json 是"中文→tagCode"的**权威字典**——用户问"华为逆变器当天发电量"时，直接查 `tags["华为逆变器当天发电量"]` = `HWNBYC173`，再拼 `HWNBYC173_1O_{设备ID}` 得到 tagName。比 `wt_iot_tags.comment` LIKE 检索更精准。

### 12.6 application-dev.yml 全量（`D:\svn\...\resources\application-dev.yml`）

**三数据源**：

| 数据源 | URL | 用户 | 库 | 用途 |
|---|---|---|---|---|
| `dataSource`（默认） | `jdbc:mysql://122.51.119.174:3306/wisetao_metatest` | `zdtbl` | 元数据库（测试） | `wt_iot_tags`/`wt_elm_equipment`/`wt_bas_alarmrecord`/`meta_classtagmodel` |
| `customDataSource` | `jdbc:mysql://192.168.15.7:3360/bole` | `zdtbl`（Druid 加密） | 业务库 | `wt_cus_alarmdynamicconfig` |
| `timeds` | `jdbc:mysql://192.168.101.54:9030/WT_DB` | `root`（空密码） | StarRocks | `WT_DATA`/`WT_TAG`/`WT_CUBE` |

> **注意**：`dataSource` 指向公网 `122.51.119.174`（`wisetao_metatest` 测试库），`customDataSource` 指向 `192.168.15.7:3360`（bole 业务库）。**生产环境**这些 IP 会变——问数系统配置必须从环境变量读，不能硬编码。

**其他配置**：
- Redis：`localhost:6379`（无密码）
- Ice：`ATRTDBServer`@`192.51.119.174:9001`（**IP 缺了首位 1**，应为 `122.51.119.174`；timeout 600000ms）
- Ice Blob（注释）：`ATBLOBServer`@192.168.15.91:9031
- xxl-job admin：`http://192.168.101.54:8088/xxl-job-admin`，executor appname `guangfu-job-executor`，port 9996
- 监控：Prometheus metrics 暴露

### 12.7 StarRocks 派生表清单（从 JdbcTemplate SQL 提取）

| 表 | 写入 Task | 语义 | 问数可用性 |
|---|---|---|---|
| `WT_DATA` | StreamLoad / `historyWrite` | 原始时序数据（主表） | ✅ 问数主查 |
| `WT_TAG` | — | 测点字典 | ✅ 问数主查 |
| `WT_STRINGDATA` | — | 字符串时序数据 | ✅（本项目无字符串测点） |
| `WT_CUBE` | `SumTask`/`CnDianLiangTask`/`FdLiSanLuTask`/`PCSOperatingTimeTask` | 立方体汇总（cubeType×granularity×device×tag×time） | ✅ 问数查汇总 |
| `WT_DEVICE_DATA_STAT` | `DataCalcTask` | 设备数据采集统计 | ✅ 问数查"设备数据完整率" |
| `WT_DEVICE_TAG_STAT` | `DataCalcTask` | 设备测点采集统计 | ✅ 同上 |
| `WT_DUST` | `DustDetectionTask` | 灰尘检测 | ✅ 问数查"灰尘/污损" |
| `WT_LOW_STRINGS` | `LowStringsTask` | 低效组串（zscore ≤ -2） | ✅ 问数查"低效组串" |
| `WT_RESTRICT_INFO` | `RestrictedTask` | 限电损失电量 | ✅ 问数查"限电损失" |
| `WT_INVERTER_FAILURE` | `FailureLossTask` | 故障损失电量 | ✅ 问数查"故障损失" |
| `WT_ALL_DEVICES` | — | 全设备维度表 | ✅ JOIN 用 |
| `WT_DEVICE` | — | 设备维度（含 inverterId/subId） | ✅ JOIN 用 |
| `WT_BAD_PVS` | — | 坏光伏板列表 | ✅ 过滤用 |

### 12.8 Entity 表名确认（`@MetaClass` 注解）

| Entity | classPath | 库 | 语义 |
|---|---|---|---|
| `AlarmRecord` | `wt_bas_alarmrecord` | 元数据库 | 告警记录（18 字段：id/app_id/entity_class_path/alarm_type/alarm_time/description/entity_code/entity_id/entity_name/position/alarm_status/alarm_title/alarm_level/alarm_classify/last_alarm_time/tag_code/type/handler_comment/handler_time） |
| `AlarmDynamicConfigEntity` | `wt_cus_alarmdynamicconfig` | 业务库（bole） | 告警动态配置（10 字段：id/app_id/cus_class_path/tag_code/tag_comment/status/alarm_type/is_white/alarm_level/alarm_classify） |

### 12.9 上游 Service 接口（来自 jar，未反编译但已确认调用）

| 接口 | 方法 | 调用位置 | 语义 |
|---|---|---|---|
| `IClassInfoService` | `detail(ClassInfoParam)` | `IAlarmInfoServiceImpl:161` | 查类路径中文名（classPath → classAlias） |
| `IClassInfoService` | `refreshMetaFullCache(ClassInfoParam)` | `RefreshCacheLoader:33` | 刷新对象建模缓存（启动时） |
| `IClassInfoService` | `refreshCacheMapper(ClassInfoParam)` | `RefreshCacheLoader:36` | 刷新 MyBatis Mapper（启动时） |
| `MetaObjectServiceImpl<T>` | `listByParams(QueryParam)` | 所有 Service | 通用条件查询（底层走 MyBatis-Plus） |
| `MetaObjectServiceImpl<T>` | `list(T)` / `getById(id)` / `save(T)` / `updateByIdSelective(T)` | `IAlarmInfoServiceImpl`/`CusTagAlarmConsumer` | 通用 CRUD |
| `IAlarmDynamicConfigService` | `getAlarmDynamicConfigList()` | `AlarmInfoWatchTask:76` | 查全部告警配置（`app_id=10062 AND is_white=0`） |

### 12.10 StarRocks UDF（`D:\svn\WISETao_custom_demo\StarrocksUDF`）

| 类 | 语义 | 问数关系 |
|---|---|---|
| `GroupPeriod` | 时段分组 UDF（Java 编写，部署到 StarRocks BE） | `PCSOperatingTimeTask` 用它算"发电时段"——问数查"逆变器发电时段"时底层走此 UDF |

### 12.11 修正与补充项

1. **§十一.2 的 appId 硬编码 `0L`**：仅 Web 工程的 DataSource 们如此；**定时任务**（`AlarmInfoWatchTask`/`ArrayAlarmInfoWatchTask`）和**消费者**（`CusTagAlarmConsumer`）都用 `10062L`。与离线任务工程一致。
2. **§十一.4 "未找到 MyBatis Mapper XML"**：确认 `E:\src\WISETao_custom_demo\src\main\resources` 下无 `*.xml`。`MetaObjectServiceImpl` 来自上游 jar，用 MyBatis-Plus 注解模式 + `@MetaClass`/`@TableField` 注解动态建 Mapper。
3. **§十一.5 "HTTP 网关被注释"**：确认 `BasicTask` 里 `okHttpClient` 字段和 `getWideHistory` 调用全被注释。`OkHttpConfig` 的 `@Bean` 也被注释。**HTTP 网关通道在离线任务工程中完全未启用**。
4. **Ice server IP 错误**：`application-dev.yml` 里 `ice.server.ip: 192.51.119.174` 缺首位 `1`，应为 `122.51.119.174`。但实测 `122.51.119.174:9001` 从当前网络不通，`192.168.101.54:9001` 通——生产环境用内网 IP。
5. **`FdDianLiangTask.java` 编码问题**：该文件被识别为二进制（可能是 GBK 编码 + BOM），Read 工具读不了，但 grep 确认它调 `historyInterWideQuery`/`historyWrite`。

---

## 十三、AGP 模型层与后端服务 jar 深挖（第三轮，含三文档交叉验证）

> **资料来源**：`D:\doc\taineng\光伏\智道\部署文档\server\后端服务\`（4 个服务：cus/bole、WISETao-Pack、WISETao-SpringBoot、wt-zen）反编译（javap）+ `D:\doc\taineng\智能体平台\` 三文档（《AGP的层次架构和实体模型.pptx》《ＡＧＰ的接口.pdf》《了解模型.pdf》）。
> **定位**：补齐 AGP "模型层"全貌——问数系统要接的不只是 TSDB/MySQL 两类库，还有 AGP 模型层的元数据接口和 WT-SQL 查询面。

### 13.1 后端服务与核心 jar 盘点

| 服务 | 主 jar | 模型/数据相关 jar |
|---|---|---|
| `cus/bole`（博乐定制 = E:\src 工程） | cus-bole-1.0.0-SNAPSHOT-exec.jar | meta-api/meta-common/meta-data/meta-idgen/meta-log/meta-object/meta-server、tag-biz、wtsource、lib-ice-rtdb(-starter)/lib-ice-blob、magic-api 全家桶、sa-token |
| `WISETao-SpringBoot`（主系统） | wisetao-system-1.0.0-exec.jar | 同上 meta-server 系列 + lib-rabbitmq/lib-statemachine + wisetao-common + wtsource |
| `WISETao-Pack`（打包版） | WISETao-Pack-1.0-SNAPSHOT.jar | **atsource-4.0.0**（cn.atfusion，wtsource 的上游通用版，包结构完全同构：graph/table/tree/calendar） |
| `wt-zen`（主服务加密版） | wisetao-server-xjar.jar（300MB，xjar 加密）+ license-common.jar | conf/db/migration 内含 Flyway 迁移脚本 |

### 13.2 模型层 jar 类结构（问数相关）

**meta-object-1.0.0**（对象服务 + REST）：
- Controller：`ObjectController`（`/meta/object/*`）、`QueryController`（`/meta/queryByTemplate`）、`ClassController`、`RefreshController`
- 服务：`ObjectServiceImpl`、`QueryServiceImpl`、`ITagObjectService/TagObjectServiceImpl`（对象↔测点关联）、`ClassDataEmbedServiceImpl`/`ClassMapperLoader`（**@MetaClass 动态 MyBatis Mapper 生成器**——解释了无 XML 之谜）

**meta-api-1.0.0**（接口与实体全集）：
- `IObjectService`（27 方法，见 13.4）
- `IMetaService<T>` 基类（27 方法：save/remove/update/list/listByParams/page/pageByParam/treeTableList…）
- `ITableDataService`（22 方法：任意动态表 CRUD + `queryDataList`/`queryDataPage`/`getTableMetaInfo`/`queryTreeTableDataList`）
- `IGenericQueryService`：**`queryByGenericSql(QueryStatisticBySqlParam)`**、`queryDictList`、**`getWtSqlDict(sql)`（WT-SQL 字典！）**、`getDataSourceDict`
- `QueryStatisticBySqlParam` = `{appDomain, dataMaps, sql, pageNum, pageSize}`——SQL 模板化查询
- 实体：ObjectBaseAttribute{Query,PageQuery,Detail,QueryChildByParent,Export,DeleteByCondition}、ObjectProcessAttribute{Query,PageQuery,Export}、**ObjectComputeAttributeCallEntity**、ObjectLink/TagObjectLink/TreeTableObjectQuery、DictQuery/GenericDict、DataBase/DataQuery/DataQueryPage/TreeTableDataQuery 等

**meta-server-1.0.0**（元模型服务器，模型管理的全部模块）：

| 模块 | 语义 | 问数用途 |
|---|---|---|
| classInfo / classLink / classRelation | 类信息/类链接/类关系（+`ClassRelationRule`） | 模型间六种关系（见 13.6）的存储与查询 |
| basicAttrsInfo | 基础属性定义 | 模型字段元数据 |
| dynamicAttrsInfo | **动态属性（=tagCode）定义** | 模型→测点映射的元数据源 |
| computeAttrsInfo + computeAttrsDetail | **计算属性（=Expressions）定义** | 在线指标算法元数据；`callObjectComputeAttribute` 调用 |
| processAttrsInfo + processAttrsDetail | 过程属性 | 过程数据（巡检/维修类）元数据 |
| professionAttrsInfo/ClassLink/ObjectLink | 专业属性及其与类/对象的关联 | 行业扩展属性 |
| fieldAttrEnumInfo + Detail | 字段枚举字典 | 枚举字段翻译（如状态码→中文） |
| fieldmetainfo / tablemetainfo / tableIndexInfo / tableLink / tableRelation | 字段/表/索引/表链接/表关系元数据 | DDL 级元数据（与 docs/spec/ddl_metadata_tables.md 对应） |
| metaToTable | **模型→建表（DDL 生成）** | 建模工具落库引擎 |
| **queryStatisticTemplate** | **查询统计模板**（`QueryStatisticTemplate` 实体 + `GenericQueryServiceImpl` + `WiseTaoSqlHelper` + GenericSqlParam{sqlStatement,resultSql,countSql,fields} + QueryStatisticByTemplateParam{templateId,dataMaps}） | **模板化 SQL 查询的正主**——与本项目"模板化 SQL"红线同思路 |
| queryDatasourceInfo / queryFilterInfo / queryFilterGroupInfo / queryGroupInfo / querySortInfo / queryResultParams | 查询配置六件套（数据源/过滤/过滤组/分组/排序/结果参数） | 动态查询的配置化组装 |
| **dynamicDSManager** | 动态数据源管理（`DataSourceController`、`DataSourceInfo`、`DataInitialize`、SYSInitInfo） | 多租户运行时注册数据源（appDomain→DS） |
| **ice** | **`RTDBController`（`/rtdb/*`）+ `IRTDBProxyService`（11 方法）+ RTDBQueryParam{type,tagNames,startTime,endTime,intervalByMS,numberOfSamples,appId}.convert()→ANTAI.ATRTDBQueryParam** | **TSDB 的 REST 代理**——不用 Ice 客户端也能 HTTP 查 TSDB！ |
| magicapi | MagicApiController + WtdbModule/WtdbConfiguration | magic-api 动态接口（免注册编程） |
| deployLog | `JdbcTemplateWithExecuteLog` + SqlExecuteLog + SqlDeploy{Import,Export}Log | **SQL 执行审计日志** |

**tag-biz-1.0.0**（测点业务）：
- `IMetaTagService` **完整 10 方法**（§11.2 只列了 5 个）：`getTagRealtimeValue`、**`getMixedTagRealtimeValue`**、`historyRawQuery`、**`historyRawWideQuery`**（宽表原始）、**`historyMixQuery`**、**`historyRawSpecificQuery(MetaTagSpecialValueQuery)`**、`historyInterQuery`、`historyInterWideQuery`、`historyQueryReverse`、`historyWrite`、`realtimeWrite`
- `MetaTagSpecialValueQuery` = `{tags[], time, radiusBefore, radiusAfter}`——**查指定时刻前后半径内最近值**
- `MetaTagValueController`：**类级 `/iot-etl/iot/tag`** + POST `/realtime`、`/historyMixQuery`、`/historyRawSpecificQuery`、`/realtimeWrite`、`/historyWrite`
- `MetaTagBook` = `{tags[], infos:Map<String,MetaTagInfo>, tagUnknown[], tagDouble[], tagString[]}`
- 转换器：ITagInfoConverterRTDB / ITagValueConverterRTDB / TagValueFillRTDB

**wtsource-1.0.0**（展示数据源框架，cn.wisetao；上游为 cn.atfusion.atsource-4.0.0）：
- `WTSource` 基类 + TableData/TableSource/TableQuery/TableSourceForGIS/TableEnergySource
- 图形源：SeriesSource（折线）/PieSource/RadarSource/InkPenSource、CalendarSource、TreeSource、WTArrSource/WTObjSource
- `TableSource.Page`/`Field{Type}`——§11 所有 DataSource 的基类；Excel 导出 ExportExcelFile

### 13.3 REST 查询面全集（问数可直接 HTTP 调用）

| 前缀 | 端点（节选） | 语义 |
|---|---|---|
| `/iot-etl/iot/tag` | POST `/realtime`、`/historyMixQuery`、`/historyRawSpecificQuery`、`/historyWrite`✗、`/realtimeWrite`✗ | **pvConfig.url 前缀的真实来源**！网关 `https://agp.sksyri.com/s1M6_uE9/wz/iot-etl/iot/` 背后就是这个 Controller |
| `/rtdb` | GET `historyValueQuery`、`historyValueQueryString`、`realTimeValueQuery`、`realTimeValueQueryString`、`tagDel`；POST `tagAdd`、`tagEdit`、4 个写✗ | TSDB REST 代理（type: 原始/插值/统计由 RTDBQueryParam.type 区分） |
| `/meta` | `/queryByTemplate` | 按模板 ID + dataMaps 查询 |
| `/meta/model` | `/queryByTemplate`、`/queryByGenericSql`、`queryStatisticTemplatePage`、`/detail`、增删改、`dict/getDictList` | 查询统计模板管理 + 执行 |
| `/meta/object` | `queryObjectBaseAttribute`、`queryObjectBaseAttributePage`、`queryObjectBaseAttributeById`、`queryObjectBaseAttributeByParentInfo`、`queryObjectProcessAttribute(Page)`、`callObjectComputeAttribute`、`queryTreeTableObjectList`、`dict/commonDictTreeList`、CRUD✗、import/export | 对象（实例）查询面 |
| `/alarm/*` | §11.1 的 9 个 | 博乐告警业务 |

✗ = 写操作，问数只读红线禁止。

### 13.4 IObjectService 完整 27 方法（§11.3 只有 1 个）

**读（问数可用）**：`queryObjectBaseAttributeList`、**`queryObjectBaseAttributePage`**（分页）、`queryObjectBaseAttributeById`、**`queryObjectBaseAttributeByParentInfo`**（按父查子=设备树下钻）、`queryObjectProcessAttribute(Page)`、**`callObjectComputeAttribute`**（调计算属性）、`queryTreeTableObjectList(WithoutTree)`、`commonDictTreeList`、`generateTree`
**写（禁用）**：createObject/modifyObject(ByConditon)/deleteObject(ByConditon)/linkObject/deleteObjectLink/modifyObjectLink/sychroniseDerivativeLink/nodeMove/nodeCopy/importExcel/importLinkExcel
**导出**：templateExport/exportObjectBaseAttribute/exportObjectProcessAttribute/exportObjectLinkTemplate

### 13.5 文档×jar 交叉验证表

| 文档概念（三文档） | jar 实证 | 状态 |
|---|---|---|
| 实体模型=数字身份证，五类属性（基础/动态/计算/关联/内置方法）+ 过程属性 + 智能符号（pptx S8-9，PDF 了解模型 P6-7） | basicAttrsInfo/dynamicAttrsInfo/computeAttrsInfo(+Detail)/classLink+tableLink/computeAttrsDetail+callObjectComputeAttribute/processAttrsInfo(+Detail)；SmartSymbol 未找到独立模块 | ✅ 基本对应；**SmartSymbol 无代码实证**（可能尚未实现） |
| 动态属性=IOT 参数，通过测点表接 TSDB（接口 PDF P8） | dynamicAttrsInfo + wt_iot_tags + IMetaTagService + MetaTagValueController | ✅ |
| 计算属性=在线计算算法（设备在线率/负荷率） | computeAttrsInfo + ObjectComputeAttributeCallEntity + StarRocks EQ_ 表达式测点（§九.10） | ✅ 双实现：TSDB 公式测点 + Java 计算属性 |
| 模型六种关系：泛化/关联/聚合/组合/依赖/实现（了解模型 P16-18） | ClassRelationInfo + ClassRelationRule + IObjectService.linkObject；ClassDataEmbedServiceImpl | ✅ |
| 11 管理维度基础模型（人机料法环细分） | 元数据库 `meta_%` 47 张 + `wt_elm_%`/`wt_bas_%`/`wt_sys_%`（§四.50） | ✅ |
| 接口四层：元数据(少)→基础业务(多)→场景(多)→项目(少)，逐级引用（接口 PDF P3） | Controller 分层实证：`/meta/object`、`/meta/model`（元）→ `/alarm/*`、DataSource 们（业务/场景）；pom 无项目级 | ✅ |
| 统一返回格式 `{code,message,fields[],data[],page{pageNum,pageSize,pageTotal,itemTotal},timestamp,executeTime}`（接口 PDF P5） | `TableSource{Page,Field{Type}}`（wtsource）+ `StandredResult`+`StandredResult$Field`（commons） | ✅ |
| **中文查询 WT-SQL：`select 姓名,年龄 from 钛能职工模型 where 部门='设计部'`**（pptx S14） | `IGenericQueryService.getWtSqlDict(sql)` + WiseTaoSqlHelper + queryByGenericSql(appDomain+sql+dataMaps+分页) | ✅ **WT-SQL 是真实存在的执行通道** |
| 结构化中文查询参数 `{dataSource:"职工模型", searchStr:"count(年龄)", whereStr:"性别='男'", grouped, segment[], showSegment[]}`（接口 PDF P7） | QueryStatisticTemplate + GenericQueryServiceImpl + queryByTemplate(templateId,dataMaps)；segment/showSegment 对应分段统计 | ✅ |
| TSDB 接口清单：实时值/历史原始值/宽格式/统计值/模型的动态属性列表/对象的测点列表（接口 PDF P8） | MetaTagValueController + IMetaTagService 10 方法 + dynamicAttrsInfo + ITagObjectService/TagObjectLink | ✅ 全部有实现；"查询网关列表"未找到 |
| 三级 app_id：系统级=1、场景级=100、应用级=10062（pptx S3） | appId 贯穿（0L/10062L 混用见 §12.11）；dynamicDSManager 按 appDomain 注册 DS | ✅ |
| MagicAPI 编程工具（pptx S15，接口 PDF P2） | magic-api-2.1.1 全家桶 + MagicApiController + WtdbModule + bole 库 magic-api 表 | ✅ |
| 实时运行数据="心电图"（TSDB 秒级）（了解模型 P14-15） | WT_DATA + historyRawQuery | ✅ |

### 13.6 对问数系统的增量结论（第三轮）

1. **新增可接入通道——TSDB REST 代理 `/rtdb/*`**：若 Ice 客户端集成成本高，可直接 HTTP 调 `RTDBController`（GET `historyValueQuery?tagNames=..&startTime=..&endTime=..&type=..`）。部署在哪台主机 = WISETao-SpringBoot/wt-zen 所在主机，需实测（101.54:80 是前端，后端端口待查）。
2. **`/iot-etl/iot/tag/realtime` 是官方推荐的实时值 REST**：与 pvConfig.url 前缀吻合，公网网关可用时优先此通道（免 Ice 依赖）。
3. **WT-SQL/模板查询通道**：`/meta/model/queryByGenericSql`（直接 SQL）与 `/meta/queryByTemplate`（模板 ID）是 AGP 原生的"受控取数面"。问数若复用，天然符合"模板化 SQL"红线——模板存 `queryStatisticTemplate` 表（元数据库），LLM 只见模板 ID + dataMaps。
4. **模型元数据是"中文→数据"的权威映射链**：模型名（meta_classtagmodel/classInfo）→ 动态属性（dynamicAttrsInfo，tagCode+中文名）→ 测点（wt_iot_tags，tagName=tagCode_粒度_设备ID）→ 数据（WT_DATA）。比 §12.5 的 pvConfig.json 静态字典更完整（pvConfig 只是光伏场景快照）。
5. **枚举翻译**：fieldAttrEnumInfo 提供"字段枚举→中文"映射，问数展示状态类测点（2O）时需要。
6. **SQL 审计先例**：deployLog 的 `JdbcTemplateWithExecuteLog` 证明 AGP 自身就有 SQL 执行日志体系——问数插件的审计哈希链（AGENTS.md）可对齐此模式。
7. **wtsource 是统一取数抽象**：TableData/TableSource（含 Page/Field 协议）= AGP 版"数据源插件接口"；§11 的 5 个 DataSource 全部实现它。问数工具若按此协议返回（fields+data+page），可无缝对接 AGP 前端组件。

---

## 十四、101.54 MySQL 模型/对象元数据实测（2026-09-08，scripts/model-meta-probe*.mjs）

> 连接 `192.168.101.54:3306`（root，凭据走环境变量不落盘）。本节是 §十三 模型层的**数据实证**。

### 14.1 模型定义层（wisetao_meta.meta_%，47 表）

| 表 | 行数 | 实测内容 |
|---|---|---|
| `meta_class_info` | 294 | **模型清单**。列：class_name/class_alias(中文)/class_path/parent_class_id/app_domain/app_id/level。分布：wisetao_meta 218（app_id=1 系统级 82；101/102/103/104/109 场景级）、**bole=34（app_id=10062 应用级）**、zyzx/gstsg 其他租户。继承树实证：`wt_elm_basic_building/wt_elm_buildingspace/wt_bas_dorm_info` 三级 |
| `meta_basic_attrs_info` | 3625 | **基础属性定义**。设备模型 15 字段：node_code(设备编码)/node_name(设备名称)/equpment_model(型号)/install_date(安装日期)/manufacturer(生产厂家)/position(安装位置)/asset_code/picture(62=图片)/intnet_id(工业互联网标识)…field_type 编码：1=long,3=string,51=date,62=图片 |
| `meta_classtagmodel` | 15308 | **动态属性主表**。列：tag_code/name(中文)/tag_type(模拟量\|数字量)/calculated/script(计算脚本)/master_class_id/in_out(r)/tsl_text/static。**华为逆变器模型 221 个属性**：HWNBYC001 通讯故障、HWNBYC003 逆变开关机状态、HWNBYC012 电网欠压…全部 tag_type=数字量 in_out=r |
| `meta_dynamic_attrs_info` | 12 | 动态属性定义（tag_type_module=meta-tag、tag_type_class_name=tag_analog/tag_discrete/tag_character、dynamic_attrs_unit=m/s）。多为测试数据；生产主数据在 meta_classtagmodel |
| `meta_class_link_info` | 138 | **模型关系表**。relation_type 0-3 双向配对（is_revert=1 反向）；from_class_path→link_class_path+两端字段；**link_table_name=`cl_wt_bas_systemparameters_33F1F42D`——关系数据存独立链接表 cl_%** |
| `meta_process_attrs_info/detail` | 79/1415 | 过程属性定义/明细 |
| `meta_classscriptmodel` | 10 | 计算属性关联模型（script 脚本） |
| `meta_smartsymbol` | 14 | **智能符号实证**：symbol 列存 mxGraph XML + Blockly 脚本，脚本内绑定测点公式 `${ReadUsed_1O}`、规则 JSON（classPath+variables+formula）——组态符号与测点联动 |
| `meta_query_statistic_template` | 9 | 查询统计模板（meta-app1/XIABASE 测试模板 9 个，template_name+app_domain+page_on/page_size） |
| `meta_query_datasource_info` | 12 | 模板↔数据源关联（template_id+data_source_type=2+data_source_id） |
| `meta_query_filter_info/filter_group_info/group_info/sort_info/result_params` | 13/6/4/3/24 | 查询配置六件套（过滤/过滤组/分组/排序/出参） |
| `meta_field_attr_enum_info/detail` | 20/60 | 字段枚举字典（值→中文标签） |
| `meta_data_source` | 4 | 动态数据源注册：meta-tag/XIABASE/wisetao_client/wisetao_meta（pass_word 为 Druid 加密或明文——**凭据红线：问数不得输出此表内容**） |
| `meta_sql_execute_log` | 2772 | SQL 执行审计日志（deployLog 模块实证） |
| `meta_magic_api_file_v2` | 320 | magic-api 接口脚本 |
| `meta_dictionarytree` | 619 | 公用字典树 |
| 空表 | 0 | meta_compute_attrs_info/detail、meta_class_relation_info、meta_table_link/relation_info、meta_profession_attrs_*（计算属性用 meta_classscriptmodel，类关系用 class_link_info） |

### 14.2 对象实例层（wisetao_meta.wt_elm_%，54 表 = 54 个模型类的实例表）

- `wt_elm_equipment` 11407 设备，按 class__path 分布：电池簇 1680、阳光逆变器 1320、华为逆变器 590、modbus 网关 862、iot 网关 564、摄像头 508、华为箱变 191、35KV 段、热斑相机…
- 对象样例（华为逆变器）：`{id:100620000015521, node_code:"1#-N1-H", node_name:"1号箱变1号逆变器", class__path:"wt_elm_equipment/wt_iot_huaweisun2000", parent_ids:".../100620000015521"}`——parent_ids 斜杠路径 = 设备树
- 非光伏系统级模型：persons 5163/document 7731/meterial 4202/building 系（园区/建筑/楼层/空间）
- bole 应用级模型（class_alias 中文）：35KV1-5 段模型、AGC/AVC 模型、电池簇/电池堆、热斑摄像机、方阵告警配置表、运维工单、逆变器电损统计…

### 14.3 WT-SQL 语法实证（wisetao_meta.wt_bas_queryscheme，11 行）

```sql
-- 模型宏：类路径→物理表；参数占位符：#{名,类型,中文提示}
select a.* from $CLASS(wt_iot_tags) as A where id=#{id,long,标识}

-- 继承子模型
select a.* from $CLASS(wt_elm_persons/wt_edu_student) as A where name like '%#{name,String,姓名}%' and sex=#{sex,int,性别}

-- 关系宏：$LINK(outterLink_[模型A]_[模型B], A|B/子模型) —— 跨模型 JOIN
select a.* from $LINK(outterLink_[WT_IOT_TAGCLASSIFY]_[WT_IOT_TAGS],WT_IOT_TAGCLASSIFY|WT_IOT_ANALOGTAG) as A where leftid=#{id,long,键值}

-- 复杂样例 getUserInfoV2：$CLASS×2 + $LINK×3 五模型 JOIN + GROUP_CONCAT + alias_transform(字段中文名 JSON) + :appId 命名参数
```

### 14.4 获取模型/对象信息的四种调用方式

**A. 直连 SQL（问数 P1 工具 execute_wt_select 直查元库）**
```sql
-- 模型清单（中文别名）
SELECT class_alias, class_name, class_path, app_id FROM wisetao_meta.meta_class_info WHERE deleted=0 AND app_id=10062;
-- 某模型的动态属性（tagCode+中文名+类型）
SELECT t.tag_code, t.name, t.tag_type, t.calculated FROM wisetao_meta.meta_classtagmodel t
  JOIN wisetao_meta.meta_class_info c ON t.master_class_id=c.id
  WHERE c.class_path='wt_elm_equipment/wt_iot_huaweisun2000' AND t.deleted=0;
-- 某模型的对象列表
SELECT id, node_code, node_name, position FROM wisetao_meta.wt_elm_equipment
  WHERE deleted=0 AND class__path='wt_elm_equipment/wt_iot_huaweisun2000';
-- 模型间关系
SELECT from_class_path, link_class_path, from_class_field, link_class_field, link_table_name
  FROM wisetao_meta.meta_class_link_info WHERE deleted=0;
```

**B. Java SDK（classpath 加载 cus/bole/libs 的 meta-*+tag-biz jar）**
```java
// 1) 模型清单：IClassInfoService.detail(ClassInfoParam{classPath, appDomain}) 或列表接口
// 2) 对象查询：IObjectService
ObjectBaseAttributeQueryEntity q = new ObjectBaseAttributeQueryEntity();
q.setClassPath("wt_elm_equipment/wt_iot_huaweisun2000");  // 类路径
q.setUseDistinct(true);
q.setConditionGroups(List.of(buildConditionGroups("and",
    List.of(buildCondition("app_id","=",10062L)))));
q.setSelectFields(List.of("id","node_code","node_name","position"));
List<Map<String,Object>> list = objectService.queryObjectBaseAttributeList(q);   // 列表
Page page = objectService.queryObjectBaseAttributePage(pageQuery);               // 分页
List<Map<String,Object>> children = objectService.queryObjectBaseAttributeByParentInfo(childQuery); // 设备树下钻
Object val = objectService.callObjectComputeAttribute(callEntity);               // 计算属性
// 3) 对象↔测点：ITagObjectService；动态属性定义：dynamicAttrsInfo 模块接口
// 4) WT-SQL：IGenericQueryService.queryByGenericSql(
//      new QueryStatisticBySqlParam(){appDomain="wisetao_meta"; sql="select ... $CLASS(...)"; dataMaps=Map.of("id",1L); pageNum; pageSize})
```

**C. REST（需后端服务可达；部署主机/端口待实测）**
```
GET  /meta/object/queryObjectBaseAttribute?classPath=wt_elm_equipment/wt_iot_huaweisun2000&app_id=10062
POST /meta/object/queryObjectBaseAttributePage   -- body 同 ObjectBaseAttributePageQueryEntity
POST /meta/queryByTemplate                       -- {templateId, dataMaps}（wt_bas_queryscheme/meta_query_statistic_template）
POST /meta/model/queryByGenericSql               -- {appDomain, sql(WT-SQL), dataMaps, pageNum, pageSize}
POST /meta/model/queryByTemplate                 -- {templateId, dataMaps}
GET  /rtdb/realTimeValueQuery?appId=10062&tagNames=HWNBYC174_1O_xxx  -- TSDB 代理
```

**D. 问数插件落地建议**
1. "有哪些模型/对象"类问题：直查 `meta_class_info`+`meta_classtagmodel`+`wt_elm_equipment`（方式 A 新增模板即可，纯 SELECT）。
2. "模型→测点→数据"链路：meta_classtagmodel(tag_code) → TagGenerateUtil 拼 `tagCode_1O_设备id` → WT_DATA/或 tagService。
3. WT-SQL 若复用，需实现 `$CLASS/$LINK/#{} :param` 四个语法元素 + alias_transform 中文名映射（模板存 wt_bas_queryscheme，LLM 只见方案 name+参数，符合模板化红线）。
4. **红线**：meta_data_source 含凭据（Druid 加密+明文混合），问数模板禁止映射该表；meta_sql_execute_log 可作审计样例参考。

---

## 十五、华为逆变器详细信息查询实证（2026-09-08，四层验证）

> **目标**：以"1号箱变1号逆变器"（id=100620000015521）为例，验证从模型元数据→对象实例→测点字典→时序数据的完整查询链，给出 SQL 和 Java 两种调用方式的可执行代码与实证结果。
> **连接**：MySQL `192.168.101.54:3306`（root，凭据走环境变量 `MYSQL_PWD` 不落盘）；StarRocks `192.168.101.54:9030`（root 空密码，WT_DB 库）。

### 15.1 查询目标与四层链路

```
层1 基础属性     wt_elm_equipment (MySQL wisetao_meta)
     ↓ class__path
层2 子类特有属性 wt_iot_huaweisun2000_b16793ce (MySQL wisetao_meta，@MetaClass 动态表)
     ↓ master_class_id → meta_class_info.id
层3 动态属性定义 meta_classtagmodel (MySQL wisetao_meta，221 个测点 tagCode+中文名)
     ↓ tagCode + 粒度 + 设备id → tagName
层4a 测点字典    wt_iot_tags (MySQL wisetao_meta，205万行，tagName→alias/tag_code/master_code)
层4b 时序数据    WT_DATA (StarRocks WT_DB，tagName→timestamp→value)
```

### 15.2 SQL 查询代码（四层，均已实测出数据）

**层1 基础属性** ✅
```sql
-- 查"1号箱变1号逆变器"的基础属性（设备树节点）
SELECT id, node_code, node_name, class__path, parent_ids, description, position
FROM wisetao_meta.wt_elm_equipment
WHERE id = 100620000015521 AND deleted = 0;
-- 实测结果（1 行）：
-- id=100620000015521 | node_code=1#-N1-H | node_name=1号箱变1号逆变器
-- class__path=wt_elm_equipment/wt_iot_huaweisun2000 | description=光伏区1号箱变1号逆变器
```

**层2 子类特有属性** ⚠️（表存在但只有 id 列）
```sql
-- 查华为逆变器子类表的特有字段（@MetaClass 动态生成的物理表）
SELECT * FROM wisetao_meta.wt_iot_huaweisun2000_b16793ce
WHERE id = 100620000015521;
-- 实测结果（1 行，仅 id 列）：
-- id=100620000015521
-- 结论：华为逆变器模型无特有属性，全部继承父表 wt_elm_equipment 的 15 个基础字段。
-- 子类表名后缀 _b16793ce 是 meta_class_info.id 的 16 进制（@MetaClass 命名规则）。
```

**层3 动态属性定义** ✅（221 个测点）
```sql
-- 查华为逆变器模型的 221 个动态属性（tagCode + 中文名 + 类型 + 是否计算点）
SELECT t.tag_code, t.name AS tag_name_cn, t.tag_type, t.calculated, t.in_out
FROM wisetao_meta.meta_classtagmodel t
JOIN wisetao_meta.meta_class_info c ON t.master_class_id = c.id
WHERE c.class_path = 'wt_elm_equipment/wt_iot_huaweisun2000'
  AND t.deleted = 0
ORDER BY t.tag_code;
-- 实测结果（221 行），摘录：
-- HWNBYC001 | 通讯故障              | 数字量 | 0 | r
-- HWNBYC003 | 逆变开关机状态        | 数字量 | 0 | r
-- HWNBYC012 | 电网欠压              | 数字量 | 0 | r
-- HWNBYC163 | 电网A相电流           | 模拟量 | 0 | r
-- HWNBYC173 | 当天发电量            | 模拟量 | 0 | r
-- HWNBYC174 | 总发电量              | 模拟量 | 0 | r
-- calculated=0 表示原始测点（非计算派生）；in_out=r 表示只读。
```

**层4a 测点字典** ✅（**关键修正：列名是 `tagname` 不是 `tag_name`**）
```sql
-- 拼 tagName = tagCode + "_" + 粒度 + "_" + 设备id，查测点字典
-- 粒度：1O=原始秒级、1H=小时、1D=日、1M=月、1Y=年
SELECT tagname, alias, tag_code, master_code, app_id, tag_type
FROM wisetao_meta.wt_iot_tags
WHERE tagname = 'HWNBYC174_1O_100620000015521';
-- 实测结果（1 行）：
-- tagname=HWNBYC174_1O_100620000015521 | alias=1号箱变1号逆变器总发电量
-- tag_code=HWNBYC174 | master_code=100620000015521 | app_id=10062 | tag_type=0
--
-- 模糊查某设备的全部测点（按 master_code = 设备id）：
SELECT tagname, alias, tag_code FROM wisetao_meta.wt_iot_tags
WHERE master_code = 100620000015521 AND app_id = 10062
ORDER BY tag_code;
-- 返回该逆变器的全部测点字典行。
```

**层4b 时序数据** ✅（StarRocks）
```sql
-- 查该逆变器总发电量最近 5 条原始数据（StarRocks SQL，MySQL 协议 9030 端口）
SELECT tagName, timestamp, value, quality
FROM WT_DB.WT_DATA
WHERE tagName = 'HWNBYC174_1O_100620000015521'
ORDER BY timestamp DESC
LIMIT 5;
-- 实测结果（5 行）：
-- HWNBYC174_1O_100620000015521 | 2024-08-14 10:47:28 | 215524.77 | 0
-- HWNBYC174_1O_100620000015521 | 2024-08-14 10:46:28 | 215523.55 | 0
-- HWNBYC174_1O_100620000015521 | 2024-08-14 10:45:28 | 215522.33 | 0
-- ...
-- quality=0 表示数据质量正常；value 单位 kWh（累计电量）。
```

### 15.3 Java 接口调用代码（来自 cus/bole/libs 反编译的 meta-* + tag-biz jar）

**层1+层2 对象查询（IObjectService，27 方法见 §13.4）**
```java
// 注入：@Autowired IObjectService objectService;

// 1a) 按 id 查对象基础属性（等价 SQL 层1）
ObjectBaseAttributeDetail detail = objectService.queryObjectBaseAttributeById(
    new ObjectBaseAttributeDetailQuery(){{
        setId(100620000015521L);
        setClassPath("wt_elm_equipment/wt_iot_huaweisun2000");
    }});
// detail.getNodeName() = "1号箱变1号逆变器"
// detail.getNodeCode() = "1#-N1-H"

// 1b) 按类路径 + 条件查对象列表（等价 SQL 层1 的列表版）
ObjectBaseAttributeQueryEntity q = new ObjectBaseAttributeQueryEntity();
q.setClassPath("wt_elm_equipment/wt_iot_huaweisun2000");
q.setSelectFields(List.of("id", "node_code", "node_name", "position"));
q.setConditionGroups(List.of(buildConditionGroup("and",
    List.of(buildCondition("app_id", "=", 10062L)))));
List<Map<String,Object>> list = objectService.queryObjectBaseAttributeList(q);

// 1c) 设备树下钻（按父查子）
List<Map<String,Object>> children = objectService.queryObjectBaseAttributeByParentInfo(
    new ObjectBaseAttributeQueryChildByParent(){{
        setParentId(100620000015520L);  // 父节点 id（如箱变）
        setClassPath("wt_elm_equipment/wt_iot_huaweisun2000");
    }});

// 2) 调计算属性（如"在线率"——computeAttrsInfo 定义的算法）
Object result = objectService.callObjectComputeAttribute(
    new ObjectComputeAttributeCallEntity(){{
        setClassPath("wt_elm_equipment/wt_iot_huaweisun2000");
        setObjectId(100620000015521L);
        setComputeAttrCode("ONLINE_RATE");  // 计算属性编码
    }});
```

**层3 动态属性定义（IMetaService<meta_classtagmodel> 或 ITagObjectService）**
```java
// 注入：@Autowired ITagObjectService tagObjectService;
//       @Autowired IMetaService<MetaClasstagModel> classtagMetaService;

// 3a) 查对象的全部动态属性定义（tagCode + 中文名）
//     ITagObjectService 内部走 meta_classtagmodel + meta_class_info JOIN
List<MetaTagInfo> tagInfos = tagObjectService.queryTagInfosByClassPath(
    "wt_elm_equipment/wt_iot_huaweisun2000", 10062L);
// tagInfos.size() == 221
// tagInfos.stream().filter(t -> "HWNBYC174".equals(t.getTagCode()))
//         .findFirst().get().getName() == "总发电量"

// 3b) 通用 MetaService 查法（等价 SQL 层3）
List<MetaClasstagModel> attrs = classtagMetaService.listByParams(
    new QueryParam(){{
        put("masterClassId", classInfoIdOfHuaweiInverter);
        put("deleted", 0);
    }});
```

**层4a+4b 测点数据（IMetaTagService，10 方法见 §13.2）**
```java
// 注入：@Autowired IMetaTagService metaTagService;

// 4a) 查测点字典（tagBook 一次查多个 tagName）
MetaTagBook book = metaTagService.tagBook(new String[]{
    "HWNBYC174_1O_100620000015521",  // 总发电量
    "HWNBYC173_1O_100620000015521",  // 当天发电量
    "HWNBYC163_1O_100620000015521"   // 电网A相电流
});
// book.getInfos().get("HWNBYC174_1O_100620000015521").getAlias() == "1号箱变1号逆变器总发电量"

// 4b) 查实时值（getTagRealtimeValue —— 最新一条）
Map<String, MetaTagValue> realtime = metaTagService.getTagRealtimeValue(
    new String[]{"HWNBYC174_1O_100620000015521"});
// realtime.get("...").getValue() == 215524.77（最新累计电量）

// 4c) 查历史原始值（historyRawQuery —— 等价 StarRocks 层4b）
MetaTagValueQuery histQuery = new MetaTagValueQuery();
histQuery.setTags(new String[]{"HWNBYC174_1O_100620000015521"});
histQuery.setStartTime("2024-08-14 00:00:00");
histQuery.setEndTime("2024-08-14 23:59:59");
MetaTagValueResult hist = metaTagService.historyRawQuery(histQuery);
// hist.getValues() 返回该日全部秒级数据点

// 4d) 查历史插值/统计值（historyInterQuery —— 按间隔聚合）
MetaTagValueQuery interQuery = new MetaTagValueQuery();
interQuery.setTags(new String[]{"HWNBYC174_1O_100620000015521"});
interQuery.setStartTime("2024-08-01 00:00:00");
interQuery.setEndTime("2024-08-31 23:59:59");
interQuery.setIntervalByMS(3600_000L);  // 1 小时间隔
interQuery.setNumberOfSamples(0);        // 0=不限点数
MetaTagValueResult inter = metaTagService.historyInterQuery(interQuery);

// 4e) 查指定时刻前后最近值（historyRawSpecificQuery —— 故障时刻定位）
MetaTagSpecialValueQuery specQuery = new MetaTagSpecialValueQuery();
specQuery.setTags(new String[]{"HWNBYC174_1O_100620000015521"});
specQuery.setTime("2024-08-14 10:47:00");
specQuery.setRadiusBefore(600_000L);  // 前 10 分钟
specQuery.setRadiusAfter(600_000L);   // 后 10 分钟
MetaTagValueResult spec = metaTagService.historyRawSpecificQuery(specQuery);
```

**层4 替代通道：TSDB REST 代理（IRTDBProxyService，免 Ice 客户端）**
```java
// 注入：@Autowired IRTDBProxyService rtdbProxyService;
// 或直接 HTTP：GET /rtdb/historyValueQuery?appId=10062&tagNames=HWNBYC174_1O_100620000015521&startTime=..&endTime=..&type=0

RTDBQueryParam param = new RTDBQueryParam();
param.setType(0);  // 0=原始,1=插值,2=统计
param.setTagNames(new String[]{"HWNBYC174_1O_100620000015521"});
param.setStartTime("2024-08-14 00:00:00");
param.setEndTime("2024-08-14 23:59:59");
param.setAppId(10062L);
Object result = rtdbProxyService.historyValueQuery(param);  // 内部 convert()→ANTAI.ATRTDBQueryParam 走 Ice
```

### 15.4 实测结论

| 层 | 通道 | 是否查出数据 | 关键发现 |
|---|---|---|---|
| 层1 基础属性 | MySQL `wt_elm_equipment` | ✅ | 设备树节点含 node_code/node_name/class__path/parent_ids |
| 层2 子类特有 | MySQL `wt_iot_huaweisun2000_b16793ce` | ⚠️ | 表存在但仅 id 列——华为逆变器无特有属性，全继承父表 |
| 层3 动态属性定义 | MySQL `meta_classtagmodel` | ✅ | 221 个测点（HWNBYC001~HWNBYC174+），含中文名和类型 |
| 层4a 测点字典 | MySQL `wt_iot_tags` | ✅ | **列名是 `tagname` 不是 `tag_name`**（踩坑修正）；tagName=tagCode_粒度_设备id |
| 层4b 时序数据 | StarRocks `WT_DATA` | ✅ | 2024-08-14 当天数据可查，秒级，quality=0 正常 |

**对问数系统的关键启示**：
1. **中文→数据的完整映射链已验证**：用户问"1号箱变1号逆变器总发电量" → `wt_elm_equipment` 按 node_name 查得 id=100620000015521 → `meta_classtagmodel` 按 name="总发电量" 查得 tagCode=HWNBYC174 → 拼 tagName=`HWNBYC174_1O_100620000015521` → `wt_iot_tags` 确认测点存在 → `WT_DATA`/Ice 查时序数据。**五步全链路有真实数据**。
2. **`wt_iot_tags.tagname` 列名陷阱**：与 `wt_iot_tags.tag_code`（带下划线）不同，`tagname` 是连写无下划线。问数模板必须用 `tagname`，否则 `Unknown column 'tag_name'`。
3. **子类表可能为空壳**：`wt_iot_huaweisun2000_b16793ce` 只有 id 列，说明华为逆变器模型未建模特有属性。问数查"逆变器特有字段"时应回退到父表 `wt_elm_equipment` 的 15 个基础字段。
4. **粒度后缀字典**：tagName 中段 `1O/1H/1D/1M/1Y` = 原始/小时/日/月/年。问数"最近 N 天日发电量"用 `1D`，"实时功率"用 `1O`。
5. **StarRocks 与 Ice 双通道均可用**：层4b 实测 StarRocks SQL 可查；Java 侧 `IMetaTagService.historyRawQuery` 走 Ice 9001 也能查同一份数据（Ice 是 StarRocks 的上层封装）。问数 P0 走 StarRocks SQL（已实现），P1 可加 Ice 通道。

---

## 十六、全量素材深挖实测（2026-09-08，StarRocks + MySQL 全库盘点）

> **脚本**：`scripts/deep-probe.mjs`（第 1-3 节）+ `scripts/deep-probe3.mjs`（第 4-7 节）。连接 MySQL `192.168.101.54:3306` + StarRocks `192.168.101.54:9030`。

### 16.1 StarRocks WT_DB 15 张表实测（含列结构 + 行数）

| 表 | 估算行数 | 列结构 | 语义 |
|---|---|---|---|
| `WT_DATA` | 34.5 亿 | `tagIndex:int, timestamp:datetime, quality:smallint, value:double` | **时序主表**。不存 tagName，通过 tagIndex 关联 WT_TAG |
| `WT_TAG` | 238 万 | `tagName:varchar(256), tagIndex:int, dataType:tinyint, comment:varchar(1024)` | **测点字典**。tagName↔tagIndex 映射 |
| `WT_CUBE` | 2553 万 | `device:bigint, tagCode:varchar(64), cubeType:smallint, timestamp:datetime, granularity:tinyint, value/avgValue/maxValue1/minValue1/sumValue/countValue:double` | 立方体汇总（含 6 种聚合值） |
| `WT_INVERTER_STATUS` | 19 万 | `device:bigint, timestamp:datetime, granularity:tinyint, status:tinyint, type:tinyint` | 逆变器状态汇总 |
| `WT_LOW_STRINGS` | 12 万 | `day:datetime, device:bigint, tagCode:varchar(128), type:tinyint, value:double, score:double` | 低效组串（score ≤ -2） |
| `WT_DUST` | 8408 | `timestamp, radiaValue, theoreValue, fullSumValue, fullRatio, actualSumValue, actualCountValue:int, actualRatio` | 灰尘检测 |
| `WT_PCS_TIMES` | 8020 | （PCS 运行时长） | PCS 设备运行时长 |
| `WT_BAD_PVS` | 7827 | （缺陷组串） | 坏光伏板列表 |
| `WT_INVERTER_FAILURE` | 6904 | （逆变器故障） | 故障损失电量 |
| `WT_ALL_DEVICES` | 4315 | `device:bigint, code:varchar(256), name:varchar(256)` | 全设备维度表（JOIN 用） |
| `WT_DEVICE` | 1910 | `inverterId, inverterName, inverterCode, arrayId, arrayName, arrayCode, subId, subName, subCode, type:tinyint` | 设备维度（逆变器↔方阵↔箱变关联） |
| `WT_ZC` | 112 | — | 未知（组串？） |
| `WT_RESTRICT_INFO` | 2 | — | 日限电电量统计 |
| `WT_STAUS_PERIODS` | 0 | — | 设备状态采集统计（空） |
| `WT_STRINGDATA` | 0 | — | 字符串时序数据（空） |

**WT_DATA 时间范围**：测点 `HWNBYC174_1O_100620000015521`（tagIndex=960799）有数据 `2024-08-01 ~ 2024-08-14`（14 天），最新值 215524.77，quality=0。**WT_DATA 不存 tagName，查时序数据必须先从 WT_TAG 查 tagIndex**。

> **与 §12.7 的差异**：实测 15 张表，比 §12.7 从 Java 代码提取的 12 张多了 `WT_INVERTER_STATUS`/`WT_PCS_TIMES`/`WT_ZC`/`WT_STAUS_PERIODS`。§12.7 的 `WT_DEVICE_DATA_STAT`/`WT_DEVICE_TAG_STAT` 实测不存在（可能未部署或改名）。

### 16.2 meta_class_info 295 个模型完整清单（按 app_id 分组）

| app_id | 数量 | 语义 | 代表模型 |
|---|---|---|---|
| -1 | 37 | **系统元模型** | queryscheme/smartsymbol/users/permission/routines/appinfo |
| 1 | 82 | **系统级通用模型** | equipment/persons/organization/document/building/meterial/product/warehouse/workflow/role/calendar |
| 101 | 11 | 能源管理 | 排放物/电力/燃气/油品/蒸汽/冷热/水 |
| 102 | 19 | 教育管理 | 学生/教师/考试/成绩/学校/加分 |
| 103 | 15 | 医疗管理 | 医院/病患/医生/医用氧/氮/压缩空气 |
| 104 | 6 | 图书馆 | 图书/章节/函套/页码/册 |
| 106 | 3 | 工厂 | 工厂/部门/仓库 |
| 109 | 40 | **IoT + 智能建筑** | MQTT/modbus/摄像头/电表/测点分类/智能系统 16 种（门禁/广播/照明/停车等） |
| 111 | 5 | ETL | 接口/SQL 采集/数据源 |
| **10062** | **35** | **博乐光伏（问数主战场）** | 见下表 |
| 3471/3474/3478 | 16 | 宿舍/安保/访客 | 请假/就寝/考勤/访客/人脸/隐蔽工程 |
| 其他 | 26 | 各租户测试/定制 | 10028 图书图像检测、10106 环保、10119 监理等 |

**app_id=10062 博乐光伏 35 个模型**（问数主战场）：

| 中文名 | class_path | 类型 |
|---|---|---|
| 华为逆变器模型 | `wt_elm_equipment/wt_iot_huaweisun2000` | 设备 |
| 阳光电源逆变器模型 | `wt_elm_equipment/wt_iot_sungrowsg` | 设备 |
| 华为箱变模型 | `wt_elm_equipment/wt_iot_padmounted` | 设备 |
| 阳光箱变模型 | `wt_elm_equipment/wt_iot_sungrowpadmounted` | 设备 |
| 华为方阵模型 | `wt_elm_equipment/wt_iot_huaweiarray` | 设备 |
| 阳光电源方阵模型 | `wt_elm_equipment/wt_iot_sungrowarray` | 设备 |
| 电池簇模型 | `wt_elm_equipment/wt_iot_batteryrack` | 设备 |
| 电池堆模型 | `wt_elm_equipment/wt_iot_betterybank` | 设备 |
| 储能PCS模型 | `wt_elm_equipment/wt_iot_pcs` | 设备 |
| 储能升压一体机模型 | `wt_elm_equipment/wt_iot_storebooster` | 设备 |
| 35KV1-5段模型 | `wt_elm_equipment/wt_iot_35kv{1-5}seg` | 设备 |
| AGC模型 / AVC模型 | `wt_elm_equipment/wt_iot_agc` / `wt_iot_avc` | 设备 |
| 站用变模型 | `wt_elm_equipment/wt_iot_ownsubstation` | 设备 |
| 无功补偿装置模型 | `wt_elm_equipment/wt_iot_svg` | 设备 |
| PID模块模型 | `wt_elm_equipment/wt_iot_pidmodule` | 设备 |
| 组串支架模型 | `wt_elm_equipment/wt_iot_pvmodules` | 设备 |
| 一体化电源模型 | `wt_elm_equipment/wt_iot_sources` | 设备 |
| 热斑摄像机 | `wt_elm_equipment/wt_iot_hotsoptcam` | 设备 |
| 中皂/中集/中储光线路模型 | `wt_iot_zhongzao` / `zhongji` / `zhongchu` | 设备 |
| 新能源电站模型 | `wt_elm_organization/wt_elm_unit/wt_egy_renewablestation` | 组织 |
| 电站部门模型 | `wt_elm_organization/wt_elm_department/wt_iot_solarunit` | 组织 |
| 告警动态属性配置 | `wt_cus_alarmdynamicconfig` | 业务 |
| 方阵告警配置表 | `wt_10062_fangzhengaojingpeizhibiao` | 业务 |
| 告警白名单配置模型 | `wt_10062_gaojingbaimingdanpeizhimoxing` | 业务 |
| 逆变器电损统计 | `wt_10062_nibianqidiansuntongji` | 业务 |
| 运维工单 | `wt_cus_10062_work_order` | 业务 |
| 组串热斑图 | `wt_iot_hotsoptblock` | 业务 |
| 图书馆借书记录 | `wt_cus_borrow_book_record` | 业务（非光伏） |

### 16.3 WT-SQL 11 个方案完整内容（问数模板化的权威参考）

| ID | name | app_id | SQL 摘要 |
|---|---|---|---|
| 10000000001 | chanxu jie | 0 | `select a.* from $CLASS(wt_iot_tags) as A where id=#{id,long,标识}` |
| 10000000031 | getOrgInfoByClassPath | 1 | `select a.id,a.node_name,a.parent_id from $CLASS(wt_elm_organization) as A where a.class__path = '#{classPath,string,类路径}'` |
| 10000000041 | getDocumentClassify | 1 | `select a.* from $CLASS(wt_elm_docclassify) as A where app_id = '#{appId,string,应用ID}'` |
| 10000000051 | getStudentWithAppId | 1 | `select a.* from $CLASS(wt_elm_persons/wt_edu_student) as A where app_id = #{app_id,long,应用ID}` |
| 10000000071 | getAllDormList | 1 | `select a.* from $CLASS(wt_elm_basic_building/wt_elm_buildingspace) as a where a.app_id = #{appId,Integer,应用ID} and a.use_to = 7 and a.node_name not like '%卫生间%'` |
| 10000000082 | getUserInfoV1 | 1 | 3 表 JOIN：`$CLASS(wt_bas_users/wt_bas_consumer)` + `$LINK(outterLink_[wt_elm_organization]_[wt_bas_users],...)` + `$CLASS(wt_elm_post)` + GROUP_CONCAT |
| 10000000091 | getUserInfoV2 | 1 | **4 表 JOIN**：users + org + post + role + duties，GROUP_CONCAT × 15，**alias_transform 15 字段中文名 JSON** |
| 34710000000013 | getStudent | 3471 | `select a.* from $CLASS(wt_elm_persons/wt_edu_student) as A where name like '%#{name,String,姓名}%' and sex = #{sex,int,性别}` |
| 324844576804864 | getAllTagList | 1 | `select a.* from $LINK(outterLink_[WT_IOT_TAGCLASSIFY]_[WT_IOT_TAGS],WT_IOT_TAGCLASSIFY) as A where leftid = #{id,long,键值}` |
| 324844585193472 | getAllAnalogTags | 1 | 同上 + `\|WT_IOT_ANALOGTAG`（子模型过滤） |
| 324844597776384 | getAllDigitalTags | 1 | 同上 + `\|WT_IOT_DIGITALTAG` |

**WT-SQL 语法元素全集**（从 11 个方案实证提取）：
- `$CLASS(类路径)` — 模型宏，类路径→物理表
- `$LINK(outterLink_[模型A]_[模型B], 模型A|模型B/子模型)` — 关系宏，跨模型 JOIN
- `#{参数名,类型,中文提示}` — 位置占位符
- `:参数名` — 命名参数（getUserInfoV2 的 `:appId`）
- `alias_transform` — `[{"field_name":"org_name","field_title":"部门名称"},...]` 字段中文名映射 JSON

### 16.4 wt_iot_tags 测点分布（205 万行）

- **总行数**：2,054,844（估算）
- **按 app_id**：几乎全部 app_id=10062（博乐光伏）
- **tag_type**：存中文文本（"数字量"/"模拟量"），非编码
- **粒度后缀**：`1O`=原始秒级、`1H`=时统计、`1D`=日统计、`1M`=月统计、`1Y`=年统计
- **华为逆变器测点命名规律**（HWNBYC 前缀）：
  - `HWNBYC174_1O_100620000015521` = 总发电量原始测点
  - `HWNBYC174_1H_100620000015521` = 总发电量时统计测点
  - `HWNBYC174_1D_100620000015521` = 总发电量日统计测点
  - `HWNBYC174_1M_100620000015521` = 总发电量月统计测点
  - `HWNBYC174_1Y_100620000015521` = 总发电量年统计测点
  - **每个 tagCode × 每个设备 × 5 种粒度 = 5 行测点字典**
- **阳光逆变器**：`YGNBYC054` = 总发电量（同构命名）

### 16.5 bole 业务库 35 张表（含子类实例表命名规律）

**子类实例表**（@MetaClass 动态生成，表名 = `类名_hex(id)`）：

| 表 | 行数 | 对应模型 | 说明 |
|---|---|---|---|
| `wt_iot_batteryrack_1c159d84` | 1680 | 电池簇 | 最多实例 |
| `wt_iot_sungrowsg_e41274bd` | 1320 | 阳光逆变器 | |
| `wt_iot_huaweisun2000_b16793ce` | 590 | 华为逆变器 | 仅 id 列（无特有属性） |
| `wt_iot_sungrowarray_8c7f8acd` | 132 | 阳光方阵 | |
| `wt_iot_sungrowpadmounted_af50988c` | 132 | 阳光箱变 | |
| `wt_iot_pcs_4d491b72` | 106 | 储能PCS | |
| `wt_iot_betterybank_13f5de8a` | 105 | 电池堆 | |
| `wt_iot_padmounted_e6e1c7e2` | 59 | 华为箱变 | |
| `wt_iot_huaweiarray_9a5d8afd` | 59 | 华为方阵 | |
| `wt_iot_storebooster_1879f70c` | 56 | 储能升压一体机 | |
| 其他 | <25 | 热斑/线路/AGC等 | |

**业务表**：

| 表 | 行数 | 说明 |
|---|---|---|
| `wt_cus_alarmdynamicconfig` | 379 | **告警动态配置**（tag_code + tag_comment + alarm_level + alarm_classify + cus_class_path） |
| `meta_magic_api_file_custom` | 47 | magic-api 接口脚本 |
| `wt_cus_10062_work_order` | 4 | 运维工单 |
| `wt_iot_hotsoptblock` | 16 | 组串热斑图 |
| `wt_10062_fangzhengaojingpeizhibiao` | 0 | 方阵告警配置（含 wrj_ip/account/passwd 无人机配置） |
| `wt_10062_gaojingbaimingdanpeizhimoxing` | 0 | 告警白名单 |
| `wt_10062_nibianqidiansuntongji` | 0 | 逆变器电损统计 |

**告警配置样本**（`wt_cus_alarmdynamicconfig`）：
```json
{
  "tag_code": "HWFZYC010", "tag_comment": "有功调度指令异常1",
  "cus_class_path": "wt_elm_equipment/wt_iot_huaweiarray",
  "alarm_type": "1", "alarm_level": "1::提示", "alarm_classify": "数据传输异常",
  "is_white": "0", "status": 1, "app_id": 10062
}
```

### 16.6 告警数据实测（wt_bas_alarmrecord，11489 行真实告警）

**最新 10 条告警**（2024-10-10）：

| alarm_time | alarm_level | entity_name | tag_code | alarm_title |
|---|---|---|---|---|
| 10-10 06:41 | 3::严重 | AGCYC009_1O_100620000028851 | AGCYC009 | AGC超发功率告警 |
| 10-10 05:34 | 2::警告 | 77号箱变10号逆变器 | HWNBYC001 | 通讯故障 |
| 10-10 05:20 | 1::提示 | Ⅲ-#1B储能电池堆8号簇 | CNRACKYX22 | 充电电流过大一级报警 |
| 10-10 05:20 | 1::提示 | Ⅱ-#8B储能电池堆8号簇 | CNRACKYX22 | 充电电流过大一级报警 |
| 10-10 03:54 | 3::严重 | AGCYC009_1O_100620000028851 | AGCYC009 | AGC超发功率告警 |

**告警级别**：`1::提示` / `2::警告` / `3::严重`。**告警状态**：`0`=已恢复，`1`=未处理。
**告警 tag_code 前缀**：`HWNBYC`=华为逆变器、`AGCYC`=AGC、`CNRACKYX`=电池簇。

### 16.7 设备树拓扑实测

**tree_level 分布**：

| level | 数量 | 语义 |
|---|---|---|
| null | 800 | 未设置层级（35KV 段等） |
| 1 | 6126 | 顶层（含大量测试数据 a1~a17） |
| 2 | 67 | |
| 3 | 244 | **方阵**（如"1#方阵"） |
| 4 | 296 | **箱变**（如"1#箱变"） |
| 5 | 2015 | **逆变器**（如"1号箱变1号逆变器"） |
| 6 | 1680 | **电池簇** |

**光伏设备树层级**（实测父链）：
```
L3 方阵（wt_iot_huaweiarray）
  └─ L4 箱变（wt_iot_padmounted）
       └─ L5 逆变器（wt_iot_huaweisun2000）
            └─ L6 电池簇（wt_iot_batteryrack）
```

**实测父链**：`1号箱变1号逆变器`(L5, id=100620000015521) → parent `1#箱变`(L4, id=100620000005899) → parent `1#方阵`(L3)。1#箱变下有 10 台华为逆变器（1#-N1-H ~ 1#-N10-H）。

### 16.8 对问数系统的增量结论（第四轮）

1. **WT_DATA 必须通过 tagIndex 查**：`WT_DATA` 不存 tagName，只有 `tagIndex(int)`。查询链：`WT_TAG.tagName → tagIndex → WT_DATA.tagIndex`。问数工具需要先查 WT_TAG 拿 tagIndex，再查 WT_DATA。
2. **WT_CUBE 是汇总查询的首选**：含 `value/avgValue/maxValue1/minValue1/sumValue/countValue` 6 种聚合值，按 `device+tagCode+granularity+timestamp` 维度聚合。问数"某设备某指标某时段的平均值/最大值"走 WT_CUBE 比 WT_DATA 全表聚合快得多。
3. **WT_DEVICE 是设备关联维度表**：`inverterId↔arrayId↔subId` 直接关联逆变器/方阵/箱变，问数"某方阵下所有逆变器"走 WT_DEVICE 比 wt_elm_equipment 递归查 parent_id 快。
4. **295 个模型中只有 35 个是光伏相关**（app_id=10062）。问数系统应过滤 `app_id=10062`，避免查到教育/医疗/图书馆等无关模型。
5. **WT-SQL 11 个方案全部是系统级**（app_id=0/1/3471），**无光伏场景方案**。问数若复用 WT-SQL 通道，需自建光伏场景的查询方案（存入 wt_bas_queryscheme）。
6. **告警数据有 11489 行真实数据**，最新到 2024-10-10。问数"最近有什么告警"能查出真实结果。告警级别 3 级（提示/警告/严重），状态 2 种（0=恢复/1=未处理）。
7. **告警配置 379 行**，按 `cus_class_path`（设备类路径）+ `tag_code`（测点）配置告警规则。问数"某类设备的告警配置"走 `wt_cus_alarmdynamicconfig`。
8. **设备树 6 层**：方阵(L3)→箱变(L4)→逆变器(L5)→电池簇(L6)。问数"某方阵下所有逆变器"可用 `wt_elm_equipment WHERE class__path LIKE '%huaweisun2000%' AND parent_id IN (SELECT id FROM wt_elm_equipment WHERE parent_id = 方阵id)` 或走 WT_DEVICE 维度表。
9. **bole 库的子类实例表命名规律**：`{类名}_{hex(meta_class_info.id)}`。如 `wt_iot_huaweisun2000_b16793ce`，`b16793ce` = hex(10062 模型的 meta_class_info.id)。问数动态查某模型实例表时需先从 meta_class_info.id 算 hex 后缀。
