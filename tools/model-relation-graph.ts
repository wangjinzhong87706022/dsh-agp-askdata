/**
 * `model_relation_graph`（关系图谱，docs/architecture.md §20）：
 * 查询一个模型的关系链——AGP 数据底座 meta 接口
 * `GET {metaBase}/getRelationsByModel?modelName=<class_path>`，
 * 返回与该模型相关的所有模型关系，模型按指引以 dsh-ui echart 树形图渲染。
 *
 * 两步流程（2026-09-23 线上实证）：
 *   1. 中文名 → class_path：POST `{metaBase}/model/queryByGenericSql`
 *      （sql: select class_path from meta_class_info where class_alias='<中文名>'；
 *      入参含 "/" 时视为已是 class_path，直接跳过本步）；
 *   2. GET getRelationsByModel?modelName=<class_path> → 关系清单
 *      （relation_description=关系名，leftModelName/rightModelName=左右模型中文名）。
 *
 * 线上实现细节（与 PDF 文档的差异，均已实测对拍）：
 *   - 路径：前端在 /v7i0_wG9/，后端 API 在 /s1M6_uE9/wz/（config.js backSuffix/serviceWz）；
 *     metaBase 从 query.rest.baseUrl 的 /iot-etl/iot 段替换为 /meta 派生；
 *   - 编码：服务端 Content-Type 声称 UTF-8 实际发 GBK 字节——先按 UTF-8 严格解码，
 *     失败回退 GBK；
 *   - 信封：code 可能是数字 0 或字符串 "0"，message/msg 两种字段名都收；
 *   - modelName 实际匹配 class_path（PDF 写"模型名称"），中文名必须先解析。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import { fail, ok, type ResultField } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { resolveAgpCredentials } from '../src/clients/tsdb-rest.ts'

const FIELDS: ResultField[] = [
  { name: 'rank', title: '序号', type: 'number' },
  { name: 'relation_name', title: '关系内部名', type: 'string' },
  { name: 'relation_description', title: '关系名称', type: 'string' },
  { name: 'leftModelName', title: '左模型', type: 'string' },
  { name: 'rightModelName', title: '右模型', type: 'string' },
]

/** 由 TSDB 网关 baseUrl 派生 meta 接口基址。 */
export function metaBaseUrl(tsdbBaseUrl: string): string {
  const base = tsdbBaseUrl.replace(/\/+$/, '')
  if (/\/iot-etl\/iot$/i.test(base)) return base.replace(/\/iot-etl\/iot$/i, '/meta')
  return `${base}/meta`
}

/**
 * 响应体解码：服务端 Content-Type 声称 UTF-8 但实际可能发 GBK 字节。
 * 先按 UTF-8 严格解码，失败回退 GBK。
 */
export function decodeAgpBody(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}

/** AGP 信封（宽松形态）：code 数字/字符串皆收，message/msg 皆收。 */
export interface AgpEnvelope {
  code: number | string
  message: string
  field: Record<string, unknown>[]
  rows: Record<string, unknown>[]
  page?: { pageNum: number; pageSize: number; pageTotal: number; itemTotal: number }
}

/** 解析 AGP 统一信封；业务失败抛 INVALID_PARAM（带服务端 message）。 */
export function parseAgpEnvelope(text: string): AgpEnvelope {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw askdataError('INVALID_PARAM', 'AGP 接口响应不是合法 JSON')
  }
  const rawCode = payload.code
  const code = typeof rawCode === 'string' ? Number(rawCode) : rawCode
  if (typeof code !== 'number' || Number.isNaN(code)) {
    throw askdataError('INVALID_PARAM', 'AGP 接口响应形态不合法（缺少 code 字段）')
  }
  const message = String(payload.message ?? payload.msg ?? '')
  if (code !== 0) {
    throw askdataError('INVALID_PARAM', `AGP 接口业务失败 code=${rawCode}: ${message}`)
  }
  const data = (payload.data ?? {}) as Record<string, unknown>
  const field = Array.isArray(data.field) ? (data.field as Record<string, unknown>[]) : []
  const rows = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : []
  const rawPage = (data.page ?? null) as Record<string, unknown> | null
  const page = rawPage
    ? {
        pageNum: Number(rawPage.pageNum ?? 0),
        pageSize: Number(rawPage.pageSize ?? 0),
        pageTotal: Number(rawPage.pageTotal ?? 0),
        itemTotal: Number(rawPage.itemTotal ?? 0),
      }
    : undefined
  return { code, message, field, rows, page }
}

/** 网络调用：三头 + 超时/取消合并 + 解码。（meta 面工具共享，model-field-list 复用） */
export async function agpGet(ctx: ToolContext, metaBase: string, pathAndQuery: string): Promise<string> {
  const cred = resolveAgpCredentials(ctx.config.query.rest, ctx.config.appId)
  const url = `${metaBase}${pathAndQuery}`
  const impl = ctx.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(ctx.config.system.queryTimeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  let res: Response
  try {
    res = await impl(url, {
      headers: { 'WT-APPID': cred.appId, 'WT-OPENID': cred.openid, 'WT-TOKEN': cred.token },
      signal,
    })
    if (!res.ok) throw askdataError('BACKEND_DOWN', `AGP meta 接口返回 HTTP ${res.status}`)
  } catch (err) {
    if (err instanceof AskdataError) throw err
    const reason = (err as { cause?: { code?: string }; message?: string })?.cause?.code
      ?? (err instanceof Error ? err.message : String(err))
    throw askdataError('BACKEND_DOWN', `AGP meta 接口调用失败: ${String(reason).slice(0, 200)}`)
  }
  return decodeAgpBody(await res.arrayBuffer())
}

/** 中文名 → class_path（queryByGenericSql 查 meta_class_info.class_alias）。（meta 面工具共享） */
export async function resolveClassPath(ctx: ToolContext, metaBase: string, modelName: string, urlLog: string[]): Promise<string> {
  const cred = resolveAgpCredentials(ctx.config.query.rest, ctx.config.appId)
  const url = `${metaBase}/model/queryByGenericSql`
  urlLog.push(`${url} (class_alias=${modelName})`)
  const impl = ctx.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(ctx.config.system.queryTimeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  const sql = `select class_alias, class_name, class_path from meta_class_info where class_alias='${modelName.replaceAll("'", "''")}'`
  let res: Response
  try {
    res = await impl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'WT-APPID': cred.appId,
        'WT-OPENID': cred.openid,
        'WT-TOKEN': cred.token,
      },
      body: JSON.stringify({ sql, dataMaps: {}, pageNum: 1, pageSize: 50 }),
      signal,
    })
    if (!res.ok) throw askdataError('BACKEND_DOWN', `AGP meta 接口返回 HTTP ${res.status}`)
  } catch (err) {
    if (err instanceof AskdataError) throw err
    const reason = (err as { cause?: { code?: string }; message?: string })?.cause?.code
      ?? (err instanceof Error ? err.message : String(err))
    throw askdataError('BACKEND_DOWN', `AGP meta 接口调用失败: ${String(reason).slice(0, 200)}`)
  }
  const env = parseAgpEnvelope(decodeAgpBody(await res.arrayBuffer()))
  for (const row of env.rows) {
    const classPath = row.class_path
    if (typeof classPath === 'string' && classPath !== '') return classPath
  }
  throw askdataError(
    'INVALID_PARAM',
    `模型「${modelName}」不存在（meta_class_info 无此 class_alias）。请确认模型中文名，或直接传 class_path（含 / 的形态）`,
  )
}

/** 渲染指引（作为最后一行数据输出给模型）。自包含完整模板——不依赖 skill 注入。 */
function renderHintRow(modelName: string, relationCount: number): Record<string, unknown> {
  return {
    rank: 0,
    relation_name: '',
    relation_description: '【树形图渲染指引】',
    leftModelName: '',
    rightModelName: '',
    hint:
      `请原样套用以下 dsh-ui 围栏模板输出树形图（JSON 逐字保留，只替换 title 和 data；` +
      `配色/roam 拖拽缩放/展开收起/悬停高亮/保存图片/actionTemplate 点击下钻桥都已内置）：\n` +
      '```dsh-ui\n' +
      `{"type":"echart","title":"${modelName} · 关系图谱（${relationCount} 条关系）","height":560,` +
      `"actionTemplate":"下钻模型：{name}","option":{"tooltip":{"trigger":"item","triggerOn":"mousemove"},` +
      `"toolbox":{"show":true,"feature":{"saveAsImage":{}},"right":10,"top":2},"series":[{"type":"tree",` +
      `"roam":true,"expandAndCollapse":true,"initialTreeDepth":-1,"orient":"LR","left":16,"right":200,` +
      `"top":10,"bottom":10,"symbol":"circle","symbolSize":12,` +
      `"itemStyle":{"color":"#5b8ff9","borderColor":"#5b8ff9","borderWidth":2},` +
      `"lineStyle":{"color":"#b8c6dd","width":1.5,"curveness":0.45},` +
      `"label":{"position":"left","fontSize":13,"color":"#47607c","distance":6},` +
      `"leaves":{"symbolSize":9,"itemStyle":{"color":"#5ad8a6"},"label":{"position":"right","fontSize":13,"color":"#2e7d5b"}},` +
      `"emphasis":{"focus":"descendant","lineStyle":{"width":2.5},"itemStyle":{"color":"#f6bd16","borderColor":"#f6bd16"}},` +
      `"animationDuration":400,"data":[{"name":"${modelName}","children":[按 relation_description 聚合：` +
      `第二层=关系名，叶子=rightModelName；同一对端模型多条关系时合并到一个关系节点]}]}]}}\n` +
      '```\n' +
      `文字回复概述关系数量与对端模型清单。` +
      `后续若收到 [genui-action] "下钻模型：X"（用户点击了图上节点）或用户打字"下钻 X"：` +
      `调用本工具查 X 的关系，把结果合并进上一棵树的 X 节点 children（树中已有的关系不重复挂），` +
      `用同一模板重绘整棵树；X 无关系时如实说明、保持原图。`,
  }
}

/** model_relation_graph 工具定义。 */
export const modelRelationGraphTool: AskdataTool = {
  name: 'model_relation_graph',
  description:
    '查询一个模型的关系链（关系图谱）：返回与指定模型相关的所有模型关系清单（关系名称、左模型、右模型），'
    + '并按指引以 dsh-ui echart 树形图渲染。输入中文模型名（如 水泵模型、企业职工模型、安科瑞水表模型；'
    + '也接受 class_path 形态）。数据来自 AGP 数据底座 meta 接口（getRelationsByModel），只读。'
    + '查模型的字段构成（属性清单）用 model_field_list。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: {
        type: 'string',
        description: '中文模型名称（如 水泵模型、企业职工模型、安科瑞水表模型）；也接受 class_path（含 / 的形态）',
      },
    },
    required: ['model_name'],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const started = Date.now()
    const modelName = typeof args.model_name === 'string' ? args.model_name.trim() : ''
    const urlLog: string[] = []
    try {
      if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填（中文模型名或 class_path）')
      if (!ctx.config.query.rest.baseUrl) {
        throw askdataError('BACKEND_DOWN', 'AGP API 未配置（query.rest.baseUrl），关系图谱接口不可用')
      }
      const metaBase = metaBaseUrl(ctx.config.query.rest.baseUrl)

      // 1. 中文名 → class_path（含 "/" 的入参视为 class_path 直接使用）
      const classPath = modelName.includes('/') ? modelName : await resolveClassPath(ctx, metaBase, modelName, urlLog)

      // 2. 关系链查询
      urlLog.push(`${metaBase}/getRelationsByModel?modelName=${classPath}`)
      const text = await agpGet(ctx, metaBase, `/getRelationsByModel?modelName=${encodeURIComponent(classPath)}`)
      const env = parseAgpEnvelope(text)

      const data: Record<string, unknown>[] = env.rows.map((row, i) => ({
        rank: i + 1,
        relation_name: String(row.relation_name ?? ''),
        relation_description: String(row.relation_description ?? ''),
        leftModelName: String(row.leftModelName ?? ''),
        rightModelName: String(row.rightModelName ?? ''),
      }))
      if (data.length === 0) {
        data.push({
          rank: 0,
          relation_name: '',
          relation_description: `模型「${modelName}」（${classPath}）没有已定义的模型关系（返回 0 行）。请直接说明，不要编造关系。`,
          leftModelName: '',
          rightModelName: '',
        })
      } else {
        data.push(renderHintRow(modelName, env.rows.length))
      }

      const apiOrSql = `GET ${metaBase}/getRelationsByModel?modelName=${classPath} → ${env.rows.length} 条关系`
      const result = ok(modelRelationGraphTool.name, {
        apiOrSql,
        params: args,
        fields: FIELDS,
        data,
        executionMs: Date.now() - started,
      })
      applyAudit(modelRelationGraphTool, args, ctx, apiOrSql, result, started, urlLog[0])
      return result
    } catch (err) {
      const askErr = err instanceof AskdataError ? err : null
      const code: ErrorCode = askErr ? askErr.code : 'BACKEND_DOWN'
      const message = askErr ? askErr.message : `关系图谱查询异常: ${err instanceof Error ? err.message : String(err)}`
      const result = fail(modelRelationGraphTool.name, {
        params: args,
        code,
        message,
        executionMs: Date.now() - started,
      })
      applyAudit(modelRelationGraphTool, args, ctx, urlLog[0] ?? '', result, started, urlLog[0])
      return result
    }
  },
}

export const MODEL_RELATION_GRAPH_FIELDS = FIELDS
