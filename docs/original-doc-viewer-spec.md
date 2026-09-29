# 原文查看器规格：现状与跨源可信代理扩展（original-doc-viewer-spec）

> 背景：genui 引用溯源的「打开原文」查看器（`original-viewer.tsx` + dsh-ragflow
> `ragflow-documents` 代理）现为**宿主同源**形态，2026-09-29 完成空白/屏蔽页修复
> （见 `docs/knowledge-eval-zuhe.md` §3 发现 6/7）。本文回答下一跳：**当文档代理
> 跨源部署但仍可信时（多租户方案 2 的租户网关形态），查看器与代理如何改造**。
> 本文是评审修正版——对最初口头方案的三个漏洞（下载同源限制、PDF.js 中文 cmaps
> 与大文件内存、HEAD 被当 GET 拉全量）已吸收为规格条款。

## 1. 威胁模型与信任边界

| 形态 | 帧内容来源 | sandbox 语义 | 结论 |
|---|---|---|---|
| 同源代理（现状） | 宿主自有文档 + 自写纯文本错误 | **无保护对象** → 去 sandbox（已落地） | 已完成 |
| **跨源 · 可信**（本文主题） | 我方运维的租户网关：自有文档，但通道跨源 | 有意义：opaque origin 防注入后触碰宿主 | 按内容类型分层（§2） |
| 跨源 · 不可信 | 第三方任意内容 | 必须 sandbox，且永不给 allow-same-origin | 出本方案范围（不承接） |

铁律：**跨源内容绝不同时给 `allow-scripts + allow-same-origin`**（等效无 sandbox）；
不可信来源绝不去 sandbox。PDF 一律不进 sandboxed iframe（Chromium 拦截插件文档，
与同源无关——2026-09-29 实测）。

## 2. 内容类型分派表（查看器核心逻辑）

打开引用时先做一次**预检**（HEAD 或 `Range: bytes=0-0` 局部 GET，取 status +
Content-Type；结果按 citation 缓存），再分派：

| 预检 Content-Type | 渲染方式 | sandbox | 说明 |
|---|---|---|---|
| `application/pdf` | **PDF.js 自渲染**（懒加载资产）；失败/降级 → 「新标签」 | 不适用（无 iframe） | PDF.js 在页面内 canvas 渲染：无插件文档语义（绕开 Chromium 拦截），无插件环境（嵌入式 Chromium）也能渲染——同时消除 §3-P1 的 IAB 空文档兜底场景。**前提**：代理支持 Range（26MB 全量载入内存不可接受）+ 中文字体 cmaps 资产齐全（中文规程 PDF 缺 cmap 会乱码） |
| `text/html` | iframe | `sandbox="allow-scripts"`（**无** allow-same-origin） | 可信 HTML 需跑脚本；opaque origin 保证注入后碰不到宿主 DOM。注意：opaque origin 下 localStorage/cookie 失效——预览场景可接受 |
| `image/*` | iframe 或直接 `<img>` | 默认 sandbox（无 allow-scripts） | 代理须不回 `X-Frame-Options: DENY`；建议回 CSP `frame-ancestors` 白名单 |
| `text/plain`（错误语义） | 错误面板 | 不适用 | 同源可直接读 contentDocument；**跨源读不到**——预检的 status 即错误信号（代理保证错误=非 2xx，见 §3-5） |
| 其它/未知 | 「新标签」按钮 + 下载 | — | 不猜 |

**下载语义修正**：HTML 规范中 `<a download>` 的文件名只对**同源** URL 生效——跨源
形态下"下载"按钮改为代理 fetch → Blob → `URL.createObjectURL` 保存（凭据走签名
URL，见 §3-4），不能继续用裸 `<a href download>`。

## 3. 可信代理义务清单（"可信"落在协议上）

1. **HEAD 语义正确**：只回 `Content-Type` / `Content-Length` / `Accept-Ranges: bytes`，
   不回 body。现状缺陷：document.js 对 HEAD 走了 GET 全量拉取路径（P1 修复项）。
2. **Range 请求**：支持 `Range: bytes=a-b` 回 206（PDF.js 按页懒加载的硬前提）；
   64MB 总量上限按累计字节计（分段流式不豁免）。
3. **内容协商正确**：`Content-Type` 如实（分派表的依据）；`Content-Disposition:
   inline; filename*=UTF-8''<名>`（下载文件名正确且不强制下载）。
4. **跨源凭据 = 短期签名 URL**：宿主 webServer 增签发端点（HMAC(docId|exp|client)
   + 短过期），代理验证后放行。**禁止**依赖 cookie（跨站 iframe 带不上
   SameSite=Lax 凭据）、禁止把长期 API key 暴露给页面。签名密钥是新的 secret，
   纳入凭据不落盘纪律管理。
5. **错误语义**：业务失败（上游 200+code≠0）转真 404/502 文本（同源已落地）——
   保证预检 status 即真值、跨源不依赖读帧内容判错。
6. **嵌入声明**：`Content-Security-Policy: frame-ancestors 'self' https://<宿主域>`
   （HTML/image 路径）；PDF 路径不依赖此头。

## 4. 分阶段落地计划

### P0 —— 同源形态（已完成，勿回退）
现状即 P0：无 sandbox + 8s 自撤浮层 + 错误面板 + 新标签按钮 + 空插件文档自适应
提示。**触发 P1/P2/P3 的不是时间，是需求**——过早引入跨源机制是过度设计。

### P1 —— 代理义务（✅ 已完成 2026-09-29，含缓存与两处实测修正）
- `document.js`：HEAD 只回元信息（上游仍 GET，body cancel）；Range 转发上游、
  上游忽略时内联切片回 206；`accept-ranges`；业务失败信封转 404（含 HEAD 路径）。
- **宿主侧字节缓存**（评审后追加）：首取全文入缓存（128MB 总量最旧淘汰），
  HEAD/Range/全量全部内存直出——HEAD 预检也入缓存（否则查看器预检 + pdf.js
  正文 = 冷打开双拉 26MB）；缓存值 `{buf, contentType}`（命中分支不硬编码）。
  权衡：miss 的 HEAD 不再"便宜"（触发全量拉取）——查看器场景净赚；外部高频
  HEAD 探测不同文档会把它们灌入缓存，由 128MB 上限 + 最旧淘汰兜底。已知未做：
  同文档并发 miss 的 in-flight 去重（各拉一次，浪费不出错）；慢链路 >30s 的
  全量拉取会 502（timeoutMs 覆盖全程，与改前一致，缓存命中后不受影响）。
- **两处实测修正**：① 缓存投毒——miss 路径转发客户端 Range 时上游 206 会让
  arrayBuffer 只拿分片入缓存，已改恒发无 Range 全量 GET + 仅 200 入缓存
  （Range-first 冷缓存重验：首 Range 1.16s 入全量、深偏移 14ms、全量尾部
  `%%EOF` 完整）；② **宿主 webServer 栈对无 filename 的
  `content-disposition: inline` 回 400**——该头已从 serveBuffer 移除
  （`content-disposition` 只允许与 attachment/文件名同现或干脆不发）。
- 验收（实测全过）：冷 HEAD 入缓存回元信息；深偏移 Range 7.6ms；全量尾部
  `%%EOF`；错误 id HEAD 回 404。

### P2 —— 查看器探测-分派 + PDF.js（✅ 已完成 2026-09-29，含性能调优）
- `asset-pdfjs.ts`/`asset-pdfjs-worker.ts` 资产入口（pdfjs-dist 6.3 build 现代版）；
  worker 以 IIFE 捆绑、经 `GlobalWorkerOptions.workerSrc` 引用；cmaps 168 个
  bcmap 经 `scripts/copy-cmaps.mjs` 拷入 `lib/assets/cmaps/`，节点路由按
  `application/octet-stream` 提供（`ASSET_CMAP_RE` 平面名单防穿越）。
- `original-doc-presentation.ts`：预检分派纯函数（单测 5 例）；
  `original-viewer.tsx`：预检（**HEAD + 有界缓存**）→ 分派；PDF → `PdfJsFrame`
  （canvas 按页渲染 + 上下页 + 引用页直跳 + 30s 加载预算）；html → `sandbox="allow-scripts"`
  iframe；其余/预检失败 → 无 sandbox iframe（历史行为含空文档检测）。
- **性能调优（实测）**：`disableStream + disableAutoFetch` 强制按需 Range 取块；
  document.js 加宿主侧字节缓存（首取 26MB 入缓存，深层偏移 Range 20-35s →
  **6ms**），IAB 无插件环境 canvas 渲染 624×883 零错误面板。
- **遗留观察**：pdf.js 全量探测回退仍先拉一次 26MB（1.4s，可接受）；复杂 CJK 页
  首渲仍需数秒（fake worker 路径），`workerPort` 直构是候选优化（未做）。

### P3 —— 跨源租户网关（方案 2 触发时）
- 代理独立部署 + 签名 URL 端点（§3-4）；CSP frame-ancestors；下载改 Blob。
- 触发条件：多租户文档代理独立部署立项（即 AGENTS.md 方案 2 的 document 代理
  租户化）。
- 验收：跨源预检/渲染/下载全链路；签名过期后 403；宿主页面零长期凭据。
- 工作量：~3 天 + 联调。

## 5. 评审结论与风险登记

**方案成立**，修正三点后落地：① 下载按钮跨源失效（§2 修正为 Blob 下载）；
② PDF.js 不是"换个渲染器"而是带两个硬前提（Range 代理 + 中文 cmaps）和一个内存
约束（26MB 文档必须按页取）；③ HEAD 现状是假实现（P1 先修，否则 P2 预检每次
全量拉文档）。

| 风险 | 等级 | 状态 |
|---|---|---|
| PDF.js 中文乱码（缺 cmap） | 高（必现） | ✅ 已消（168 cmaps 捆绑 + 路由） |
| 大文件内存（全量载入） | 高 | ⚠️ 观察：pdf.js v6 Range 探测回退全量（26MB 内存中解析），渲染慢的根因之一；P3 网关可回 `content-range` 严格 206 改善 |
| **字节缓存投毒**（Range 转发上游时 arrayBuffer 只拿分片入缓存） | 高（必修） | ✅ 已消（2026-09-29 评审发现）：miss 路径恒发无 Range 全量 GET、仅 200 入缓存；冷缓存 Range-first 重验——首 Range 1.16s 入全量缓存，其后深偏移 14ms、全量尾部 `%%EOF` 完整 |
| 复杂 CJK 页首渲染慢 | 中 | 已知观察；候选：`pdfjs-dist/legacy` worker 或禁 fake worker 快速失败；暂不阻塞 |
| PDF.js CVE 历史 | 中 | 资产锁定版本（6.3.289）+ 升级走 genui 资产流程；内容本属可信库 |
| 签名密钥管理（新 secret） | 中 | 短过期 + 进凭据纪律；仅 P3 引入 |
| 预检多一跳延迟 | 低 | ✅ 已消（HEAD + 按 URL 有界缓存） |
| opaque origin 下 HTML 功能受限 | 低 | 预览场景可接受，文档化即可 |
| genui 存量 SKILL.md 6 测试失败 | — | ✅ 已消（根因 CRLF 行尾非内容：工作树 autocrlf 注入 \r，yaml col490/示例正则双失败；SKILL.md 归一 LF + `.gitattributes` `*.md text eol=lf`，22/22 绿） |

**不做清单**：不承接不可信第三方内容（威胁模型外）；不在同源期引入签名 URL
（YAGNI）；不用 `<embed>`/`<object>` 直嵌 PDF（同等拦截风险）。

## 6. 关联

- 现状修复记录：`docs/knowledge-eval-zuhe.md` §3 发现 6/7
- 多租户背景：`AGENTS.md`「RAGFlow 多租户凭据」与方案 1/2 说明
- 代码落点：`dsh-genui/src/client/original-viewer.tsx`（分派）、
  `examples/ragflow/lib/document.js`（代理义务）
- 渲染协议改动按 AGENTS.md 联动规则两仓成对提交
