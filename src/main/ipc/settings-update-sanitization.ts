import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { sanitizeFloatingWorkspaceDirectorySetting } from './floating-workspace-directory'
import { normalizeProxyBypassRules, normalizeProxyUrl } from '../../shared/network-proxy'
import { normalizeAppIconId } from '../../shared/app-icon'
import { normalizeUiLanguage } from '../../shared/ui-language'
import { normalizeTerminalCustomThemes } from '../../shared/terminal-custom-themes'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'
import { normalizeTerminalLineHeight } from '../../shared/terminal-line-height-settings'
import { normalizeIdleAgentCleanupIntervalMs } from '../../shared/idle-agent-cleanup-interval-policy'
import {
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../shared/mobile-pairing-custom-address'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode
} from '../../shared/computer-awake-mode'

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

export function sanitizeRendererSettingsUpdate(
  args: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedArgs } =
    args as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  // Plugin consent and enablement are main-owned authority state. Renderer
  // writes must pass the dedicated reviewed-fingerprint handlers.
  delete sanitizedArgs.pluginConsents
  delete sanitizedArgs.disabledPlugins
  return sanitizedArgs
}

/**
 * Applies every per-key normalizer to a `settings:set` payload, mutating
 * `sanitizedArgs` in place. Split out of the IPC handler purely to keep
 * `settings.ts` under the repo's max-lines limit — this is the same chain of
 * `if (key in args) sanitizedArgs.key = normalizeKey(args.key)` calls that
 * used to live inline there.
 */
export async function applySettingsUpdateNormalizations(
  store: Store,
  args: Partial<GlobalSettings>,
  sanitizedArgs: Partial<GlobalSettings>
): Promise<void> {
  // Why: connection/navigation code receives the generic settings writer; the
  // durable server preference has a dedicated Advanced-control boundary.
  delete sanitizedArgs.activeRuntimeEnvironmentId
  // Why: Floating Workspace grants are trusted only when written by the
  // main-process directory picker, never by renderer-provided settings IPC.
  delete sanitizedArgs.floatingTerminalTrustedCwds
  if ('computerAwakeMode' in sanitizedArgs) {
    Object.assign(
      sanitizedArgs,
      computerAwakeSettingsForMode(
        normalizeComputerAwakeMode(
          sanitizedArgs.computerAwakeMode,
          sanitizedArgs.keepComputerAwakeWhileAgentsRun
        )
      )
    )
  } else if ('keepComputerAwakeWhileAgentsRun' in sanitizedArgs) {
    Object.assign(
      sanitizedArgs,
      computerAwakeSettingsForMode(sanitizedArgs.keepComputerAwakeWhileAgentsRun ? 'auto' : 'off')
    )
  }
  if (typeof args.floatingTerminalCwd === 'string') {
    sanitizedArgs.floatingTerminalCwd = await sanitizeFloatingWorkspaceDirectorySetting(
      store,
      args.floatingTerminalCwd
    )
  }
  if ('httpProxyUrl' in args) {
    const proxyUrl = normalizeProxyUrl(args.httpProxyUrl)
    sanitizedArgs.httpProxyUrl = proxyUrl.ok ? proxyUrl.value : ''
  }
  if ('httpProxyBypassRules' in args) {
    sanitizedArgs.httpProxyBypassRules = normalizeProxyBypassRules(args.httpProxyBypassRules)
  }
  if ('appIcon' in args) {
    sanitizedArgs.appIcon = normalizeAppIconId(args.appIcon)
  }
  if ('terminalCustomThemes' in args) {
    sanitizedArgs.terminalCustomThemes = normalizeTerminalCustomThemes(args.terminalCustomThemes)
  }
  if ('terminalScrollbackRows' in args) {
    sanitizedArgs.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
      args.terminalScrollbackRows
    )
  }
  if ('terminalLineHeight' in args) {
    sanitizedArgs.terminalLineHeight = normalizeTerminalLineHeight(args.terminalLineHeight)
  }
  if ('idleAgentCleanupIntervalMs' in args) {
    sanitizedArgs.idleAgentCleanupIntervalMs = normalizeIdleAgentCleanupIntervalMs(
      args.idleAgentCleanupIntervalMs
    )
  }
  if ('uiLanguage' in args) {
    sanitizedArgs.uiLanguage = normalizeUiLanguage(args.uiLanguage)
  }
  if ('mobilePairingCustomAddress' in args) {
    sanitizedArgs.mobilePairingCustomAddress = normalizeMobilePairingCustomAddress(
      args.mobilePairingCustomAddress
    )
  }
  if ('mobilePairingCustomAddresses' in args) {
    sanitizedArgs.mobilePairingCustomAddresses = normalizeMobilePairingCustomAddresses(
      args.mobilePairingCustomAddresses
    )
  }
}
