import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  bumpRuntimeClientEventSubscriptionGeneration,
  createRuntimeClientEventSubscriptionInvalidationGate
} from './runtime-client-event-subscription-invalidation'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { createTestStore } from '@/store/slices/store-test-helpers'

type InputState = Pick<
  AppState,
  'runtimeEnvironments' | 'runtimeStatusByEnvironmentId' | 'settings'
>

function createState(): InputState {
  return {
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    settings: null
  }
}

describe('runtime client-event subscription invalidation', () => {
  it('ignores publications that preserve every subscription input', () => {
    const state = createState()
    const gate = createRuntimeClientEventSubscriptionInvalidationGate(state)

    expect(gate.changed(state)).toBe(false)
    expect(gate.changed({ ...state })).toBe(false)
  })

  it('detects catalog, status, and normalized active-environment changes', () => {
    const initial = createState()
    const gate = createRuntimeClientEventSubscriptionInvalidationGate(initial)
    const catalogChanged = { ...initial, runtimeEnvironments: [...initial.runtimeEnvironments] }
    expect(gate.changed(catalogChanged)).toBe(true)

    const statusChanged = {
      ...catalogChanged,
      runtimeStatusByEnvironmentId: new Map(catalogChanged.runtimeStatusByEnvironmentId)
    }
    expect(gate.changed(statusChanged)).toBe(true)

    const activeChanged = {
      ...statusChanged,
      settings: { activeRuntimeEnvironmentId: ' env-1 ' } as AppState['settings']
    }
    expect(gate.changed(activeChanged)).toBe(true)
    expect(
      gate.changed({
        ...activeChanged,
        settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
      })
    ).toBe(false)
  })

  it('detects out-of-store generation changes with identical Zustand references', () => {
    const state = createState()
    const gate = createRuntimeClientEventSubscriptionInvalidationGate(state)

    bumpRuntimeClientEventSubscriptionGeneration()

    expect(gate.changed(state)).toBe(true)
    expect(gate.changed(state)).toBe(false)
  })

  it('tracks silent runtime and nested SSH generation advances', () => {
    const store = createTestStore()
    const initial = store.getState()
    const gate = createRuntimeClientEventSubscriptionInvalidationGate(initial)

    initial.clearRuntimeEnvironmentStatus('missing')
    expect(store.getState()).toBe(initial)
    expect(gate.changed(store.getState())).toBe(true)

    initial.markEnvironmentSshStateStale('missing')
    expect(store.getState()).toBe(initial)
    expect(gate.changed(store.getState())).toBe(true)
  })

  it('tracks pairing revision replacement without relying on Zustand identity', () => {
    const state = createState()
    const gate = createRuntimeClientEventSubscriptionInvalidationGate(state)

    replaceRuntimeEnvironmentRevisions([])

    expect(gate.changed(state)).toBe(true)
  })
})
