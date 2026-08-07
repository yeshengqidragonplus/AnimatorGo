import { build as viteBuild } from 'vite'
import { buildOnce } from './electron-bundle.mjs'

/** 生产构建:渲染进程(dist/) + 主进程和 preload(dist-electron/) */

await viteBuild()
await buildOnce()

console.log('\n构建完成。打包成安装程序:pnpm build:win / pnpm build:mac')
