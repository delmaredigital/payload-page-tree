import type { Payload } from 'payload'
import type { BuildSlugArgs, BuildSlugFn } from '../types.js'
import { getFolderPath } from './getFolderPath.js'

/** Shared by slug writes and availability probes, including custom callback fallbacks. */
export async function buildPageSlug(options: {
  payload: Payload
  folderId: string | number | null | undefined
  folderSlug: string
  segmentFieldName: string
  pageSegment: string
  doc: Record<string, unknown>
  operation: BuildSlugArgs['operation']
  buildSlug?: BuildSlugFn
}): Promise<string> {
  const { payload, folderId, folderSlug, segmentFieldName, pageSegment, doc, operation, buildSlug } = options
  const folderPath = await getFolderPath(folderId, payload, folderSlug, segmentFieldName)
  const defaultSlug = folderPath ? `${folderPath}/${pageSegment}` : pageSegment

  if (buildSlug) {
    try {
      return (await buildSlug({ folderPath, pageSegment, doc, operation })) || defaultSlug
    } catch (error) {
      console.error('[payload-page-tree] buildSlug callback error, falling back to default:', error)
    }
  }
  return defaultSlug
}
