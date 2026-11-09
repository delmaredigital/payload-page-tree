import type { CollectionSlug, Payload } from 'payload'
import type { FolderDocument } from '../types.js'
import { readAccessOptions, type ReadAccessOptions } from './readAccess.js'

/**
 * Recursively traverses the folder hierarchy to build the full URL path
 * @param folderId - The ID of the folder to start from
 * @param payload - Payload instance for database queries
 * @param folderSlug - The slug of the folders collection
 * @param segmentFieldName - The field name for the path segment
 * @param options - Optional req/overrideAccess. With req, READ rules apply by default;
 * without req, trusted server calls retain their legacy overrideAccess: true.
 * @returns The full path string (e.g., "appeals/2024/spring")
 */
export async function getFolderPath(
  folderId: number | string | null | undefined,
  payload: Payload,
  folderSlug: string = 'payload-folders',
  segmentFieldName: string = 'pathSegment',
  options: ReadAccessOptions = {},
): Promise<string> {
  if (!folderId) return ''

  try {
    const folder = (await payload.findByID({
      ...readAccessOptions(options),
      collection: folderSlug as CollectionSlug,
      id: folderId,
      depth: 0,
    })) as FolderDocument

    if (!folder) return ''

    const segment = folder[segmentFieldName as keyof FolderDocument] as string | undefined

    // Get parent folder ID - handle both populated and unpopulated cases
    const parentFolderId =
      typeof folder.folder === 'object' && folder.folder !== null
        ? folder.folder.id
        : folder.folder

    // Recursively get parent path
    const parentPath = await getFolderPath(parentFolderId, payload, folderSlug, segmentFieldName, options)

    // Combine parent path with current segment
    return [parentPath, segment].filter(Boolean).join('/')
  } catch (error) {
    console.error(`[payload-page-tree] Error fetching folder ${folderId}:`, error)
    return ''
  }
}

/**
 * Slugifies a string for use in URLs
 * @param text - The text to slugify
 * @returns URL-safe slug
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove non-word characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
}
