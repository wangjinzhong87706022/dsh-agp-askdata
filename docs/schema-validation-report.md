# 数据底座查询结构验证报告

> 生成时间: 2026-09-09
> 验证环境: StarRocks 192.168.101.54:9030 (WT_DB) + MySQL 192.168.101.54:3306 (wisetao_meta)

## 验证结果概览

| 数据库 | 表名 | 结果 | 差异说明 |
|--------|------|------|----------|
| StarRocks | WT_TAG | ✓ 通过 | 4 列匹配 |
| StarRocks | WT_DATA | ✓ 通过 | 4 列匹配 |
| StarRocks | WT_CUBE | ✗ 差异 | 用 device+tagCode 而非 tagIndex；无 quality |
| StarRocks | WT_DEVICE | ✗ 差异 | 字段名全异（inverterId/arrayId/subId 而非 deviceCode） |
| MySQL | meta_class_info | ✗ 差异 | parent_class_id 而非 parent_id；level 而非 tree_level |
| MySQL | wt_elm_equipment | ✓ 通过 | 34 列，预期字段全在 |
| MySQL | meta_classtagmodel | ✓ 通过 | 22 列，预期字段全在 |
| MySQL | wt_iot_tags | ✗ 差异 | tagname（小写 n）而非 tagName；无 tagIndex |

## 详细差异数据

### 1. WT_CUBE（StarRocks）— 聚合表

**实际列** (11 列):
```
device, tagCode, cubeType, timestamp, granularity, value,
avgValue, maxValue1, minValue1, sumValue, countValue
```

**预期列**: `tagIndex, timestamp, value, quality, granularity`

**差异**:
- 用 `device` (bigint) + `tagCode` (varchar) 定位测点，而非 `tagIndex`
- 无 `quality` 字段（聚合后无质量位）
- 多出 `avgValue/maxValue1/minValue1/sumValue/countValue` 聚合值列
- `cubeType` 列编码测点类型

**样本**:
```json
{"device":100620000005912,"tagCode":"NBQDLLSD1","cubeType":13,"timestamp":"2023-12-31T16:00:00.000Z","granularity":4,"value":0.035,"avgValue":79.94,"maxValue1":81.07,"minValue1":78.26,"sumValue":478295.91,"countValue":6670}
```

### 2. WT_DEVICE（StarRocks）— 设备表

**实际列** (10 列):
```
inverterId, inverterName, inverterCode,
arrayId, arrayName, arrayCode,
subId, subName, subCode, type
```

**预期列**: `deviceCode, deviceName, deviceType`

**差异**: 字段名完全不同，按设备类型分组（逆变器/组串/子阵）

### 3. meta_class_info（MySQL）— 模型清单

**实际列** (24 列):
```
id, class_name, class_alias, class_description, class_inner_name, class_path,
class_icon, parent_class_id, module_id, app_domain, level, industry_id,
app_id, table_type, cascade_delete_flag, attrs_extend_type, classify_tag,
addtion_props, remark, seq_name, create_time, create_id, update_time, update_id
```

**预期列**: `id, class_path, class_name, parent_id, tree_level`

**差异**:
- `parent_class_id` 而非 `parent_id`
- `level` 而非 `tree_level`

**行数**: 295 行

### 4. wt_iot_tags（MySQL）— 测点字典

**实际列** (21 列):
```
id, tagname, alias, description, tag_type, master_code, active, tag_code,
master_class_id, app_id, tag_address, in_out, static, class__path, deleted,
create_time, create_id, update_time, update_id, belong_info, derive_type
```

**预期列**: `tagName, tagIndex, alias, tag_code, master_code`

**差异**:
- `tagname`（全小写）而非 `tagName`（驼峰）
- 无 `tagIndex` 列（tagIndex 在 StarRocks WT_TAG 中，不在 MySQL wt_iot_tags）

**行数**: 2,354,571 行

## 数据量统计

| 表 | 行数 |
|----|------|
| StarRocks WT_TAG | 2,377,997 |
| MySQL meta_class_info | 295 |
| MySQL wt_elm_equipment | 11,230 |
| MySQL meta_classtagmodel | 15,067 |
| MySQL wt_iot_tags | 2,354,571 |

## 需修复的代码引用

1. **`src/config.ts`** — WT_CUBE 表的 `tagIndex`/`quality` 字段引用需改为 `device`+`tagCode`
2. **`src/sql/templates.ts`** — 聚合模板中 WT_CUBE 的 JOIN 条件需调整
3. **P1 工具** — `lookup_model` 中 `parent_id`→`parent_class_id`，`tree_level`→`level`
4. **P1 工具** — `resolve_tag` step4 中 `wt_iot_tags.tagName`→`wt_iot_tags.tagname`