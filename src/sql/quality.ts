/**
 * 质量位处理（《工具实现规范》§1.3）。
 *
 * 生产 SQL 统一三件套之一：`bitand(quality, :badValueMask) != :badValueMask`，
 * 默认掩码 128 剔除 BAD 值；解码函数面向答案解释（手抄 vs 计算、是否告警）。
 * @module
 */

/** 生成质量过滤谓词（列名由模板给定，默认 wt_data.quality）。 */
export function qualityFilter(column: string, badValueMask: number): string {
  return `bitand(${column}, ${badValueMask}) != ${badValueMask}`
}

/**
 * 低字节 OriginalStatus 位标志（厂商手册 V2.2）。
 *
 * 手册按 "4 nibble" 描述，但 BAD=128 等标志实际位于低字节高位；
 * 操作性掩码以生产三件套 `bitand(quality,128)!=128` 为准。
 * 256/512/1024（DIVBYZERO/REMOVED/DISABLED）与 DataSrc 半字节掩码重叠，此处不参与解码。
 */
const ORIGINAL_STATUS: Record<number, string> = {
  0: 'GOOD',
  1: 'NODATA',
  2: 'CREATED',
  4: 'SHUTDOWN',
  8: 'CALCOFF',
  128: 'BAD',
}

/** 次 4 位 DataSrc。 */
const DATA_SRC: Record<number, string> = {
  0: 'RAWDATA',
  0x0200: 'HANDIN',
  0x0400: 'CALCULATED',
}

/** 高 4 位 CurStatus。 */
const CUR_STATUS: Record<number, string> = {
  0: 'NORMAL',
  0x1000: 'OVER_LIMIT_I',
  0x2000: 'OVER_LIMIT_II',
  0x4000: 'DALARM',
  0x8000: 'HITALARMSCRIPT',
}

function decodeNibble(value: number, table: Record<number, string>): string {
  if (value === 0) return table[0] ?? 'NORMAL'
  const names = Object.keys(table)
    .map(Number)
    .filter((bit) => bit !== 0 && (value & bit) === bit)
    .map((bit) => table[bit]!)
  return names.length > 0 ? names.join('|') : `UNKNOWN(0x${value.toString(16)})`
}

/** 质量码 2 字节 4 nibble 解码结果。 */
export interface QualityDecode {
  originalStatus: string
  dataSrc: string
  opcStatus: string
  curStatus: string
  isBad: boolean
  isHandInput: boolean
  isAlarm: boolean
}

/** 解码 2 字节质量码；面向答案解释，不参与过滤。 */
export function decodeQuality(quality: number): QualityDecode {
  const original = quality & 0x00ff
  const dataSrc = quality & 0x0f00
  const opc = (quality >> 8) & 0x0f
  const cur = quality & 0xf000
  return {
    originalStatus: decodeNibble(original, ORIGINAL_STATUS),
    dataSrc: decodeNibble(dataSrc, DATA_SRC),
    opcStatus: opc === 0 ? 'OK' : `OPC_FLAG(0x${opc.toString(16)})`,
    curStatus: decodeNibble(cur, CUR_STATUS),
    isBad: (quality & 128) === 128,
    isHandInput: (quality & 0x0200) === 0x0200,
    isAlarm: (quality & 0xf000) !== 0,
  }
}
