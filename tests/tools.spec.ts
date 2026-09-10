import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { QueryOutput } from '../src/clients/starrocks.ts'
import type { SqlExecutor, ToolContext } from '../tools/types.ts'
import { p0Tools, p1Tools, schemaTools, allTools } from '../tools/index.ts'
import { buildAuditRow, type AuditRow } from '../src/audit.ts'

function testContext(
  respond: (sql: string) => QueryOutput,
  options?: { maxScanRows?: number; mysqlRespond?: (sql: string) => QueryOutput },
): { ctx: ToolContext; audits: AuditRow[] } {
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    mysqlConnection: { host: 'db', port: 3306, user: 'u', password: 'p', database: 'wisetao_meta' },
    system: options?.maxScanRows !== undefined ? { maxScanRows: options.maxScanRows } : undefined,
    audit: { enabled: true },
  })
  const executor: SqlExecutor = { execute: async (sql) => respond(sql) }
  const mysqlExecutor: SqlExecutor = {
    execute: async (sql) => (options?.mysqlRespond ?? respond)(sql),
  }
  const audits: AuditRow[] = []
  const ctx: ToolContext = {
    config,
    executor,
    mysqlExecutor,
    prevAuditHash: '',
    onAudit: (row) => audits.push(row as AuditRow),
  }
  return { ctx, audits }
}

function byIncludes(map: Array<[string, QueryOutput]>): (sql: string) => QueryOutput {
  return (sql) => {
    const hit = map.find(([needle]) => sql.includes(needle))
    if (!hit) throw new Error(`fake executor: 未匹配的 SQL: ${sql.slice(0, 80)}`)
    return hit[1]
  }
}

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name)
  if (!t) throw new Error(`工具未注册: ${name}`)
  return t
}

describe('工具注册表', () => {
  it('P0 五工具齐全且顺序合理', () => {
    expect(p0Tools.map((t) => t.name)).toEqual([
      'lookup_tag',
      'estimate_count',
      'latest_value',
      'time_series',
      'aggregate',
    ])
  })
  it('P1 六工具齐全且顺序合理', () => {
    expect(p1Tools.map((t) => t.name)).toEqual([
      'lookup_model',
      'lookup_object',
      'lookup_tag_definition',
      'resolve_tag',
      'query_alarm',
      'query_alarm_config',
    ])
  })
  it('结构验证阶段工具消费 WT_DEVICE', () => {
    expect(schemaTools.map((t) => t.name)).toEqual(['lookup_device'])
  })
})

describe('lookup_tag', () => {
  it('命中返回结构化行', async () => {
    const { ctx, audits } = testContext(
      byIncludes([
        ['FROM WT_TAG', { columns: ['tagName', 'tagIndex', 'dataType', 'comment'], rows: [{ tagName: 'HWNBYC174_1O_DEV001', tagIndex: '174', dataType: '2', comment: '组串电流' }] }],
      ]),
    )
    const result = await tool('lookup_tag').run({ keyword: '组串电流' }, ctx)
    expect(result.success).toBe(true)
    expect(result.rowCount).toBe(1)
    expect(result.data[0]).toEqual({ tagName: 'HWNBYC174_1O_DEV001', tagIndex: 174, dataType: 2, comment: '组串电流' })
    expect(audits).toHaveLength(1)
    expect(result.auditId).toBe(audits[0]!.auditId)
  })
  it('空关键字返回 INVALID_PARAM', async () => {
    const { ctx } = testContext(() => ({ columns: [], rows: [] }))
    const result = await tool('lookup_tag').run({ keyword: '' }, ctx)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_PARAM')
  })
})

describe('latest_value', () => {
  const existCheck = (names: string[]) => ({
    columns: ['tagName'],
    rows: names.map((n) => ({ tagName: n })),
  })
  it('全部缺失 → TAG_NOT_FOUND', async () => {
    const { ctx } = testContext(byIncludes([['WHERE tagName IN', { columns: ['tagName'], rows: [] }]]))
    const result = await tool('latest_value').run({ tag_names: ['nope_1O_D1'] }, ctx)
    expect(result.errorCode).toBe('TAG_NOT_FOUND')
  })
  it('部分缺失继续查询并回填 missingTagNames', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT tagName FROM WT_TAG', existCheck(['HWNBYC174_1O_DEV001'])],
        ['max_by', {
          columns: ['tagName', 'latestValue', 'latestTime'],
          rows: [{ tagName: 'HWNBYC174_1O_DEV001', latestValue: '12.5', latestTime: '2026-08-01 10:00:00' }],
        }],
      ]),
    )
    const result = await tool('latest_value').run(
      { tag_names: ['HWNBYC174_1O_DEV001', 'GHOST_1O_D9'] },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      tagName: 'HWNBYC174_1O_DEV001',
      latestValue: 12.5,
      latestTime: '2026-08-01 10:00:00',
    })
    expect(result.data[1]?.missingTagNames).toBe('GHOST_1O_D9')
  })
})

describe('time_series 扫描护栏', () => {
  const args = {
    tag_filter: '^HWNBYC174_1O_',
    start_time: '2026-08-01T00:00:00+08:00',
    end_time: '2026-08-02T00:00:00+08:00',
    bucket: '1h',
  }
  it('扫描量超限 → EXCEED_LIMIT，且不执行主查询', async () => {
    const executed: string[] = []
    const { ctx } = testContext((sql) => {
      executed.push(sql)
      return { columns: ['scanRows'], rows: [{ scanRows: String(100_000_001) }] }
    })
    const result = await tool('time_series').run(args, ctx)
    expect(result.errorCode).toBe('EXCEED_LIMIT')
    expect(executed.filter((s) => s.includes('date_trunc'))).toHaveLength(0)
  })
  it('限额内走主查询并产出桶行', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '1000' }] }],
        ['AS `bucket`', {
          columns: ['bucket', 'avgValue', 'minValue', 'maxValue', 'sampleCount'],
          rows: [{ bucket: '2026-08-01 01:00:00', avgValue: '5.0', minValue: '4.9', maxValue: '5.2', sampleCount: '60' }],
        }],
        ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '174' }] }],
      ]),
    )
    const result = await tool('time_series').run(args, ctx)
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      bucket: '2026-08-01 01:00:00',
      avgValue: 5.0,
      minValue: 4.9,
      maxValue: 5.2,
      sampleCount: 60,
    })
  })
})

describe('aggregate', () => {
  it('device 分组返回数值化行', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '10' }] }],
        ['AS `aggValue`', {
          columns: ['device', 'aggValue', 'sampleCount'],
          rows: [{ device: 'DEV001', aggValue: '3.3', sampleCount: '24' }],
        }],
        ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '174' }] }],
      ]),
    )
    const result = await tool('aggregate').run(
      {
        tag_filter: '^HWNBYC174_1O_',
        start_time: '2026-08-01T00:00:00+08:00',
        end_time: '2026-08-02T00:00:00+08:00',
        func: 'AVG',
        group_by: 'device',
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({ device: 'DEV001', aggValue: 3.3, sampleCount: 24 })
  })
  it('非法 func → INVALID_PARAM（不触达执行器）', async () => {
    let called = 0
    const { ctx } = testContext(() => {
      called++
      return { columns: [], rows: [] }
    })
    const result = await tool('aggregate').run(
      {
        tag_filter: '^t_',
        start_time: '2026-08-01T00:00:00+08:00',
        end_time: '2026-08-02T00:00:00+08:00',
        func: 'MEDIAN',
      },
      ctx,
    )
    expect(result.errorCode).toBe('INVALID_PARAM')
    expect(called).toBe(0)
  })
  it('1H 粒度 + func 可路由 → cubeType 唯一 → 查 WT_CUBE', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '10' }] }],
        ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '1961453' }] }],
        ['SELECT DISTINCT cubeType', { columns: ['cubeType'], rows: [{ cubeType: '1' }] }],
        ['FROM WT_CUBE a', {
          columns: ['bucket', 'aggValue', 'sampleCount'],
          rows: [{ bucket: 'all', aggValue: '79.9', sampleCount: '24' }],
        }],
      ]),
    )
    const result = await tool('aggregate').run(
      {
        tag_filter: '^HWNBYC174_1H_100620000015521',
        start_time: '2026-08-01T00:00:00+08:00',
        end_time: '2026-08-02T00:00:00+08:00',
        func: 'AVG',
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({ bucket: 'all', aggValue: 79.9, sampleCount: 24 })
    expect(result.apiOrSql).toContain('FROM WT_CUBE a')
    expect(result.apiOrSql).toContain("a.`tagCode` = 'HWNBYC174'")
    expect(result.apiOrSql).toContain('a.`device` = 100620000015521')
  })
  it('cubeType 口径不唯一（2 个）→ 回退 WT_DATA', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '10' }] }],
        ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '1961453' }] }],
        ['SELECT DISTINCT cubeType', { columns: ['cubeType'], rows: [{ cubeType: '13' }, { cubeType: '15' }] }],
        ['AS `aggValue`', {
          columns: ['bucket', 'aggValue', 'sampleCount'],
          rows: [{ bucket: 'all', aggValue: '1.5', sampleCount: '99' }],
        }],
      ]),
    )
    const result = await tool('aggregate').run(
      {
        tag_filter: '^NBQDLLSD1_1H_100620000005912',
        start_time: '2026-08-01T00:00:00+08:00',
        end_time: '2026-08-02T00:00:00+08:00',
        func: 'AVG',
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.apiOrSql).toContain('FROM WT_DATA a')
    expect(result.apiOrSql).not.toContain('WT_CUBE')
  })
  it('STDDEV 不路由 WT_CUBE（D3），走 WT_DATA', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '10' }] }],
        ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '1961453' }] }],
        ['AS `aggValue`', {
          columns: ['bucket', 'aggValue', 'sampleCount'],
          rows: [{ bucket: 'all', aggValue: '0.02', sampleCount: '24' }],
        }],
      ]),
    )
    const result = await tool('aggregate').run(
      {
        tag_filter: '^HWNBYC174_1H_100620000015521',
        start_time: '2026-08-01T00:00:00+08:00',
        end_time: '2026-08-02T00:00:00+08:00',
        func: 'STDDEV',
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.apiOrSql).toContain('FROM WT_DATA a')
    expect(result.apiOrSql).not.toContain('WT_CUBE')
  })
})

describe('estimate_count', () => {
  it('返回估算与限额判定', async () => {
    const { ctx } = testContext(
      byIncludes([['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '123' }] }]]),
    )
    const result = await tool('estimate_count').run(
      { start_time: '2026-08-01T00:00:00+08:00', end_time: '2026-08-02T00:00:00+08:00' },
      ctx,
    )
    expect(result.data[0]).toEqual({ scanRows: 123, withinLimit: true, maxScanRows: 100_000_000 })
  })
})

// ============ P1 工具测试 ============

describe('lookup_model', () => {
  it('返回模型清单', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['FROM wisetao_meta.meta_class_info', {
          columns: ['class_alias', 'class_name', 'class_path', 'level'],
          rows: [{ class_alias: 'Inverter', class_name: '逆变器', class_path: 'wisetao.pv.inverter', level: '3' }],
        }],
      ]),
    )
    const result = await tool('lookup_model').run({}, ctx)
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      class_alias: 'Inverter',
      class_name: '逆变器',
      class_path: 'wisetao.pv.inverter',
      level: 3,
    })
  })
})

describe('lookup_object', () => {
  it('按 node_name 模糊查询设备', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['FROM wisetao_meta.wt_elm_equipment', {
          columns: ['id', 'node_code', 'node_name', 'class__path', 'parent_id', 'tree_level', 'position'],
          rows: [{ id: '174', node_code: 'INV001', node_name: '1号逆变器', class__path: 'wisetao.pv.inverter', parent_id: '10', tree_level: '3', position: '1' }],
        }],
      ]),
    )
    const result = await tool('lookup_object').run({ node_name: '逆变器' }, ctx)
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      id: 174,
      node_code: 'INV001',
      node_name: '1号逆变器',
      'class__path': 'wisetao.pv.inverter',
      parent_id: 10,
      tree_level: 3,
      position: '1',
    })
  })
})

describe('lookup_tag_definition', () => {
  it('返回模型测点定义', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['FROM wisetao_meta.meta_classtagmodel', {
          columns: ['tag_code', 'name', 'tag_type', 'calculated', 'in_out'],
          rows: [{ tag_code: 'Udc', name: '直流电压', tag_type: '2', calculated: '0', in_out: '1' }],
        }],
      ]),
    )
    const result = await tool('lookup_tag_definition').run({ class_path: 'wisetao.pv.inverter' }, ctx)
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({ tag_code: 'Udc', name: '直流电压', tag_type: 2, calculated: 0, in_out: 1 })
  })
  it('空 class_path → INVALID_PARAM', async () => {
    const { ctx } = testContext(() => ({ columns: [], rows: [] }))
    const result = await tool('lookup_tag_definition').run({ class_path: '' }, ctx)
    expect(result.errorCode).toBe('INVALID_PARAM')
  })
})

describe('resolve_tag', () => {
  it('5 步链路成功解析', async () => {
    const mysqlRespond = byIncludes([
      ['FROM wisetao_meta.wt_elm_equipment', {
        columns: ['id', 'class__path'],
        rows: [{ id: '174', class__path: 'wisetao.pv.inverter' }],
      }],
      ['FROM wisetao_meta.meta_classtagmodel', {
        columns: ['tag_code'],
        rows: [{ tag_code: 'Udc' }],
      }],
      ['FROM wisetao_meta.wt_iot_tags', {
        columns: ['alias'],
        rows: [{ alias: 'UdcAlias' }],
      }],
    ])
    const srRespond = byIncludes([
      ['FROM WT_TAG', {
        columns: ['tagIndex'],
        rows: [{ tagIndex: '999' }],
      }],
    ])
    const { ctx } = testContext(srRespond, { mysqlRespond })
    const result = await tool('resolve_tag').run(
      { device_name: '1号逆变器', tag_name_cn: '直流电压', granularity: '1O' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      tagName: 'Udc_1O_174',
      tagIndex: 999,
      deviceId: 174,
      tagCode: 'Udc',
      alias: 'UdcAlias',
    })
  })
  it('设备未找到 → OBJECT_NOT_FOUND', async () => {
    const mysqlRespond = byIncludes([
      ['FROM wisetao_meta.wt_elm_equipment', { columns: ['id', 'class__path'], rows: [] }],
    ])
    const { ctx } = testContext(() => ({ columns: [], rows: [] }), { mysqlRespond })
    const result = await tool('resolve_tag').run(
      { device_name: '不存在', tag_name_cn: '直流电压', granularity: '1O' },
      ctx,
    )
    expect(result.errorCode).toBe('OBJECT_NOT_FOUND')
  })
  it('测点中文名未找到 → TAG_DEFINITION_NOT_FOUND', async () => {
    const mysqlRespond = byIncludes([
      ['FROM wisetao_meta.wt_elm_equipment', {
        columns: ['id', 'class__path'],
        rows: [{ id: '174', class__path: 'wisetao.pv.inverter' }],
      }],
      ['FROM wisetao_meta.meta_classtagmodel', { columns: ['tag_code'], rows: [] }],
    ])
    const { ctx } = testContext(() => ({ columns: [], rows: [] }), { mysqlRespond })
    const result = await tool('resolve_tag').run(
      { device_name: '1号逆变器', tag_name_cn: '不存在的测点', granularity: '1O' },
      ctx,
    )
    expect(result.errorCode).toBe('TAG_DEFINITION_NOT_FOUND')
  })
  it('tagName 未注册 → TAG_NOT_REGISTERED', async () => {
    const mysqlRespond = byIncludes([
      ['FROM wisetao_meta.wt_elm_equipment', {
        columns: ['id', 'class__path'],
        rows: [{ id: '174', class__path: 'wisetao.pv.inverter' }],
      }],
      ['FROM wisetao_meta.meta_classtagmodel', {
        columns: ['tag_code'],
        rows: [{ tag_code: 'Udc' }],
      }],
      ['FROM wisetao_meta.wt_iot_tags', { columns: ['alias'], rows: [] }],
    ])
    const { ctx } = testContext(() => ({ columns: [], rows: [] }), { mysqlRespond })
    const result = await tool('resolve_tag').run(
      { device_name: '1号逆变器', tag_name_cn: '直流电压', granularity: '1O' },
      ctx,
    )
    expect(result.errorCode).toBe('TAG_NOT_REGISTERED')
  })
})

describe('query_alarm', () => {
  it('返回告警记录', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['FROM wisetao_meta.wt_bas_alarmrecord', {
          columns: ['id', 'alarm_title', 'alarm_time', 'alarm_level', 'alarm_status', 'entity_name', 'tag_code', 'description'],
          rows: [{ id: '1', alarm_title: '逆变器离线', alarm_time: '2026-08-01 10:00:00', alarm_level: 'critical', alarm_status: '1', entity_name: '1号逆变器', tag_code: 'Status', description: '设备离线' }],
        }],
      ]),
    )
    const result = await tool('query_alarm').run({
      start_time: '2026-08-01T00:00:00+08:00',
      end_time: '2026-08-02T00:00:00+08:00',
    }, ctx)
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      id: 1,
      alarm_title: '逆变器离线',
      alarm_time: '2026-08-01 10:00:00',
      alarm_level: 'critical',
      alarm_status: 1,
      entity_name: '1号逆变器',
      tag_code: 'Status',
      description: '设备离线',
    })
  })
})

describe('query_alarm_config', () => {
  it('返回告警配置', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['FROM bole.wt_cus_alarmdynamicconfig', {
          columns: ['tag_code', 'tag_comment', 'cus_class_path', 'alarm_type', 'alarm_level', 'alarm_classify', 'is_white', 'status'],
          rows: [{ tag_code: 'Udc', tag_comment: '直流电压', cus_class_path: 'wisetao.pv.inverter', alarm_type: 'low', alarm_level: 'warning', alarm_classify: 'voltage', is_white: '0', status: '1' }],
        }],
      ]),
    )
    const result = await tool('query_alarm_config').run({}, ctx)
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      tag_code: 'Udc',
      tag_comment: '直流电压',
      cus_class_path: 'wisetao.pv.inverter',
      alarm_type: 'low',
      alarm_level: 'warning',
      alarm_classify: 'voltage',
      is_white: 0,
      status: 1,
    })
  })
})

describe('aggregate WT_CUBE 路由', () => {
  it('粒度 1H → 路由到 WT_CUBE', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '10' }] }],
        ['FROM WT_CUBE', {
          columns: ['bucket', 'aggValue', 'sampleCount'],
          rows: [{ bucket: 'all', aggValue: '100.5', sampleCount: '24' }],
        }],
        ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '174' }] }],
      ]),
    )
    const result = await tool('aggregate').run({
      tag_filter: '^HWNBYC174_1H_',
      start_time: '2026-08-01T00:00:00+08:00',
      end_time: '2026-08-02T00:00:00+08:00',
      func: 'AVG',
      group_by: 'none',
    }, ctx)
    expect(result.success).toBe(true)
    expect(result.apiOrSql).toContain('FROM WT_CUBE')
  })
  it('粒度 1O → 路由到 WT_DATA', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '10' }] }],
        ['FROM WT_DATA', {
          columns: ['bucket', 'aggValue', 'sampleCount'],
          rows: [{ bucket: 'all', aggValue: '50.0', sampleCount: '60' }],
        }],
        ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '174' }] }],
      ]),
    )
    const result = await tool('aggregate').run({
      tag_filter: '^HWNBYC174_1O_',
      start_time: '2026-08-01T00:00:00+08:00',
      end_time: '2026-08-02T00:00:00+08:00',
      func: 'AVG',
      group_by: 'none',
    }, ctx)
    expect(result.success).toBe(true)
    expect(result.apiOrSql).toContain('FROM WT_DATA')
  })
})

describe('lookup_device（WT_DEVICE 设备层级）', () => {
  it('关键字命中返回层级行，id 数值化', async () => {
    const { ctx } = testContext(
      byIncludes([
        ['FROM WT_DEVICE', {
          columns: ['inverterId', 'inverterName', 'inverterCode', 'arrayId', 'arrayName', 'arrayCode', 'subId', 'subName', 'subCode', 'type'],
          rows: [{
            inverterId: '100620000015521', inverterName: '1号逆变器', inverterCode: 'INV001',
            arrayId: '201', arrayName: '1号组串', arrayCode: 'ARR001',
            subId: '301', subName: '1号子阵', subCode: 'SUB001',
            type: 'inverter',
          }],
        }],
      ]),
    )
    const result = await tool('lookup_device').run({ keyword: '逆变器' }, ctx)
    expect(result.success).toBe(true)
    expect(result.data[0]).toEqual({
      inverterId: 100620000015521, inverterName: '1号逆变器', inverterCode: 'INV001',
      arrayId: 201, arrayName: '1号组串', arrayCode: 'ARR001',
      subId: 301, subName: '1号子阵', subCode: 'SUB001',
      type: 'inverter',
    })
    expect(result.apiOrSql).toContain("inverterName LIKE '%逆变器%'")
  })
  it('device_type 精确过滤', async () => {
    const { ctx } = testContext(
      byIncludes([['FROM WT_DEVICE', { columns: ['inverterId'], rows: [] }]]),
    )
    const result = await tool('lookup_device').run({ device_type: 'array' }, ctx)
    expect(result.success).toBe(true)
    expect(result.apiOrSql).toContain("`type` = 'array'")
    expect(result.apiOrSql).not.toContain('LIKE')
  })
  it('keyword 与 device_type 均缺省 → INVALID_PARAM（不触达执行器）', async () => {
    let called = 0
    const { ctx } = testContext(() => {
      called++
      return { columns: [], rows: [] }
    })
    const result = await tool('lookup_device').run({}, ctx)
    expect(result.errorCode).toBe('INVALID_PARAM')
    expect(called).toBe(0)
  })
})

describe('审计链', () => {
  it('两次调用形成 prev_hash 链', async () => {
    let prev = ''
    const audits: AuditRow[] = []
    const { ctx } = testContext(
      byIncludes([['FROM WT_TAG', { columns: ['tagName'], rows: [] }]]),
    )
    ctx.onAudit = (row) => {
      const full = buildAuditRow({
        userId: ctx.config.audit.userId,
        appId: ctx.config.audit.appId,
        orgId: ctx.config.audit.orgId,
        question: 'q',
        sqlText: row.sqlText,
        rowCount: 0,
        executionMs: 1,
        resultJson: '[]',
        prevHash: prev,
        toolName: row.toolName,
        toolLayer: row.toolLayer,
      })
      prev = full.resultHash
      audits.push(full)
    }
    const t = tool('lookup_tag')
    await t.run({ keyword: 'a' }, ctx)
    await t.run({ keyword: 'b' }, ctx)
    expect(audits).toHaveLength(2)
    expect(audits[1]!.prevHash).toBe(audits[0]!.resultHash)
  })
})
