import type { Payload } from 'payload'
import type { BuildSlugArgs, BuildSlugFn } from '../types.js'
import { getFolderPath } from './getFolderPath.js'
import { trustedRead, type ReadAccessOptions } from './readAccess.js'

/** Build stored slugs with complete ancestry, independent of the editor's READ rights. */
export async function buildPageSlug(options: {
  payload: Payload
  folderId: string | number | null | undefined
  folderSlug: string
  segmentFieldName: string
  pageSegment: string
  doc: Record<string, unknown>
  operation: BuildSlugArgs['operation']
  buildSlug?: BuildSlugFn
} & ReadAccessOptions): Promise<string> {
  const { payload, folderId, folderSlug, segmentFieldName, pageSegment, doc, operation, buildSlug } = options
  const folderPath = await getFolderPath(folderId, payload, folderSlug, segmentFieldName, trustedRead(options.req))
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
