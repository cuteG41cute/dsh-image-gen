// dsh-image-gen — Host half.
//
// The browser page cannot call third-party image-generation endpoints directly
// (CORS), so the client asks this route instead: POST /dsh-image/api { method, args }.
//
//   get-config   -> { ok: true, config }
//   save-config  { config } -> { ok }
//   generate     { prompt, provider?, model?, size?, n? }
//                  -> POST <baseURL>/images/generations {model, prompt, n, size}
//                     Authorization: Bearer <key>
//                  -> downloads data[0].url to <outputDir>\<timestamp>-<provider>.<ext>
//                  -> { ok: true, path, url, revised_prompt? }
//   edit         { prompt, image, provider?, model?, size? }
//                  -> multipart POST <baseURL>/images/edits {model, prompt, image}
//                     image = 本地绝对路径（或 file:// / data: / 纯 base64）
//                  -> 下载结果并落盘，返回同 generate
//   test         { provider?, model? } -> same as generate with a fixed short prompt
//   list         -> { ok: true, providers, defaultProvider, defaultModel, recent: [...] }
//
// Config persists at ~/.dsh/image-gen-config.json (GLOBAL — not per-project).
// The file may carry a UTF-8 BOM; strip it before JSON.parse.
// Errors are reported as { ok:false, error } with real messages, never silent.
// API keys are never logged.
import { Service } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ROUTE_PATH = '/dsh-image/api'
const UPSTREAM_TIMEOUT_MS = 180000
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'image-gen-config.json')
const OUTPUT_DIR_FALLBACK = path.join(os.homedir(), '.dsh', 'image-gen', 'outputs')
const TEST_PROMPT = '一只橙色的猫坐在窗台上，窗外是雪景，水彩风格'

const SEED_CONFIG = {
  providers: [
    { name: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '<YOUR_ZHIPU_API_KEY>', models: ['cogview-4', 'cogview-3-flash'] },
    { name: 'minimax', baseURL: 'https://api.minimaxi.com/v1', apiKey: '<YOUR_MINIMAX_API_KEY>', models: ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'] },
  ],
  defaultProvider: 'minimax',
  defaultModel: 'MiniMax-H3-Image',
  outputDir: path.join(os.homedir(), '.dsh', 'image-gen', 'outputs'),
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function sanitizeConfig(value) {
  if (!value || typeof value !== 'object') return null
  const providers = Array.isArray(value.providers)
    ? value.providers
      .filter((p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim() !== '' && typeof p.baseURL === 'string')
      .map((p) => ({
        name: String(p.name).trim().slice(0, 60),
        baseURL: String(p.baseURL).trim().slice(0, 300),
        apiKey: typeof p.apiKey === 'string' ? p.apiKey.slice(0, 400) : '',
        models: Array.isArray(p.models) ? p.models.map((m) => String(m).trim()).filter((m) => m !== '').slice(0, 50) : [],
      }))
    : []
  if (providers.length === 0) return null
  const names = providers.map((p) => p.name)
  const defaultProvider = names.includes(value.defaultProvider) ? value.defaultProvider : names[0]
  const provider = providers.find((p) => p.name === defaultProvider)
  const defaultModel = typeof value.defaultModel === 'string' && provider.models.includes(value.defaultModel)
    ? value.defaultModel
    : (provider.models[0] || '')
  const outputDir = typeof value.outputDir === 'string' && value.outputDir.trim() !== ''
    ? String(value.outputDir).trim().slice(0, 400)
    : OUTPUT_DIR_FALLBACK
  return { providers, defaultProvider, defaultModel, outputDir }
}

function readConfigFile() {
  try {
    return sanitizeConfig(JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8'))))
  } catch {
    const seeded = sanitizeConfig(SEED_CONFIG)
    writeConfigFile(seeded)
    return seeded
  }
}

function writeConfigFile(value) {
  const clean = sanitizeConfig(value)
  if (!clean) return false
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 扩展名取自 URL 路径（默认 .png）。 */
function extFromUrl(url) {
  try {
    const p = new URL(url).pathname
    const m = /\.([a-z0-9]{2,5})$/i.exec(p)
    return m ? '.' + m[1].toLowerCase() : '.png'
  } catch {
    return '.png'
  }
}

export class ImageGenService extends Service {
  static inject = ['webServer']

  constructor(ctx) {
    super(ctx, 'image-gen')
  }

  async [Service.init]() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => this.handleApi(req, res),
    }))
  }

  async handleApi(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') { send(405, { ok: false, error: 'method-not-allowed' }); return }
    let raw = ''
    try { for await (const chunk of req) raw += chunk } catch { send(400, { ok: false, error: 'read-failed' }); return }
    let request = null
    try { request = JSON.parse(raw) } catch { send(400, { ok: false, error: 'bad-json' }); return }
    const method = request && typeof request.method === 'string' ? request.method : ''
    const args = (request && request.args && typeof request.args === 'object') ? request.args : {}
    try {
      if (method === 'get-config') { send(200, { ok: true, config: readConfigFile() }); return }
      if (method === 'save-config') {
        const saved = writeConfigFile(args.config)
        send(200, saved
          ? { ok: true, config: readConfigFile() }
          : { ok: false, error: '配置无效：至少需要一个 provider（name + baseURL 必填）' })
        return
      }
      if (method === 'generate') { send(200, await this.generate(args)); return }
      if (method === 'edit') { send(200, await this.edit(args)); return }
      if (method === 'test') { send(200, await this.generate(Object.assign({}, args, { prompt: TEST_PROMPT }))); return }
      if (method === 'list') { send(200, this.list()); return }
      send(200, { ok: false, error: 'unknown-method: ' + method })
    } catch (error) {
      send(200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 从 args 解析 provider/model，无效时抛错。 */
  resolveTarget(config, args) {
    const providerName = typeof args.provider === 'string' && args.provider.trim() !== '' ? args.provider.trim() : config.defaultProvider
    const provider = config.providers.find((p) => p.name === providerName)
    if (!provider) throw new Error('provider-not-found: ' + providerName)
    const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : (config.defaultModel || provider.models[0])
    if (!model) throw new Error('no-model-selected')
    if (!provider.apiKey) throw new Error('provider-no-api-key: ' + providerName)
    return { provider, providerName, model }
  }

  /** 读取 args.image：本地路径 / data:URL / 纯 base64 -> { blob, filename, mime } */
  readImageArg(imageArg) {
    const asBlob = (buf, mime, filename) => ({ blob: new Blob([buf], { type: mime }), filename, mime })
    if (typeof imageArg !== 'string' || imageArg.trim() === '') throw new Error('image-required（本地文件绝对路径或 data:URL）')
    const arg = imageArg.trim()
    const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(arg)
    if (dataMatch) {
      const mime = dataMatch[1] || 'image/png'
      const buf = dataMatch[2] ? Buffer.from(dataMatch[3], 'base64') : Buffer.from(decodeURIComponent(dataMatch[3]), 'utf8')
      return asBlob(buf, mime, 'input.' + (mime.split('/')[1] || 'png'))
    }
    let filePath = arg
    if (/^file:\/\//i.test(filePath)) {
      try { filePath = decodeURIComponent(new URL(filePath).pathname) } catch { /* 保持原样 */ }
    }
    filePath = path.resolve(filePath.replace(/^['"]|['"]$/g, ''))
    let stat
    try { stat = fs.statSync(filePath) } catch { throw new Error('image-not-found: ' + filePath) }
    if (stat.size > 20 * 1024 * 1024) throw new Error('image-too-large: ' + stat.size + '>20MB')
    const ext = (path.extname(filePath).slice(1) || 'png').toLowerCase()
    const mime = ext === 'jpg' ? 'image/jpeg' : (ext === 'jpeg' ? 'image/jpeg' : (['png', 'webp', 'gif', 'bmp'].includes(ext) ? 'image/' + ext : 'image/png'))
    return asBlob(fs.readFileSync(filePath), mime, path.basename(filePath))
  }

  /** 发上游请求 -> 解析 -> 下载 -> 落盘（generate 与 edit 共用）。 */
  async requestAndSave(url, init, providerName, model) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    let res
    try {
      res = await fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      const msg = error && error.name === 'AbortError' ? 'upstream-timeout (180s)' : 'upstream-error: ' + (error && error.message ? error.message : String(error))
      return { ok: false, error: msg }
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 500) } catch { /* ignore */ }
      return { ok: false, error: 'upstream-' + res.status + (detail ? ': ' + detail : '') }
    }
    let payload
    try { payload = await res.json() } catch (e) { return { ok: false, error: 'bad-upstream-json: ' + e.message } }
    const item = payload && Array.isArray(payload.data) ? payload.data[0] : null
    if (!item) return { ok: false, error: 'no-image-in-response: ' + JSON.stringify(payload).slice(0, 300) }
    const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined

    // 下载图片：优先 url，其次 b64_json
    let buf = null
    let sourceUrl = ''
    if (typeof item.url === 'string' && /^https?:\/\//.test(item.url)) {
      sourceUrl = item.url
      const controller2 = new AbortController()
      const timer2 = setTimeout(() => controller2.abort(), 120000)
      try {
        const img = await fetch(sourceUrl, { signal: controller2.signal })
        if (!img.ok) return { ok: false, error: 'download-' + img.status + ': ' + sourceUrl }
        buf = Buffer.from(await img.arrayBuffer())
      } catch (error) {
        return { ok: false, error: 'download-error: ' + (error && error.message ? error.message : String(error)) }
      } finally {
        clearTimeout(timer2)
      }
    } else if (typeof item.b64_json === 'string' && item.b64_json !== '') {
      try { buf = Buffer.from(item.b64_json, 'base64') } catch (e) { return { ok: false, error: 'b64-decode-error: ' + e.message } }
      sourceUrl = '(b64_json)'
    } else {
      return { ok: false, error: 'no-url-or-b64-in-item' }
    }
    if (!buf || buf.length === 0) return { ok: false, error: 'empty-image' }

    // 扩展名按文件魔数判断（有的上游 URL 写 .png 实际发 JPEG）
    const extFromMagic = (b) => {
      if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return '.jpg'
      if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return '.png'
      if (b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return '.webp'
      if (b.length > 6 && b.slice(0, 3).toString() === 'GIF') return '.gif'
      return null
    }
    const magicExt = extFromMagic(buf)

    const config = readConfigFile()
    const outDir = (config && config.outputDir) || OUTPUT_DIR_FALLBACK
    try { fs.mkdirSync(outDir, { recursive: true }) } catch (e) { return { ok: false, error: 'mkdir-failed: ' + e.message } }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const file = path.join(outDir, stamp + '-' + providerName + extFromUrl(sourceUrl))
    try { fs.writeFileSync(file, buf) } catch (e) { return { ok: false, error: 'write-failed: ' + e.message } }
    return { ok: true, path: file, url: sourceUrl, bytes: buf.length, model, provider: providerName, ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}) }
  }

  /** 图片编辑：multipart POST <baseURL>/images/edits。 */
  async edit(args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') return { ok: false, error: 'empty-prompt' }
    if (prompt.length > 4000) return { ok: false, error: 'prompt-too-long: ' + prompt.length + '>4000' }
    const config = readConfigFile()
    if (!config) return { ok: false, error: 'config-unavailable' }
    let target
    try { target = this.resolveTarget(config, args) } catch (e) { return { ok: false, error: e.message } }
    const { provider, providerName, model } = target

    let image
    try { image = this.readImageArg(args.image) } catch (e) { return { ok: false, error: e.message } }
    const fd = new FormData()
    fd.append('model', model)
    fd.append('prompt', prompt)
    fd.append('image', image.blob, image.filename)
    const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : undefined
    if (size) fd.append('size', size)

    return this.requestAndSave(
      provider.baseURL.replace(/\/+$/, '') + '/images/edits',
      { method: 'POST', headers: { authorization: 'Bearer ' + provider.apiKey }, body: fd },
      providerName, model,
    )
  }

  async generate(args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') return { ok: false, error: 'empty-prompt' }
    if (prompt.length > 4000) return { ok: false, error: 'prompt-too-long: ' + prompt.length + '>4000' }
    const config = readConfigFile()
    if (!config) return { ok: false, error: 'config-unavailable' }
    let target
    try { target = this.resolveTarget(config, args) } catch (e) { return { ok: false, error: e.message } }
    const { provider, providerName, model } = target

    const body = { model, prompt, n: Number.isFinite(Number(args.n)) && Number(args.n) >= 1 && Number(args.n) <= 4 ? Math.floor(Number(args.n)) : 1 }
    const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : undefined
    if (size) body.size = size

    return this.requestAndSave(
      provider.baseURL.replace(/\/+$/, '') + '/images/generations',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + provider.apiKey }, body: JSON.stringify(body) },
      providerName, model,
    )
  }

  list() {
    const config = readConfigFile()
    if (!config) return { ok: false, error: 'config-unavailable' }
    const outDir = config.outputDir || OUTPUT_DIR_FALLBACK
    let recent = []
    try {
      recent = fs.readdirSync(outDir)
        .filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f))
        .map((f) => {
          const full = path.join(outDir, f)
          let mtime = null
          try { mtime = fs.statSync(full).mtime.toISOString() } catch { /* ignore */ }
          return { name: f, path: full, mtime }
        })
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))
        .slice(0, 10)
    } catch { /* 目录还不存在就给空列表 */ }
    return { ok: true, providers: config.providers.map((p) => ({ name: p.name, baseURL: p.baseURL, models: p.models })), defaultProvider: config.defaultProvider, defaultModel: config.defaultModel, outputDir: outDir, recent }
  }
}

export default ImageGenService
