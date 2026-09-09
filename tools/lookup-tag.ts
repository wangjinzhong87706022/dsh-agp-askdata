/**
 * `lookup_tag`（P0, metadata）：查 WT_TAG 测点字典，反查业务名 ↔ tagName（§2.3）。
 * @module
 */

import { runSqlTool, toNumber, type AskdataTool, type ToolContext } from './types.ts'
import { lookupTagSql } from '../src/sql/templates.ts'
import {
  validateDataType,
  validateFilterText,
  validateGranularity,
  validateLimit,
} from '../src/sql/validate.ts'
import { askdataError } from '../src/errors.ts'

/** lookup_tag 工具定义。 */
export const lookupTagTool: AskdataTool = {
  name: 'lookup_tag',
  description:
    '查询时序点位字典 WT_TAG，反查业务名↔tagName 映射。用户提到具体测点/测量值但没有 tagName 时必须先调用本工具。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '点位名/中文名/注释关键字' },
      data_type: { type: 'integer', enum: [0, 1, 2, 6], description: '0=整型/1=单精度/2=双精度/6=字符串' },
      granularity: {
        type: 'string',
        enum: ['1O', '2O', '1H', '1D', '1M', '1Y'],
        description: '粒度段：1O/2O=原始模拟量/状态量，1H/1D/1M/1Y=小时/天/月/年派生',
      },
      limit: { type: 'integer', description: '返回条数上限，默认 100' },
    },
    required: ['keyword'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(lookupTagTool, args, ctx, async () => {
      const keyword = validateFilterText(String(args.keyword ?? ''), 'keyword')
      if (keyword.trim() === '') throw askdataError('INVALID_PARAM', 'keyword 必填')
      const dataType = validateDataType(args.data_type)
      const granularity = validateGranularity(args.granularity)
      const limit = validateLimit(args.limit, ctx.config.system, ctx.config.system.defaultLookupLimit)
      const sql = lookupTagSql(ctx.config, { keyword, dataType, granularity, limit })
      return {
        sql,
        params: { keyword, data_type: dataType, granularity, limit },
        fields: [
          { name: 'tagName', title: '测点全名', type: 'string' },
          { name: 'tagIndex', title: '测点索引', type: 'number' },
          { name: 'dataType', title: '数据类型', type: 'number' },
          { name: 'comment', title: '中文描述', type: 'string' },
        ],
        shape: (rows) =>
          rows.map((r) => ({
            tagName: r.tagName,
            tagIndex: toNumber(r.tagIndex),
            dataType: toNumber(r.dataType),
            comment: r.comment,
          })),
      }
    })
  },
}
