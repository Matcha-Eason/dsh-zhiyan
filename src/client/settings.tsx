import { useEffect, useState, type CSSProperties } from 'react'
import { SETTINGS_PATH } from '../protocol.ts'

type Provider = 'deepseek' | 'jev'
type Settings = Record<Provider, { configured: boolean; writable: boolean }>
const providers = [
  { id: 'deepseek', label: 'DeepSeek 官方 API Key', description: 'DeepSeek Pro · 思考 Off', url: 'https://platform.deepseek.com/api_keys' },
  { id: 'jev', label: 'JEV 官方 API Key', description: 'TypeSafe · jev-latest · 只判断讨论时机', url: 'https://docs.typesafe.ai/' },
] as const
const buttonStyle: CSSProperties = { border: '1px solid var(--dsw-alias-border-l3, #ccc)', borderRadius: 6, padding: '6px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer' }

export function ModelSettings() {
  const [settings, setSettings] = useState<Settings>()
  const [keys, setKeys] = useState({ deepseek: '', jev: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    void fetch(SETTINGS_PATH, { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('settings-unavailable')
      const result = await response.json() as Settings
      if (!abort.signal.aborted) setSettings(result)
    }).catch(() => { if (!abort.signal.aborted) setMessage('暂时无法读取知言配置，请重新打开设置。') })
    return () => abort.abort()
  }, [])

  async function update(provider: Provider, remove: boolean) {
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch(SETTINGS_PATH, {
        method: remove ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(remove ? { provider } : { provider, apiKey: keys[provider] }),
      })
      if (!response.ok) throw new Error('save-failed')
      setSettings(await response.json() as Settings)
      setKeys(previous => ({ ...previous, [provider]: '' }))
      setMessage(remove ? '已移除，下次使用前请填写 API Key。' : '已保存，下次请求生效。')
    } catch {
      setMessage('保存失败，请检查本机服务和凭据存储权限后重试。')
    } finally { setBusy(false) }
  }

  return <section aria-label="知言模型设置" style={{ border: '1px solid var(--dsw-alias-border-l3, #ddd)', borderRadius: 12, padding: 20, marginTop: 16 }}>
    <h3 style={{ marginTop: 0 }}>知言 · 边写边聊</h3>
    <p>填好两个 API Key 即可。知言固定使用官方服务，独立于聊天模型选择；保留当前会话的人设。</p>
    {providers.map(provider => <form key={provider.id} onSubmit={event => { event.preventDefault(); void update(provider.id, false) }} style={{ marginTop: 18 }}>
      <label htmlFor={`zhiyan-${provider.id}`} style={{ display: 'block', fontWeight: 600 }}>{provider.label}</label>
      <p style={{ margin: '4px 0 8px', fontSize: 13 }}>{provider.description} · {settings ? settings[provider.id].configured ? '已配置' : '未配置' : '读取中…'} · <a href={provider.url} target="_blank" rel="noreferrer">官方平台</a></p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input id={`zhiyan-${provider.id}`} type="password" autoComplete="new-password" spellCheck={false}
          value={keys[provider.id]} disabled={busy || !settings?.[provider.id].writable}
          placeholder={settings?.[provider.id].configured ? '填写新 Key 以替换；已有 Key 不回显' : '粘贴 API Key'}
          onChange={event => setKeys(previous => ({ ...previous, [provider.id]: event.target.value }))}
          style={{ flex: 1, minWidth: 180, border: '1px solid var(--dsw-alias-border-l3, #ccc)', borderRadius: 6, padding: 8, background: 'var(--dsw-alias-bg-l1, Canvas)', color: 'inherit' }} />
        <button type="submit" style={buttonStyle} disabled={busy || !settings?.[provider.id].writable || !keys[provider.id].trim()}>保存</button>
        <button type="button" style={buttonStyle} disabled={busy || !settings?.[provider.id].writable || !settings[provider.id].configured}
          onClick={() => void update(provider.id, true)}>移除</button>
      </div>
    </form>)}
    <p style={{ fontSize: 12 }}>密钥保存到 DSH 本机凭据库，保存后不回显。保存仅记录配置，不调用模型或验证额度。</p>
    <p role="status" aria-live="polite">{message}</p>
  </section>
}
