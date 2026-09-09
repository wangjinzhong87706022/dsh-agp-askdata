import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/dsh/plugin.ts', 'src/dsh/tools.ts', 'src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: true,
})
