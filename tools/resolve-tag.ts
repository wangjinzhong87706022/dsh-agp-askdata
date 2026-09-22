/**
 * `resolve_tag`（P1, metadata）：中文设备名 + 中文测点名 → tagName + tagIndex（§14.3）。
 *
 * 5 步链路：
 *   step1 MySQL  wt_elm_equipment     → deviceId + class__path
 *   step2 MySQL  meta_classtagmodel   → tagCode
 *   step3 JS     拼接                  → tagName = `${tagCode}_${granularity}_${deviceId}`
 *   step4 MySQL  wt_iot_tags          → alias（确认 tagName 已注册）
 *   step5 SR     WT_TAG               → tagIndex
 * @module
 */

import { runSqlTool, toNumber, type AskdataTool, type SqlPlan, type ToolContext } from './types.ts'
import {
  resolveTagStep1Sql,
  resolveTagStep2Sql,
  resolveTagStep4Sql,
  resolveTagStep5Sql,
} from '../src/sql/templates.ts'
import { validateFilterText, validateGranularity } from '../src/sql/validate.ts'
import { assertSafeToExecute } from '../src/sql/whitelist.ts'
import { askdataError } from '../src/errors.ts'
import { slugName } from '../src/clients/ragflow.ts'

/** resolve_tag 工具定义。 */
export const resolveTagTool: AskdataTool = {
  name: 'resolve_tag',
  description:
    '将中文设备名+中文测点名解析为 tagName+tagIndex。5 步链路：查设备→查测点编码→拼 tagName→验注册→查 tagIndex。用户用中文描述测点（如"1号逆变器直流电压"）时必须先调用本工具。设备名未命中时自动查知识图谱（实体别名）归一化后重试一次。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      device_name: { type: 'string', description: '设备中文名（如"1号逆变器"）' },
      tag_name_cn: { type: 'string', description: '测点中文名（如"直流电压"）' },
      granularity: {
        type: 'string',
        enum: ['1O', '2O', '1H', '1D', '1M', '1Y'],
        description: '粒度段：1O/2O=原始，1H/1D/1M/1Y=聚合',
      },
    },
    required: ['device_name', 'tag_name_cn', 'granularity'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(resolveTagTool, args, ctx, async (): Promise<SqlPlan> => {
      const deviceName = validateFilterText(String(args.device_name ?? ''), 'device_name')
      const tagNameCn = validateFilterText(String(args.tag_name_cn ?? ''), 'tag_name_cn')
      const granularity = validateGranularity(args.granularity)
      if (!granularity) throw askdataError('INVALID_PARAM', 'granularity 必填')

      const mysqlWl = ctx.config.security.mysqlTableWhitelist

      // step1: 查设备 id + class__path（未命中时经知识图谱别名归一化重试一次）
      const lookupDevice = async (name: string) => {
        const sql = resolveTagStep1Sql(ctx.config, name, ctx.config.appId)
        assertSafeToExecute(sql, mysqlWl)
        return ctx.mysqlExecutor.execute(sql, { signal: ctx.signal })
      }
      let step1 = await lookupDevice(deviceName)
      if (step1.rows.length === 0) {
        const aliasCandidates = await knowledgeAliasCandidates(ctx, deviceName)
        for (const candidate of aliasCandidates) {
          if (candidate === deviceName) continue
          step1 = await lookupDevice(candidate)
          if (step1.rows.length > 0) {
            ctx.log?.(`resolve_tag: 设备名经知识图谱归一化 ${deviceName} → ${candidate}`)
            break
          }
        }
      }
      if (step1.rows.length === 0) {
        throw askdataError('OBJECT_NOT_FOUND', `设备未找到: ${deviceName}`)
      }
      const deviceId = toNumber(step1.rows[0]!.id)
      const classPath = step1.rows[0]!.class__path
      if (deviceId === null) throw askdataError('OBJECT_NOT_FOUND', `设备 id 为空: ${deviceName}`)

      // step2: 查 tagCode
      const step2Sql = resolveTagStep2Sql(ctx.config, tagNameCn, classPath ?? '')
      assertSafeToExecute(step2Sql, mysqlWl)
      const step2 = await ctx.mysqlExecutor.execute(step2Sql, { signal: ctx.signal })
      if (step2.rows.length === 0) {
        throw askdataError(
          'TAG_DEFINITION_NOT_FOUND',
          `测点中文名未找到: ${tagNameCn} (class_path=${classPath})`,
        )
      }
      const tagCode = step2.rows[0]!.tag_code

      // step3: 拼 tagName（真实格式 tagCode_粒度_deviceId，如 HWNBYC174_1O_100620000015521；
      // 2026-09-09 WT_TAG 实测样例 HWNBYC174_1D_100620000015524 与 §14.3 规格一致）
      const tagName = `${tagCode}_${granularity}_${deviceId}`

      // step4: 确认 tagName 已在 wt_iot_tags 注册 + 取 alias
      const step4Sql = resolveTagStep4Sql(ctx.config, tagName)
      assertSafeToExecute(step4Sql, mysqlWl)
      const step4 = await ctx.mysqlExecutor.execute(step4Sql, { signal: ctx.signal })
      if (step4.rows.length === 0) {
        throw askdataError('TAG_NOT_REGISTERED', `tagName 未在 wt_iot_tags 注册: ${tagName}`)
      }
      const alias = step4.rows[0]!.alias

      // step5: 查 tagIndex（StarRocks WT_TAG）
      const step5Sql = resolveTagStep5Sql(ctx.config, tagName)
      return {
        sql: step5Sql,
        params: {
          device_name: deviceName,
          tag_name_cn: tagNameCn,
          granularity,
          resolved_tag_name: tagName,
          device_id: deviceId,
          tag_code: tagCode,
          alias,
        },
        fields: [
          { name: 'tagName', title: '测点全名', type: 'string' },
          { name: 'tagIndex', title: '测点索引', type: 'number' },
          { name: 'deviceId', title: '设备ID', type: 'number' },
          { name: 'tagCode', title: '测点编码', type: 'string' },
          { name: 'alias', title: '别名', type: 'string' },
        ],
        shape: (rows) => {
          if (rows.length === 0) {
            throw askdataError('TAG_NOT_FOUND', `tagName 不在 WT_TAG 中: ${tagName}`)
          }
          return [
            {
              tagName,
              tagIndex: toNumber(rows[0]!.tagIndex),
              deviceId,
              tagCode,
              alias,
            },
          ]
        },
      }
    })
  },
}

/**
 * 知识图谱别名归一化：设备名未命中设备表时，查 RAGFlow 实体子图拿标准名与别名
 * 作为重试候选（ragflow-import 的 DomainKnowledgeDict 在服务端的同构能力）。
 *
 * 知识面不可用/超时/无命中都返回空数组——归一化是增强不是依赖，失败不影响
 * resolve_tag 原有错误语义（仍报 OBJECT_NOT_FOUND）。
 */
async function knowledgeAliasCandidates(ctx: ToolContext, deviceName: string): Promise<string[]> {
  if (!ctx.knowledge) return []
  try {
    const sub = await ctx.knowledge.subgraph({ node: deviceName, topN: 8, signal: ctx.signal })
    const names: string[] = []
    for (const entity of sub.entities) {
      const name = slugName(entity.slug)
      if (name && name !== deviceName) names.push(name)
      for (const alias of entity.aliases) {
        if (alias && alias !== deviceName) names.push(alias)
      }
    }
    // 去重保序；标准名（与输入不同的实体名）优先于别名
    return [...new Set(names)].slice(0, 6)
  } catch {
    return []
  }
}