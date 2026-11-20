/**
 * Browser-side RPC contract for the notify configuration channel.
 *
 * The channel/endpoint strings and the config wire shape are DUPLICATED with
 * `src/notify-rpc.ts` / `src/types.ts` (the browser bundle cannot import a Host
 * file). Keep them in lockstep. The client calls a loopback-only channel on the
 * host `connection.rpc`; the host applies the write and persists it.
 */

/** Absolute logical channel the host registers (see src/notify-rpc.ts). */
export const NOTIFY_RPC_CHANNEL = '/dsh-notify'

/** Endpoint names (see src/notify-rpc.ts). */
export const NOTIFY_ENDPOINTS = Object.freeze({
  configGet: 'notify.config.get',
  configSet: 'notify.config.set',
  wechatStatus: 'notify.wechat.status',
  wechatRelogin: 'notify.wechat.relogin',
  wecomAibotStatus: 'notify.wecom-aibot.status',
  wecomAibotQrStart: 'notify.wecom-aibot.qr-start',
  workspaceRoutesGet: 'notify.workspace-routes.get',
  workspaceRoutesSet: 'notify.workspace-routes.set',
  rulesGet: 'notify.rules.get',
  rulesSet: 'notify.rules.set',
})

/** One workspace row returned by notify.workspace-routes.get. */
export interface WorkspaceRouteRow {
  title: string
  path: string
  mode: 'off' | 'status' | 'full'
  explicit: boolean
}

/** Payload of notify.workspace-routes.get / .set. */
export interface WorkspaceRoutesValue {
  workspaces: WorkspaceRouteRow[]
}

/** One channel block (企业微信 / Server酱). */
export interface ChannelRule {
  enabled: boolean
  events: string[]
  workspaces: string[]
  /** Per message type: which workspaces it covers (['*'] = every workspace). */
  scopes: Record<string, string[]>
}

/** One workspace bound to its own bot. */
export interface BindingRule {
  workspace: string
  bot: string
  events: string[]
}

/** Filterable event type. */
export interface EventDef {
  key: string
  label: string
}

/** One AI Bot entry as the host reports it. */
export interface AiBotRule {
  /** 显示名称（默认等于 id）。 */
  label: string
  id: string
  botId: string
  hasSecret: boolean
  interactive: boolean
  /** '' = 总机器人；否则是该机器人独占的工作区路径。 */
  workspace: string
  /** 该机器人转发哪些消息类型（仅分配工作区时生效）。 */
  events: string[]
  /** 连接状态：ready / connecting / error / disabled / missing。 */
  state?: string
  /** 连接失败原因（state === 'error' 时）。 */
  stateError?: string
}

/** Payload of notify.rules.get. */
export interface RulesValue {
  channels: { wecom: ChannelRule; serverchan: ChannelRule }
  bindings: BindingRule[]
  workspaces: Array<{ title: string; path: string }>
  events: EventDef[]
  aibots: AiBotRule[]
  /** 总机器人是否参与双向交互（命令 / 审批 / 提问）。 */
  mainInteractive: boolean
  serverchan: { enabled: boolean; hasKey: boolean; device: string; titleTemplate: string }
}

/** The notification config the settings page edits (see src/types.ts). */
export interface NotifyRpcConfig {
  enabled?: boolean
  channels?: {
    system?: { enabled?: boolean; sound?: boolean; soundName?: string; soundFile?: string; icon?: string }
    webhook?: { enabled?: boolean; url?: string; method?: 'POST' | 'PUT' | 'PATCH'; timeout?: number; headers?: Record<string, string> }
    wecom?: { enabled?: boolean; webhookUrl?: string; mentions?: string[]; msgType?: 'text' | 'markdown' }
    wecomAibot?: { enabled?: boolean; botId?: string; secret?: string; toChatIds?: string[]; interactive?: boolean; wsUrl?: string; sessionFile?: string }
    wechat?: { enabled?: boolean; toUserIds?: string[]; interactive?: boolean; sessionFile?: string; channelVersion?: string }
    telegram?: { enabled?: boolean; botToken?: string; chatId?: string; parseMode?: 'HTML' | 'MarkdownV2' | 'text'; disableNotification?: boolean; timeout?: number; interactive?: boolean }
  }
  events?: {
    conversationCompleted?: boolean
    conversationPaused?: boolean
    conversationFailed?: boolean
    authorizationRequired?: boolean
    confirmationRequired?: boolean
    todoProgress?: boolean
  }
  titlePrefix?: string
  /** Suppress subagent completion/TODO notifications (see src/types.ts). */
  mainAgentOnly?: boolean
}

/** WeChat ClawBot adapter status (see src/adapters/wechat.ts). */
export interface WeChatStatus {
  state: 'disabled' | 'login' | 'ready' | 'error'
  accountId?: string
  /** QR payload to encode and scan while state is 'login'. */
  qrContent?: string
  error?: string
  knownUsers: string[]
}

/** WeCom AI Bot adapter status (see src/service.ts). */
export interface WeComAiBotStatus {
  state: 'disabled' | 'connecting' | 'ready' | 'error'
  error?: string
  knownChats: string[]
  qr: {
    phase: 'idle' | 'pending' | 'error'
    /** URL to render as a QR code while phase is 'pending'. */
    authUrl?: string
    error?: string
  }
}

/** The unary RPC result shape the host connection returns. */
export interface NotifyRpcResult {
  ok: boolean
  value?: unknown
  error?: { message?: string }
}

/** The connection.rpc.call face the settings page injects. */
export interface NotifyRpcCall {
  (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<NotifyRpcResult>
}