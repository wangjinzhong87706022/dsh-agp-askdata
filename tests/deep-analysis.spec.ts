/**
 * askdata_deep_analysis（subagent-style 工具）单测：
 * 工具链按 question 关键词分支；failure 不抛错、stage 留痕。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { QueryOutput } from '../src/clients/starrocks.ts'
import type { ToolContext } from '../tools/types.ts'
import { askdataDeepAnalysisTool } from '../tools/deep-analysis.ts'
import { allTools } from '../tools/index.ts'

function cfg() {
  return resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
  })
}

function ctx(c = cfg()): ToolContext {
  const exec = {
    execute: async (sql: string): Promise<QueryOutput> => {
      if (sql.includes('lookup_object') || sql.includes('wt_elm_equipment')) {
        return { columns: ['id', 'node_name', 'class__path'], rows: [{ id: '174', node_name: '1号箱变1号逆变器', 'class__path': 'wt_elm_equipment/wt_iot_huaweisun2000' }] }
      }
      if (sql.includes('FROM WT_TAG WHERE')) {
        return { columns: ['tagName'], rows: [{ tagName: 'HWNBYC174_1D_100620000015521' }] }
      }
      if (sql.includes('FROM WT_DATA') || sql.includes('time_slice') || sql.includes('FROM WT_CUBE')) {
        return { columns: ['bucket', 'aggValue', 'sampleCount'], rows: [{ bucket: 'all', aggValue: '1665.5', sampleCount: '12' }] }
      }
      if (sql.includes('wt_bas_alarmrecord')) {
        return { columns: ['id', 'alarm_title'], rows: [{ id: '1', alarm_title: '测试告警' }] }
      }
      if (sql.includes('wt_cus_alarmdynamicconfig')) {
        return { columns: ['tag_code', 'alarm_level'], rows: [{ tag_code: 'X1', alarm_level: '1::提示' }] }
      }
      return { columns: [], rows: [] }
    },
  }
  return { config: c, executor: exec, mysqlExecutor: exec, prevAuditHash: '', onAudit: () => {} }
}

describe('askdata_deep_analysis（subagent-style 工具）', () => {
  it('已在 tools 索引中、且总工具数 18（P0 5 + P1 6 + subagent 1 + 知识面 4 + 值班报告 2）', () => {
    expect(allTools.find((t) => t.name === 'askdata_deep_analysis')).toBeTruthy()
    expect(allTools).toHaveLength(18)
  })

  it('关键问题分支：日均 → aggregate（cube 路由）', async () => {
    const r = await askdataDeepAnalysisTool.run(
      { question: '1号箱变1号逆变器总发电量最近一周日均值是多少？' },
      ctx(),
    )
    expect(r.success).toBe(true)
    expect(r.apiOrSql).toContain('subagent pipeline')
    // data 第一部分应是 trace 行（step / tool / ms）
    expect(r.data[0]).toHaveProperty('step')
    expect(r.data[0]).toHaveProperty('tool')
  })

  it('关键问题分支：最新 → latest_value（兜底降级通过 cubeType MAX）', async () => {
    const r = await askdataDeepAnalysisTool.run(
      { question: '1号箱变1号逆变器总发电量最新值是多少？' },
      ctx(),
    )
    expect(r.success).toBe(true)
    // 至少包含 lookup_object（解析设备）+ latest_value（取数）两步
    const tools = r.data.map((row) => (row as { tool?: string }).tool).filter(Boolean)
    expect(tools).toContain('latest_value')
  })

  it('关键问题分支：告警 → query_alarm（7 天默认窗）', async () => {
    const r = await askdataDeepAnalysisTool.run(
      { question: '最近有哪些告警？' },
      ctx(),
    )
    expect(r.success).toBe(true)
    const traceRow = r.data[0] as { tool: string }
    expect(traceRow.tool).toBe('query_alarm')
  })

  it('关键问题分支：告警配置 → query_alarm_config', async () => {
    const r = await askdataDeepAnalysisTool.run(
      { question: '有哪些告警配置？' },
      ctx(),
    )
    expect(r.success).toBe(true)
    const traceRow = r.data[0] as { tool: string }
    expect(traceRow.tool).toBe('query_alarm_config')
  })

  it('关键问题分支：模型 → lookup_model', async () => {
    const r = await askdataDeepAnalysisTool.run(
      { question: '有哪些光伏设备模型？' },
      ctx(),
    )
    expect(r.success).toBe(true)
    const traceRow = r.data[0] as { tool: string }
    expect(traceRow.tool).toBe('lookup_model')
  })

  it('设备解析采用 lookup_object 精确命中值传给 resolve_tag（而非问句片段）', async () => {
    const sqls: string[] = []
    const exec = {
      execute: async (sql: string): Promise<QueryOutput> => {
        sqls.push(sql)
        if (sql.includes('wt_elm_equipment') && sql.includes('LIKE')) {
          return { columns: ['id', 'node_name', 'class__path'], rows: [{ id: '174', node_name: '1号箱变1号逆变器', 'class__path': 'wt_elm_equipment/wt_iot_huaweisun2000' }] }
        }
        if (sql.includes('wt_elm_equipment')) {
          return { columns: ['id', 'class__path'], rows: [{ id: '174', 'class__path': 'wt_elm_equipment/wt_iot_huaweisun2000' }] }
        }
        return { columns: [], rows: [] }
      },
    }
    await askdataDeepAnalysisTool.run(
      { question: '号箱变功率趋势' },
      { ...ctx(), executor: exec, mysqlExecutor: exec },
    )
    // resolve_tag step1（等值查询）必须用 lookup_object 返回的精确 node_name
    const step1 = sqls.find((s) => s.includes('wt_elm_equipment') && !s.includes('LIKE'))
    expect(step1).toContain("node_name = '1号箱变1号逆变器'")
  })

  it('空 question → INVALID_PARAM', async () => {
    const r = await askdataDeepAnalysisTool.run({}, ctx())
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('INVALID_PARAM')
  })

  it('流水线全失败 → BACKEND_DOWN（不抛裸错）', async () => {
    const failCtx = ctx()
    failCtx.executor = {
      execute: async () => { throw new Error('mock db down') },
    }
    // 用 lookup_tag 这条唯一步骤的分支：所有 SQL 都抛错，runStep 都 ok=false
    const r = await askdataDeepAnalysisTool.run(
      { question: '光伏组件' }, // classify 不命中任何具体分支 → 默认走 lookup_tag
      failCtx,
    )
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('BACKEND_DOWN')
    expect(r.errorMessage).toContain('全部失败')
  })
})
