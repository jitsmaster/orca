import { useState } from 'react'
import { getActiveOptionId, type ActiveOption } from './tab-create-entry-active-option'

type NetworkSelectionArgs = {
  activeOptions: ActiveOption[]
  forcedSearch: boolean
  menuOpen: boolean
  pinnedOptionId: string | null
  query: string
}

export function useNetworkSafeTabEntrySelection({
  activeOptions,
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
  const [policy, setPolicy] = useState({ allowed: true, menuOpen, query })
  let ordinarySearchAllowed =
    policy.menuOpen === menuOpen && policy.query === query ? policy.allowed : true
  const rankedOption = pinnedOptionIndex < 0 ? activeOptions[0] : undefined
  const rankedOrdinarySearch =
    !forcedSearch &&
    rankedOption?.kind === 'entry' &&
    rankedOption.option.classification.kind === 'search'
  if (rankedOption && !rankedOrdinarySearch && ordinarySearchAllowed) {
    ordinarySearchAllowed = false
  }
  if (
    policy.allowed !== ordinarySearchAllowed ||
    policy.menuOpen !== menuOpen ||
    policy.query !== query
  ) {
    setPolicy({ allowed: ordinarySearchAllowed, menuOpen, query })
  }
  const activeSelectedIndex =
    pinnedOptionIndex >= 0
      ? pinnedOptionIndex
      : activeOptions.length === 0 || (rankedOrdinarySearch && !ordinarySearchAllowed)
        ? null
        : 0
  return {
    activeSelectedIndex,
    selectedActiveOption:
      activeSelectedIndex === null ? undefined : activeOptions[activeSelectedIndex]
  }
}
