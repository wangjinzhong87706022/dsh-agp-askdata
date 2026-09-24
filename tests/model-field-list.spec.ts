/**
 * model_field_list 单测：中文名主路直查（§2.3 契约）、「模型不存在」回落
 * class_path 重试、空属性行、HTTP/业务失败收敛、参数守卫。
 * 全部 mock fetch，不触网。响应形态取自 2026-09-24 真实网关实测。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ToolContext } from '../tools/types.ts'
import { modelFieldListTool } from '../tools/model-field-list.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 2026-09-24 真实网关实测形态：data.field=列定义 + data.data=属性行。 */
const ATTRIBUTES_ENVELOPE = {
  code: 0,
  message: 'success',
  data: {
    field: [
      { name: 'field_name', title: '属性名称', type: '3' },
      { name: 'field_description', title: '描述', type: '3' },
      { name: 'field_type', title: '属性类型', type: '11' },
    ],
    data: [
      { field_name: 'id', field_description: 'ID', field_type: '1' },
      { field_name: 'code', field_description: '参数类型码', field_type: '3' },
      { field_name: 'name', field_description: '参数名称', field_type: '3' },
      { field_name: 'canshuzhi', field_description: '参数值', field_type: '3' },
    ],
  },
}

const CLASS_LIST_ENVELOPE = {
  code: '0',
  msg: '成功',
  data: {
    field: [],
    data: [
      { class_alias: '设备参数列模型', class_name: 'wt_x', class_path: 'wt_elm_devattr/wt_x' },
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

describe('model_field_list', () => {
  it('主路：中文名一次 GET 直达属性行（无需 class_path 解析）', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return jsonResponse(ATTRIBUTES_ENVELOPE)
    })
    const res = await modelFieldListTool.run({ model_name: '设备参数列模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('https://www.openagp.top:9080/s1M6_uE9/wz/meta/getModelBasAttributes?modelName=%E8%AE%BE%E5%A4%87%E5%8F%82%E6%95%B0%E5%88%97%E6%A8%A1%E5%9E%8B')
    expect(res.apiOrSql).toContain('getModelBasAttributes')
    expect(res.apiOrSql).toContain('4 个属性')
    expect(res.rowCount).toBe(4)
    expect(res.data[0]).toMatchObject({ rank: 1, field_name: 'id', field_description: 'ID', field_type: '1' })
    expect(res.data[3]).toMatchObject({ field_name: 'canshuzhi', field_description: '参数值' })
  })

  it('回落：中文名报「没有找到」→ queryByGenericSql 解析 class_path → 重试命中', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('queryByGenericSql')) return jsonResponse(CLASS_LIST_ENVELOPE)
      if (u.includes('wt_elm_devattr')) return jsonResponse(ATTRIBUTES_ENVELOPE)
      return jsonResponse({ code: -1, message: '没有找到模型' })
    })
    const res = await modelFieldListTool.run({ model_name: '设备参数列模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[1]).toContain('queryByGenericSql')
    expect(calls[2]).toContain('modelName=wt_elm_devattr%2Fwt_x')
    expect(res.rowCount).toBe(4)
  })

  it('class_path 直传（含 /）：失败不回落，直接透出业务错误', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: -1, message: '没有找到模型' }))
    const res = await modelFieldListTool.run(
      { model_name: 'wt_elm_devattr/wt_x' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('INVALID_PARAM')
    expect(res.errorMessage).toContain('没有找到模型')
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls
    expect(calls).toHaveLength(1)
  })

  it('空属性行：明确"没有可见的基本属性"行，不编造字段', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, message: 'success', data: { field: [], data: [] } }))
    const res = await modelFieldListTool.run({ model_name: '水泵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(res.rowCount).toBe(1)
    expect(String(res.data[0]!.field_description)).toContain('没有可见的基本属性')
  })

  it('非「模型不存在」的业务失败不回落重试', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: -1, message: '令牌失效' }))
    const res = await modelFieldListTool.run({ model_name: '水泵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(false)
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls
    expect(calls).toHaveLength(1)
  })

  it('HTTP 500 → BACKEND_DOWN；缺 model_name / 未配 baseUrl → 明确错误', async () => {
    const r1 = await modelFieldListTool.run(
      { model_name: '水泵模型' },
      ctxOf(async () => new Response('oops', { status: 500 })),
    )
    expect(r1.errorCode).toBe('BACKEND_DOWN')

    const r2 = await modelFieldListTool.run({}, ctxOf(async () => jsonResponse({})))
    expect(r2.errorCode).toBe('INVALID_PARAM')

    const cfg = resolveConfig({
      connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
      query: { rest: { baseUrl: '', wtAppid: '', wtOpenid: '', wtToken: '', fallbackToSql: false, maxPageSize: 1000 } },
    })
    const executor = { execute: async () => ({ columns: [], rows: [] }) }
    const r3 = await modelFieldListTool.run({ model_name: 'X' }, { config: cfg, executor, mysqlExecutor: executor })
    expect(r3.errorCode).toBe('BACKEND_DOWN')
    expect(r3.errorMessage).toContain('AGP API 未配置')
  })
})
