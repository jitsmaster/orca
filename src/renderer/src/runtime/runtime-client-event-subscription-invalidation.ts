import type { AppState } from '@/store/types'

type RuntimeClientEventSubscriptionState = Pick<
  AppState,
  'runtimeEnvironments' | 'runtimeStatusByEnvironmentId' | 'settings'
>

let subscriptionGeneration = 0

/** Invalidates the store gate when an out-of-Zustand key component changes. */
export function bumpRuntimeClientEventSubscriptionGeneration(): void {
  subscriptionGeneration += 1
}

export function createRuntimeClientEventSubscriptionInvalidationGate(
  initialState: RuntimeClientEventSubscriptionState
): { changed: (state: RuntimeClientEventSubscriptionState) => boolean } {
  let activeEnvironmentId = initialState.settings?.activeRuntimeEnvironmentId?.trim() || null
  let environments = initialState.runtimeEnvironments
  let generation = subscriptionGeneration
  let statuses = initialState.runtimeStatusByEnvironmentId
  return {
    changed: (state) => {
      const nextActiveEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim() || null
      if (
        activeEnvironmentId === nextActiveEnvironmentId &&
        environments === state.runtimeEnvironments &&
        generation === subscriptionGeneration &&
        statuses === state.runtimeStatusByEnvironmentId
      ) {
        return false
      }
      activeEnvironmentId = nextActiveEnvironmentId
      environments = state.runtimeEnvironments
      generation = subscriptionGeneration
      statuses = state.runtimeStatusByEnvironmentId
      return true
    }
  }
}
