import { APIError } from 'payload'
import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, CollectionSlug, PayloadRequest } from 'payload'
import { cascadeAccess, trustedRead, userRead } from '../utils/readAccess.js'
import type { FolderDocument } from '../types.js'

interface CascadeOptions {
  collections: string[]
  folderSlug: string
  segmentFieldName: string
  folderFieldName: string
}

type CascadeTarget = { collection: CollectionSlug; id: string | number }

/** Trashed documents keep their folder, so restoring them must not bring back a stale URL. */
function trashOptions(req: PayloadRequest, collection: string) {
  return req.payload.collections?.[collection as CollectionSlug]?.config.trash ? { trash: true } : {}
}

async function inventoryPages(id: string | number, req: PayloadRequest, options: CascadeOptions): Promise<CascadeTarget[]> {
  const childFolderIds = await getAllChildFolderIds(id, req, options.folderSlug)
  const targets: CascadeTarget[] = []
  for (const collection of options.collections) {
    const { docs } = await req.payload.find({
      collection: collection as CollectionSlug,
      where: { [options.folderFieldName]: { in: [id, ...childFolderIds] } },
      limit: 0,
      depth: 0,
      ...trashOptions(req, collection),
      ...trustedRead(req),
    })
    targets.push(...docs.map(page => ({ collection: collection as CollectionSlug, id: page.id })))
  }
  return targets
}

async function preflightPages(targets: CascadeTarget[], req: PayloadRequest) {
  if (!req.user) return
  for (const target of targets) {
    try {
      await req.payload.findByID({ ...target, depth: 0, ...trashOptions(req, target.collection), ...userRead(req) })
    } catch (error) {
      const status = (error as { status?: number } | null)?.status
      if (status !== 403 && status !== 404) throw error
      throw new APIError('Cannot change the URL of a folder containing pages you cannot edit', 403)
    }
  }
}

/** Check READ before the folder itself is written, including without transactions. */
export function createCascadeSlugPreflightHook(options: CascadeOptions): CollectionBeforeChangeHook {
  return async ({ data, originalDoc, req, context }) => {
    if (!req.user || context?.cascading || !context?.updateSlugs || !originalDoc) return data
    const doc = { ...originalDoc, ...data }
    if (doc[options.segmentFieldName] === originalDoc[options.segmentFieldName] &&
      getParentId(doc.folder) === getParentId(originalDoc.folder)) return data
    await preflightPages(await inventoryPages(originalDoc.id, req, options), req)
    return data
  }
}

/**
 * Creates an afterChange hook for folders that cascades slug updates to all affected pages
 * when a folder's pathSegment changes or it's moved to a different parent.
 *
 * IMPORTANT: Cascade only runs when context.updateSlugs is true.
 * This prevents accidental URL changes when folders are edited through Payload's standard UI.
 * To update slugs, use the tree view's "Update URLs" option or the /api/page-tree/regenerate-slugs endpoint.
 */
export function createCascadeSlugUpdatesHook(
  options: CascadeOptions,
): CollectionAfterChangeHook<FolderDocument> {
  const { segmentFieldName } = options

  return async ({ doc, previousDoc, req, context }) => {
    // Prevent infinite loops - check if we're already cascading
    if (context?.cascading) return doc

    // Only cascade if explicitly requested
    // This prevents breaking URLs when folders are edited via Payload's standard UI
    if (!context?.updateSlugs) return doc

    // Check if pathSegment changed or parent folder changed
    const segmentChanged = (doc as unknown as Record<string, unknown>)[segmentFieldName] !==
      (previousDoc as unknown as Record<string, unknown> | undefined)?.[segmentFieldName]
    const parentChanged = getParentId(doc.folder) !== getParentId(previousDoc?.folder)

    if (!segmentChanged && !parentChanged) {
      return doc
    }

    // Inventory every collection before writing. Recheck READ for the actual
    // targets even if another hook changed the subtree since beforeChange.
    const targets = await inventoryPages(doc.id, req, options)
    await preflightPages(targets, req)
    for (const target of targets) {
      // Keep the original request so failures roll back the folder transaction.
      await req.payload.update({
        ...target,
        ...trashOptions(req, target.collection),
        data: {}, // Empty update triggers beforeChange hook
        context: {
          cascading: true,
          updateSlugs: true,
          slugChangeReason: context?.slugChangeReason || (parentChanged ? 'move' : 'edit-url'),
        },
        ...cascadeAccess(req),
      })
    }

    return doc
  }
}

/**
 * Recursively finds all child folder IDs
 */
async function getAllChildFolderIds(
  parentId: number | string,
  req: PayloadRequest,
  folderSlug: string,
): Promise<(number | string)[]> {
  const result = await req.payload.find({
    collection: folderSlug as CollectionSlug,
    where: {
      folder: {
        equals: parentId,
      },
    },
    limit: 0,
    depth: 0,
    // Live folders only: getFolderPath cannot resolve a trashed ancestor, so
    // regenerating pages beneath one would drop its segment from their URLs.
    ...trustedRead(req),
  })

  const children = result.docs as unknown as FolderDocument[]
  const childIds = children.map((child) => child.id)

  // Recursively get grandchildren
  const grandchildIds: (number | string)[] = []
  for (const childId of childIds) {
    const descendants = await getAllChildFolderIds(childId, req, folderSlug)
    grandchildIds.push(...descendants)
  }

  return [...childIds, ...grandchildIds]
}

/**
 * Helper to extract parent folder ID from potentially populated field
 */
function getParentId(
  folder: number | string | FolderDocument | null | undefined,
): number | string | null {
  if (!folder) return null
  if (typeof folder === 'object') return folder.id
  return folder
}
