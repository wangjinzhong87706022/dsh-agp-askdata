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

// 服务端不按 modelName 过滤：末行是与查询模型无关的"全局关系尾巴"，工具层应剔除。
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
      { id: 10000000062, relation_name: 'subLink_[wt_10462_shuibengmoxing]_[code]_[wt_1_shebeicanshuliemoxing]', relation_description: '水泵参数列表', leftModelName: '水泵模型', rightModelName: '设备参数列模型' },
      { id: 10000003038, relation_name: 'outterLink_[wt_elm_equipment]_[wt_egy_energy]', relation_description: '设备与能源的关系', leftModelName: '设备基础模型', rightModelName: '能源基础模型' },
    ],
  },
}

function ctxOf(
  fetchImpl: (url: string | URL | Request) => Promise<Response>,
  meta?: Partial<{ relationCap: number }>,
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
  it('两步主链：中文名 → queryByGenericSql 解析 class_path → getRelationsByModel → 关系清单 + 渲染指引（单击下钻常开）', async () => {
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
    // 2 条返回里 1 条是无关尾巴 → 只留 1 条直接关系 + 1 行渲染指引
    expect(res.rowCount).toBe(2)
    expect(res.total).toBe(1)
    expect(res.complete).toBe(true)
    expect(res.data[0]!.relation_description).toBe('水泵参数列表')
    expect(res.data[0]!.rightModelName).toBe('设备参数列模型')
    expect(res.data[0]!.direct).toBe('是')
    expect(res.apiOrSql).toContain('已剔除 1 条无关关系')
    const hint = res.data.at(-1)!
    expect(String(hint.relation_description)).toContain('渲染指引')
    const hintText = String((hint as Record<string, unknown>).hint)
    // 单击下钻常开：模板只带 drill.key，actionTemplate 用渲染器默认值（少抄一个字段）
    expect(hintText).not.toContain('actionTemplate')
    expect(hintText).toContain('单击')
    expect(hintText).not.toContain('双击')
    expect(hintText).toContain('"preset":"tree"')
    expect(hintText).toContain('"drill":{"key":"水泵模型"}')
    expect(hintText).toContain('[genui-action]')
    // patch 协议 + drill key
    expect(hintText).toContain('drillPatch')
    expect(hintText).toContain('幂等检查')
    // 叶子取"非本模型"那一端，并告知剔除了多少条
    expect(hintText).toContain('leftModelName 等于本模型则取 rightModelName')
    expect(hintText).toContain('混了 1 条与本模型无关的全局关系')
  })

  it('服务端关系尾巴按端点过滤：只留本模型为端点的行（两个模型不再画出同一张图）', async () => {
    // 复刻 2026-09-28 实测形态：50 条里只有前几条是本模型的直接关系，其余是
    // 无关的全局关系（工作计划/组织/职工…）。关键在于**无关尾巴对两个模型是同一
    // 批**（实测返回集交集 49/49）——这正是两个模型画出同一张图的根因。
    const TAIL = Array.from({ length: 45 }, (_, i) => ({
      relation_name: `global_r${i}`,
      relation_description: `全局无关关系${i}`,
      leftModelName: i % 2 === 0 ? '工作计划模型' : '组织基础模型',
      rightModelName: i % 2 === 0 ? '工作任务模型' : '角色模型',
    }))
    const build = (alias: string, directCount: number) => [
      ...Array.from({ length: directCount }, (_, i) => ({
        relation_name: `${alias}_r${i}`,
        relation_description: `${alias}直接关系${i}`,
        leftModelName: alias,
        rightModelName: `对端${i}`,
      })),
      ...TAIL,
    ]
    const runOne = async (alias: string, rows: ReturnType<typeof build>): Promise<{ descs: string[]; hint: string; api: string }> => {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('queryByGenericSql')) {
          return jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [{ class_alias: alias, class_name: 'x', class_path: `p_${alias}` }] } })
        }
        return jsonResponse({ code: 0, message: 'success', data: { field: [], data: rows } })
      })
      const res = await modelRelationGraphTool.run({ model_name: alias }, ctxOf(fetchImpl as unknown as typeof fetch))
      expect(res.success).toBe(true)
      const descs = res.data.slice(0, -1).map((r) => String(r.relation_description))
      return { descs, hint: String((res.data.at(-1) as unknown as Record<string, unknown>).hint), api: res.apiOrSql }
    }
    const a = await runOne('水泵模型', build('水泵模型', 12))
    const b = await runOne('建筑模型', build('建筑模型', 2))
    // 前提坐实：不过滤的话两模型返回值交集 = 45/45，就是"两张一样的图"
    const shared = build('水泵模型', 12).map((r) => r.relation_description)
      .filter((d) => build('建筑模型', 2).some((r) => r.relation_description === d))
    expect(shared).toHaveLength(45)
    // 过滤后：各留各的直接关系
    expect(a.descs).toHaveLength(12)
    expect(b.descs).toHaveLength(2)
    // 两张图不再有共同关系——这正是用户报的现象的判据
    expect(a.descs.filter((d) => b.descs.includes(d))).toHaveLength(0)
    expect(a.api).toContain('已剔除 45 条无关关系')
    expect(b.api).toContain('已剔除 45 条无关关系')
    // 过滤后全是直接关系：不再有「经XX链路」间接分组那套规则
    expect(a.hint).not.toContain('经XX链路')
    expect(a.hint).not.toContain('间接')
  })

  it('安全截断上限走 config.query.meta.relationCap（超出即 complete=false）', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: `关系${i}`,
      leftModelName: '水泵模型',
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

  it('class_path 入参：先反查 class_alias 拿中文名，过滤照常生效', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('queryByGenericSql')) {
        // 反查 SQL 按 class_path 走，能拿回中文名
        expect(u).toBe('https://www.openagp.top:9080/s1M6_uE9/wz/meta/model/queryByGenericSql')
        return jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [{ class_alias: '水泵模型', class_name: 'x', class_path: 'wt_10462_shuibengmoxing' }] } })
      }
      return jsonResponse(RELATION_ENVELOPE)
    })
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_10462_shuibengmoxing' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    expect(calls).toHaveLength(2) // 反查 + 关系查询
    expect(res.data[0]!.direct).toBe('是')
    expect(res.data[0]!.relation_description).toBe('水泵参数列表')
    expect(res.apiOrSql).toContain('已剔除 1 条无关关系')
  })

  it('class_path 反查不到中文名：原样透出 + 指引要求只画本模型为端点的关系', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: `关系${i}`,
      leftModelName: '水泵模型',
      rightModelName: `对端${i}`,
    }))
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('queryByGenericSql')) {
        return jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [] } })
      }
      return jsonResponse({ code: 0, message: 'success', data: { field: [], data: rows } })
    })
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_unknown_path' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    expect(res.total).toBe(5) // 没法判定就全给，不误报 0 条
    expect(res.data[0]!.direct).toBe('无法判定')
    expect(res.apiOrSql).toContain('无法按端点过滤')
    const hint = String((res.data.at(-1) as unknown as Record<string, unknown>).hint)
    expect(hint).toContain('只画以本模型为端点的关系')
  })

  it('有返回但无一条以本模型为端点：明确说"没有直接关系"而非"返回 0 行"', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: `全局关系${i}`,
      leftModelName: '其他模型',
      rightModelName: `别模型${i}`,
    }))
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('queryByGenericSql')) return jsonResponse(CLASS_LIST_ENVELOPE)
      return jsonResponse({ code: 0, message: 'success', data: { field: [], data: rows } })
    })
    const res = await modelRelationGraphTool.run({ model_name: '水泵模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(true)
    expect(res.rowCount).toBe(1)
    expect(String(res.data[0]!.relation_description)).toContain('没有直接关系')
    expect(String(res.data[0]!.relation_description)).toContain('服务端未按 modelName 过滤')
  })

  it('非法字符在两种入参形态下都被拒，不触网', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RELATION_ENVELOPE))
    // 无 "/"：中文名白名单（CLASS_ALIAS_RE）拒绝
    const res1 = await modelRelationGraphTool.run(
      { model_name: "wt_x'-- y" },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res1.success).toBe(false)
    expect(res1.errorCode).toBe('INVALID_PARAM')
    expect(res1.errorMessage).toContain('模型名含非法字符')
    // 有 "/"：当 class_path 处理，CLASS_PATH_RE 预检拒绝——引号绝不进 SQL
    const res2 = await modelRelationGraphTool.run(
      { model_name: "wt_x/';--" },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res2.success).toBe(false)
    expect(res2.errorCode).toBe('INVALID_PARAM')
    expect(res2.errorMessage).toContain('不存在')
    expect(res2.errorMessage).toContain('class_path')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('恰好 300 条关系：渲染指引行不被预览截断吞掉（H1）', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      relation_name: `r${i}`,
      relation_description: `关系${i}`,
      leftModelName: i % 2 === 0 ? '水泵模型' : `对端${i}`,
      rightModelName: i % 2 === 0 ? `对端${i}` : '水泵模型',
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

  it('class_path 直传（含 /）：反查 + 关系查询两步，不再是一次 GET', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('queryByGenericSql')
        ? jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [{ class_alias: '水泵模型', class_name: 'x', class_path: 'wt_10462_shuibengmoxing' }] } })
        : jsonResponse(RELATION_ENVELOPE))
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_10462_shuibengmoxing' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls
    expect(calls).toHaveLength(2)
    expect(String(calls[1]![0])).toContain('modelName=wt_10462_shuibengmoxing')
  })

  it('中文名未命中且不是合法 class_path 形态：INVALID_PARAM 提示确认模型名', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [] } }))
    const res = await modelRelationGraphTool.run({ model_name: '不存在的模型' }, ctxOf(fetchImpl as unknown as typeof fetch))
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('INVALID_PARAM')
    expect(res.errorMessage).toContain('不存在的模型')
    expect(res.errorMessage).toContain('class_alias')
    // 只查了 alias 一次就拒了——非法输入绝不进 SQL
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('中文名未命中但形态合法：回落按 class_path 查（覆盖单段无斜杠的真实 class_path）', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('queryByGenericSql')) {
        // 第一次按 class_alias 查（"wt_elm_equipment" 也是合法 alias 形态）→ 空；
        // 第二次按 class_path 查 → 命中，且带回中文别名
        return calls.length === 1
          ? jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [] } })
          : jsonResponse({ code: '0', msg: '成功', data: { field: [], data: [{ class_alias: '设备基础模型', class_name: 'wt_elm_equipment', class_path: 'wt_elm_equipment' }] } })
      }
      return jsonResponse({
        code: 0, message: 'success',
        data: {
          field: [],
          data: [
            { relation_name: 'a', relation_description: '设备与能源的关系', leftModelName: '设备基础模型', rightModelName: '能源基础模型' },
            { relation_name: 'b', relation_description: '无关关系', leftModelName: '组织基础模型', rightModelName: '角色模型' },
          ],
        },
      })
    })
    const res = await modelRelationGraphTool.run(
      { model_name: 'wt_elm_equipment' },
      ctxOf(fetchImpl as unknown as typeof fetch),
    )
    expect(res.success).toBe(true)
    expect(calls.filter((u) => u.includes('queryByGenericSql'))).toHaveLength(2)
    // 反查到的中文名让端点过滤生效：无关那条被剔除
    expect(res.data).toHaveLength(2) // 1 条关系 + 指引行
    expect(res.data[0]!.relation_description).toBe('设备与能源的关系')
    expect(res.apiOrSql).toContain('「设备基础模型」')
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
