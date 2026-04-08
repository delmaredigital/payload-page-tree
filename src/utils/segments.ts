import type { Payload, CollectionSlug } from 'payload'
import { slugify } from './getFolderPath.js'

/**
 * Re-export of slugify for clarity at call sites.
 * Use this when converting a display name to a URL segment.
 */
export const slugifyName = slugify

interface SegmentLookupOptions {
  payload: Payload
  parentId: string | number | null
  type: 'page' | 'folder'
  /** Required when type === 'page'. Ignored for folders. */
  collection?: string
  /** All page collections configured for the plugin. Used for folder-impact queries. */
  collections: string[]
  /** The folder collection slug. */
  folderSlug: string
  /** Exclude this record from collision checks (for self-edits). */
  excludeId?: string | number
}

/**
 * Returns all existing segments at the given parent level for the given type.
 * Single database query. Used internally by isSegmentAvailable and findAvailableSegment.
 */
async function getExistingSegments(opts: SegmentLookupOptions): Promise<string[]> {
  const { payload, parentId, type, collection, folderSlug, excludeId } = opts

  const targetCollection = type === 'folder' ? folderSlug : collection
  if (!targetCollection) {
    throw new Error('[segments] collection is required when type === "page"')
  }

  const segmentField = type === 'folder' ? 'pathSegment' : 'pageSegment'

  const folderClause = parentId
    ? { folder: { equals: parentId } }
    : { folder: { exists: false } }

  const where =
    excludeId !== undefined
      ? { and: [folderClause, { id: { not_equals: excludeId } }] }
      : folderClause

  const { docs } = await payload.find({
    collection: targetCollection as CollectionSlug,
    where,
    limit: 0,
    depth: 0,
  })

  return docs
    .map((d: Record<string, unknown>) => d[segmentField] as string | undefined)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => s.toLowerCase())
}

/**
 * Checks whether a specific segment is available at the given parent level.
 * Used by the edit-url and check-segment endpoints.
 */
export async function isSegmentAvailable(
  opts: SegmentLookupOptions & { segment: string },
): Promise<boolean> {
  const existing = await getExistingSegments(opts)
  return !existing.includes(opts.segment.toLowerCase())
}

/**
 * Returns an available segment, auto-incrementing if needed.
 * Convention (matches WordPress, Ghost):
 *   'thank-you' → 'thank-you' (if free)
 *   'thank-you' → 'thank-you-2' (if taken)
 *   'thank-you' → 'thank-you-3' (if both taken)
 * The '-1' suffix is skipped by convention.
 *
 * Used by the create and duplicate endpoints.
 */
export async function findAvailableSegment(
  opts: SegmentLookupOptions & { baseSegment: string },
): Promise<string> {
  const { baseSegment } = opts
  const safeBase = baseSegment && baseSegment.length > 0 ? baseSegment : 'untitled'

  const existing = new Set(await getExistingSegments(opts))

  if (!existing.has(safeBase.toLowerCase())) {
    return safeBase
  }

  // Try base-2, base-3, ... up to a sanity cap
  const MAX_ATTEMPTS = 1000
  for (let i = 2; i <= MAX_ATTEMPTS; i++) {
    const candidate = `${safeBase}-${i}`
    if (!existing.has(candidate.toLowerCase())) {
      return candidate
    }
  }

  throw new Error(
    `[segments] Could not find available segment for "${safeBase}" after ${MAX_ATTEMPTS} attempts`,
  )
}

/**
 * Counts all pages whose slugs would be affected if this folder's pathSegment changed.
 * Includes pages in nested subfolders. One recursive walk + one query per page collection.
 * Used by the folder-impact endpoint and the EditUrlModal cascade gate.
 *
 * IMPORTANT: this function does NOT swallow errors. If any per-collection query
 * fails, the error propagates. Silently undercounting would mislead the user
 * into approving a much larger cascade than they realize. The endpoint that
 * wraps this should return a 500 on failure, and the modal should refuse to
 * proceed when the count is unknown.
 */
export async function countDescendantPages(opts: {
  payload: Payload
  folderId: string | number
  collections: string[]
  folderSlug: string
}): Promise<number> {
  const { payload, folderId, collections, folderSlug } = opts

  // Recursively gather all child folder IDs (this folder + all descendants)
  const allFolderIds = await collectFolderAndDescendants(payload, folderId, folderSlug)

  let total = 0
  for (const collectionSlug of collections) {
    const { totalDocs } = await payload.find({
      collection: collectionSlug as CollectionSlug,
      where: {
        folder: { in: allFolderIds },
      },
      limit: 0,
      depth: 0,
    })
    total += totalDocs
  }

  return total
}

/**
 * Recursively collects a folder and all of its descendant folder IDs.
 */
async function collectFolderAndDescendants(
  payload: Payload,
  folderId: string | number,
  folderSlug: string,
): Promise<(string | number)[]> {
  const result: (string | number)[] = [folderId]

  const { docs } = await payload.find({
    collection: folderSlug as CollectionSlug,
    where: { folder: { equals: folderId } },
    limit: 0,
    depth: 0,
  })

  for (const child of docs) {
    const childId = (child as { id: string | number }).id
    const descendants = await collectFolderAndDescendants(payload, childId, folderSlug)
    result.push(...descendants)
  }

  return result
}
