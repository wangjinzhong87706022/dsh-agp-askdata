/**
 * model_relation_graph 单测：中文名/class_path 两步解析、AGP 信封（code/message
 * 双形态、GBK 解码）、**规范方向解析**（方向只认 relation_name，不信服务端
 * left/right）、读法 A（只留本模型主体的关系）、逐层展开与限流、失败收敛。
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
  parseRelationName,
  resolvePeer,
} from '../tools/model-relation-graph.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const META_BASE = 'https://www.openagp.top:9080/s1M6_uE9/wz/meta'

/** class_alias → class_path 表（模拟 meta_class_info）。 */
const ALIAS_TO_PATH: Record<string, string> = {
  设备基础模型: 'wt_elm_equipment',
  设备参数列模型: 'wt_1_shebeicanshuliemoxing',
  设备报修过程模型: 'wt_iot_repair_requests',
  能源基础模型: 'wt_egy_energy',
  水泵模型: 'wt_10462_shuibengmoxing',
  基础运维过程基础模型: 'wt_iot_work_orders',
}
const PATH_TO_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(ALIAS_TO_PATH).map(([a, p]) => [p, a]),
)

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** 一条关系：方向编码在 relation_name 里。 */
function rel(
  desc: string,
  source: string,
  target: string,
  kind: 'subLink' | 'outterLink' = 'subLink',
): Record<string, unknown> {
  const name = kind === 'outterLink'
    ? `outterLink_[${source}]_[${target}]`
    : `subLink_[${source}]_[node_code]_[${target}]_[code]`
  return {
    id: Math.abs(hashCode(name)),
    relation_name: name,
    relation_description: desc,
    // 服务端端点顺序**故意反着给**——它随查询模型漂移，不可信（见 parseRelationEndpoints 注释）
    leftModelName: PATH_TO_ALIAS[target] ?? target,
    rightModelName: PATH_TO_ALIAS[source] ?? source,
  }
}

/**
 * 统一 mock：
 *  - queryByGenericSql：`where class_alias='X'` 或 `where class_path in (...)`
 *  - getRelationsByModel?modelName=P：返回 relationsByPath[P]（缺省空）
 */
function makeFetch(relationsByPath: Record<string, Array<Record<string, unknown>>>) {
  const getCalls: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('queryByGenericSql')) {
      // sql 在 POST body 里，从 init 直接读（工具用 fetchImpl(url, init) 调用）
      let sql = ''
      try {
        sql = String((JSON.parse(String(init?.body ?? '{}')) as { sql?: string }).sql ?? '')
      } catch {
        sql = ''
      }
      const byAlias = /class_alias='([^']*)'/.exec(sql)
      if (byAlias) {
        const path = ALIAS_TO_PATH[byAlias[1]!]
        return jsonResponse({
          code: '0',
          msg: '成功',
          data: { field: [], data: path === undefined ? [] : [{ class_alias: byAlias[1], class_path: path }] },
        })
      }
      const byPath = /class_path='([^']*)'/.exec(sql)
      if (byPath) {
        const p = byPath[1]!
        return jsonResponse({
          code: '0',
          msg: '成功',
          data: {
            field: [],
            data: PATH_TO_ALIAS[p] === undefined ? [] : [{ class_alias: PATH_TO_ALIAS[p], class_path: p }],
          },
        })
      }
      const inList = /class_path in \(([^)]*)\)/.exec(sql)
      if (inList) {
        const wanted = [...inList[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
        return jsonResponse({
          code: '0',
          msg: '成功',
          data: {
            field: [],
            data: wanted
              .filter((p) => PATH_TO_ALIAS[p] !== undefined)
              .map((p) => ({ class_alias: PATH_TO_ALIAS[p], class_path: p })),
          },
        })
      }
      return jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [] } })
    }
    const q = /modelName=([^&]+)/.exec(u)
    const path = q === null ? '' : decodeURIComponent(q[1]!)
    getCalls.push(path)
    return jsonResponse({ code: 0, message: 'success', data: { field: [], data: relationsByPath[path] ?? [] } })
  })
  return { fetchImpl, getCalls }
}


function ctxOf(
  fetchImpl: (url: string | URL | Request) => Promise<Response>,
  meta?: Partial<{ relationCap: number; relationDepth: number; relationFanout: number }>,
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

const CLASS_OK = {
  code: '0',
  msg: '成功',
  data: { field: [], data: [{ class_alias: '设备基础模型', class_path: 'wt_elm_equipment' }] },
}

describe('metaBaseUrl', () => {
  it('iot-etl/iot 段替换为 meta；其余形态追加 /meta', () => {
    expect(metaBaseUrl('https://www.openagp.top:9080/s1M6_uE9/wz/iot-etl/iot')).toBe(META_BASE)
    expect(metaBaseUrl('http://host:8080')).toBe('http://host:8080/meta')
  })
})

describe('decodeAgpBody helpers', () => {
  it('decodeAgpBody：UTF-8 严格解码失败回退 GBK，且真解出汉字', () => {
    const utf8 = new TextEncoder().encode('{"message":"plain"}')
    expect(decodeAgpBody(utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength))).toContain('plain')
    // GBK 字节：0x7B 0x7D = "{}"，0xB4 0xED = "错"（UTF-8 严格解码必失败）
    const gbkBuffer = new Uint8Array([0x7b, 0x7d, 0xb4, 0xed]).buffer
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(gbkBuffer)).toThrow()
    expect(decodeAgpBody(gbkBuffer)).toBe('{}错')
    expect(decodeAgpBody(gbkBuffer)).not.toContain('�')
  })

  it('parseAgpEnvelope：code 字符串/数字双形态、message/msg 双字段', () => {
    expect(parseAgpEnvelope('{"code":0,"message":"ok","data":{"field":[],"data":[]}}').code).toBe(0)
    expect(parseAgpEnvelope('{"code":"0","msg":"成功","data":{"field":[],"data":[]}}').message).toBe('成功')
    expect(() => parseAgpEnvelope('{"code":-1,"message":"模型不存在"}')).toThrow(/模型不存在/)
    expect(() => parseAgpEnvelope('not json')).toThrow(/合法 JSON/)
  })
})

describe('parseRelationName / resolvePeer', () => {
  const known = new Set(['wt_elm_equipment', 'wt_egy_energy', 'wt_1_shebeicanshuliemoxing'])

  it('主体恒为首段（outterLink 与 subLink 同构）', () => {
    expect(parseRelationName('outterLink_[wt_elm_equipment]_[wt_egy_energy]')!.source)
      .toBe('wt_elm_equipment')
    expect(parseRelationName('subLink_[wt_elm_equipment]_[node_code]_[wt_iot_repair_requests]_[name]')!.source)
      .toBe('wt_elm_equipment')
  })

  it('对端不能按位置猜：subLink 的连接键段与外键名段都不是模型', () => {
    // 第 2 段 node_code 是连接键、末段 name 是外键名——按位置取会拿错
    const p = parseRelationName('subLink_[wt_elm_equipment]_[canshubianmab0a1]_[wt_1_shebeicanshuliemoxing]_[code]')!
    expect(p.peers).toEqual(['canshubianmab0a1', 'wt_1_shebeicanshuliemoxing', 'code'])
    expect(resolvePeer(p.peers, known)).toBe('wt_1_shebeicanshuliemoxing')
  })

  it('outterLink 的对端直接是第二段', () => {
    const p = parseRelationName('outterLink_[wt_elm_equipment]_[wt_egy_energy]')!
    expect(resolvePeer(p.peers, known)).toBe('wt_egy_energy')
  })

  it('候选段都不是登记模型 → null（整条丢弃，不猜方向）', () => {
    const p = parseRelationName('outterLink_[wt_elm_equipment]_[wt_unknown_thing]')!
    expect(resolvePeer(p.peers, known)).toBeNull()
  })

  it('段数不足 / 非字符串 → null', () => {
    expect(parseRelationName('outterLink_[wt_elm_equipment]')).toBeNull()
    expect(parseRelationName(undefined)).toBeNull()
  })

  it('方向来自 relation_name，与服务端给的 left/right 无关（回归点）', () => {
    const row = rel('设备报修过程', 'wt_elm_equipment', 'wt_iot_repair_requests')
    const p = parseRelationName(row.relation_name)!
    // 服务端这次把对端顶到了 left——若信了它，方向就反了
    expect(row.leftModelName).toBe('设备报修过程模型')
    expect(p.source).toBe('wt_elm_equipment')
  })
})

describe('model_relation_graph', () => {
  it('主链：中文名 → class_path → 只保留本模型主体的关系 + 渲染指引（graph 模板，关系是边）', async () => {
    const { fetchImpl, getCalls } = makeFetch({
      wt_elm_equipment: [
        rel('设备与能源的关系', 'wt_elm_equipment', 'wt_egy_energy', 'outterLink'),
        rel('设备参数列表', 'wt_elm_equipment', 'wt_1_shebeicanshuliemoxing'),
        // 本模型只是对端的入边 → 读法 A 丢弃
        rel('设备分组和设备的关系', 'wt_elm_devclassify', 'wt_elm_equipment', 'outterLink'),
      ],
    })
    const res = await modelRelationGraphTool.run({ model_name: '设备基础模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(getCalls[0]).toBe('wt_elm_equipment')
    expect(res.total).toBe(2)
    expect(res.complete).toBe(true)
    expect(res.data[0]!.relation_description).toBe('设备与能源的关系')
    expect(res.data[0]!.source_model).toBe('设备基础模型')
    expect(res.data[0]!.target_model).toBe('能源基础模型')
    expect(res.data[0]!.level).toBe(1)
    expect(res.apiOrSql).toContain('剔除入边/无关关系 1 条')

    const hintText = String((res.data.at(-1) as unknown as Record<string, unknown>).hint)
    // 关系是边不是节点：graph preset + links + 边 label
    expect(hintText).toContain('"preset":"graph"')
    expect(hintText).toContain('"links":[')
    expect(hintText).toContain('"label":"关系A"')
    expect(hintText).toContain('关系是边不是节点')
    expect(hintText).toContain('单击')
    expect(hintText).not.toContain('双击')
    expect(hintText).toContain('"drill":{"key":"设备基础模型"}')
    expect(hintText).toContain('drillPatch')
  })

  it('两个模型的图不再镜像：入边互不出现', async () => {
    const shared = rel('设备参数列表', 'wt_elm_equipment', 'wt_1_shebeicanshuliemoxing')
    const { fetchImpl } = makeFetch({
      wt_elm_equipment: [shared, rel('设备与能源的关系', 'wt_elm_equipment', 'wt_egy_energy', 'outterLink')],
      wt_1_shebeicanshuliemoxing: [shared],
    })
    const a = await modelRelationGraphTool.run({ model_name: '设备基础模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    const b = await modelRelationGraphTool.run({ model_name: '设备参数列模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    // 设备基础模型有 2 条（含指向设备参数列模型的边）
    expect(a.total).toBe(2)
    // 设备参数列模型**没有**以自己为主体的边 → 明确说没有，而不是把入边反向画出来
    expect(b.total).toBe(0)
    expect(String(b.data[0]!.relation_description)).toContain('没有它发出的模型关系')
    expect(String(b.data[0]!.relation_description)).toContain('入边')
  })

  it('逐层展开：第二层的边带 level=2，对端会被再次查询', async () => {
    const { fetchImpl, getCalls } = makeFetch({
      wt_elm_equipment: [rel('设备与能源的关系', 'wt_elm_equipment', 'wt_egy_energy', 'outterLink')],
      wt_egy_energy: [rel('能源设备的关系', 'wt_egy_energy', 'wt_iot_work_orders', 'outterLink')],
    })
    const res = await modelRelationGraphTool.run(
      { model_name: '设备基础模型' },
      ctxOf(fetchImpl as unknown as typeof fetch, { relationDepth: 3, relationFanout: 3 }),
    )
    expect(res.success).toBe(true)
    expect(getCalls).toContain('wt_egy_energy')
    const levels = res.data.slice(0, -1).map((r) => r.level)
    expect(levels).toContain(1)
    expect(levels).toContain(2)
    const l2 = res.data.find((r) => r.level === 2)!
    expect(l2.source_model).toBe('能源基础模型')
    expect(res.apiOrSql).toContain('展开到第 2 层')
  })

  it('对端没有出边时降级为叶子（不因一个叶子让整张图失败）', async () => {
    // 回归：服务端把"没有出边"表达成业务错误 code=-1「没有找到模型…的定义」
    // （实测 wt_egy_energy / wt_10462_shuibengmoxing），展开第二层时直接抛
    // 会让整个工具失败——图都出不来。
    const { fetchImpl } = makeFetch({
      wt_elm_equipment: [rel('设备与能源的关系', 'wt_elm_equipment', 'wt_egy_energy', 'outterLink')],
    })
    // 让能源模型返回"无定义"业务错误
    const wrapped = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('wt_egy_energy')) {
        return jsonResponse({ code: -1, message: '错误:没有找到模型<<wt_egy_energy>>的定义！' })
      }
      return fetchImpl(url, init)
    })
    const res = await modelRelationGraphTool.run(
      { model_name: '设备基础模型' },
      ctxOf(wrapped as unknown as typeof fetch, { relationDepth: 3, relationFanout: 3 }),
    )
    expect(res.success).toBe(true)
    expect(res.total).toBe(1)
    expect(res.apiOrSql).toContain('1 个对端无出边')
  })

  it('首层的"无定义"错误仍照常抛出（那才是真的查不成）', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('queryByGenericSql')) {
        let sql = ''
        try { sql = String((JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as { sql?: string }).sql ?? '') } catch { sql = '' }
        if (/class_alias='([^']*)'/.test(sql)) {
          return jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [{ class_alias: '幽灵模型', class_path: 'wt_ghost' }] } })
        }
        return jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [] } })
      }
      return jsonResponse({ code: -1, message: '错误:没有找到模型<<wt_ghost>>的定义！' })
    })
    const res = await modelRelationGraphTool.run({ model_name: '幽灵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('INVALID_PARAM')
  })

  it('relationDepth=1 = 只画首层，不再查对端', async () => {
    const { fetchImpl, getCalls } = makeFetch({
      wt_elm_equipment: [rel('设备与能源的关系', 'wt_elm_equipment', 'wt_egy_energy', 'outterLink')],
      wt_egy_energy: [rel('能源设备的关系', 'wt_egy_energy', 'wt_iot_work_orders', 'outterLink')],
    })
    const res = await modelRelationGraphTool.run(
      { model_name: '设备基础模型' },
      ctxOf(fetchImpl as unknown as typeof fetch, { relationDepth: 1 }),
    )
    expect(res.total).toBe(1)
    expect(getCalls).toEqual(['wt_elm_equipment'])
  })

  it('relationFanout 限流：深层分支超上限时截断，并声明图非全量', async () => {
    const targets = Array.from({ length: 5 }, (_, i) => `wt_1_target${i}`)
    targets.forEach((p, i) => {
      ALIAS_TO_PATH[`对端${i}`] = p
      PATH_TO_ALIAS[p] = `对端${i}`
    })
    try {
      const byPath: Record<string, Array<Record<string, unknown>>> = {
        wt_elm_equipment: targets.map((p, i) => rel(`关系${i}`, 'wt_elm_equipment', p, 'outterLink')),
      }
      targets.forEach((p, i) => {
        byPath[p] = [rel(`深${i}`, p, `wt_leaf${i}`, 'outterLink')]
      })
      const { fetchImpl } = makeFetch(byPath)
        const res = await modelRelationGraphTool.run(
        { model_name: '设备基础模型' },
        ctxOf(fetchImpl as unknown as typeof fetch, { relationDepth: 3, relationFanout: 2 }),
      )
      const hintText = String((res.data.at(-1) as unknown as Record<string, unknown>).hint)
      expect(res.apiOrSql).toContain('深层限流 2 个分支')
      expect(hintText).toContain('图不是全量')
      const l3 = res.data.filter((r) => r.level === 3)
      expect(l3.length).toBeLessThanOrEqual(2)
    } finally {
      targets.forEach((p, i) => {
        delete ALIAS_TO_PATH[`对端${i}`]
        delete PATH_TO_ALIAS[p]
      })
    }
  })

  it('relationCap 截断：超出即 complete=false', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => rel(`关系${i}`, 'wt_elm_equipment', `wt_t${i}`, 'outterLink'))
    rows.forEach((_r, i) => {
      ALIAS_TO_PATH[`对端${i}`] = `wt_t${i}`
      PATH_TO_ALIAS[`wt_t${i}`] = `对端${i}`
    })
    try {
      const { fetchImpl } = makeFetch({ wt_elm_equipment: rows })
        const res = await modelRelationGraphTool.run(
        { model_name: '设备基础模型' },
        ctxOf(fetchImpl as unknown as typeof fetch, { relationCap: 5, relationDepth: 1 }),
      )
      expect(res.total).toBe(5)
      expect(res.complete).toBe(false)
      expect(res.rowCount).toBe(6) // 5 条 + 指引行
    } finally {
      rows.forEach((_r, i) => {
        delete ALIAS_TO_PATH[`对端${i}`]
        delete PATH_TO_ALIAS[`wt_t${i}`]
      })
    }
  })

  it('class_path 入参：先反查 class_alias 拿中文名，再按方向过滤', async () => {
    const { fetchImpl, getCalls } = makeFetch({
      wt_1_shebeicanshuliemoxing: [rel('设备参数列表', 'wt_elm_equipment', 'wt_1_shebeicanshuliemoxing')],
    })
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_1_shebeicanshuliemoxing' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    expect(getCalls[0]).toBe('wt_1_shebeicanshuliemoxing')
    // 这条关系的主体是设备基础模型，本模型只是对端 → 读法 A 丢弃
    expect(res.total).toBe(0)
    expect(String(res.data[0]!.relation_description)).toContain('没有它发出的模型关系')
  })

  it('中文名未命中但形态合法：回落按 class_path 查（覆盖单段无斜杠的真实 class_path）', async () => {
    const { fetchImpl, getCalls } = makeFetch({
      wt_elm_equipment: [rel('设备与能源的关系', 'wt_elm_equipment', 'wt_egy_energy', 'outterLink')],
    })
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_elm_equipment' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    expect(getCalls[0]).toBe('wt_elm_equipment')
    expect(res.total).toBe(1)
    // 中文名来自反查，而不是入参
    expect(res.data[0]!.source_model).toBe('设备基础模型')
  })

  it('关系名解析不出方向：整条丢弃，不猜方向', async () => {
    const { fetchImpl } = makeFetch({
      wt_elm_equipment: [
        { relation_name: 'weird_no_brackets', relation_description: '无方向', leftModelName: '设备基础模型', rightModelName: '能源基础模型' },
        rel('正常关系', 'wt_elm_equipment', 'wt_egy_energy', 'outterLink'),
      ],
    })
    const res = await modelRelationGraphTool.run({ model_name: '设备基础模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.total).toBe(1)
    expect(res.data[0]!.relation_description).toBe('正常关系')
    expect(res.apiOrSql).toContain('剔除入边/无关关系 1 条')
  })

  it('空关系：明确"没有它发出的模型关系"，不生成渲染指引', async () => {
    const { fetchImpl } = makeFetch({ wt_elm_equipment: [] })
    const res = await modelRelationGraphTool.run({ model_name: '设备基础模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(res.rowCount).toBe(1)
    expect(String(res.data[0]!.relation_description)).toContain('没有它发出的模型关系')
  })

  it('中文名未命中且不是合法 class_path 形态：INVALID_PARAM，不触网拼 SQL', async () => {
    const { fetchImpl } = makeFetch({})
    const res = await modelRelationGraphTool.run(
      { model_name: "不存在';--" },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('INVALID_PARAM')
    expect(res.errorMessage).toContain('非法字符')
  })

  it('HTTP 500 → BACKEND_DOWN；业务失败 code=-1 → INVALID_PARAM 透传服务端 message', async () => {
    const r1 = await modelRelationGraphTool.run(
      { model_name: '设备基础模型' },
      ctxOf(async () => new Response('oops', { status: 500 })),
    )
    expect(r1.errorCode).toBe('BACKEND_DOWN')

    const r2 = await modelRelationGraphTool.run(
      { model_name: '设备基础模型' },
      ctxOf(async (u) => (String(u).includes('queryByGenericSql') ? jsonResponse(CLASS_OK) : jsonResponse({ code: -1, message: '没有找到模型的定义' }))),
    )
    expect(r2.errorCode).toBe('INVALID_PARAM')
    expect(r2.errorMessage).toContain('没有找到模型的定义')
  })

  it('缺 model_name / 未配 baseUrl → 明确错误', async () => {
    const { fetchImpl } = makeFetch({})
    const r1 = await modelRelationGraphTool.run({}, ctxOf(fetchImpl as unknown as typeof fetch))
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
