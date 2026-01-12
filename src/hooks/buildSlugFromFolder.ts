import type { CollectionBeforeChangeHook } from 'payload'
import type { SlugChangeReason, SlugHistoryEntry } from '../types.js'
import { getFolderPath, slugify } from '../utils/getFolderPath.js'

interface BuildSlugOptions {
  folderSlug: string
  segmentFieldName: string
  pageSegmentFieldName: string
  folderFieldName: string
}

/** Maximum number of slug history entries to keep per page */
const MAX_SLUG_HISTORY = 20

/**
 * Creates a beforeChange hook that auto-generates the slug from folder hierarchy
 *
 * Slug generation behavior:
 * - CREATE: Always generate slug from folder path + pageSegment
 * - UPDATE: Only regenerate if context.updateSlugs is true, otherwise preserve existing slug
 *
 * Slug history tracking:
 * - When a slug changes, the previous slug is added to slugHistory with timestamp and reason
 * - History is limited to MAX_SLUG_HISTORY entries (oldest are dropped)
 * - Reason comes from context.slugChangeReason or defaults to 'manual'
 *
 * This prevents breaking existing URLs when folders are reorganized or pages are edited.
 * To regenerate slugs, use the /api/page-tree/regenerate-slugs endpoint or
 * choose "Update URLs" when moving folders in the tree view.
 */
export function createBuildSlugHook(options: BuildSlugOptions): CollectionBeforeChangeHook {
  const { folderSlug, segmentFieldName, pageSegmentFieldName, folderFieldName } = options

  return async ({ data, req, operation, originalDoc, context }) => {
    if (!data) return data

    // Skip slug generation entirely when restoring a slug manually
    if (context?.skipSlugGeneration) {
      return data
    }

    // Preserve existing slugs on update unless explicitly requested to regenerate
    // This prevents breaking URLs when editing pages or reorganizing folders
    if (operation === 'update' && originalDoc?.slug && !context?.updateSlugs) {
      return data
    }

    // Get the folder ID - handle both populated and unpopulated cases
    const folderId =
      typeof data[folderFieldName] === 'object' && data[folderFieldName] !== null
        ? data[folderFieldName].id
        : data[folderFieldName]

    // Get the page segment - use provided value or generate from title
    let pageSegment = data[pageSegmentFieldName]
    if (!pageSegment && data.title) {
      pageSegment = slugify(data.title)
      data[pageSegmentFieldName] = pageSegment
    }

    // If no segment at all, we can't build a slug
    if (!pageSegment) {
      return data
    }

    // Get the folder path
    const folderPath = await getFolderPath(folderId, req.payload, folderSlug, segmentFieldName)

    // Build the full slug
    const newSlug = folderPath ? `${folderPath}/${pageSegment}` : pageSegment

    // Track slug history if slug is changing on an existing document
    if (operation === 'update' && originalDoc?.slug && originalDoc.slug !== newSlug) {
      const reason: SlugChangeReason = (context?.slugChangeReason as SlugChangeReason) || 'manual'
      const historyEntry: SlugHistoryEntry = {
        slug: originalDoc.slug,
        changedAt: new Date().toISOString(),
        reason,
      }

      // Prepend new entry and keep only MAX_SLUG_HISTORY entries
      const existingHistory: SlugHistoryEntry[] = originalDoc.slugHistory || []
      data.slugHistory = [historyEntry, ...existingHistory].slice(0, MAX_SLUG_HISTORY)
    }

    // Update slug if changed
    if (data.slug !== newSlug) {
      data.slug = newSlug
    }

    return data
  }
}
