import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

type RuntimeStatusHydrationDependencies = {
  listEnvironments: () => Promise<PublicKnownRuntimeEnvironment[]>
  getCurrentEnvironments: () => PublicKnownRuntimeEnvironment[]
  publishEnvironments: (environments: PublicKnownRuntimeEnvironment[]) => void
  refreshEnvironmentStatus: (environmentId: string) => Promise<boolean>
  markCatalogSettled: () => void
}

function environmentRevisions(
  environments: PublicKnownRuntimeEnvironment[]
): ReadonlyMap<string, number> {
  return new Map(
    environments.map((environment) => [
      environment.id,
      environment.pairingRevision ?? environment.createdAt
    ])
  )
}

function revisionsMatch(
  environments: PublicKnownRuntimeEnvironment[],
  expected: ReadonlyMap<string, number>
): boolean {
  const current = environmentRevisions(environments)
  if (current.size !== expected.size) {
    return false
  }
  for (const [environmentId, revision] of current) {
    if (expected.get(environmentId) !== revision) {
      return false
    }
  }
  return true
}

export function createRuntimeStatusHydration({
  listEnvironments,
  getCurrentEnvironments,
  publishEnvironments,
  refreshEnvironmentStatus,
  markCatalogSettled
}: RuntimeStatusHydrationDependencies): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  let expectedRevisions: ReadonlyMap<string, number> | null = null
  let rerunRequested = false

  return () => {
    if (inFlight) {
      if (expectedRevisions && !revisionsMatch(getCurrentEnvironments(), expectedRevisions)) {
        rerunRequested = true
      }
      return inFlight
    }
    const hydration = (async (): Promise<void> => {
      // Catalog changes queue a current-catalog pass without duplicating stable overlaps.
      do {
        rerunRequested = false
        const revisionsAtListStart = environmentRevisions(getCurrentEnvironments())
        expectedRevisions = revisionsAtListStart
        let environments: PublicKnownRuntimeEnvironment[]
        try {
          environments = await listEnvironments()
        } catch (err) {
          console.error('Failed to list runtime environments for status hydration:', err)
          markCatalogSettled()
          return
        }
        if (!revisionsMatch(getCurrentEnvironments(), revisionsAtListStart)) {
          rerunRequested = true
          continue
        }
        expectedRevisions = environmentRevisions(environments)
        publishEnvironments(environments)
        await Promise.allSettled(
          environments.map((environment) => refreshEnvironmentStatus(environment.id))
        )
      } while (
        rerunRequested ||
        (expectedRevisions && !revisionsMatch(getCurrentEnvironments(), expectedRevisions))
      )
    })()
    inFlight = hydration.finally(() => {
      inFlight = null
      expectedRevisions = null
      rerunRequested = false
    })
    return inFlight
  }
}
