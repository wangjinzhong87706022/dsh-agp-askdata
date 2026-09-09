/**
 * tagName 四段式编码（《工具实现规范》§1.3.1）。
 *
 * tagName = [前缀]_tagCode_粒度段_device；粒度段首位 = 点类型（1 模拟量 / 2 状态量），
 * 末位 = 粒度（O/H/D/M/Y）。StarRocks `split(tagName,'_')` 为 1 基下标：
 * `[1]`=tagCode、`[3]`=device——生成 SQL 禁止 0 基。
 * @module
 */

import { askdataError } from '../errors.ts'
import type { Granularity } from './validate.ts'

/** tagName 解析结果（JS 侧 0 基数组，仅用于解释；SQL 侧恒用 1 基 split）。 */
export interface TagNameParts {
  tagCode: string
  granularity: string
  device: string
  /** 粒度段首位：1=模拟量，2=状态量；无法判定时为 undefined。 */
  pointType: 'analog' | 'digit' | undefined
  /** 粒度段末位：O/H/D/M/Y。 */
  granularityChar: string | undefined
}

/**
 * 解析 tagName 三/四段式。
 *
 * 生产实例存在 3 段（HWNBYC174_1O_DEV001：前缀_tagCode_粒度段 后接 device 合并段）
 * 与 4 段两种形态；按"最后一段=device、倒数第二段=粒度段"切分。
 */
export function parseTagName(tagName: string): TagNameParts {
  const segments = tagName.split('_')
  if (segments.length < 3) {
    throw askdataError('INVALID_PARAM', `tagName 不是合法的四段式编码: ${tagName}`)
  }
  const device = segments[segments.length - 1]!
  const granularitySeg = segments[segments.length - 2]!
  const tagCode = segments.slice(0, segments.length - 2).join('_')
  const pointType =
    granularitySeg.startsWith('1') ? 'analog' : granularitySeg.startsWith('2') ? 'digit' : undefined
  return {
    tagCode,
    granularity: granularitySeg,
    device,
    pointType,
    granularityChar: granularitySeg.slice(1) || undefined,
  }
}

/** 前缀 + 粒度 → 带定位锚 `^` 的 tagName 正则（《规范》：regexp 必须带 ^）。正则元字符转义保留字面语义。 */
export function buildTagRegexp(prefix: string, granularity?: Granularity): string {
  const safePrefix = prefix.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return granularity ? `^${safePrefix}_${granularity}_` : `^${safePrefix}_`
}

/** tag_filter 前缀解析结果：tagCode + 粒度段 +（可选）device 尾段。 */
export interface TagFilterParts {
  tagCode: string
  granularity: string
  /** 过滤串以 `_数字` 结尾且不含其他正则元字符时解析出的 device id。 */
  deviceId?: string
}

const GRANULARITY_CLASS = '[12][OHDMY]'

/**
 * 从 tag_filter 解析 `^tagCode_粒度_` 前缀（供 WT_CUBE 路由取 tagCode/device 等值过滤）。
 *
 * 只接受保守形态：`^` 锚定 + tagCode 段（字母数字下划线）+ 粒度段 +（可选）纯数字
 * device 尾段；含其他正则元字符（`.*(|` 等）返回 null，由调用方回退通用路径。
 */
export function parseTagFilterPrefix(tagFilter: string): TagFilterParts | null {
  const pinned = new RegExp(`^\\^([A-Za-z0-9_]+)_(${GRANULARITY_CLASS})_(\\d+)$`).exec(tagFilter)
  if (pinned) return { tagCode: pinned[1]!, granularity: pinned[2]!, deviceId: pinned[3] }
  const open = new RegExp(`^\\^([A-Za-z0-9_]+)_(${GRANULARITY_CLASS})_$`).exec(tagFilter)
  if (open) return { tagCode: open[1]!, granularity: open[2]! }
  return null
}

/** StarRocks 1 基 split 表达式：取 tagName 的第 n 段。 */
export function splitSegment(column: string, oneBasedIndex: 1 | 2 | 3): string {
  return `split(${column}, '_')[${oneBasedIndex}]`
}
