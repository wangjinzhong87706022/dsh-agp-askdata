/**
 * AskdataTool → DSH ToolDefinition 适配器。
 *
 * 运行时形状以 harness `packages/core/tools` 的 `ToolDefinition` 为准
 * （parameters/output.schema 为 JSON Schema，execute 抛错即失败，exec.signal
 * 携带取消信号）。不经由 `@deepseek-ai/dsh-tools` 的 `defineTool`：其 npm RC
 * 依赖链（dsh-type-meta）暂不可安装，且本项目的入参校验由 `sql/validate.ts`
 * 与各工具自行完成。dsh-tools 可安装后可替换为 defineTool 获得宿主级参数校验。
 * @module
 */

import type { AskdataTool, ToolContext } from '../../tools/index.ts'
import type { ToolResult } from '../result.ts'
import { askdataError } from '../errors.ts'

/** 模型/前端可见的文本块（结构对齐 harness ContentBlock 的 text 形态）。 */
export interface ContentBlock {
  type: 'text'
  text: string
}

/** DSH 工具注册表的本地结构视图（见模块注释）。 */
export interface AskdataToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  presentCall?(args: unknown): Record<string, unknown>
  presentResult?(args: unknown, result: unknown): Record<string, unknown>
  execute(args: unknown, exec: { signal?: AbortSignal }): Promise<unknown>
}

/** 工具成功返回的 canonical 值（对应 output.schema）。 */
export interface AskdataToolValue {
  success: boolean
  toolName: string
  apiOrSql: string
  fields: unknown[]
  data: unknown[]
  rowCount: number
  executionMs: number
  auditId: string
  /** 数据集总量（分页 itemTotal / 有界清单全量）；缺省 = 未声明。 */
  total?: number
  /** 完整性契约：true = data 即全量；缺省视为 true。 */
  complete?: boolean
}

/** parameters JSON Schema：type/object + properties + required（来自 ToolDefinition 契约）。 */
export function toParametersJsonSchema(input: Record<string, unknown>): Record<string, unknown> {
  const properties = (input.properties ?? {}) as Record<string, unknown>
  const required = (input.required as string[] | undefined) ?? []
  return {
    type: 'object',
    properties: structuredClone(properties),
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  }
}

/** 工具结果 → 模型/渲染文本（fields + 行预览 + 元信息）。
 *
 * 预览行数上限由工具自声明（`AskdataTool.previewLimit`，缺省 20）：有界元数据
 * 清单（meta 面）声明更大值——完整清单本身就是答案。total/complete 是完整性
 * 契约：模型据其判断拿到的是不是全部，决定收窄条件或聚合而不是盲目翻页。 */
export function renderAskdataResult(value: AskdataToolValue, previewLimit = 20): string {
  const head = [
    '```json',
    JSON.stringify(
      {
        toolName: value.toolName,
        rowCount: value.rowCount,
        ...(value.total !== undefined ? { total: value.total, complete: value.complete ?? value.rowCount >= value.total } : {}),
        executionMs: value.executionMs,
        auditId: value.auditId,
        fields: value.fields,
        data: value.data.slice(0, previewLimit),
        ...(value.data.length > previewLimit
          ? { truncatedPreview: `仅展示前 ${previewLimit} 行，共 ${value.total ?? value.rowCount} 行` }
          : {}),
      },
      null,
      2,
    ),
    '```',
  ]
  return head.join('\n')
}

/** 参数摘要（presentCall 标题用，一行以内）。 */
function summarizeArgs(args: unknown): string {
  const line = JSON.stringify(args) ?? '{}'
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

/**
 * 把框架无关的 AskdataTool 适配为 DSH 注册表可用的工具定义。
 *
 * @param tool - 框架无关工具（name/description/inputSchema/run）。
 * @param makeContext - 每次调用构造 ToolContext（宿主注入取消信号与审计链游标）。
 */
export function adaptAskdataTool(
  tool: AskdataTool,
  makeContext: (signal?: AbortSignal) => ToolContext,
): AskdataToolDefinition {
  const execute = async (args: unknown, exec: { signal?: AbortSignal }): Promise<unknown> => {
    const result = await tool.run((args ?? {}) as Record<string, unknown>, makeContext(exec?.signal))
    if (!result.success) {
      throw askdataError(result.errorCode || 'BACKEND_DOWN', `${tool.name} 失败: ${result.errorMessage}`)
    }
    return toValue(result)
  }
  const presentTitle = (args: unknown): string => `${tool.name} ${summarizeArgs(args)}`
  return {
    name: tool.name,
    description: tool.description,
    parameters: toParametersJsonSchema(tool.inputSchema),
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          toolName: { type: 'string' },
          apiOrSql: { type: 'string' },
          fields: { type: 'array', items: { type: 'object' } },
          data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          rowCount: { type: 'integer' },
          executionMs: { type: 'integer' },
          auditId: { type: 'string' },
          total: { type: 'integer' },
          complete: { type: 'boolean' },
        },
        required: ['success', 'toolName', 'apiOrSql', 'fields', 'data', 'rowCount', 'executionMs', 'auditId'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderAskdataResult(value as AskdataToolValue, tool.previewLimit ?? 20) }],
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'read',
      title: presentTitle(args),
      rawInput: JSON.stringify(args),
    }),
    presentResult: (args) => ({ card: 'generic', title: presentTitle(args) }),
    execute,
  } satisfies AskdataToolDefinition
}

/** ToolResult → canonical 值（剥掉 citations/errorMessage 等非模型面字段）。 */
function toValue(result: ToolResult): AskdataToolValue {
  return {
    success: result.success,
    toolName: result.toolName,
    apiOrSql: result.apiOrSql,
    fields: result.fields,
    data: result.data,
    rowCount: result.rowCount,
    executionMs: result.executionMs,
    auditId: result.auditId,
    ...(result.total !== undefined ? { total: result.total, complete: result.complete ?? true } : {}),
  }
}
