import { createRequire } from 'node:module'

export type WindowsPathRegistryRead = {
  failed: boolean
  value: string | null
}

type RegistryValue = {
  type?: unknown
  value?: unknown
}

type WindowsRegistryModule = {
  HK: { CU: number; LM: number }
  getRegistryKey: (
    root: number,
    path: string
  ) => Record<string, RegistryValue | undefined> | null | undefined
}

const REG_SZ = 1
const REG_EXPAND_SZ = 2
const MACHINE_ENVIRONMENT_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_ENVIRONMENT_KEY = 'Environment'
const PATH_VALUE = 'Path'
const requireFromMain = createRequire(__filename)

let windowsRegistryLoader = (): WindowsRegistryModule =>
  requireFromMain('windows-native-registry') as WindowsRegistryModule

function readRegistryPath(
  registry: WindowsRegistryModule,
  root: number,
  key: string
): WindowsPathRegistryRead {
  try {
    const values = registry.getRegistryKey(root, key)
    if (!values || typeof values !== 'object') {
      return { failed: true, value: null }
    }
    const entry = Object.entries(values).find(
      ([name]) => name.toLowerCase() === PATH_VALUE.toLowerCase()
    )?.[1]
    if (!entry) {
      return { failed: true, value: null }
    }
    if (
      (entry.type !== REG_SZ && entry.type !== REG_EXPAND_SZ) ||
      typeof entry.value !== 'string'
    ) {
      return { failed: true, value: null }
    }
    return { failed: false, value: entry.value }
  } catch {
    return { failed: true, value: null }
  }
}

export function readWindowsPathRegistry(): WindowsPathRegistryRead[] {
  let registry: WindowsRegistryModule
  try {
    registry = windowsRegistryLoader()
  } catch {
    return [
      { failed: true, value: null },
      { failed: true, value: null }
    ]
  }
  return [
    readRegistryPath(registry, registry.HK.LM, MACHINE_ENVIRONMENT_KEY),
    readRegistryPath(registry, registry.HK.CU, USER_ENVIRONMENT_KEY)
  ]
}

export function __setWindowsPathRegistryLoaderForTests(loader?: () => WindowsRegistryModule): void {
  windowsRegistryLoader =
    loader ?? (() => requireFromMain('windows-native-registry') as WindowsRegistryModule)
}
