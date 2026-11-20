/**
 * The "通知" settings page — a top-level Settings sidebar entry that lets the
 * user configure notify channels and event filters. Data is read/written over
 * the host's /dsh-notify RPC channel; edits are staged locally and committed as
 * one config write on Save, and the host persists them for the next start.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import type { AiBotRule, ChannelRule, EventDef, NotifyRpcCall, NotifyRpcConfig, RulesValue, WeChatStatus, WeComAiBotStatus } from './rpc.ts'
import { NOTIFY_ENDPOINTS, NOTIFY_RPC_CHANNEL } from './rpc.ts'
import css from './NotifySettings.module.css'

/** Props the settings.section renderer binds (inject face + locale copy). */
export interface NotifySettingsProps {
  rpcCall: NotifyRpcCall
  t: (key: string) => string
}

/** Load status of the page. */
type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' }

/**
 * Recursively set a path like `channels.system.sound` in a shallow copy.
 * @param obj - source object.
 * @param path - dot path to the leaf.
 * @param value - leaf value.
 * @returns a new object with the leaf replaced.
 */
function setAt(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.')
  const head = parts[0]
  if (parts.length === 1) return { ...obj, [head]: value }
  const next = (obj[head] as Record<string, unknown> | undefined) ?? {}
  return { ...obj, [head]: setAt(next, parts.slice(1).join('.'), value) }
}

/** Read a value at a dot path. */
function getAt(obj: Record<string, unknown> | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj)
}

/** Default config the page shows before the first load lands. */
const DEFAULTS: NotifyRpcConfig = {
  enabled: true,
  channels: {
    system: { enabled: true, sound: true, soundName: '' },
    webhook: { enabled: false, url: '' },
    wecom: { enabled: false, webhookUrl: '', msgType: 'markdown' },
    wecomAibot: { enabled: false, botId: '', secret: '', toChatIds: [], interactive: true },
    wechat: { enabled: false, toUserIds: [] },
    telegram: { enabled: false, botToken: '', chatId: '', parseMode: 'HTML' },
  },
  events: {
    conversationCompleted: true,
    conversationPaused: true,
    conversationFailed: true,
    authorizationRequired: true,
    confirmationRequired: true,
    todoProgress: true,
  },
  titlePrefix: '',
  mainAgentOnly: true,
}

/** One labelled toggle row. */
function ToggleRow(props: {
  t: (key: string) => string
  labelKey: string
  hintKey: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  const { t } = props
  return (
    <div className={css.field}>
      <div className={css.fieldHead}>
        <label className={css.label} htmlFor={`notify-${props.labelKey}`}>{t(props.labelKey)}</label>
        <span className={css.toggle}>
          <input
            id={`notify-${props.labelKey}`}
            className={css.toggleInput}
            type="checkbox"
            checked={props.checked}
            disabled={props.disabled === true}
            onChange={(event) => { props.onChange(event.target.checked) }}
          />
          <span className={css.toggleTrack} />
          <span className={css.toggleThumb} />
        </span>
      </div>
      <p className={css.hint}>{t(props.hintKey)}</p>
    </div>
  )
}

/** One text input row. */
function TextRow(props: {
  t: (key: string) => string
  labelKey: string
  hintKey: string
  placeholder?: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const { t } = props
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={`notify-${props.labelKey}`}>{t(props.labelKey)}</label>
      <input
        id={`notify-${props.labelKey}`}
        className={css.input}
        type="text"
        value={props.value}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled === true}
        spellCheck={false}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
      <p className={css.hint}>{t(props.hintKey)}</p>
    </div>
  )
}

/** A segmented enum select (markdown/text, HTML/MarkdownV2/text). */
function SelectRow(props: {
  t: (key: string) => string
  labelKey: string
  options: readonly string[]
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const { t } = props
  return (
    <div className={css.field}>
      <label className={css.label}>{t(props.labelKey)}</label>
      <div className={css.select} role="radiogroup" aria-label={t(props.labelKey)}>
        {props.options.map((option) => (
          <button
            key={option}
            type="button"
            className={css.selectOption}
            data-active={props.value === option ? '' : undefined}
            disabled={props.disabled === true}
            role="radio"
            aria-checked={props.value === option}
            onClick={() => { props.onChange(option) }}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * WeChat ClawBot login / status panel. Polls the host for the adapter status
 * while the channel is enabled and renders the login QR code (encoded locally
 * from the iLink QR payload) when the host is waiting for a scan.
 */
function WeChatPanel(props: {
  rpcCall: NotifyRpcCall
  t: (key: string) => string
  enabled: boolean
}): JSX.Element | null {
  const { t } = props
  const [status, setStatus] = useState<WeChatStatus | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [relogging, setRelogging] = useState(false)

  // Poll the adapter status while the channel is enabled.
  useEffect(() => {
    if (!props.enabled) {
      setStatus(null)
      return
    }
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.wechatStatus, {})
      if (!cancelled && res.ok && res.value && typeof res.value === 'object') {
        setStatus(res.value as WeChatStatus)
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [props.enabled])

  // Encode the QR payload locally (never sent to a third-party QR service).
  // NOTE: static import — the DSH module loader ships the client as a single
  // self-contained file; a dynamic import() would emit chunks the loader's
  // require() cannot resolve.
  const qrContent = status?.state === 'login' ? status.qrContent : undefined
  useEffect(() => {
    let cancelled = false
    if (!qrContent) {
      setQrUrl(null)
      return
    }
    QRCode.toDataURL(qrContent, { width: 220, margin: 1 })
      .then((url) => { if (!cancelled) setQrUrl(url) })
      .catch(() => { if (!cancelled) setQrUrl(null) })
    return () => { cancelled = true }
  }, [qrContent])

  const relogin = async (): Promise<void> => {
    setRelogging(true)
    const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.wechatRelogin, {})
    if (res.ok && res.value && typeof res.value === 'object') {
      setStatus(res.value as WeChatStatus)
    }
    setRelogging(false)
  }

  if (!props.enabled) return null

  return (
    <div className={css.field}>
      {status?.state === 'ready' ? (
        <p className={css.hint}>
          {t('wechatStatusReady')}{status.accountId ? ` (${status.accountId})` : ''}
          {' · '}{t('wechatKnownUsers')}: {status.knownUsers.length}
        </p>
      ) : null}
      {status?.state === 'ready' && status.knownUsers.length === 0 ? (
        <p className={css.hint}>{t('wechatNoUsers')}</p>
      ) : null}
      {status?.state === 'login' ? (
        <div className={css.qrBox}>
          {qrUrl ? <img className={css.qrImg} src={qrUrl} alt={t('wechatScanHint')} /> : <p className={css.hint}>{t('wechatQrLoading')}</p>}
          <p className={css.hint}>{t('wechatScanHint')}</p>
        </div>
      ) : null}
      {status?.state === 'error' ? (
        <p className={css.failed} role="alert">{t('wechatStatusError')}: {status.error ?? ''}</p>
      ) : null}
      <div>
        <button type="button" className={css.discard} disabled={relogging} onClick={() => void relogin()}>
          {relogging ? t('wechatRelogging') : t('wechatRelogin')}
        </button>
      </div>
    </div>
  )
}

/**
 * WeCom AI Bot (智能机器人) association / status panel. The "扫码关联" button
 * starts the host-side QR flow; while an attempt is pending the panel renders
 * the QR code (encoded locally from the auth URL) and polls the adapter
 * status. A successful association fills BotId/Secret into the host config —
 * the parent merges just those fields without discarding other staged edits.
 */
function WeComAiBotPanel(props: {
  rpcCall: NotifyRpcCall
  t: (key: string) => string
  enabled: boolean
  onAssociated: () => void
}): JSX.Element | null {
  const { t } = props
  const [status, setStatus] = useState<WeComAiBotStatus | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const wasPending = useRef(false)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    if (!props.enabled) {
      setStatus(null)
      return
    }
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const res = await latest.current.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.wecomAibotStatus, {})
      if (cancelled || !res.ok || !res.value || typeof res.value !== 'object') return
      const next = res.value as WeComAiBotStatus
      // pending → idle without an error means the scan succeeded and the host
      // has already applied the credentials; merge them into the page config.
      if (wasPending.current && next.qr.phase === 'idle') {
        latest.current.onAssociated()
      }
      wasPending.current = next.qr.phase === 'pending'
      setStatus(next)
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [props.enabled])

  // Encode the QR payload locally (never sent to a third-party QR service).
  const authUrl = status?.qr.phase === 'pending' ? status.qr.authUrl : undefined
  useEffect(() => {
    let cancelled = false
    if (!authUrl) {
      setQrUrl(null)
      return
    }
    QRCode.toDataURL(authUrl, { width: 220, margin: 1 })
      .then((url) => { if (!cancelled) setQrUrl(url) })
      .catch(() => { if (!cancelled) setQrUrl(null) })
    return () => { cancelled = true }
  }, [authUrl])

  const startQr = async (): Promise<void> => {
    setStarting(true)
    setStartError(null)
    try {
      const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.wecomAibotQrStart, {})
      if (!res.ok) throw new Error(res.error?.message ?? 'QR start failed')
      const authUrl = (res.value as { authUrl?: unknown } | undefined)?.authUrl
      if (typeof authUrl !== 'string' || !authUrl) throw new Error('QR URL not available')
      wasPending.current = true
      setStatus((s) => ({
        state: s?.state ?? 'disabled',
        knownChats: s?.knownChats ?? [],
        qr: { phase: 'pending', authUrl },
      }))
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }

  if (!props.enabled) return null

  return (
    <div className={css.field}>
      {status?.state === 'ready' ? (
        <p className={css.hint}>
          {t('wecomAibotStatusReady')}
          {' · '}{t('wecomAibotKnownChats')}: {status.knownChats.length}
        </p>
      ) : null}
      {status?.state === 'ready' && status.knownChats.length === 0 ? (
        <p className={css.hint}>{t('wecomAibotNoChats')}</p>
      ) : null}
      {status?.state === 'connecting' ? (
        <p className={css.hint}>{t('wecomAibotStatusConnecting')}</p>
      ) : null}
      {status?.state === 'error' ? (
        <p className={css.failed} role="alert">{t('wecomAibotStatusError')}: {status.error ?? ''}</p>
      ) : null}
      {status?.qr.phase === 'pending' ? (
        <div className={css.qrBox}>
          {qrUrl ? <img className={css.qrImg} src={qrUrl} alt={t('wecomAibotScanHint')} /> : <p className={css.hint}>{t('wecomAibotQrLoading')}</p>}
          <p className={css.hint}>{t('wecomAibotScanHint')}</p>
        </div>
      ) : null}
      {startError ? <p className={css.failed} role="alert">{startError}</p> : null}
      {status?.qr.phase === 'error' ? (
        <p className={css.failed} role="alert">{status.qr.error ?? ''}</p>
      ) : null}
      <div>
        <button type="button" className={css.discard} disabled={starting} onClick={() => void startQr()}>
          {starting ? t('wecomAibotQrStarting') : t('wecomAibotQrStart')}
        </button>
      </div>
    </div>
  )
}

/** The full notify configuration page. */

/** Checkbox row for one message type (channel-level control). */
function EventToggles(props: { events: EventDef[]; selected: string[]; disabled: boolean; onChange: (next: string[]) => void }): JSX.Element {
  return (
    <div className={css.field}>
      {props.events.map((event) => (
        <label className={css.label} key={event.key}>
          <input type="checkbox" checked={props.selected.includes(event.key)} disabled={props.disabled}
            onChange={(change) => props.onChange(change.target.checked
              ? [...props.selected, event.key]
              : props.selected.filter((key) => key !== event.key))} />
          {' '}{event.label}
        </label>
      ))}
    </div>
  )
}

/** Modal used for both adding and editing one WeCom bot. */
function BotDialog(props: {
  open: boolean
  busy: boolean
  t: (key: string) => string
  rpcCall: NotifyRpcCall
  workspaces: Array<{ title: string; path: string }>
  initial: AiBotRule | null
  onClose: () => void
  onSave: (draft: AiBotRule & { secret?: string }) => void
  onDelete: () => void
}): JSX.Element | null {
  const [label, setLabel] = useState('')
  const [id, setId] = useState('')
  const [botId, setBotId] = useState('')
  const [secret, setSecret] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!props.open) { setReady(false); return }
    setLabel(props.initial?.label ?? '')
    setId(props.initial?.id ?? '')
    setBotId(props.initial?.botId ?? '')
    setSecret('')
    setWorkspace(props.initial?.workspace ?? '')
    setReady(true)
  }, [props.open, props.initial])

  if (!props.open || !ready) return null
  const editing = props.initial !== null
  const valid = id.trim().length > 0 && botId.trim().length > 0 && (editing || secret.trim().length > 0)
  return (
    <div className={css.modalOverlay} role="dialog" aria-modal="true">
      <div className={css.modalPanel}>
        <h4 className={css.sectionTitle}>{editing ? '编辑机器人' : '添加企业微信机器人'}</h4>
        <WeComAiBotPanel rpcCall={props.rpcCall} t={props.t} enabled
          onAssociated={() => {
            void (async () => {
              // The QR flow writes the credentials into the host config; pull them
              // back into this dialog so the user only has to confirm.
              const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.configGet, {})
              if (!res.ok || !res.value || typeof res.value !== 'object')
                return
              const bot = (res.value as NotifyRpcConfig).channels?.wecomAibot
              if (!bot)
                return
              if (typeof bot.botId === 'string' && bot.botId.length > 0)
                setBotId(bot.botId)
              if (typeof bot.secret === 'string' && bot.secret.length > 0)
                setSecret(bot.secret)
              setId((current) => current || 'main')
              setLabel((current) => current || '主机器人')
            })()
          }} />
        <input className={css.input} placeholder="名称（如 论文机器人）" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input className={css.input} placeholder="id（如 main / paper）" value={id} onChange={(e) => setId(e.target.value)} />
        <input className={css.input} placeholder="BotId（aib…）" value={botId} onChange={(e) => setBotId(e.target.value)} />
        <input className={css.input} type="password" placeholder={editing && props.initial?.hasSecret ? 'Secret 已设置（留空保持不变）' : 'Secret'} value={secret} onChange={(e) => setSecret(e.target.value)} />
        {editing ? (
          <select className={css.select} value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">总机器人（收未分配工作区）</option>
            {props.workspaces.map((row) => <option key={row.path} value={row.path}>{row.title}</option>)}
          </select>
        ) : (
          <p className={css.hint}>默认不分配工作区，添加后可在列表里再分配。</p>
        )}
        <div className={css.field}>
          <button className={css.save} disabled={!valid || props.busy}
            onClick={() => props.onSave({
              label: label.trim() || id.trim(),
              id: id.trim(),
              botId: botId.trim(),
              hasSecret: true,
              interactive: editing ? (props.initial?.interactive ?? true) : true,
              workspace,
              events: props.initial?.events ?? [],
              ...(secret.trim().length > 0 ? { secret: secret.trim() } : {}),
            })}>
            保存
          </button>
          <button className={css.save} disabled={props.busy} onClick={props.onClose}>取消</button>
          {editing ? <button className={css.save} disabled={props.busy} onClick={props.onDelete}>删除</button> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Push rules, organised by channel (the "global" switchboard): each channel
 * picks the message types it forwards; a workspace bound to its own bot is
 * managed separately and bypasses the channel blocks.
 */
function PushRulesSection(props: { rpcCall: NotifyRpcCall; t: (key: string) => string }): JSX.Element {
  const [rules, setRules] = useState<RulesValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sendKeyDraft, setSendKeyDraft] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [botStatus, setBotStatus] = useState<WeComAiBotStatus | null>(null)

  const load = async (): Promise<void> => {
    const statusRes = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.wecomAibotStatus, {})
    if (statusRes.ok && statusRes.value && typeof statusRes.value === 'object')
      setBotStatus(statusRes.value as WeComAiBotStatus)
    const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.rulesGet, {})
    if (res.ok && res.value && typeof res.value === 'object') {
      setRules(res.value as RulesValue)
      setError(null)
    } else {
      setError(res.ok ? '规则不可用' : (res.error?.message ?? '加载失败'))
    }
  }

  useEffect(() => { void load() }, [])

  const apply = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.rulesSet, patch)
    if (res.ok && res.value && typeof res.value === 'object') {
      setRules(res.value as RulesValue)
      setError(null)
    } else {
      setError(res.ok ? '保存失败' : (res.error?.message ?? '保存失败'))
    }
    setBusy(false)
  }

  if (rules === null)
    return <details className={css.section}><summary className={css.sectionTitle}>推送规则</summary><p className={css.status}>{error ?? '加载中…'}</p></details>

  const workspaceTitle = (path: string): string => rules.workspaces.find((row) => row.path === path)?.title ?? path
  const botStatusText = (bot: AiBotRule): string => {
    const state = bot.state ?? botStatus?.state ?? 'unknown'
    const label = state === 'ready' ? '已连接'
      : state === 'connecting' ? '连接中'
        : state === 'error' ? `连接异常${bot.stateError ? `：${bot.stateError}` : ''}`
          : state === 'disabled' ? '未启用'
            : state === 'missing' ? '未创建（重启 DSH 后生效）'
              : '状态未知'
    return label
  }

  const patchChannel = (name: 'wecom' | 'serverchan', change: Partial<ChannelRule>): void => {
    void apply({ channels: { [name]: { ...rules.channels[name], ...change } } })
  }

  return (
    <>
    <details className={css.section}>
      <summary className={css.sectionTitle}>推送规则</summary>
      <p className={css.hint}>按通道总控：勾选该通道要转发哪些消息类型。某个工作区单独绑定机器人后，它不再走下面的总控，由「单独绑定」管。</p>
      {error ? <p className={css.status} role="alert">{error}</p> : null}

      <div className={css.field}>
        <div className={css.fieldHead}><span className={css.label}>企业微信</span></div>
        <label className={css.label}>
          <input type="checkbox" checked={rules.channels.wecom.enabled} disabled={busy}
            onChange={(event) => patchChannel('wecom', { enabled: event.target.checked })} />
          {' '}启用
        </label>
        <details>
          <summary className={css.label}>消息类型与工作区（点击展开）</summary>
          <EventToggles events={rules.events} selected={rules.channels.wecom.events} disabled={busy}
            onChange={(events) => patchChannel('wecom', { events })} />
        </details>
      </div>

      <div className={css.field}>
        <div className={css.fieldHead}><span className={css.label}>Server酱（微信）</span></div>
        <label className={css.label}>
          <input type="checkbox" checked={rules.channels.serverchan.enabled} disabled={busy}
            onChange={(event) => patchChannel('serverchan', { enabled: event.target.checked })} />
          {' '}启用
        </label>
        <details>
          <summary className={css.label}>消息类型与工作区（点击展开）</summary>
          <EventToggles events={rules.events} selected={rules.channels.serverchan.events} disabled={busy}
            onChange={(events) => patchChannel('serverchan', { events })} />
        <p className={css.hint}>推送哪些工作区（微信侧独立于企业微信的机器人分配）：</p>
        <div className={css.field}>
          {rules.workspaces.map((workspace) => {
            const list = rules.channels.serverchan.workspaces ?? ['*']
            const all = list.includes('*')
            const checked = all || list.includes(workspace.path)
            return (
              <label className={css.label} key={workspace.path}>
                <input type="checkbox" checked={checked} disabled={busy}
                  onChange={(change) => {
                    const base = all ? rules.workspaces.map((row) => row.path) : list.filter((entry) => entry !== '*')
                    const nextList = change.target.checked
                      ? [...base, workspace.path].filter((entry, i, arr) => arr.indexOf(entry) === i)
                      : base.filter((entry) => entry !== workspace.path)
                    patchChannel('serverchan', { workspaces: nextList.length > 0 ? nextList : ['*'] })
                  }} />
                {' '}{workspace.title}
              </label>
            )
          })}
        </div>
        </details>
        <p className={css.hint}>{rules.serverchan.hasKey ? 'SendKey 已设置（留空=保持不变）' : '尚未设置 SendKey'}</p>
        <input className={css.input} type="password" placeholder="SCT…" value={sendKeyDraft} disabled={busy}
          onChange={(event) => setSendKeyDraft(event.target.value)} />
        <button className={css.save} disabled={busy || sendKeyDraft.trim().length === 0}
          onClick={() => { void apply({ serverchan: { sendKey: sendKeyDraft.trim() } }).then(() => setSendKeyDraft('')) }}>
          保存 SendKey
        </button>
        <input className={css.input} placeholder="设备名（留空=本机主机名）" defaultValue={rules.serverchan.device} disabled={busy}
          onBlur={(event) => void apply({ serverchan: { device: event.target.value } })} />
        <input className={css.input} placeholder="标题模板 DSH状态更新 · {device}" defaultValue={rules.serverchan.titleTemplate} disabled={busy}
          onBlur={(event) => void apply({ serverchan: { titleTemplate: event.target.value } })} />
      </div>

      </details>

      <details className={css.section} aria-label="企业微信机器人">
        <summary className={css.sectionTitle}>企业微信机器人</summary>
      <div className={css.field}>
        <div className={css.fieldHead}>
          <span className={css.hint}>{botStatus ? `连接状态：${botStatus.state}` : ''}</span>
        </div>
        {rules.aibots.length === 0 ? <p className={css.hint}>还没有机器人，点下面添加。</p> : null}
        {rules.aibots.map((bot, index) => (
          <div className={css.fieldHead} key={bot.id || index}>
            <span className={css.label}>{bot.label || bot.id}</span>
            <span className={css.hint}>
              {bot.workspace ? `专属 · ${workspaceTitle(bot.workspace)}` : '总机器人'} · {botStatusText(bot)}
            </span>
            <button className={css.save} disabled={busy}
              onClick={() => { setEditing(index); setDialogOpen(true) }}>编辑</button>
          </div>
        ))}
        <button className={css.save} disabled={busy}
          onClick={() => { setEditing(null); setDialogOpen(true) }}>+ 添加机器人</button>
        <BotDialog open={dialogOpen} busy={busy} t={props.t} rpcCall={props.rpcCall} workspaces={rules.workspaces}
          initial={editing === null ? null : (rules.aibots[editing] ?? null)}
          onClose={() => setDialogOpen(false)}
          onDelete={() => {
            if (editing === null) return
            void apply({ aibots: rules.aibots.filter((_, i) => i !== editing) }).then(() => setDialogOpen(false))
          }}
          onSave={(draft) => {
            const next = [...rules.aibots]
            if (editing === null)
              next.push(draft as AiBotRule)
            else
              next[editing] = { ...next[editing], ...draft, hasSecret: true } as AiBotRule
            void apply({ aibots: next }).then(() => { setDialogOpen(false); void load() })
          }} />
      </div>
    </details>
    </>
  )
}

export function NotifySettings(props: NotifySettingsProps): JSX.Element | null {
  const { t } = props
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [config, setConfig] = useState<NotifyRpcConfig>(DEFAULTS)
  const [draft, setDraft] = useState<NotifyRpcConfig>(DEFAULTS)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Push routing (workspaces / Server酱 / bots) is its own section below.

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(draft), [config, draft])

  const refreshAssociation = async (): Promise<void> => {
    const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.configGet, {})
    if (!res.ok || !res.value || typeof res.value !== 'object') return
    const bot = (res.value as NotifyRpcConfig).channels?.wecomAibot
    if (!bot) return
    const merge = (current: NotifyRpcConfig): NotifyRpcConfig => ({
      ...current,
      channels: {
        ...current.channels,
        wecomAibot: {
          ...current.channels?.wecomAibot,
          enabled: bot.enabled,
          botId: bot.botId,
          secret: bot.secret,
        },
      },
    })
    setConfig(merge)
    setDraft(merge)
  }

  const fetchConfig = async (): Promise<void> => {
    const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.configGet, {})
    if (res.ok && res.value && typeof res.value === 'object') {
      setConfig(res.value as NotifyRpcConfig)
      setDraft(res.value as NotifyRpcConfig)
      setLoad({ status: 'ready' })
    } else if (!res.ok) {
      setLoad({ status: 'error', message: res.error?.message ?? 'failed to load config' })
    } else {
      setLoad({ status: 'error', message: 'config not available' })
    }
  }

  useEffect(() => { void fetchConfig() }, [])

  const setField = (path: string, value: unknown): void => {
    setDraft((d) => setAt({ ...d } as Record<string, unknown>, path, value) as NotifyRpcConfig)
    setSaveError(null)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    const res = await props.rpcCall(NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS.configSet, draft)
    if (res.ok) {
      // Re-seed from what the host accepted.
      const next = res.value ?? draft
      setConfig(next as NotifyRpcConfig)
      setDraft(next as NotifyRpcConfig)
    } else {
      setSaveError(res.error?.message ?? 'save failed')
    }
    setSaving(false)
  }

  const startOver = (): void => {
    setDraft(config)
    setSaveError(null)
  }

  const c = (path: string): unknown => getAt(draft as Record<string, unknown>, path)
  const cd = (path: string, fallback: boolean): boolean => {
    const v = c(path)
    return typeof v === 'boolean' ? v : fallback
  }
  const cs = (path: string, fallback = ''): string => {
    const v = c(path)
    return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : fallback)
  }
  const enabled = (): boolean => cd('enabled', true)

  if (load.status === 'loading') return <div className={css.page}><p className={css.status}>{t('loading')}</p></div>
  if (load.status === 'error') return <div className={css.page}><p className={css.status} role="alert">{t('loadError')}: {load.message}</p></div>

  const sysOn = cd('channels.system.enabled', true)
  const webhookOn = cd('channels.webhook.enabled', false)
  const wecomOn = cd('channels.wecom.enabled', false)
  const aibotOn = cd('channels.wecomAibot.enabled', false)
  const wechatOn = cd('channels.wechat.enabled', false)
  const telegramOn = cd('channels.telegram.enabled', false)

  return (
    <div className={css.page}>
      <p className={css.pageHint}>{t('pageHint')}</p>

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('notifyTitle')}</summary>
        <ToggleRow t={t} labelKey="enabled" hintKey="enabledHint" checked={enabled()} onChange={(v) => setField('enabled', v)} />
      </details>

      <PushRulesSection rpcCall={props.rpcCall} t={t} />

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('channelsSystem')}</summary>
        <ToggleRow t={t} labelKey="systemEnabled" hintKey="systemEnabledHint" checked={sysOn}
          disabled={!enabled()} onChange={(v) => setField('channels.system.enabled', v)} />
        <ToggleRow t={t} labelKey="systemSound" hintKey="systemSoundHint" checked={cd('channels.system.sound', true)}
          disabled={!enabled() || !sysOn} onChange={(v) => setField('channels.system.sound', v)} />
        <TextRow t={t} labelKey="systemSoundName" hintKey="systemSoundNameHint" placeholder="Glass"
          value={cs('channels.system.soundName')} disabled={!enabled()}
          onChange={(v) => setField('channels.system.soundName', v)} />
      </details>

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('channelsWebhook')}</summary>
        <ToggleRow t={t} labelKey="webhookEnabled" hintKey="webhookEnabledHint" checked={webhookOn}
          disabled={!enabled()} onChange={(v) => setField('channels.webhook.enabled', v)} />
        <TextRow t={t} labelKey="webhookUrl" hintKey="webhookUrlHint" placeholder="https://example.com/notify"
          value={cs('channels.webhook.url')} disabled={!enabled()}
          onChange={(v) => setField('channels.webhook.url', v)} />
      </details>

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('channelsWecom')}</summary>
        <ToggleRow t={t} labelKey="wecomEnabled" hintKey="wecomEnabledHint" checked={wecomOn}
          disabled={!enabled()} onChange={(v) => setField('channels.wecom.enabled', v)} />
        <TextRow t={t} labelKey="wecomWebhookUrl" hintKey="wecomWebhookUrlHint" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
          value={cs('channels.wecom.webhookUrl')} disabled={!enabled()} 
          onChange={(v) => setField('channels.wecom.webhookUrl', v)} />
        <SelectRow t={t} labelKey="wecomMsgType" options={['markdown', 'text']} value={cs('channels.wecom.msgType', 'markdown')}
          disabled={!enabled() || !wecomOn} onChange={(v) => setField('channels.wecom.msgType', v)} />
      </details>

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('channelsWechat')}</summary>
        <ToggleRow t={t} labelKey="wechatEnabled" hintKey="wechatEnabledHint" checked={wechatOn}
          disabled={!enabled()} onChange={(v) => setField('channels.wechat.enabled', v)} />
        <TextRow t={t} labelKey="wechatUserIds" hintKey="wechatUserIdsHint" placeholder="o9cq8…@im.wechat, o9cq8…@im.wechat"
          value={(() => { const v = c('channels.wechat.toUserIds'); return Array.isArray(v) ? v.join(', ') : '' })()}
          disabled={!enabled() || !wechatOn}
          onChange={(v) => setField('channels.wechat.toUserIds', v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))} />
        <ToggleRow t={t} labelKey="wechatInteractive" hintKey="wechatInteractiveHint" checked={cd('channels.wechat.interactive', true)}
          disabled={!enabled() || !wechatOn} onChange={(v) => setField('channels.wechat.interactive', v)} />
        <WeChatPanel rpcCall={props.rpcCall} t={t} enabled={enabled() && wechatOn} />
      </details>

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('channelsTelegram')}</summary>
        <ToggleRow t={t} labelKey="telegramEnabled" hintKey="telegramEnabledHint" checked={telegramOn}
          disabled={!enabled()} onChange={(v) => setField('channels.telegram.enabled', v)} />
        <TextRow t={t} labelKey="telegramToken" hintKey="telegramTokenHint" placeholder="123456:ABC-DEF…"
          value={cs('channels.telegram.botToken')} disabled={!enabled() || !telegramOn}
          onChange={(v) => setField('channels.telegram.botToken', v)} />
        <TextRow t={t} labelKey="telegramChatId" hintKey="telegramChatIdHint" placeholder="123456789"
          value={cs('channels.telegram.chatId')} disabled={!enabled() || !telegramOn}
          onChange={(v) => setField('channels.telegram.chatId', v)} />
        <SelectRow t={t} labelKey="telegramParseMode" options={['HTML', 'MarkdownV2', 'text']} value={cs('channels.telegram.parseMode', 'HTML')}
          disabled={!enabled() || !telegramOn} onChange={(v) => setField('channels.telegram.parseMode', v)} />
        <ToggleRow t={t} labelKey="telegramInteractive" hintKey="telegramInteractiveHint" checked={cd('channels.telegram.interactive', true)}
          disabled={!enabled() || !telegramOn} onChange={(v) => setField('channels.telegram.interactive', v)} />
      </details>

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('eventsTitle')}</summary>
        {(['conversationCompleted', 'conversationPaused', 'conversationFailed', 'authorizationRequired', 'confirmationRequired', 'todoProgress'] as const).map((key) => (
          <ToggleRow key={key} t={t} labelKey={key} hintKey={`${key}Hint`} checked={cd(`events.${key}`, true)}
            disabled={!enabled()} onChange={(v) => setField(`events.${key}`, v)} />
        ))}
        <ToggleRow t={t} labelKey="mainAgentOnly" hintKey="mainAgentOnlyHint" checked={cd('mainAgentOnly', true)}
          disabled={!enabled()} onChange={(v) => setField('mainAgentOnly', v)} />
      </details>

      <details className={css.section}>
        <summary className={css.sectionTitle}>{t('titlePrefix')}</summary>
        <TextRow t={t} labelKey="titlePrefix" hintKey="titlePrefixHint" placeholder="[MyApp]"
          value={cs('titlePrefix')} disabled={!enabled()}
          onChange={(v) => setField('titlePrefix', v)} />
      </details>

      <div className={css.footer}>
        {saveError ? <p className={css.failed} role="alert">{t('saveFailed')}: {saveError}</p> : null}
        <button type="button" className={css.discard} disabled={!dirty || saving} onClick={startOver}>{t('discard')}</button>
        <button type="button" className={css.save} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  )
}