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
  { name: 'level', title: '层级', type: 'number' },
  { name: 'relation_description', title: '关系名称', type: 'string' },
  { name: 'source_model', title: '发起模型', type: 'string' },
  { name: 'target_model', title: '对端模型', type: 'string' },
]

/**
 * 关系内部名的结构：`outterLink_[A]_[B]` / `subLink_[A]_[key]_[B]_[fk]`。
 * 首个方括号段 A 是**主体**（关系的发起方），B 是对端；subLink 中间的
 * `[key]` 段是连接键（node_code / app_id / canshubianmab0a1 之类），
 * 不是模型，必须跳过。
 */
const RELATION_SEGMENT_RE = /\[([A-Za-z0-9_]+)\]/g

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

/**
 * SQL 字面量白名单：`class_alias` 值只允许建模命名的实际字符，`class_path`
 * 值只允许内部名的字母/数字/下划线。两者都不含引号/反斜杠/`%`/`_` 通配之外的
 * 元字符，故 `''` 倍增无从构造——这是白名单而非转义的理由。
 */
const CLASS_ALIAS_VALUE_RE = /^[\p{Script=Han}a-zA-Z0-9 _·\-()（）,.]{1,64}$/u
const CLASS_PATH_VALUE_RE = /^[A-Za-z0-9_]{1,64}$/

/** 按 `column=value` 查 meta_class_info（queryByGenericSql）。值在此处过白名单。 */
async function queryClassInfo(
  ctx: ToolContext,
  metaBase: string,
  column: 'class_alias' | 'class_path',
  value: string,
  urlLog: string[],
): Promise<ClassRow[]> {
  const ok = column === 'class_path' ? CLASS_PATH_VALUE_RE.test(value) : CLASS_ALIAS_VALUE_RE.test(value)
  if (!ok) {
    throw askdataError('INVALID_PARAM', `meta_class_info 查询值含非法字符：${value.slice(0, 40)}`)
  }
  return queryClassInfoRaw(
    ctx, metaBase,
    `select class_alias, class_name, class_path from meta_class_info where ${column}='${value}'`,
    urlLog,
  )
}

/**
 * 自由 SQL 的 queryByGenericSql 调用。
 *
 * **调用方负责在拼接前逐值过白名单**（见 queryClassInfo / resolveAliases）——
 * 不在这里对成品 SQL 做字符过滤：那既不可靠（正则剥关键词会误伤合法值），
 * 也给不了"哪个值有问题"的信息。
 */
async function queryClassInfoRaw(
  ctx: ToolContext,
  metaBase: string,
  sql: string,
  urlLog: string[],
): Promise<ClassRow[]> {
  const cred = resolveAgpCredentials(ctx.config.query.rest, ctx.config.appId)
  const url = `${metaBase}/model/queryByGenericSql`
  urlLog.push(`${url} (${sql.slice(0, 120)})`)
  const impl = ctx.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(ctx.config.system.queryTimeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
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
      body: JSON.stringify({ sql, dataMaps: {}, pageNum: 1, pageSize: 100 }),
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

/**
 * 关系内部名 → 主体与候选对端。
 *
 * **为什么不用服务端返回的 leftModelName/rightModelName**：那对端点的顺序
 * 随查询模型漂移——同一条 `subLink_[wt_elm_equipment]_..` 在查设备基础模型时
 * 回 `[设备基础模型 → 设备参数列模型]`，在查设备参数列模型时回
 * `[设备参数列模型 → 设备基础模型]`；且同一批数据里也有与 `relation_name`
 * 编码方向相反的（实测 16 条中 4 条）。只有 `relation_name` 稳定。
 *
 * **主体恒为首段**：`outterLink_[A]_[B]` 与 `subLink_[A]_[key]_[B]_[fk]`
 * 的 A 都是发起方。
 *
 * 对端**不能按位置猜**——subLink 的第 2 段是连接键（node_code /
 * canshubianmab0a1）、末段是外键名（code / name），都不是模型。故这里只给出
 * 候选段，由调用方拿 `resolveAliases` 验证过的 class_path 集合来挑真正的对端；
 * 挑不出就整条丢弃（宁可少画一条，也不用可能反了方向的边）。
 */
export function parseRelationName(relationName: unknown): { source: string; peers: string[] } | null {
  if (typeof relationName !== 'string') return null
  const segments = [...relationName.matchAll(RELATION_SEGMENT_RE)].map((m) => m[1]!)
  if (segments.length < 2) return null
  return { source: segments[0]!, peers: segments.slice(1) }
}

/** 从候选段里挑出真正登记在册的对端 class_path（首个命中）。 */
export function resolvePeer(peers: string[], knownPaths: { has: (k: string) => boolean }): string | null {
  for (const p of peers) {
    if (knownPaths.has(p)) return p
  }
  return null
}

/**
 * 判断是不是"该模型没有出边"的服务端业务错误。
 *
 * 服务端把叶子模型表达成 `code=-1 / 错误:没有找到模型<<X>>的定义！`（实测
 * wt_egy_energy、wt_10462_shuibengmoxing 均如此），而不是回一个空列表。
 * 展开多层时这是常态，一个叶子不该让整张图失败。
 */
function isNoRelationError(err: unknown): boolean {
  if (!(err instanceof AskdataError)) return false
  return /没有找到模型.*的定义/.test(err.message)
}

/** 一批 class_path → 中文名（一次 IN 查询，不逐个往返）。 */async function resolveAliases(
  ctx: ToolContext,
  metaBase: string,
  classPaths: string[],
  urlLog: string[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(classPaths)]
  const out = new Map<string, string>()
  // 逐值过白名单后再拼 IN 列表：入参来自服务端 relation_name 的方括号段，
  // 属不可信输入，放任引号即可击穿 SQL 字面量。非法值直接剔除（它本来也
  // 不可能是 class_path——没通过白名单就不是登记模型）。
  const safe = uniq.filter((p) => CLASS_PATH_VALUE_RE.test(p))
  // 单次 IN 的段数上限：超长 SQL 会被网关截断，分批查。
  for (let i = 0; i < safe.length; i += 100) {
    const batch = safe.slice(i, i + 100)
    if (batch.length === 0) continue
    const list = batch.map((p) => `'${p}'`).join(',')
    const rows = await queryClassInfoRaw(
      ctx, metaBase,
      `select class_alias, class_path from meta_class_info where class_path in (${list})`,
      urlLog,
    )
    for (const row of rows) {
      const path = row.class_path
      const alias = row.class_alias
      if (typeof path === 'string' && path !== '' && typeof alias === 'string' && alias !== '') {
        out.set(path, alias)
      }
    }
  }
  return out
}
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
 * **关系是边，不是节点**：图用 `preset:'graph'`，节点=模型、边=关系（关系名挂
 * 在边的 label 上）。早前用 tree 把关系名当第二层节点，语义就错了——关系是模型
 * 之间的连接，把它冒充成模型会让"关系名"变成可下钻的模型名。
 *
 * 单击下钻：节点折叠已在客户端关闭（`expandAndCollapse:false`），单击全部让位
 * 给下钻。曾试过双击，但 ECharts 树图单击会 toggle 子树并触发重绘，第二次点击
 * 落在重绘后的新位置上，dblclick 序列判定失败——双击永远不触发。
 */
function renderHintRow(
  modelName: string,
  relationCount: number,
  depthReached: number,
  fanoutCap: number | null,
): Record<string, unknown> {
  // 提示行的措辞底线：这里的一切都可能被模型原样搬进用户可见的回答，
  // 只允许「画图规则」与「给用户的交代」，不允许实现叙述（谁过滤了什么、
  // 哪个配置项限流——那是 apiOrSql/审计面的事）。
  const dataRule =
    `data/links 构造规则（每行一条关系，**关系是边不是节点**）：\n` +
    `① data 里放全部出现过的模型（去重）：data:[{"label":"模型名"}]；\n` +
    `② links 每行一条边：{"from":发起模型,"to":对端模型,"label":关系名称}，` +
    `from/to 必须与 data 里的 label 逐字一致（发起方在 from，箭头方向即关系方向）；\n` +
    `③ 同一对起终点有多条关系时，各自成一条边（关系名不同，label 不同）；\n` +
    `④ 所查模型固定放 data 第一位（它是布局的根，图按层级向右展开，树状阅读）。\n` +
    `本次共 ${relationCount} 条关系，已展开到第 ${depthReached} 层。` +
    `\n图只基于上方数据绘制，不要自行补充、推断或反向任何关系。` +
    (fanoutCap !== null
      ? `\n图面只展开了关联最多的 ${fanoutCap} 个深层分支，并非全部关系；用户想看未展开的分支时，可下钻对应的对端模型。`
      : '')

  const drillProtocol =
    `单击图上任意节点会向你发 [genui-action] "下钻模型：X"，用户打字"下钻 X"同义。下钻响应协议：\n` +
    `[1] 幂等检查——若本次会话里 X 已经查过（上一条回答展开过 X），只回复一句"「X」上一条已展开"，` +
    `不调用工具、不输出围栏。\n` +
    `[2] 否则调用本工具查 X 的关系，只输出以下 patch 围栏——**就地展开为本次回答里的一棵独立子树图**，` +
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
    level: 0,
    relation_description: '【关系图渲染指引】',
    source_model: '',
    target_model: '',
    hint:
      `请套用以下 dsh-ui 围栏模板输出关系图（结构逐字保留，data/links 里的示例模型按上方真实关系替换；` +
      `配色、箭头、边标签与单击下钻全部内置，不要自己补 option 或样式字段）：\n` +
      '```dsh-ui\n' +
      `{"type":"echart","preset":"graph","title":"${modelName} · 关系图谱（${relationCount} 条关系）","height":560,` +
      `"graphLayout":"hierarchy","drill":{"key":"${modelName}"},` +
      `"data":[{"label":"${modelName}"},{"label":"对端模型1"},{"label":"对端模型2"}],` +
      `"links":[{"from":"${modelName}","to":"对端模型1","label":"关系A"},` +
      `{"from":"对端模型1","to":"对端模型2","label":"关系B"}]}\n` +
      '```\n' +
      `${dataRule}\n` +
      `${drillProtocol}` +
      `文字回复概述关系数量、涉及模型数与各层分布。`,
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
    '查询一个模型的关系图谱：返回由该模型发起的模型关系清单（发起模型、对端模型、关系名称），'
    + '并逐层展开对端模型，按指引以 dsh-ui graph 关系图渲染（节点=模型，边=关系，边上带关系名）。'
    + '输入中文模型名（如 水泵模型、企业职工模型；也接受内部编码形态）。'
    + '数据来自 AGP 数据底座 meta 接口，只读。查模型的字段构成（属性清单）用 model_field_list。',
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

      // 1. 入参 → (class_path, 中文名)。判定顺序不能只看有没有 "/":真实
      //    class_path 常是 `wt_elm_equipment` 这种单段无斜杠形态。先按
      //    class_alias 查，未命中再按 class_path 查。alias 为 null 表示反查不到
      //    中文名（无法命名节点），调用方退化为只画首层、不展开。
      const resolved = await resolveModelRef(ctx, metaBase, modelName, urlLog)
      const classPath = resolved.classPath

      // 2. 服务端已知缺陷（2026-09-28 实测）：getRelationsByModel 完全忽略
      //    modelName——设备基础模型与建筑基础模型的返回集交集 49/49；且返回的
      //    leftModelName/rightModelName 方向随查询模型漂移（同一条关系两次查询
      //    方向相反）。所以：方向一律从 relation_name 解析，只保留"本模型是
      //    主体"的关系（读法 A），入边与无关尾巴全部剔除。
      // 3. 逐层展开：每层对上一层的对端再查一次，取其自身发出的关系。
      const { relationCap, relationDepth, relationFanout } = ctx.config.query.meta
      const cap = Math.min(relationCap, RELATION_PREVIEW_LIMIT - 1)

      interface Edge { level: number; name: string; desc: string; src: string; dst: string }
      const edges: Edge[] = []
      const seenPairs = new Set<string>()
      const expanded = new Set<string>([classPath])
      // class_path → 中文名；随展开逐步累积（每层一次批量 IN 查询补齐）
      const aliases = new Map<string, string>()
      if (resolved.alias !== null) aliases.set(classPath, resolved.alias)
      // 首层里"引用了所查模型"的关系（对端=所查模型、发起方是别的模型）——
      // 模型没有发起关系时，这是给用户的有用交代（谁在引用它）
      const referencedBy: Array<{ src: string; desc: string }> = []
      let fetched = 0
      let leaves = 0
      let fanoutLimited = false
      let frontier: Array<{ path: string; depth: number }> = [{ path: classPath, depth: 1 }]

      while (frontier.length > 0 && edges.length < cap) {
        const next: Array<{ path: string; depth: number }> = []
        for (const node of frontier) {
          if (edges.length >= cap) break
          // 命名不了的节点不画（画出来是内部名，对用户无意义）
          if (!aliases.has(node.path)) continue
          fetched++
          let rows: Record<string, unknown>[]
          try {
            const text = await agpGet(
              ctx, metaBase,
              `/getRelationsByModel?modelName=${encodeURIComponent(node.path)}`,
            )
            rows = parseAgpEnvelope(text).rows
          } catch (err) {
            // 展开层级的对端"没有出边"是**正常情况**（叶子模型），但服务端
            // 用业务错误表达它：实测 wt_egy_energy / wt_10462_shuibengmoxing 都回
            // code=-1「没有找到模型…的定义」而不是空列表。展开时把它降级为
            // "该节点没有出边"并计数——一个叶子不该让整张图失败。首层仍照常
            // 抛错（那才是真的查不成）。
            if (node.depth > 1 && isNoRelationError(err)) { leaves++; continue }
            throw err
          }
          // 先把本批所有候选段批量解析成"已知模型"集合，才能判定哪些段是真对端
          // （subLink 的连接键段/外键名段也在方括号里，位置猜不得）。
          // 发起方段也一并解析：首层"被引用"统计要用它的中文名。
          const candidates = new Set<string>()
          const parsed: Array<{ source: string; peers: string[]; name: string; desc: string }> = []
          for (const row of rows) {
            const p = parseRelationName(row.relation_name)
            if (p === null) continue
            parsed.push({ ...p, name: String(row.relation_name ?? ''), desc: String(row.relation_description ?? '') })
            for (const c of p.peers) candidates.add(c)
            candidates.add(p.source)
          }
          const missing = [...candidates].filter((c) => !aliases.has(c))
          if (missing.length > 0) {
            const found = await resolveAliases(ctx, metaBase, missing, urlLog)
            for (const [k, v] of found) aliases.set(k, v)
          }
          for (const p of parsed) {
            if (edges.length >= cap) break
            const target = resolvePeer(p.peers, aliases)
            // 不是本节点发起的关系：若对端恰是所查模型（仅首层），记为"被引用"，
            // 供零关系时交代；其余与图无关，跳过。
            if (p.source !== node.path) {
              if (node.depth === 1 && target === node.path) {
                referencedBy.push({ src: p.source, desc: p.desc })
              }
              continue
            }
            // 挑不出真对端（候选段都不是登记模型）→ 跳过，不猜方向
            if (target === null) continue
            const key = `${p.source}->${target}:${p.name}`
            if (seenPairs.has(key)) continue
            seenPairs.add(key)
            edges.push({ level: node.depth, name: p.name, desc: p.desc, src: p.source, dst: target })
          }
          // 下一层候选：本节点的对端（去重 + 不重复展开）
          if (node.depth < relationDepth) {
            for (const e of edges) {
              if (e.src !== node.path) continue
              if (expanded.has(e.dst)) continue
              expanded.add(e.dst)
              next.push({ path: e.dst, depth: node.depth + 1 })
            }
          }
        }
        if (next.length === 0) break
        // 最深层限流：按出边数（度数）取前 N 个继续展开
        if (next.length > relationFanout) {
          fanoutLimited = true
          const degree = new Map<string, number>()
          for (const e of edges) degree.set(e.src, (degree.get(e.src) ?? 0) + 1)
          next.sort((a, b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0))
          next.length = relationFanout
        }
        frontier = next
      }

      // 节点名 = 中文名；解析不出中文名的（aliases 里没有）退回内部名，
      // 至少图还能看，且不静默丢边。
      const nodeAliases = aliases
      const rootAlias = nodeAliases.get(classPath) ?? resolved.alias ?? modelName
      const complete = edges.length < cap
      const depthReached = edges.reduce((m, e) => Math.max(m, e.level), 0)
      const data: Record<string, unknown>[] = edges.map((e, i) => ({
        rank: i + 1,
        level: e.level,
        relation_description: e.desc,
        source_model: nodeAliases.get(e.src) ?? e.src,
        target_model: nodeAliases.get(e.dst) ?? e.dst,
      }))

      if (data.length === 0) {
        // 零关系说明要经模型转述给用户，只能写结论与建议，不能带实现叙述
        // （"剔除/入边/服务端缺陷"这类词模型会原样搬进回答）。
        const referrers = [...new Set(referencedBy.map((r) => nodeAliases.get(r.src) ?? r.src))]
        const shown = referrers.slice(0, 5)
        const refNote = shown.length > 0
          ? `它在 ${referencedBy.length} 条关系中被引用为对端（发起方：${shown.join('、')}${referrers.length > shown.length ? ' 等' : ''}）。`
            + `想查看这类关联，可查询对应发起方模型的关系图谱。`
          : ''
        data.push({
          rank: 0, level: 0,
          relation_description: `「${rootAlias}」没有由它发起的模型关系。${refNote}请如实说明，不要编造关系。`,
          source_model: '', target_model: '',
        })
      } else {
        data.push(renderHintRow(rootAlias, data.length, depthReached, fanoutLimited ? relationFanout : null))
      }

      const apiOrSql = `关系图谱（getRelationsByModel ×${fetched} 次）：`
        + `由「${rootAlias}」发起的关系 ${edges.length} 条，展开至第 ${depthReached} 层`
        + (referencedBy.length > 0 ? `；另有 ${referencedBy.length} 条关系引用了它（未画入图）` : '')
        + (leaves > 0 ? `；${leaves} 个对端模型没有向外的关系` : '')
        + (fanoutLimited ? `；深层仅展开 ${relationFanout} 个分支` : '')
      const result = ok(modelRelationGraphTool.name, {
        apiOrSql,
        params: args,
        fields: FIELDS,
        data,
        executionMs: Date.now() - started,
        // total 报画进图里的关系条数（不含渲染指引行）。complete 只反映
        // relationCap 截断——被剔除的入边/尾巴不算"没取全"，它们本来就不该画。
        total: edges.length,
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

