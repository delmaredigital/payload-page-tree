import type { CollectionBeforeChangeHook } from 'payload'
import type { BuildSlugFn } from '../types.js'
import type { SlugChangeReason, SlugHistoryEntry } from '../types.js'
import { getFolderPath, slugify } from '../utils/getFolderPath.js'

interface BuildSlugOptions {
  folderSlug: string
  segmentFieldName: string
  pageSegmentFieldName: string
  folderFieldName: string
  buildSlug?: BuildSlugFn
}

/** Maximum number of slug history entries to keep per page */
const MAX_SLUG_HISTORY = 20

/**
 * Creates a beforeChange hook that auto-generates the slug from folder hierarchy
 *
 * Slug generation behavior:
 * - CREATE: Always generate slug from folder path + pageSegment
 * - UPDATE: Regenerate slug if folder or pageSegment changed, or if context.updateSlugs is true
 *
 * Slug history tracking:
 * - When a slug changes, the previous slug is added to slugHistory with timestamp and reason
 * - History is limited to MAX_SLUG_HISTORY entries (oldest are dropped)
 * - Reason comes from context.slugChangeReason or defaults to 'manual'
 *
 * This prevents breaking existing URLs when editing unrelated page content.
 * To force regenerate all slugs, use the /api/page-tree/regenerate-slugs endpoint or
 * choose "Update URLs" when moving folders in the tree view.
 */
export function createBuildSlugHook(options: BuildSlugOptions): CollectionBeforeChangeHook {
  const { folderSlug, segmentFieldName, pageSegmentFieldName, folderFieldName, buildSlug } = options

  return async ({ data, req, operation, originalDoc, context }) => {
    if (!data) return data

    // Skip slug generation entirely when restoring a slug manually
    if (context?.skipSlugGeneration) {
      return data
    }

    // Check if folder or pageSegment changed
    const getIdValue = (val: unknown): string | number | null | undefined => {
      if (val && typeof val === 'object' && 'id' in val) return (val as { id: string | number }).id
      return val as string | number | null | undefined
    }

    const newFolderId = getIdValue(data[folderFieldName])
    const originalFolderId = getIdValue(originalDoc?.[folderFieldName])
    // Only consider folder changed if data explicitly provides a different value.
    // Critically: data.folder=null from Payload's admin form is NOT a move to root —
    // it's a form serialization artifact. Only treat null as intentional when
    // we're in a tree operation (has slugChangeReason context).
    const folderChanged =
      newFolderId !== undefined &&
      newFolderId !== originalFolderId &&
      (newFolderId != null || !!context?.slugChangeReason)

    const newSegment = data[pageSegmentFieldName]
    const originalSegment = originalDoc?.[pageSegmentFieldName]
    const segmentChanged = newSegment !== undefined && newSegment !== originalSegment

    // Slug preservation logic:
    // 1. context.updateSlugs === false (explicit "Keep existing URL"): ALWAYS preserve slug
    // 2. context.updateSlugs === true (explicit "Update URL"): ALWAYS regenerate slug
    // 3. context.updateSlugs === undefined (default, e.g. Payload admin edit):
    //    regenerate only if folder or pageSegment changed
    if (operation === 'update' && originalDoc?.slug) {
      if (context?.updateSlugs === false) {
        // Explicit "Keep existing URL" — never touch the slug
        return data
      }
      if (context?.updateSlugs !== true && !folderChanged && !segmentChanged) {
        // Default behavior — preserve slug when nothing relevant changed
        return data
      }
    }

    // Get folder ID for path building.
    // Use the new folder only if it genuinely changed (tree move or admin UI folder edit).
    // Otherwise always use originalDoc to prevent losing folder path from form artifacts.
    const folderId = folderChanged ? newFolderId : (originalFolderId ?? newFolderId)

    // Get pageSegment - prefer data, fall back to originalDoc for cascade updates
    // Use loose check (!value) to catch undefined, null, and empty string
    let pageSegment = data[pageSegmentFieldName]
    if (!pageSegment && originalDoc?.[pageSegmentFieldName]) {
      pageSegment = originalDoc[pageSegmentFieldName]
    }
    // Only auto-generate from title on CREATE, or if truly no segment exists anywhere
    // This prevents overwriting an intentional segment with slugify(title) during moves/updates
    if (!pageSegment && data.title && (operation === 'create' || !originalDoc?.[pageSegmentFieldName])) {
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
    const defaultSlug = folderPath ? `${folderPath}/${pageSegment}` : pageSegment
    let newSlug: string
    if (buildSlug) {
      try {
        newSlug = await buildSlug({
          folderPath,
          pageSegment,
          doc: data,
          operation,
        })
      } catch (error) {
        console.error('[payload-page-tree] buildSlug callback error, falling back to default:', error)
        newSlug = defaultSlug
      }
      if (!newSlug) {
        newSlug = defaultSlug
      }
    } else {
      newSlug = defaultSlug
    }

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
