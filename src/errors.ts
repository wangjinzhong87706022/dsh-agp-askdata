/**
 * 错误码与错误类型，对齐《工具实现规范》§1.4。
 *
 * 每个错误码携带 LLM 应对提示（retryHint），由上层组织进 ToolResult.errorMessage。
 * @module
 */

/** 《工具实现规范》§1.4 定义的错误码全集。 */
export const ERROR_CODES = {
  INVALID_PARAM: '参数不合法（缺字段、类型错）',
  PERMISSION_DENIED: '字段/行级权限不足',
  SENSITIVE_TABLE: '命中敏感表白名单',
  DML_FORBIDDEN: '检测到 INSERT/UPDATE/DELETE/DDL',
  EXCEED_LIMIT: '时间跨度/扫描行数超阈值',
  BACKEND_DOWN: '后端不可达',
  WT_SQL_PARSE_ERROR: 'AGP 不接受该 WT-SQL',
  TAG_NOT_FOUND: 'tagName 不在 WT_TAG',
  OBJECT_NOT_FOUND: '设备/对象名未命中',
  TAG_DEFINITION_NOT_FOUND: '测点中文名未命中动态属性定义',
  TAG_NOT_REGISTERED: 'tagName 未在 wt_iot_tags 注册',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** 每个 P0 错误码对应的 LLM 处置提示。 */
const RETRY_HINTS: Partial<Record<ErrorCode, string>> = {
  INVALID_PARAM: '重试，修正参数',
  PERMISSION_DENIED: '用其他字段重试或放弃',
  SENSITIVE_TABLE: '改用授权数据源重试',
  DML_FORBIDDEN: '拒绝，本系统强制只读',
  EXCEED_LIMIT: '缩小时间范围或加大聚合粒度后重试',
  BACKEND_DOWN: '报错，等用户确认后端后重试',
  WT_SQL_PARSE_ERROR: '简化查询特性后重试',
  TAG_NOT_FOUND: '先用 lookup_tag 查出正确 tagName 再重试',
  OBJECT_NOT_FOUND: '先用 lookup_object 查出正确设备名再重试',
  TAG_DEFINITION_NOT_FOUND: '先用 lookup_tag_definition 查出正确测点中文名再重试',
  TAG_NOT_REGISTERED: 'tagName 未在 wt_iot_tags 注册，检查粒度后缀或设备 id',
}

/** 取错误码对应的 LLM 处置提示。 */
export function retryHint(code: ErrorCode): string {
  return RETRY_HINTS[code] ?? ''
}

/** 携带规范错误码的工具错误。 */
export class AskdataError extends Error {
  readonly code: ErrorCode
  readonly retryHint: string

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'AskdataError'
    this.code = code
    this.retryHint = RETRY_HINTS[code] ?? ''
  }
}

/** 抛出规范错误的便捷工厂。 */
export function askdataError(code: ErrorCode, message: string): AskdataError {
  return new AskdataError(code, message)
}
