import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/dsh/plugin.ts', 'src/dsh/tools.ts', 'src/dsh/skills.ts', 'src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: true,
  // 可选协作依赖：宿主同装 dsh-ragflow 时共享 chunk→document 反查 Map
  //（knowledge-search 动态 import，未安装走 catch 跳过）——保持零硬耦合，
  // 构建期标记 external 以免打包器解析失败。
  external: [/^@deepseek-ai\/dsh-ragflow\//],
})
