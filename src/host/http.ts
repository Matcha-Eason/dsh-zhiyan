import type { IncomingMessage } from 'node:http'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** This MVP exposes draft analysis only to the local, same-origin web app. */
export function requireLocalRequest(req: IncomingMessage): void {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    throw new HttpError(403, 'local-only')
  }
  const host = req.headers.host
  if (!host) throw new HttpError(403, 'local-only')
  let url: URL
  try { url = new URL(`http://${host}`) } catch { throw new HttpError(403, 'local-only') }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new HttpError(403, 'local-only')
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'same-origin-required')
  if (req.headers.origin !== undefined && req.headers.origin !== url.origin) throw new HttpError(403, 'same-origin-required')
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'json-required')
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.length
    if (size > 48_000) throw new HttpError(413, 'draft-too-large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new HttpError(400, 'invalid-json') }
}
