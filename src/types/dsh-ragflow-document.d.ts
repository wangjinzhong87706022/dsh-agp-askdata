/**
 * `@deepseek-ai/dsh-ragflow/document` 的可选协作声明：宿主同装 dsh-ragflow 时
 * （web profile file: 依赖），knowledge-search 动态 import 该模块把检索结果
 * 同步进其 chunkId→documentId 反查 Map（by-chunk 原文溯源）。askdata 不依赖
 * 该包——运行时未解析走 catch 跳过；此声明仅为 tsc 服务。
 */
declare module '@deepseek-ai/dsh-ragflow/document' {
  export function registerChunkDocuments(chunks: Array<{ chunkId?: string; documentId?: string }>): void
}
