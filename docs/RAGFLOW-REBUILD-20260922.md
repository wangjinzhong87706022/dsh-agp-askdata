# ragflow 插件 lib 重建交接（2026-09-22 事故）

examples/ragflow/lib 被外部清空。重建物与步骤：

## 需 winfr 找回（精确字节，优先）
```cmd
winfr E: D:\recovered2 /segment /n \git\deepseek-harness\examples\ragflow\lib\*
```
（/regular 漏了本路径；/segment 扫得深。找回后放回 lib/ 即用。）

## 无法找回时的手写重建清单
1. `lib/settings-compat.js`：rc.2 shim。导出 settingsNamespace(id)→{id}、
   installSettingsSection(ctx,ns,schema,config,hooks)→hooks.setSource(()=>config)。
2. `lib/document.js`：ragflow-documents 行。inject=['webServer']，
   Config=Schema.object({baseURL,apiKeyEnv 默认 RAGFLOW_API_KEY,timeoutMs 30000,
   maxBytes 64MB,webBaseURL,webOpenPerMinute 30})。
   三条 prefix 路由：/api/ragflow/documents/:id（反代 /api/v1/documents/:id，
   超限 res.destroy+logger.warn id尾8位）、/by-chunk/:chunkId（chunkDocuments
   Map 反查，限 2048 条）、/api/ragflow/web-open/:id（302 到 webBaseURL/document/:id，
   分钟限流）。id 校验 /^[0-9a-z][0-9a-z-]{7,127}$/。凭据 credentials.resolve
   →环境变量回退。
3. `lib/tool.js`/`lib/http2.js`：基于 master src/tool.ts+provider.ts 重建后打 4 补丁：
   a) projectChunk 省略 null page_num；b) 透传 positions(5元组净化)+imageId；
   c) execute 末尾 registerChunkDocuments(chunks)（Map 2048 上限，与 document.js
   共享实例——tool 行 import '@deepseek-ai/dsh-ragflow/document' 并加 externals）；
   d) 指令强化（documentId 是 hex id、positions 原样抄、禁写 undefined 字面量、
   图片用 http://127.0.0.1:<webServer.port>/api/ragflow/images/<id> 绝对地址）。
   另 http2 的 mapRagflowChunk 加 normalizePositions。
4. `lib/settings.js` 首行 import 改 './settings-compat.js'；tool/http2 的
   installSettingsSection 同理。
5. `package.json`（exports ././http ./tool ./document ./config ./settings ./types
   + dsh.bundle.patch）与 `cordis.patch.yml`（5 行装配：ragflow/ragflow-http/
   tool-ragflow/ragflow-documents）按 2026-09-21 版重写。
6. profile junction @deepseek-ai/dsh-ragflow → examples/ragflow 已存在。
7. 启动环境变量：RAGFLOW_API_KEY/BASE_URL/DATASET_IDS(规程库
   fda7a510...；标准库 ec5591d4... 属另一 key 租户，见跨租户说明)。
