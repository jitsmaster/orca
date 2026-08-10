import { useRef } from 'react'
import { getActiveOptionId, type ActiveOption } from './tab-create-entry-active-option'

type NetworkSelectionArgs = {
  activeOptions: ActiveOption[]
  fileIndexReady: boolean
  forcedSearch: boolean
  menuOpen: boolean
  pinnedOptionId: string | null
  query: string
}

export function useNetworkSafeTabEntrySelection({
  activeOptions,
  fileIndexReady,
  forcedSearch,
  menuOpen,
  pinnedOptionId,
  query
}: NetworkSelectionArgs): {
  activeSelectedIndex: number | null
  selectedActiveOption: ActiveOption | undefined
} {
  const pinnedOptionIndex = pinnedOptionId
    ? activeOptions.findIndex((option) => getActiveOptionId(option) === pinnedOptionId)
    : -1
  const policyRef = useRef({ allowed: fileIndexReady, fileIndexReady, menuOpen, query })
  const policy = policyRef.current
  let networkActionAllowed =
    policy.fileIndexReady === fileIndexReady &&
    policy.menuOpen === menuOpen &&
    policy.query === query
      ? policy.allowed
      : fileIndexReady
  const rankedOption = pinnedOptionIndex < 0 ? activeOptions[0] : undefined
  const rankedNetworkAction =
    !forcedSearch &&
    rankedOption?.kind === 'entry' &&
    (rankedOption.option.classification.kind === 'search' ||
      rankedOption.option.classification.kind === 'host-url')
  if (rankedOption && !rankedNetworkAction && networkActionAllowed) {
    networkActionAllowed = false
  }
  if (
    policy.allowed !== networkActionAllowed ||
    policy.fileIndexReady !== fileIndexReady ||
    policy.menuOpen !== menuOpen ||
    policy.query !== query
  ) {
    policyRef.current = { allowed: networkActionAllowed, fileIndexReady, menuOpen, query }
  }
  const activeSelectedIndex =
    pinnedOptionIndex >= 0
      ? pinnedOptionIndex
      : activeOptions.length === 0 || (rankedNetworkAction && !networkActionAllowed)
        ? null
        : 0
  return {
    activeSelectedIndex,
    selectedActiveOption:
      activeSelectedIndex === null ? undefined : activeOptions[activeSelectedIndex]
  }
}
