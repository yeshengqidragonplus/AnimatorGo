// Cocos 侧验证用的采集端:页面 / 原生模拟器把渲染出来的帧 POST 过来,存成文件。
//
//   node tools/cocos/collect.mjs --dir <输出目录> [--port 8082] [--flip-web 1] [--flip-jsb 1]
//
// 两种 body:
//   - 现成的 PNG(浏览器里 canvas.toDataURL 转的):`POST /save?name=x.png`,原样落盘
//   - RenderTexture.readPixels 读出来的 RGBA 裸像素(tools/cocos/probe/AgcCapture.ts,Web 和原生都走这个):
//     `POST /save?name=x.png&w=960&h=640&plat=web|jsb`,这里编成 PNG。GL 读出来的像素是从下往上的,
//     按 --flip-web / --flip-jsb 决定要不要上下翻(默认都翻)
// 跨域要带 CORS 头(页面在别的端口上);浏览器会先发 OPTIONS。
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { deflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const dir = opt('dir', 'renders')
const port = Number(opt('port', '8082'))
const flip = { web: opt('flip-web', '1') === '1', jsb: opt('flip-jsb', '1') === '1' }
mkdirSync(dir, { recursive: true })

const CRC = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[n] = c
}
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** RGBA 裸像素 → PNG(8 位 RGBA,不滤波);flipY 为真表示输入是从下往上的 */
function encodePng(w, h, rgba, flipY) {
  const row = w * 4
  const raw = Buffer.alloc((row + 1) * h)
  for (let y = 0; y < h; y++) {
    const sy = flipY ? h - 1 - y : y
    raw[y * (row + 1)] = 0
    rgba.copy(raw, y * (row + 1) + 1, sy * row, sy * row + row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method !== 'POST' || url.pathname !== '/save') { res.writeHead(404); res.end('POST /save?name=<文件名>[&w=&h=&plat=web|jsb]'); return }
  // 只取文件名那一段,防止写到目录外面
  const name = basename(url.searchParams.get('name') ?? 'frame.png')
  const w = Number(url.searchParams.get('w') ?? 0)
  const h = Number(url.searchParams.get('h') ?? 0)
  const plat = url.searchParams.get('plat') ?? 'web'
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const target = join(dir, name)
    let body = Buffer.concat(chunks)
    let note = ''
    if (w > 0 && h > 0) {
      if (body.length !== w * h * 4) { res.writeHead(400); res.end(`像素数对不上:${body.length} != ${w}x${h}x4`); return }
      body = encodePng(w, h, body, flip[plat] ?? true)
      note = ` (${plat} 裸像素 → png)`
    }
    writeFileSync(target, body)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(target)
    console.log(`saved ${target} (${body.length} bytes)${note}`)
  })
}).listen(port, '127.0.0.1', () => console.log(`collect: http://127.0.0.1:${port}/save → ${dir}`))
