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

function ctxOf(
  fetchImpl: (url: string | URL | Request) => Promise<Response>,
  meta?: Partial<{ relationCap: number; groupedHintThreshold: number }>,
): ToolContext {
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    query: {
      rest: { baseUrl: 'https://www.openagp.top:9080/s1M6_uE9/wz/iot-etl/iot', wtAppid: '10462', wtOpenid: 'o', wtToken: 't', fallbackToSql: false, maxPageSize: 1000 },
      ...(meta ? { meta } : {}),
    },
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
  it('decodeAgpBody：UTF-8 严格解码失败回退 GBK，且真解出汉字', () => {
    // 合法 UTF-8：走严格解码主路，不触发回退
    const utf8 = new TextEncoder().encode('{"message":"plain"}')
    expect(decodeAgpBody(utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength))).toContain('plain')

    // GBK 字节：0x7B 0x7D = "{}"，0xB4 0xED = "错"（UTF-8 严格解码必失败）
    // 手写字节而非 iconv-lite：TextEncoder 只支持 UTF-8，而 '错' 的 GBK 码位是
    // 固定的两字节常量，直接写死比引入编码依赖更可读也更可移植。
    const gbkBuffer = new Uint8Array([0x7b, 0x7d, 0xb4, 0xed]).buffer
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(gbkBuffer)).toThrow()
    const gbkText = decodeAgpBody(gbkBuffer)
    expect(gbkText).toBe('{}错')
    // 回退结果不含替换字符——说明确实被 GBK 解码器认领，而不是被 UTF-8 兜底糊弄
    expect(gbkText).not.toContain('�')
  })
  it('parseAgpEnvelope：code 字符串/数字双形态、message/msg 双字段', () => {
    expect(parseAgpEnvelope('{"code":0,"message":"ok","data":{"field":[],"data":[]}}').code).toBe(0)
    expect(parseAgpEnvelope('{"code":"0","msg":"成功","data":{"field":[],"data":[]}}').message).toBe('成功')
    expect(() => parseAgpEnvelope('{"code":-1,"message":"模型不存在"}')).toThrow(/模型不存在/)
    expect(() => parseAgpEnvelope('not json')).toThrow(/合法 JSON/)
  })
})

describe('model_relation_graph', () => {
  it('两步主链：中文名 → queryByGenericSql 解析 class_path → getRelationsByModel → 关系清单 + 渲染指引（双击下钻常开）', async () => {
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
    expect(res.total).toBe(2)
    expect(res.complete).toBe(true)
    expect(res.data[0]!.relation_description).toBe('设备分组和设备的关系')
    expect(res.data[0]!.rightModelName).toBe('设备分组模型')
    // direct 标记：查询模型（水泵模型）不是这两条关系的端点 → 否
    expect(res.data[0]!.direct).toBe('否')
    expect(res.data[1]!.direct).toBe('否')
    const hint = res.data.at(-1)!
    expect(String(hint.relation_description)).toContain('渲染指引')
    const hintText = String((hint as Record<string, unknown>).hint)
    // 双击下钻常开：模板只带 drill.key，actionTemplate 用渲染器默认值（少抄一个字段）
    expect(hintText).not.toContain('actionTemplate')
    expect(hintText).toContain('双击')
    expect(hintText).toContain('"preset":"tree"')
    expect(hintText).toContain('"drill":{"key":"水泵模型"}')
    expect(hintText).toContain('水泵模型')
    expect(hintText).toContain('[genui-action]')
    // patch 协议 + drill key + 关闭节点收起（浏览点击不再误触下钻）
    expect(hintText).toContain('drillPatch')
    expect(hintText).toContain('幂等检查')
  })

  it('直接关系标记与超阈值分组指引：direct=是 + >40 行时指引切换为聚合', async () => {
    const manyRows = Array.from({ length: 45 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: i === 0 ? '直接关系甲' : `间接关系${i}`,
      leftModelName: i === 0 ? '水泵模型' : '设备基础模型',
      rightModelName: i === 0 ? '设备基础模型' : `对端模型${i}`,
    }))
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('queryByGenericSql')) return jsonResponse(CLASS_LIST_ENVELOPE)
      return jsonResponse({ code: 0, message: 'success', data: { field: [], data: manyRows } })
    })
    const res = await modelRelationGraphTool.run({ model_name: '水泵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(res.total).toBe(45)
    expect(res.complete).toBe(true)
    const rows = res.data.slice(0, 45)
    expect(rows[0]!.direct).toBe('是') // 查询模型是端点
    expect(rows[1]!.direct).toBe('否')
    const hint = String((res.data.at(-1) as unknown as Record<string, unknown>).hint)
    expect(hint).toContain('直接 1 条 + 间接 44 条')
    expect(hint).toContain('按中继模型')
    expect(hint).toContain('经XX链路')
  })

  it('分组渲染阈值走 config.query.meta.groupedHintThreshold', async () => {
    const manyRows = Array.from({ length: 45 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: i === 0 ? '直接关系甲' : `间接关系${i}`,
      leftModelName: i === 0 ? '水泵模型' : '设备基础模型',
      rightModelName: i === 0 ? '设备基础模型' : `对端模型${i}`,
    }))
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('queryByGenericSql')) return jsonResponse(CLASS_LIST_ENVELOPE)
      return jsonResponse({ code: 0, message: 'success', data: { field: [], data: manyRows } })
    })
    // 阈值调到 100 → 45 条不再触发分组指引
    const res = await modelRelationGraphTool.run(
      { model_name: '水泵模型' },
      ctxOf(fetchImpl as unknown as typeof fetch, { groupedHintThreshold: 100 }),
    )
    const hint = String((res.data.at(-1) as unknown as Record<string, unknown>).hint)
    expect(hint).not.toContain('按中继模型')
    expect(hint).toContain('第二层 = 关系名')
  })

  it('安全截断上限走 config.query.meta.relationCap（超出即 complete=false）', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: `关系${i}`,
      leftModelName: '设备基础模型',
      rightModelName: `对端${i}`,
    }))
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('queryByGenericSql')) return jsonResponse(CLASS_LIST_ENVELOPE)
      return jsonResponse({ code: 0, message: 'success', data: { field: [], data: rows } })
    })
    const res = await modelRelationGraphTool.run(
      { model_name: '水泵模型' },
      ctxOf(fetchImpl as unknown as typeof fetch, { relationCap: 5 }),
    )
    expect(res.total).toBe(12)
    expect(res.complete).toBe(false)
    expect(res.rowCount).toBe(6) // 5 条截断 + 1 行渲染指引
    // 预览上限恒 ≥ 生效截断上限 + 指引行：产出行数不会把指引行挤出模型可见面
    expect(modelRelationGraphTool.previewLimit as number).toBeGreaterThan(5)
  })

  it('class_path 入参：direct 判定不可信，标"未知"且不给直接/间接分组指引（L6）', async () => {
    const manyRows = Array.from({ length: 45 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: `关系${i}`,
      leftModelName: '设备基础模型',
      rightModelName: `对端模型${i}`,
    }))
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, message: 'success', data: { field: [], data: manyRows } }))
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_elm_equipment/wt_10462_shuibengmoxing' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    expect(res.data[0]!.direct).toBe('未知')
    const hint = String((res.data.at(-1) as unknown as Record<string, unknown>).hint)
    // 不能出现"直接 0 条 + 间接 45 条"这类基于不可信 direct 的分组结论
    expect(hint).not.toContain('直接 0 条')
    expect(hint).not.toContain('按中继模型')
    expect(hint).toContain('direct 列一律为"未知"')
  })

  it('恰好 300 条关系：渲染指引行不被预览截断吞掉（H1）', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: i === 0 ? '直接关系' : `间接关系${i}`,
      leftModelName: i === 0 ? '水泵模型' : '设备基础模型',
      rightModelName: i === 0 ? '设备基础模型' : `对端${i}`,
    }))
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('queryByGenericSql')) return jsonResponse(CLASS_LIST_ENVELOPE)
      return jsonResponse({ code: 0, message: 'success', data: { field: [], data: rows } })
    })
    const res = await modelRelationGraphTool.run({ model_name: '水泵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.total).toBe(300)
    expect(res.complete).toBe(true)
    // 301 行（300 关系 + 1 指引行）必须全部进模型可见面
    const { renderAskdataResult } = await import('../src/dsh/adapter.ts')
    const text = renderAskdataResult({
      success: true, toolName: 'model_relation_graph', apiOrSql: '', fields: [],
      data: res.data, rowCount: res.rowCount, executionMs: 1, auditId: '',
      total: res.total, complete: res.complete,
    }, modelRelationGraphTool.previewLimit as number)
    expect(text).not.toContain('truncatedPreview')
    expect(text).toContain('【树形图渲染指引】')
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
