/**
 * model_relation_graph 单测：中文名→class_path 两步解析、AGP 信封解析
 * （code/message 双形态、GBK 解码）、失败收敛、树形渲染指引。
 * 全部 mock fetch，不触网。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ToolContext } from '../tools/types.ts'
import {
  decodeAgpBody,
  metaBaseUrl,
  modelRelationGraphTool,
  parseAgpEnvelope,
} from '../tools/model-relation-graph.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const CLASS_LIST_ENVELOPE = {
  code: '0',
  msg: '成功',
  data: {
    field: [],
    data: [
      { class_alias: '水泵模型', class_name: 'wt_10462_shuibengmoxing', class_path: 'wt_elm_equipment/wt_10462_shuibengmoxing' },
    ],
  },
}

const RELATION_ENVELOPE = {
  code: 0,
  message: 'success',
  data: {
    field: [
      { name: 'id', title: '关系定义ID', type: '1' },
      { name: 'relation_name', title: '关系内部名', type: '3' },
      { name: 'relation_description', title: '关系名称', type: '3' },
      { name: 'leftModelName', title: '左模型名称', type: '3' },
      { name: 'rightModelName', title: '右模型名称', type: '3' },
    ],
    data: [
      { id: 10000000062, relation_name: 'outterLink_[wt_elm_devclassify]_[wt_elm_equipment]', relation_description: '设备分组和设备的关系', leftModelName: '设备基础模型', rightModelName: '设备分组模型' },
      { id: 10000003038, relation_name: 'outterLink_[wt_elm_equipment]_[wt_egy_energy]', relation_description: '设备与能源的关系', leftModelName: '设备基础模型', rightModelName: '能源基础模型' },
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

describe('metaBaseUrl', () => {
  it('iot-etl/iot 段替换为 meta；其余形态追加 /meta', () => {
    expect(metaBaseUrl('https://www.openagp.top:9080/s1M6_uE9/wz/iot-etl/iot')).toBe('https://www.openagp.top:9080/s1M6_uE9/wz/meta')
    expect(metaBaseUrl('http://host:8080')).toBe('http://host:8080/meta')
  })
})

describe('decodeAgpEnvelope helpers', () => {
  it('decodeAgpBody：UTF-8 严格解码失败回退 GBK', () => {
    const gbkBytes = new TextDecoder('utf-8').decode(new Uint8Array([0xb4, 0xed])) // GBK "错"
    // 直接构造 GBK 字节：'错' = 0xB4ED, UTF-8 严格解码必失败
    const bytes = new TextEncoder().encode('{"message":"plain"}')
    expect(decodeAgpBody(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).toContain('plain')
    // GBK 有效序列（0xB4 0xED = '错'）
    const gbkBuffer = new Uint8Array([0x7b, 0x7d, 0xb4, 0xed]).buffer
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(gbkBuffer)).toThrow()
    void gbkBytes
  })
  it('parseAgpEnvelope：code 字符串/数字双形态、message/msg 双字段', () => {
    expect(parseAgpEnvelope('{"code":0,"message":"ok","data":{"field":[],"data":[]}}').code).toBe(0)
    expect(parseAgpEnvelope('{"code":"0","msg":"成功","data":{"field":[],"data":[]}}').message).toBe('成功')
    expect(() => parseAgpEnvelope('{"code":-1,"message":"模型不存在"}')).toThrow(/模型不存在/)
    expect(() => parseAgpEnvelope('not json')).toThrow(/合法 JSON/)
  })
})

describe('model_relation_graph', () => {
  it('两步主链：中文名 → queryByGenericSql 解析 class_path → getRelationsByModel → 关系清单 + 渲染指引', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('queryByGenericSql')) {
        expect(String((url as Request).url ?? url)).toContain('queryByGenericSql')
        return jsonResponse(CLASS_LIST_ENVELOPE)
      }
      expect(u).toBe('https://www.openagp.top:9080/s1M6_uE9/wz/meta/getRelationsByModel?modelName=wt_elm_equipment%2Fwt_10462_shuibengmoxing')
      return jsonResponse(RELATION_ENVELOPE)
    })
    const res = await modelRelationGraphTool.run({ model_name: '水泵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('queryByGenericSql')
    expect(res.rowCount).toBe(3) // 2 条关系 + 1 行渲染指引
    expect(res.data[0]!.relation_description).toBe('设备分组和设备的关系')
    expect(res.data[0]!.rightModelName).toBe('设备分组模型')
    const hint = res.data.at(-1)!
    expect(String(hint.relation_description)).toContain('渲染指引')
    const hintText = String((hint as Record<string, unknown>).hint)
    expect(hintText).toContain('actionTemplate')
    expect(hintText).toContain('下钻模型：{name}')
    expect(hintText).toContain('5ad8a6')
    expect(hintText).toContain('水泵模型')
    expect(hintText).toContain('[genui-action]')
  })

  it('class_path 直传（含 /）：跳过解析步骤，一次 GET', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => jsonResponse(RELATION_ENVELOPE))
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_elm_equipment/wt_10462_shuibengmoxing' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls
    expect(calls).toHaveLength(1)
    expect(String(calls[0]![0])).toContain('modelName=wt_elm_equipment%2Fwt_10462_shuibengmoxing')
  })

  it('中文名未命中：INVALID_PARAM 提示确认模型名', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [] } }))
    const res = await modelRelationGraphTool.run({ model_name: '不存在的模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('INVALID_PARAM')
    expect(res.errorMessage).toContain('不存在的模型')
    expect(res.errorMessage).toContain('class_alias')
  })

  it('空关系：明确"无关系"行，不生成渲染指引', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('queryByGenericSql')) return jsonResponse(CLASS_LIST_ENVELOPE)
      return jsonResponse({ code: 0, message: 'success', data: { field: [], data: [] } })
    })
    const res = await modelRelationGraphTool.run({ model_name: '水泵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(res.rowCount).toBe(1)
    expect(String(res.data[0]!.relation_description)).toContain('没有已定义的模型关系')
  })

  it('HTTP 500 → BACKEND_DOWN；业务失败 code=-1 → INVALID_PARAM 透传服务端 message', async () => {
    const r1 = await modelRelationGraphTool.run(
      { model_name: 'wt_x/y' },
      ctxOf(async () => new Response('oops', { status: 500 })),
    )
    expect(r1.errorCode).toBe('BACKEND_DOWN')

    const r2 = await modelRelationGraphTool.run(
      { model_name: 'wt_x/y' },
      ctxOf(async () => jsonResponse({ code: -1, message: '没有找到模型的定义' })),
    )
    expect(r2.errorCode).toBe('INVALID_PARAM')
    expect(r2.errorMessage).toContain('没有找到模型的定义')
  })

  it('缺 model_name / 未配 baseUrl → 明确错误', async () => {
    const r1 = await modelRelationGraphTool.run({}, ctxOf(async () => jsonResponse({})))
    expect(r1.errorCode).toBe('INVALID_PARAM')

    const cfg = resolveConfig({
      connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
      query: { rest: { baseUrl: '', wtAppid: '', wtOpenid: '', wtToken: '', fallbackToSql: false, maxPageSize: 1000 } },
    })
    const executor = { execute: async () => ({ columns: [], rows: [] }) }
    const r2 = await modelRelationGraphTool.run({ model_name: 'X' }, { config: cfg, executor, mysqlExecutor: executor })
    expect(r2.errorCode).toBe('BACKEND_DOWN')
    expect(r2.errorMessage).toContain('AGP API 未配置')
  })
})
