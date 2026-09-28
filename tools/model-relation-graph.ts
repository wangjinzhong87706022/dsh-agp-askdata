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
  { name: 'direct', title: '直接关系', type: 'string' },
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
  // Non-finite server values become 0 — a NaN total would render as null and
  // make every `rowCount >= total` completeness check silently false.
  const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  const page = rawPage
    ? {
        pageNum: num(rawPage.pageNum),
        pageSize: num(rawPage.pageSize),
        pageTotal: num(rawPage.pageTotal),
        itemTotal: num(rawPage.itemTotal),
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

/**
 * `class_alias` 白名单：模型中文名不含 SQL 元字符，`''` 倍增在 MySQL 默认
 * sql_mode（反斜杠转义开启）下可被 `\'` 击穿，故此处改白名单而非转义。
 * 允许：中日韩文、字母、数字、空格、`·-（）()、,` 等建模命名的实际字符。
 */
const CLASS_ALIAS_RE = /^[\p{Script=Han}a-zA-Z0-9 _·\-()（）,.]{1,64}$/u

/**
 * `class_path` 白名单：服务端内部名，形如 `wt_elm_equipment` 或
 * `wt_elm_equipment/wt_10462_shuibengmoxing`（父/子两级）。同样走白名单而非
 * 转义——反引号/引号都不在允许集内，`''` 倍增无从构造。
 */
const CLASS_PATH_RE = /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+){0,3}$/

/** meta_class_info 一行的最小形态（只取三个关键列）。 */
interface ClassRow {
  class_alias?: unknown
  class_name?: unknown
  class_path?: unknown
}

/** 按 `column=value` 查 meta_class_info（queryByGenericSql）。值已过白名单。 */
async function queryClassInfo(
  ctx: ToolContext,
  metaBase: string,
  column: 'class_alias' | 'class_path',
  value: string,
  urlLog: string[],
): Promise<ClassRow[]> {
  const cred = resolveAgpCredentials(ctx.config.query.rest, ctx.config.appId)
  const url = `${metaBase}/model/queryByGenericSql`
  urlLog.push(`${url} (${column}=${value})`)
  const impl = ctx.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(ctx.config.system.queryTimeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  const sql = `select class_alias, class_name, class_path from meta_class_info where ${column}='${value}'`
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
  return parseAgpEnvelope(decodeAgpBody(await res.arrayBuffer())).rows as ClassRow[]
}

/** 中文名 → class_path（queryByGenericSql 查 meta_class_info.class_alias）。（meta 面工具共享） */
export async function resolveClassPath(ctx: ToolContext, metaBase: string, modelName: string, urlLog: string[]): Promise<string> {
  if (!CLASS_ALIAS_RE.test(modelName)) {
    throw askdataError(
      'INVALID_PARAM',
      `模型名含非法字符（仅允许中文/字母/数字/空格与 -_·（）, .）：${modelName.slice(0, 40)}`,
    )
  }
  for (const row of await queryClassInfo(ctx, metaBase, 'class_alias', modelName, urlLog)) {
    const classPath = row.class_path
    if (typeof classPath === 'string' && classPath !== '') return classPath
  }
  throw askdataError(
    'INVALID_PARAM',
    `模型「${modelName}」不存在（meta_class_info 无此 class_alias）。请确认模型中文名，或直接传 class_path（含 / 的形态）`,
  )
}

/**
 * class_path → 中文 class_alias（反向查表），未命中返回 null。
 *
 * 存在的原因：`getRelationsByModel` 返回的 `leftModelName`/`rightModelName`
 * 是**中文端点名**，而 class_path 入参时手上只有内部名，逐行比对端点名必然
 * 全部落空、direct 恒为「否」。反查一次拿到中文名，direct 判定才成立，
 * 关系尾巴过滤才能对两种入参一致生效。
 *
 * 返回 null 而非抛错：拿不到中文名时调用方退化为「不过滤」，宁可把服务端
 * 原样透出，也不要误报 0 条关系。
 */
export async function resolveAliasByClassPath(
  ctx: ToolContext,
  metaBase: string,
  classPath: string,
  urlLog: string[],
): Promise<string | null> {
  if (!CLASS_PATH_RE.test(classPath)) {
    throw askdataError(
      'INVALID_PARAM',
      `class_path 含非法字符（仅允许字母/数字/下划线与 / 分段，最多 4 段）：${classPath.slice(0, 40)}`,
    )
  }
  for (const row of await queryClassInfo(ctx, metaBase, 'class_path', classPath, urlLog)) {
    const alias = row.class_alias
    if (typeof alias === 'string' && alias !== '') return alias
  }
  return null
}

/** 模型入参解析结果：class_path 供接口查询，alias 供 direct 判定（可能为 null）。 */
export interface ModelRef {
  classPath: string
  /** 中文名；反查不到时为 null，调用方须退化为「不做端点过滤」。 */
  alias: string | null
}

/**
 * 模型入参 → (class_path, 中文名)，一次收口。
 *
 * 顺序：先当中文名查 `class_alias`（命中即返回，alias 用入参本身）；未命中
 * 再当 class_path 查（返回 class_path，并反查中文名）。
 *
 * 不能只按"含不含 /"来分流——真实 class_path 常是 `wt_elm_equipment` 这种
 * 单段无斜杠形态（如设备基础模型），按斜杠判会把它们错当中文名送去 alias
 * 查，然后报"模型不存在"。
 */
export async function resolveModelRef(
  ctx: ToolContext,
  metaBase: string,
  modelName: string,
  urlLog: string[],
): Promise<ModelRef> {
  if (CLASS_ALIAS_RE.test(modelName)) {
    for (const row of await queryClassInfo(ctx, metaBase, 'class_alias', modelName, urlLog)) {
      const classPath = row.class_path
      if (typeof classPath === 'string' && classPath !== '') {
        // 用查回来的 class_alias，而不是入参：class_alias 白名单同时放行
        // class_path 形态的入参（wt_elm_equipment 也是合法 alias 字符集），
        // 此时入参不是中文名，拿它跟中文端点名比对会全部落空。服务端回了
        // 真实别名就用它，只在字段缺失时退回入参。
        const alias = row.class_alias
        return {
          classPath,
          alias: typeof alias === 'string' && alias !== '' ? alias : modelName,
        }
      }
    }
  } else if (!modelName.includes('/')) {
    // 非中文名、又不像 class_path：直接给可读报错，别拿它去拼 SQL。
    throw askdataError(
      'INVALID_PARAM',
      `模型名含非法字符（中文名仅允许中文/字母/数字/空格与 -_·（）, .；class_path 仅允许字母/数字/下划线）：${modelName.slice(0, 40)}`,
    )
  }
  // 中文名没命中：按 class_path 再试一次。resolveAliasByClassPath 内的
  // CLASS_PATH_RE 负责把含引号/空格/反斜杠的输入挡在触网之前——这两类入参
  // （如 "不存在/y"）即使 alias 查表没命中也不会拼进 SQL。
  if (!CLASS_PATH_RE.test(modelName)) {
    throw askdataError(
      'INVALID_PARAM',
      `模型「${modelName.slice(0, 40)}」不存在（meta_class_info 既无此 class_alias，也不是合法 class_path 形态）。`
      + `请确认模型中文名，或传 class_path（形如 wt_elm_equipment 或 wt_elm_equipment/wt_xxx）`,
    )
  }
  const alias = await resolveAliasByClassPath(ctx, metaBase, modelName, urlLog)
  return { classPath: modelName, alias }
}

/**
 * 渲染指引（作为最后一行数据输出给模型）。自包含完整模板——不依赖 skill 注入。
 * 模板本身保持纯合法 JSON（模型照抄不会踩语法坑），data 构造规则放在 JSON 外。
 *
 * 下钻走**单击**：节点折叠已在客户端关闭（`expandAndCollapse:false`），单击
 * 全部让位给下钻。曾试过双击，但 ECharts 树图单击会 toggle 子树并触发重绘，
 * 第二次点击落在重绘后的新位置上，dblclick 序列判定失败——双击永远不触发。
 *
 * 关系清单已按端点过滤（见 run 内注释），全部是直接关系，故不再有
 * 「经XX链路」间接分组那套规则。
 */
function renderHintRow(
  modelName: string,
  relationCount: number,
  droppedCount: number,
  aliasKnown: boolean,
): Record<string, unknown> {
  const dataRule =
    `data 构造规则：第二层 = 关系名（relation_description），叶子 = 对端模型（该关系中不是「${modelName}」的那一端` +
    `——leftModelName 等于本模型则取 rightModelName，反之取 leftModelName）；` +
    `同一对端模型多条关系时合并到一个关系节点。` +
    (droppedCount > 0
      ? `注意：服务端未按 modelName 过滤，返回里混了 ${droppedCount} 条与本模型无关的全局关系，已在上方数据中剔除——不要把它们画进图里。`
      : '') +
    (aliasKnown ? '' : `注意：本次无法反查到本模型的中文名，接口返回的是服务端原始清单，可能混有无关关系；只画以本模型为端点的关系。`)
  const drillProtocol =
    `单击图上任意节点会向你发 [genui-action] "下钻模型：X"，用户打字"下钻 X"同义。下钻响应协议：\n` +
    `[1] 幂等检查——若本次会话里 X 已经查过（上一条回答展开过 X），只回复一句"「X」上一条已展开"，` +
    `不调用工具、不输出围栏。\n` +
    `[2] 否则调用本工具查 X 的关系，只输出以下 patch 围栏——**就地展开为本次回答中的一棵独立子树图**，` +
    `标题带完整路径；不要重绘首图，也不要把子树并回首图（会让首图膨胀、用户要往上翻找）：\n` +
    '```dsh-ui\n' +
    `{"type":"echart","preset":"tree","title":"${modelName} › X","height":400,` +
    `"drillPatch":{"key":"${modelName}","target":"X","children":[` +
    `{"name":"关系A","children":[{"name":"对端模型1"}]},` +
    `{"name":"关系B","children":[{"name":"对端模型2"}]}]}}\n` +
    '```\n' +
    `[3] children 只含本次新增的子树（真实数据元素、至少 1 个，禁止省略号或注释）；` +
    `key 固定用首图 key（"${modelName}"）；文字概述 1-2 句，并提示可继续单击下钻。\n`
  return {
    rank: 0,
    relation_name: '',
    relation_description: '【树形图渲染指引】',
    leftModelName: '',
    rightModelName: '',
    direct: '',
    hint:
      `请套用以下 dsh-ui 围栏模板输出树形图（结构逐字保留，tree.data 里的示例节点按下方规则换成真实数据；` +
      `配色与单击下钻全部内置，不要自己补 option 或样式字段）：\n` +
      '```dsh-ui\n' +
      `{"type":"echart","preset":"tree","title":"${modelName} · 关系图谱（${relationCount} 条关系）","height":560,` +
      `"drill":{"key":"${modelName}"},` +
      `"tree":{"data":[{"name":"${modelName}","children":[` +
      `{"name":"关系A","children":[{"name":"对端模型1"}]},` +
      `{"name":"关系B","children":[{"name":"对端模型2"}]}]}]}}\n` +
      '```\n' +
      `${dataRule}\n` +
      `${drillProtocol}` +
      `文字回复概述关系数量与对端模型清单。`,
  }
}

/**
 * 模型可见的预览上限（`AskdataTool.previewLimit` 静态字段，拿不到 ctx.config，
 * 故取一个恒定的上界常量）。
 *
 * 实际生效的截断上限是 `min(config.query.meta.relationCap, 本常量 - 1)`：
 * 再减 1 是给渲染指引行留位（否则恰好撞到上限时指引行会被预览切掉，模型只拿到
 * 数据和一句"仅展示前 N 行"）。取 min 而不是直接信任配置，是为了让"产出行数"
 * 与"预览行数"在任意配置下都自洽——配置把 relationCap 调到本常量之上也不会丢指引行。
 */
const RELATION_PREVIEW_LIMIT = 1000

/** model_relation_graph 工具定义。 */
export const modelRelationGraphTool: AskdataTool = {
  name: 'model_relation_graph',
  previewLimit: RELATION_PREVIEW_LIMIT,
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

      // 1. 入参 → (class_path, 中文名)。两条路径都要拿到中文名：服务端回显的
      //    leftModelName/rightModelName 是中文端点名，direct 判定与尾巴过滤
      //    全靠它跟模型名比对。
      //    判定顺序不能只看有没有 "/":真实 class_path 常是 `wt_elm_equipment`
      //    这种单段无斜杠形态。所以先按 class_alias 查，未命中再按 class_path
      //    查——中文名必然命中 alias 侧，class_path 形态（无论带不带 "/"）
      //    都会落到第二次查询。alias 为 null 表示反查不到中文名，调用方
      //    退化为"不过滤"（宁可给全量，也好过误报 0 条关系）。
      const resolved = await resolveModelRef(ctx, metaBase, modelName, urlLog)
      const classPath = resolved.classPath
      const alias = resolved.alias

      // 2. 关系链查询
      urlLog.push(`${metaBase}/getRelationsByModel?modelName=${classPath}`)
      const text = await agpGet(ctx, metaBase, `/getRelationsByModel?modelName=${encodeURIComponent(classPath)}`)
      const env = parseAgpEnvelope(text)

      // 截断上限取 min（配置 relationCap，预览常量 -1）：见 RELATION_PREVIEW_LIMIT 注释。
      const relationCap = Math.min(ctx.config.query.meta.relationCap, RELATION_PREVIEW_LIMIT - 1)
      // 服务端已知缺陷（2026-09-28 实测）：getRelationsByModel 忽略 modelName 过滤，
      // 把该模型的直接关系排在最前，后面接一大段与查询模型无关的全局关系尾巴
      // （设备 12/50 直接、建筑 2/50），且 pageSize 恒 50、page 恒 undefined。
      // 不裁掉尾巴的话，两个不同模型画出来的关系图几乎一样。拿得到中文名时按
      // 端点比对裁掉；反查不到则原样透出（宁可给全量，也好过误报 0 条）。
      const all: Record<string, unknown>[] = env.rows.map((row) => ({
        rank: 0,
        relation_name: String(row.relation_name ?? ''),
        relation_description: String(row.relation_description ?? ''),
        leftModelName: String(row.leftModelName ?? ''),
        rightModelName: String(row.rightModelName ?? ''),
        direct: alias === null
          ? '无法判定'
          : String(row.leftModelName ?? '') === alias || String(row.rightModelName ?? '') === alias
            ? '是'
            : '否',
      }))
      const relevant = alias === null ? all : all.filter((r) => r.direct === '是')
      const dropped = all.length - relevant.length
      const capped = relevant.slice(0, relationCap)
      const complete = capped.length >= relevant.length
      const data: Record<string, unknown>[] = capped.map((row, i) => ({ ...row, rank: i + 1 }))
      if (data.length === 0) {
        data.push({
          rank: 0,
          relation_name: '',
          relation_description: all.length === 0
            ? `模型「${modelName}」（${classPath}）没有已定义的模型关系（返回 0 行）。请直接说明，不要编造关系。`
            : `模型「${modelName}」（${classPath}）没有直接关系：服务端返回的 ${all.length} 条关系中没有一条以该模型为端点（返回的其实是全局关系清单，服务端未按 modelName 过滤）。请如实说明，不要编造关系。`,
          leftModelName: '',
          rightModelName: '',
          direct: '',
        })
      } else {
        data.push(renderHintRow(modelName, data.length, dropped, alias !== null))
      }

      const apiOrSql = `GET ${metaBase}/getRelationsByModel?modelName=${classPath} → 返回 ${env.rows.length} 条，`
        + (alias === null
          ? `无法按端点过滤，原样透出 ${data.length} 条`
          : `其中 ${data.length} 条与「${alias}」直接相关${dropped > 0 ? `，已剔除 ${dropped} 条无关关系（服务端未按 modelName 过滤）` : ''}`)
      const result = ok(modelRelationGraphTool.name, {
        apiOrSql,
        params: args,
        fields: FIELDS,
        data,
        executionMs: Date.now() - started,
        // total 报过滤后的相关条数：模型可见面的真实总量就是这些。服务端原始
        // 行数（含无关尾巴）记在 apiOrSql 里，不进 total——否则 complete 判定
        // 会因为"被剔除的行"而永远为 false。
        total: relevant.length,
        complete,
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

