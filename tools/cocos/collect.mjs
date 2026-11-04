// Cocos 侧验证用的采集端:浏览器里的页面把渲染出来的帧 POST 过来,存成文件。
//
//   node tools/cocos/collect.mjs --dir <输出目录> [--port 8082]
//
// 页面那边(探针工程或 AnimatorGoRender 场景)用 `fetch('http://127.0.0.1:8082/save?name=x.png', { method: 'POST', body })`。
// 跨域要带 CORS 头(页面在别的端口上);浏览器会先发 OPTIONS。
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const dir = opt('dir', 'renders')
const port = Number(opt('port', '8082'))
mkdirSync(dir, { recursive: true })

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method !== 'POST' || url.pathname !== '/save') { res.writeHead(404); res.end('POST /save?name=<文件名>'); return }
  // 只取文件名那一段,防止写到目录外面
  const name = basename(url.searchParams.get('name') ?? 'frame.png')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const target = join(dir, name)
    writeFileSync(target, Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(target)
    console.log(`saved ${target} (${chunks.reduce((n, c) => n + c.length, 0)} bytes)`)
  })
}).listen(port, '127.0.0.1', () => console.log(`collect: http://127.0.0.1:${port}/save → ${dir}`))
