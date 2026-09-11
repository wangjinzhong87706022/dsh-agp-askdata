/**
 * `object_tags`（20260911 新增, metadata）：查询一个实体对象的测点列表 + 实时值
 * （getObjetTags——官方拼写如此，勿改，接口文档 §3.6）。
 *
 * ⚠ 网关实测限制：服务端生成 SQL 要求模型数据表含 `内部编码` 列（实体模型
 * 标准属性）。对不含该列的测点类模型（如模拟量模型）会报
 * `Unknown column '内部编码'`——本工具仅对实体对象模型可用（AGP 侧为水泵等
 * 实体建模后开放）。whereStr 命中多个对象时服务端取第一个。
 * @module
 */

import { describeQueryResult, runApiTool, toString, validatePositiveInt, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** object_tags 工具定义。 */
export const objectTagsTool: AskdataApiTool = {
  name: 'object_tags',
  description:
    '查询一个实体对象（如某台水泵）的全部测点及实时值——设备实时状态类问题的首选，一次调用即可返回对象全部测点含实时值。where_str 的属性名必须用中文列名（如 "名称 = \'第一台水泵\'" 或 "名称 like \'%第二台%\'"），英文列名会报 Unknown column；命中多个对象时返回第一个。仅实体对象模型（含「内部编码」列，如水泵模型）可用。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: { type: 'string', description: '实体对象模型名称（从 list_models 获取）' },
      where_str: { type: 'string', description: "定位对象的条件，如 \"名称 = '第一台水泵'\"" },
      page_num: { type: 'integer', description: '页码，默认 1' },
      page_size: { type: 'integer', description: '每页条数，默认 100，最大 1000' },
    },
    required: ['model_name', 'where_str'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(objectTagsTool, args, ctx, async () => {
      const modelName = String(args.model_name ?? '').trim()
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填')
      const whereStr = String(args.where_str ?? '').trim()
      if (whereStr === '') throw askdataError('INVALID_PARAM', 'where_str 必填（网关要求必传）')
      // where_str 为 MySQL 风格条件（字符串值带单引号是文档规定的语法，如 名称='第一台水泵'）；
      // 注入风险按 §18.4 决策暂缓——信任边界在网关侧净化
      const pageSize = Math.min(
        validatePositiveInt(args.page_size ?? 100, 'page_size'),
        ctx.config.api.maxPageSize,
      )
      const pageNum = validatePositiveInt(args.page_num ?? 1, 'page_num')
      return {
        request: {
          path: '/wz/iot-etl/iot/getObjetTags',
          params: { modelName, whereStr, pageNum, pageSize },
        },
        describe: describeQueryResult,
      }
    })
  },
}
