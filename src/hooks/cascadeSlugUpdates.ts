import type { CollectionAfterChangeHook, CollectionSlug, PayloadRequest } from 'payload'
import type { FolderDocument } from '../types.js'

interface CascadeOptions {
  collections: string[]
  folderSlug: string
  segmentFieldName: string
  folderFieldName: string
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
  const { collections, folderSlug, folderFieldName } = options

  return async ({ doc, previousDoc, req, context }) => {
    // Prevent infinite loops - check if we're already cascading
    if (context?.cascading) return doc

    // Only cascade if explicitly requested
    // This prevents breaking URLs when folders are edited via Payload's standard UI
    if (!context?.updateSlugs) return doc

    // Check if pathSegment changed or parent folder changed
    const segmentChanged = doc.pathSegment !== previousDoc?.pathSegment
    const parentChanged = getParentId(doc.folder) !== getParentId(previousDoc?.folder)

    if (!segmentChanged && !parentChanged) {
      return doc
    }

    // Find all folders that are children of this folder (at any depth)
    const childFolderIds = await getAllChildFolderIds(doc.id, req, folderSlug)
    const allAffectedFolderIds = [doc.id, ...childFolderIds]

    // Update all pages in affected folders
    for (const collectionSlug of collections) {
      try {
        // Find all pages in any of the affected folders.
        // Pass `req` so this runs in the same transaction as the folder update;
        // otherwise Postgres deadlocks against the row lock the outer txn holds.
        const { docs: pages } = await req.payload.find({
          collection: collectionSlug as CollectionSlug,
          where: {
            [folderFieldName]: {
              in: allAffectedFolderIds,
            },
          },
          limit: 0, // Get all
          depth: 0,
          req,
        })

        // Re-save each page to trigger slug regeneration
        for (const page of pages) {
          await req.payload.update({
            collection: collectionSlug as CollectionSlug,
            id: page.id,
            data: {}, // Empty update triggers beforeChange hook
            context: { cascading: true, updateSlugs: true }, // Prevent loops + enable regeneration
            req,
          })
        }

      } catch (error) {
        console.error(
          `[payload-page-tree] Error updating ${collectionSlug} slugs after folder change:`,
          error,
        )
      }
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
    req,
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
