/**
 * meta 数据查询族单测（query_model / query_model_segment /
 * query_relation_segment / relation_field_list）：动态 fields 组装、类型码
 * 映射、分页透传、分段解析、参数守卫。全部 mock fetch，不触网。
 * 响应形态取自 2026-09-24 真实网关实测。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ToolContext } from '../tools/types.ts'
import { queryModelTool } from '../tools/query-model.ts'
import { queryModelSegmentTool } from '../tools/query-model-segment.ts'
import { queryRelationSegmentTool } from '../tools/query-relation-segment.ts'
import { relationFieldListTool } from '../tools/relation-field-list.ts'
import { resultFieldType } from '../tools/meta-common.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 2026-09-24 真实网关 §2.2 实测形态：动态 field 定义 + page。 */
const MODEL_DATA_ENVELOPE = {
  code: 0,
  message: 'success',
  data: {
    field: [
      { name: 'id', title: 'ID', type: '1' },
      { name: 'name', title: '参数名称', type: '3' },
      { name: 'canshuzhi', title: '参数值', type: '3' },
    ],
    data: [
      { id: 1, name: '汛限水位', canshuzhi: '786.8' },
      { id: 2, name: '总库容', canshuzhi: '5720万m³' },
    ],
    page: { pageNum: 1, pageSize: 100, pageTotal: 1, itemTotal: 2 },
  },
}

const RELATION_ATTRS_ENVELOPE = {
  code: 0,
  message: 'success',
  data: {
    field: [
      { name: 'field_name', title: '属性名称', type: '3' },
      { name: 'field_description', title: '描述', type: '3' },
      { name: 'field_type', title: '属性类型', type: '11' },
      { name: 'model_name', title: '所属模型', type: '3' },
    ],
    data: [
      { field_name: 'id', field_description: 'ID', field_type: '1', model_name: '设备基础模型' },
    ],
  },
}

function ctxOf(fetchImpl: (url: string | URL | Request) => Promise<Response>): ToolContext {
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    query: { rest: { baseUrl: 'https://www.openagp.top:9080/s1M6_uE9/wz/iot-etl/iot', wtAppid: '10462', wtOpenid: 'o', wtToken: 't', fallbackToSql: false, maxPageSize: 1000 } },
  })
  const executor = { execute: async () => ({ columns: [], rows: [] }) }
  return { config, executor, mysqlExecutor: executor, fetchImpl: fetchImpl as typeof fetch }
}

function postedBodyOf(fetchImpl: unknown): Record<string, unknown> {
  const calls = (fetchImpl as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
  return JSON.parse(calls[0]![1]!.body as string) as Record<string, unknown>
}

describe('resultFieldType（类型码映射，§18.x 实测）', () => {
  it('1/11/22→number，52→datetime，其余 string', () => {
    expect(resultFieldType('1')).toBe('number')
    expect(resultFieldType('11')).toBe('number')
    expect(resultFieldType('22')).toBe('number')
    expect(resultFieldType('52')).toBe('datetime')
    expect(resultFieldType('3')).toBe('string')
  })
})

describe('query_model', () => {
  it('主路：POST 参数全传 + 动态 fields + page 透传 + 类型转换', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MODEL_DATA_ENVELOPE))
    const res = await queryModelTool.run(
      { model_name: '设备参数列模型', search_str: 'id,name,canshuzhi', page_size: 50 },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    const body = postedBodyOf(fetchImpl)
    expect(body).toMatchObject({
      modelName: '设备参数列模型',
      searchStr: 'id,name,canshuzhi',
      whereStr: '',
      pageNum: 1,
      pageSize: 50,
      orderByStr: '',
      groupByStr: '',
    })
    expect(res.fields.map((f) => f.name)).toEqual(['id', 'name', 'canshuzhi'])
    expect(res.fields[0]!.type).toBe('number') // type '1' → number
    expect(res.data[0]).toMatchObject({ id: 1, name: '汛限水位', canshuzhi: '786.8' })
    expect(res.page).toMatchObject({ itemTotal: 2 })
  })

  it('守卫：* 明确拒绝（服务端展开缺陷）；缺 search_str / page_size 非法', async () => {
    const ok200 = ctxOf(async () => jsonResponse(MODEL_DATA_ENVELOPE))
    const r1 = await queryModelTool.run({ model_name: 'X', search_str: '*' }, ok200)
    expect(r1.errorCode).toBe('INVALID_PARAM')
    expect(r1.errorMessage).toContain('model_field_list')

    const r2 = await queryModelTool.run({ model_name: 'X' }, ok200)
    expect(r2.errorCode).toBe('INVALID_PARAM')

    const r3 = await queryModelTool.run(
      { model_name: 'X', search_str: 'id', page_size: 0 },
      ctxOf(async () => jsonResponse(MODEL_DATA_ENVELOPE)),
    )
    expect(r3.errorCode).toBe('INVALID_PARAM')
    expect(r3.errorMessage).toContain('page_size')
  })

  it('page_size 超上限收口到 maxPageSize（1000）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MODEL_DATA_ENVELOPE))
    await queryModelTool.run(
      { model_name: 'X', search_str: 'id', page_size: 99999 },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(postedBodyOf(fetchImpl).pageSize).toBe(1000)
  })
})

describe('query_model_segment', () => {
  it('主路：segment 解析为 whereStr/title，POST 到 postModelAggrigateData', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...MODEL_DATA_ENVELOPE, data: { ...MODEL_DATA_ENVELOPE.data, page: undefined } }))
    const res = await queryModelSegmentTool.run(
      {
        model_name: '设备参数列模型',
        search_str: 'name,count(*) as 计数',
        segment: [
          { where_str: 'id > 0', title: '全部' },
          { where_str: '' }, // 缺 where_str → 解析失败
        ],
      },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(false)
    expect(res.errorMessage).toContain('segment[1].where_str')

    const res2 = await queryModelSegmentTool.run(
      { model_name: '设备参数列模型', search_str: 'name,count(*) as 计数', segment: [{ where_str: 'id > 0', title: '全部' }] },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res2.success).toBe(true)
    const body = postedBodyOf(fetchImpl)
    expect(body.modelName).toBe('设备参数列模型')
    expect(body.segment).toEqual([{ whereStr: 'id > 0', title: '全部' }])
  })

  it('守卫：segment 空数组 / 缺 search_str', async () => {
    const c = ctxOf(async () => jsonResponse(MODEL_DATA_ENVELOPE))
    const r1 = await queryModelSegmentTool.run({ model_name: 'X', search_str: 'id,count(*)', segment: [] }, c)
    expect(r1.errorCode).toBe('INVALID_PARAM')
    const r2 = await queryModelSegmentTool.run({ model_name: 'X', segment: [{ where_str: 'id>0' }] }, c)
    expect(r2.errorCode).toBe('INVALID_PARAM')
  })
})

describe('query_relation_segment', () => {
  it('主路：relationName + 左右模型可选传 + segment', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MODEL_DATA_ENVELOPE))
    const res = await queryRelationSegmentTool.run(
      {
        relation_name: '设备参数列表',
        search_str: 'name,count(*) as 计数',
        segment: [{ where_str: 'id > 0' }],
        right_model_name: '设备参数列模型',
      },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    const body = postedBodyOf(fetchImpl)
    expect(body).toMatchObject({ relationName: '设备参数列表', rightModelName: '设备参数列模型', leftModelName: '' })
  })
})

describe('relation_field_list', () => {
  it('主路：GET 中文关系名，返回含所属模型列', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://www.openagp.top:9080/s1M6_uE9/wz/meta/getRelationBasAttributes?relationName=%E8%AE%BE%E5%A4%87%E5%8F%82%E6%95%B0%E5%88%97%E8%A1%A8')
      return jsonResponse(RELATION_ATTRS_ENVELOPE)
    })
    const res = await relationFieldListTool.run({ relation_name: '设备参数列表' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(res.rowCount).toBe(1)
    expect(res.data[0]).toMatchObject({ rank: 1, field_name: 'id', model_name: '设备基础模型' })
  })

  it('空属性行：明确提示行；缺 relation_name 守卫', async () => {
    const res = await relationFieldListTool.run(
      { relation_name: 'X' },
      ctxOf(async () => jsonResponse({ code: 0, message: 'success', data: { field: [], data: [] } })),
    )
    expect(res.success).toBe(true)
    expect(String(res.data[0]!.field_description)).toContain('没有可见的基本属性')

    const r2 = await relationFieldListTool.run({}, ctxOf(async () => jsonResponse({})))
    expect(r2.errorCode).toBe('INVALID_PARAM')
  })
})
