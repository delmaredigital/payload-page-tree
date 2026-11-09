import { commitTransaction, initTransaction, killTransaction } from 'payload'
import type { PayloadHandler, CollectionSlug, PayloadRequest } from 'payload'
import type { MovePayload, ReorderPayload, CreatePayload, BuildSlugFn } from '../types.js'
import { trustedRead, userRead } from '../utils/readAccess.js'
import { slugify } from '../utils/getFolderPath.js'
import {
  findAvailableSegment,
  isSegmentAvailable,
  countDescendantPages,
  slugifyName,
} from '../utils/segments.js'

interface TreeEndpointOptions {
  collections: string[]
  folderSlug: string
  segmentFieldName?: string
  pageSegmentFieldName?: string
  buildSlug?: BuildSlugFn
}

/** User operations must be able to read their target before mutating it. */
async function requireReadableTarget(req: PayloadRequest, collection: string, id: string | number) {
  return req.payload.findByID({
    collection: collection as CollectionSlug,
    id,
    depth: 0,
    ...userRead(req),
  })
}

/** Resolve page targets without confusing a hidden page with a missing one. */
async function resolveReadablePageCollection(
  req: PayloadRequest,
  collections: string[],
  id: string,
): Promise<string> {
  for (const collection of collections) {
    try {
      await requireReadableTarget(req, collection, id)
      return collection
    } catch (error) {
      const status = operationErrorStatus(error)
      if (status !== 403 && status !== 404) throw error
      // READ filters can return 404 for an existing document. Probe only existence;
      // never return the hidden document or fall through to a same-id sibling.
      const { totalDocs } = await req.payload.find({
        collection: collection as CollectionSlug,
        where: { id: { equals: id } },
        limit: 1,
        depth: 0,
        select: { id: true },
        ...trustedRead(req),
      })
      if (totalDocs > 0) {
        throw Object.assign(new Error('Cannot update an unreadable page'), { status: 403 })
      }
    }
  }
  throw Object.assign(new Error('Page not found'), { status: 404 })
}

function operationErrorStatus(error: unknown): number {
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
  return status === 403 || status === 404 ? status : 500
}

/** A filtered UPDATE can also return 404 after the target passed READ. */
async function updatePage(
  req: PayloadRequest,
  collection: string,
  id: string,
  data: Record<string, unknown>,
  context?: { updateSlugs: boolean; slugChangeReason: 'move' },
) {
  try {
    await req.payload.update({
      collection: collection as CollectionSlug,
      id,
      data,
      ...(context ? { context } : {}),
      ...userRead(req),
    })
  } catch (error) {
    if (operationErrorStatus(error) === 404) {
      throw Object.assign(new Error('Page update denied'), { status: 403 })
    }
    throw error
  }
}

/**
 * Move a page or folder to a new parent and/or position
 *
 * When moving folders, accepts optional `updateSlugs` parameter:
 * - `true`: Cascade slug updates to all nested pages (matches new folder path)
 * - `false` (default): Keep existing slugs (organizational move only)
 */
export function createMoveHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

  return async (req) => {
    try {
      const body = (await req.json?.()) as MovePayload & { updateSlugs?: boolean }

      if (!body?.type || !body?.id) {
        return Response.json({ error: 'Missing required fields: type, id' }, { status: 400 })
      }

      const { type, id, newParentId, newIndex, updateSlugs = false, collection: targetCollection } = body
      if (type !== 'page' && type !== 'folder') {
        return Response.json({ error: 'type must be "page" or "folder"' }, { status: 400 })
      }
      if (type === 'page' && targetCollection !== undefined && !collections.includes(targetCollection)) {
        return Response.json({ error: 'collection must name a configured page collection' }, { status: 400 })
      }

      if (type === 'folder') {
        // Move folder - pass updateSlugs context to trigger cascade if requested
        await requireReadableTarget(req, folderSlug, id)
        await req.payload.update({
          collection: folderSlug as CollectionSlug,
          id,
          data: {
            folder: newParentId || null,
            sortOrder: newIndex,
          },
          context: { updateSlugs, slugChangeReason: 'move' },
          ...userRead(req),
        })
      } else {
        const collection = await resolveReadablePageCollection(req, targetCollection ? [targetCollection] : collections, id)
        await updatePage(req, collection, id, {
          folder: newParentId || null,
          sortOrder: newIndex,
        }, { updateSlugs, slugChangeReason: 'move' })
      }

      return Response.json({ success: true })
    } catch (error) {
      console.error('[payload-page-tree] Move error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Move failed' },
        { status: operationErrorStatus(error) },
      )
    }
  }
}

/**
 * Reorder items within a folder (batch update sortOrder)
 */
export function createReorderHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

  return async (req) => {
    try {
      const body = (await req.json?.()) as ReorderPayload

      if (!body?.type || !Array.isArray(body?.items) || body.items.length === 0 || body.items.some(item => !item?.id)) {
        return Response.json({ error: 'Missing required fields: type, items' }, { status: 400 })
      }

      const { type, items, collection: targetCollection } = body
      if (type !== 'page' && type !== 'folder') {
        return Response.json({ error: 'type must be "page" or "folder"' }, { status: 400 })
      }
      if (type === 'page' && targetCollection !== undefined && !collections.includes(targetCollection)) {
        return Response.json({ error: 'collection must name a configured page collection' }, { status: 400 })
      }

      if (type === 'folder') {
        // Reorder folders
        await Promise.all(
          items.map((item) =>
            req.payload.update({
              collection: folderSlug as CollectionSlug,
              id: item.id,
              data: { sortOrder: item.sortOrder },
              ...userRead(req),
            }),
          ),
        )
      } else {
        // Resolve every target before writing, including batches spanning collections.
        const targets: { collection: string; id: string; sortOrder: number }[] = []
        for (const item of items) {
          const collection = await resolveReadablePageCollection(req, targetCollection ? [targetCollection] : collections, item.id)
          targets.push({ ...item, collection })
        }
        for (const target of targets) {
          await updatePage(req, target.collection, target.id, { sortOrder: target.sortOrder })
        }
      }

      return Response.json({ success: true })
    } catch (error) {
      console.error('[payload-page-tree] Reorder error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Reorder failed' },
        { status: operationErrorStatus(error) },
      )
    }
  }
}

/**
 * Create a new page or folder
 */
export function createCreateHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug, segmentFieldName, pageSegmentFieldName = 'pageSegment', buildSlug } = options

  return async (req) => {
    try {
      const body = (await req.json?.()) as CreatePayload

      if (!body?.type || !body?.name) {
        return Response.json({ error: 'Missing required fields: type, name' }, { status: 400 })
      }

      const { type, name, parentId, collection: targetCollection } = body
      const baseSegment = slugifyName(name)

      if (type === 'folder') {
        const pathSegment = await findAvailableSegment({
          segmentFieldName: options.segmentFieldName,
          pageSegmentFieldName: options.pageSegmentFieldName,
          payload: req.payload,
          ...trustedRead(req),
          parentId: parentId || null,
          type: 'folder',
          baseSegment,
          collections,
          folderSlug,
        })

        const result = await req.payload.create({
          collection: folderSlug as CollectionSlug,
          data: {
            name, // unchanged — display field is independent of segment
            [segmentFieldName ?? 'pathSegment']: pathSegment,
            folder: parentId || null,
            sortOrder: 0,
          },
          ...userRead(req),
        })

        return Response.json({
          success: true,
          id: result.id,
          type: 'folder',
          name,
          pathSegment,
          collisionResolved: pathSegment !== baseSegment,
        })
      } else {
        const collectionSlug = targetCollection || collections[0]

        const pageSegment = await findAvailableSegment({
          payload: req.payload,
          ...trustedRead(req),
          parentId: parentId || null,
          type: 'page',
          collection: collectionSlug,
          baseSegment,
          collections,
          folderSlug,
          segmentFieldName,
          pageSegmentFieldName,
          buildSlug,
          doc: { title: name, folder: parentId || null, sortOrder: 0, _status: 'draft' },
        })

        const result = await req.payload.create({
          collection: collectionSlug as CollectionSlug,
          draft: true,
          data: {
            title: name, // unchanged — display field is independent of segment
            [pageSegmentFieldName]: pageSegment,
            folder: parentId || null,
            sortOrder: 0,
            _status: 'draft',
          },
          ...userRead(req),
        })

        return Response.json({
          success: true,
          id: result.id,
          type: 'page',
          collection: collectionSlug,
          title: name,
          pageSegment,
          collisionResolved: pageSegment !== baseSegment,
        })
      }
    } catch (error) {
      console.error('[payload-page-tree] Create error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Create failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * Delete the full subtree in one transaction. Inventory is trusted so READ rules
 * cannot silently hide descendants; each inventoried document must then pass a
 * user READ, and every DELETE still enforces the user's DELETE rules.
 */
async function deleteFolderRecursive(
  req: PayloadRequest,
  folderId: string,
  collections: string[],
  folderSlug: string,
): Promise<void> {
  const trashOptions = (collection: string) =>
    req.payload.collections[collection]?.config.trash ? { trash: true } : {}
  const ownsTransaction = await initTransaction(req)
  if (!(await req.transactionID)) {
    // No transaction support (e.g. MongoDB without a replica set, or transactions
    // disabled). The READ preflight below still runs before any delete; only a
    // DELETE denied after earlier deletes can leave a partial subtree.
    delete req.transactionID
  }

  try {
    const folders: (string | number)[] = []
    const pages: { collection: string; id: string | number }[] = []
    const collect = async (id: string | number): Promise<void> => {
      folders.push(id)
      const { docs } = await req.payload.find({
        ...trustedRead(req),
        collection: folderSlug as CollectionSlug,
        ...trashOptions(folderSlug),
        where: { folder: { equals: id } },
        limit: 0,
        depth: 0,
      })
      for (const child of docs) await collect(child.id)
    }
    await collect(folderId)

    for (const collection of collections) {
      const { docs } = await req.payload.find({
        ...trustedRead(req),
        collection: collection as CollectionSlug,
        ...trashOptions(collection),
        where: { folder: { in: folders } },
        limit: 0,
        depth: 0,
      })
      pages.push(...docs.map(({ id }) => ({ collection, id })))
    }

    // Preflight READ on every document, including the root, before any deletion.
    const targets = [
      ...pages,
      ...folders.slice().reverse().map(id => ({ collection: folderSlug, id })),
    ]
    for (const target of targets) {
      try {
        await req.payload.findByID({
          ...target,
          collection: target.collection as CollectionSlug,
          ...trashOptions(target.collection),
          ...userRead(req),
          depth: 0,
        })
      } catch {
        throw Object.assign(new Error('Cannot delete a folder containing unreadable documents'), { status: 403 })
      }
    }

    // Sequential deletes ensure no pending write survives a failure/rollback.
    for (const target of targets) {
      await req.payload.delete({
        ...target,
        collection: target.collection as CollectionSlug,
        ...trashOptions(target.collection),
        ...userRead(req),
      })
    }
    if (ownsTransaction) await commitTransaction(req)
  } catch (error) {
    // Also roll back an inherited transaction: this handler returns an HTTP error
    // instead of throwing to an outer operation that could roll it back for us.
    await killTransaction(req)
    throw error
  }
}

/**
 * Delete a page or folder
 */
export function createDeleteHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

  return async (req) => {
    try {
      if (!req.url) {
        return Response.json({ error: 'Invalid request URL' }, { status: 400 })
      }
      const url = new URL(req.url)
      const type = url.searchParams.get('type')
      const id = url.searchParams.get('id')
      const deleteChildren = url.searchParams.get('deleteChildren') === 'true'
      const collection = url.searchParams.get('collection')

      if (!type || !id) {
        return Response.json({ error: 'Missing required params: type, id' }, { status: 400 })
      }
      if (type !== 'folder' && type !== 'page') {
        return Response.json({ error: 'type must be "page" or "folder"' }, { status: 400 })
      }
      if (type === 'page' && (!collection || !collections.includes(collection))) {
        return Response.json({ error: 'A configured collection is required for page deletion' }, { status: 400 })
      }

      if (type === 'folder') {
        if (deleteChildren) {
          await deleteFolderRecursive(req, id, collections, folderSlug)
        } else {
          // Just delete the folder itself (will fail if has children due to FK constraints)
          await requireReadableTarget(req, folderSlug, id)
          await req.payload.delete({
            collection: folderSlug as CollectionSlug,
            id,
            ...userRead(req),
          })
        }
      } else {
        await requireReadableTarget(req, collection!, id)
        await req.payload.delete({
          collection: collection as CollectionSlug,
          id,
          ...userRead(req),
        })
      }

      return Response.json({ success: true })
    } catch (error) {
      console.error('[payload-page-tree] Delete error:', error)
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? error.status
        : undefined
      return Response.json(
        { error: error instanceof Error ? error.message : 'Delete failed' },
        { status: status === 403 || status === 404 ? status : 500 },
      )
    }
  }
}

/**
 * Generate a unique title with (copy) / (copy N) suffix.
 * Used by the duplicate endpoint only — applies to TITLE not pageSegment.
 *
 * Examples:
 *   "Thank You" → "Thank You (copy)"
 *   "Thank You (copy)" → "Thank You (copy 2)"
 *   "Thank You (copy 2)" → "Thank You (copy 3)"
 */
function generateDuplicateTitle(baseTitle: string, existingTitles: string[]): string {
  const copyPattern = /^(.+?)\s*\(copy(?:\s+(\d+))?\)$/i
  const match = baseTitle.match(copyPattern)
  const cleanBase = match ? match[1].trim() : baseTitle

  const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const copyRegex = new RegExp(
    `^${escapeRegex(cleanBase)}\\s*\\(copy(?:\\s+(\\d+))?\\)$`,
    'i',
  )

  let maxCopyNum = 0
  for (const title of existingTitles) {
    if (!title) continue
    if (title.toLowerCase() === cleanBase.toLowerCase()) {
      maxCopyNum = Math.max(maxCopyNum, 0)
      continue
    }
    const m = title.match(copyRegex)
    if (m) {
      const num = m[1] ? parseInt(m[1], 10) : 1
      maxCopyNum = Math.max(maxCopyNum, num)
    }
  }

  const nextNum = maxCopyNum + 1
  return nextNum === 1 ? `${cleanBase} (copy)` : `${cleanBase} (copy ${nextNum})`
}

/**
 * Duplicate a page
 */
export function createDuplicateHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug, segmentFieldName, pageSegmentFieldName = 'pageSegment', buildSlug } = options

  return async (req) => {
    try {
      if (!req.url) {
        return Response.json({ error: 'Invalid request URL' }, { status: 400 })
      }
      const url = new URL(req.url)
      const id = url.searchParams.get('id')
      const collection = url.searchParams.get('collection')

      if (!id || !collection) {
        return Response.json({ error: 'Missing required params: id, collection' }, { status: 400 })
      }

      const versions = req.payload.collections[collection]?.config.versions
      const draftsEnabled = Boolean(versions && versions.drafts)

      // Read the same version Payload duplicates (the latest draft when drafts are on).
      const original = await req.payload.findByID({
        collection: collection as CollectionSlug,
        id,
        ...(draftsEnabled ? { draft: true } : {}),
        ...userRead(req),
      })

      const originalTitle = (original.title as string) || 'Untitled'
      const rawFolder = original.folder
      const parentId = rawFolder
        ? typeof rawFolder === 'object' && rawFolder !== null
          ? String((rawFolder as { id: string | number }).id)
          : String(rawFolder)
        : null

      // Get existing titles in the same folder so we can compute (copy N)
      const { docs: siblings } = await req.payload.find({
        ...userRead(req),
        collection: collection as CollectionSlug,
        where: parentId
          ? { folder: { equals: parentId } }
          : { folder: { exists: false } },
        limit: 0,
        depth: 0,
      })
      const existingTitles = siblings
        .map((d: Record<string, unknown>) => d.title)
        .filter((t): t is string => typeof t === 'string')

      const newTitle = generateDuplicateTitle(originalTitle, existingTitles)

      // pageSegment uses the SHARED auto-increment rule (not "(copy)" suffix)
      const storedSegment = original[pageSegmentFieldName]
      const slugSegment = typeof original.slug === 'string' ? original.slug.split('/').pop() : ''
      const baseSegment =
        (typeof storedSegment === 'string' && storedSegment) || slugSegment || slugifyName(originalTitle)
      const newPageSegment = await findAvailableSegment({
        payload: req.payload,
        ...trustedRead(req),
        parentId,
        type: 'page',
        collection,
        baseSegment,
        collections,
        folderSlug,
        segmentFieldName,
        pageSegmentFieldName,
        buildSlug,
        doc: { ...original, title: newTitle, slugHistory: [], ...(draftsEnabled ? { _status: 'draft' } : {}) },
      })

      const result = await req.payload.duplicate({
        collection: collection as CollectionSlug,
        id,
        data: {
          title: newTitle,
          [pageSegmentFieldName]: newPageSegment,
          slugHistory: [],
        },
        ...(draftsEnabled ? { draft: true } : {}),
        ...userRead(req),
      })

      return Response.json({ success: true, id: result.id, title: newTitle, pageSegment: newPageSegment })
    } catch (error) {
      console.error('[payload-page-tree] Duplicate error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Duplicate failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * Update page status (publish/unpublish)
 */
export function createStatusHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections } = options

  return async (req) => {
    try {
      const body = (await req.json?.()) as { id: string; collection: string; status: 'draft' | 'published' }

      if (!body?.id || !body?.collection || !body?.status) {
        return Response.json({ error: 'Missing required fields: id, collection, status' }, { status: 400 })
      }

      await req.payload.update({
        collection: body.collection as CollectionSlug,
        id: body.id,
        data: { _status: body.status },
        ...userRead(req),
      })

      return Response.json({ success: true })
    } catch (error) {
      console.error('[payload-page-tree] Status update error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Status update failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * Rename a page or folder — display field only.
 *
 * Renaming never touches pageSegment, pathSegment, or slug. Two pages or
 * folders in the same parent may share a display name. To change a URL
 * segment, use the Edit URL modal (which goes through createEditUrlHandler).
 */
export function createRenameHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

  return async (req) => {
    try {
      const body = (await req.json?.()) as {
        type: 'page' | 'folder'
        id: string
        name: string
        collection?: string
      }

      if (!body?.type || !body?.id || !body?.name) {
        return Response.json(
          { error: 'Missing required fields: type, id, name' },
          { status: 400 },
        )
      }

      const { type, id, name, collection } = body

      if (type === 'folder') {
        await requireReadableTarget(req, folderSlug, id)
        await req.payload.update({
          collection: folderSlug as CollectionSlug,
          id,
          data: { name },
          ...userRead(req),
        })
      } else if (collection) {
        if (!collections.includes(collection)) {
          return Response.json(
            { error: `Collection "${collection}" is not configured for page-tree` },
            { status: 400 },
          )
        }
        await requireReadableTarget(req, collection, id)
        await req.payload.update({
          collection: collection as CollectionSlug,
          id,
          data: { title: name },
          ...userRead(req),
        })
      } else {
        return Response.json(
          { error: 'Collection is required for page type' },
          { status: 400 },
        )
      }

      return Response.json({ success: true })
    } catch (error) {
      console.error('[payload-page-tree] Rename error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Rename failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * Regenerate slugs for pages based on their folder hierarchy
 *
 * Accepts optional `folderId` parameter:
 * - If provided: regenerates slugs for all pages in that folder and its subfolders
 * - If omitted: regenerates slugs for ALL pages in configured collections
 */
export function createRegenerateSlugsHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

  return async (req) => {
    try {
      if (!req.url) {
        return Response.json({ error: 'Invalid request URL' }, { status: 400 })
      }
      const url = new URL(req.url)
      const folderId = url.searchParams.get('folderId')

      let updatedCount = 0

      if (folderId) {
        // Get all folder IDs including nested children
        const childFolderIds = await getAllChildFolderIdsForRegenerate(folderId, req, folderSlug)
        const allFolderIds = [folderId, ...childFolderIds]

        // Update pages in all affected folders
        for (const collectionSlug of collections) {
          const { docs: pages } = await req.payload.find({
            ...userRead(req),
            collection: collectionSlug as CollectionSlug,
            where: {
              folder: { in: allFolderIds },
            },
            limit: 0,
            depth: 0,
          })

          for (const page of pages) {
            await req.payload.update({
              collection: collectionSlug as CollectionSlug,
              id: page.id,
              data: {}, // Empty update triggers beforeChange hook
              context: { updateSlugs: true, slugChangeReason: 'regenerate' },
              ...userRead(req),
            })
            updatedCount++
          }
        }
      } else {
        // Regenerate ALL pages
        for (const collectionSlug of collections) {
          const { docs: pages } = await req.payload.find({
            ...userRead(req),
            collection: collectionSlug as CollectionSlug,
            limit: 0,
            depth: 0,
          })

          for (const page of pages) {
            await req.payload.update({
              collection: collectionSlug as CollectionSlug,
              id: page.id,
              data: {},
              context: { updateSlugs: true, slugChangeReason: 'regenerate' },
              ...userRead(req),
            })
            updatedCount++
          }
        }
      }

      return Response.json({
        success: true,
        message: `Regenerated slugs for ${updatedCount} pages`,
        count: updatedCount,
      })
    } catch (error) {
      console.error('[payload-page-tree] Regenerate slugs error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Regenerate slugs failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * Migrate existing folders by populating pathSegment from folder name
 *
 * This endpoint helps users who add the plugin to an existing project:
 * - Finds all folders where pathSegment is null or empty
 * - Sets pathSegment to slugify(name)
 * - Does NOT update page slugs (preserves existing URLs)
 */
export function createMigrateHandler(options: TreeEndpointOptions): PayloadHandler {
  const { folderSlug, segmentFieldName = 'pathSegment' } = options

  return async (req) => {
    try {
      // Find all folders without pathSegment
      const { docs: folders } = await req.payload.find({
        ...userRead(req),
        collection: folderSlug as CollectionSlug,
        where: {
          or: [
            { [segmentFieldName]: { exists: false } },
            { [segmentFieldName]: { equals: '' } },
            { [segmentFieldName]: { equals: null } },
          ],
        },
        limit: 0,
        depth: 0,
      })

      const updated: Array<{ id: string | number; name: string; pathSegment: string }> = []

      for (const folder of folders) {
        const folderDoc = folder as unknown as { id: string | number; name: string }
        if (folderDoc.name) {
          const newPathSegment = slugify(folderDoc.name)
          await req.payload.update({
            collection: folderSlug as CollectionSlug,
            id: folderDoc.id,
            data: { [segmentFieldName]: newPathSegment },
            // Don't trigger slug cascade - we want to preserve existing page slugs
            context: { updateSlugs: false },
            ...userRead(req),
          })
          updated.push({
            id: folderDoc.id,
            name: folderDoc.name,
            pathSegment: newPathSegment,
          })
        }
      }

      return Response.json({
        success: true,
        message: `Migrated ${updated.length} folders (page slugs preserved)`,
        count: updated.length,
        folders: updated,
      })
    } catch (error) {
      console.error('[payload-page-tree] Migrate error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Migration failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * Get redirect mappings from slugHistory
 *
 * Returns all old→new URL mappings for SEO redirect setup.
 * Query param: collection (required) - which collection to get redirects for
 */
export function createRedirectsHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections } = options

  return async (req) => {
    try {
      if (!req.url) {
        return Response.json({ error: 'Invalid request URL' }, { status: 400 })
      }
      const url = new URL(req.url)
      const collection = url.searchParams.get('collection')

      if (!collection) {
        return Response.json({ error: 'Missing required param: collection' }, { status: 400 })
      }

      if (!collections.includes(collection)) {
        return Response.json(
          { error: `Collection "${collection}" is not configured for page-tree` },
          { status: 400 },
        )
      }

      // Find all pages with slug history
      const { docs: pages } = await req.payload.find({
        ...userRead(req),
        collection: collection as CollectionSlug,
        where: {
          slugHistory: { exists: true },
        },
        limit: 0,
        depth: 0,
      })

      // Build redirect map from slugHistory
      const redirects: Array<{ from: string; to: string }> = []

      for (const page of pages) {
        const pageDoc = page as unknown as { slug: string; slugHistory?: Array<{ slug: string }> }
        if (pageDoc.slug && pageDoc.slugHistory?.length) {
          for (const entry of pageDoc.slugHistory) {
            // Only add if the old slug is different from current
            if (entry.slug && entry.slug !== pageDoc.slug) {
              // Add leading slash for URL format
              const from = entry.slug.startsWith('/') ? entry.slug : `/${entry.slug}`
              const to = pageDoc.slug.startsWith('/') ? pageDoc.slug : `/${pageDoc.slug}`
              redirects.push({ from, to })
            }
          }
        }
      }

      return Response.json({
        redirects,
        count: redirects.length,
      })
    } catch (error) {
      console.error('[payload-page-tree] Redirects error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Failed to get redirects' },
        { status: 500 },
      )
    }
  }
}

/**
 * Restore a previous slug from history
 *
 * Body: { id, collection, slug } - the page ID, collection, and slug to restore
 */
export function createRestoreSlugHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, pageSegmentFieldName = 'pageSegment' } = options

  return async (req) => {
    try {
      const body = (await req.json?.()) as { id: string; collection: string; slug: string }

      if (!body?.id || !body?.collection || !body?.slug) {
        return Response.json(
          { error: 'Missing required fields: id, collection, slug' },
          { status: 400 },
        )
      }

      const { id, collection, slug: targetSlug } = body

      if (!collections.includes(collection)) {
        return Response.json(
          { error: `Collection "${collection}" is not configured for page-tree` },
          { status: 400 },
        )
      }

      // Get the current page
      const page = await req.payload.findByID({
        collection: collection as CollectionSlug,
        id,
        ...userRead(req),
      })

      const pageDoc = page as unknown as {
        slug: string
        slugHistory?: Array<{ slug: string; changedAt: string; reason?: string }>
      }

      // Check if the target slug is in the history
      const historyEntry = pageDoc.slugHistory?.find((h) => h.slug === targetSlug)
      if (!historyEntry) {
        return Response.json(
          { error: 'Target slug not found in history' },
          { status: 400 },
        )
      }

      // Extract the pageSegment from the target slug (last segment)
      const segments = targetSlug.split('/')
      const newPageSegment = segments[segments.length - 1]

      // Build new history: remove the target entry, add current slug
      const newHistory = [
        {
          slug: pageDoc.slug,
          changedAt: new Date().toISOString(),
          reason: 'restore' as const,
        },
        ...(pageDoc.slugHistory || []).filter((h) => h.slug !== targetSlug),
      ].slice(0, 20)

      // Update the page with restored slug
      await req.payload.update({
        collection: collection as CollectionSlug,
        id,
        data: {
          slug: targetSlug,
          [pageSegmentFieldName]: newPageSegment,
          slugHistory: newHistory,
        },
        // Don't trigger the buildSlug hook - we're setting the slug directly
        context: { skipSlugGeneration: true },
        ...userRead(req),
      })

      return Response.json({
        success: true,
        restoredSlug: targetSlug,
      })
    } catch (error) {
      console.error('[payload-page-tree] Restore slug error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Failed to restore slug' },
        { status: 500 },
      )
    }
  }
}

/**
 * Edit URL segment for a page or folder
 *
 * Updates pageSegment (for pages) or pathSegment (for folders) and triggers slug regeneration.
 */
export function createEditUrlHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug, segmentFieldName = 'pathSegment', pageSegmentFieldName = 'pageSegment' } = options

  return async (req) => {
    try {
      const body = (await req.json?.()) as {
        type: 'page' | 'folder'
        id: string
        segment: string
        collection?: string
      }

      if (!body?.type || !body?.id || !body?.segment) {
        return Response.json(
          { error: 'Missing required fields: type, id, segment' },
          { status: 400 },
        )
      }

      const { type, id, segment, collection } = body
      const slugifiedSegment = slugifyName(segment)

      // Look up the source record so we can determine its parent for sibling
      // collision lookups
      const sourceCollection = type === 'folder' ? folderSlug : collection
      if (!sourceCollection) {
        return Response.json(
          { error: 'Collection is required for page type' },
          { status: 400 },
        )
      }
      if (type === 'page' && collection && !collections.includes(collection)) {
        return Response.json(
          { error: `Collection "${collection}" is not configured for page-tree` },
          { status: 400 },
        )
      }

      const record = await req.payload.findByID({
        collection: sourceCollection as CollectionSlug,
        id,
        depth: 0,
        ...userRead(req),
      })
      const rawParent = (record as { folder?: unknown }).folder
      const parentId = rawParent
        ? typeof rawParent === 'object' && rawParent !== null
          ? String((rawParent as { id: string | number }).id)
          : String(rawParent)
        : null

      // Server-side guarantee — client should already have caught this via
      // the live availability check, but we don't trust the client.
      const available = await isSegmentAvailable({
        segmentFieldName: options.segmentFieldName,
        pageSegmentFieldName: options.pageSegmentFieldName,
        payload: req.payload,
        ...trustedRead(req),
        parentId,
        type,
        segment: slugifiedSegment,
        excludeId: id,
        collection,
        collections,
        folderSlug,
      })

      if (!available) {
        return Response.json(
          { error: `URL segment "${slugifiedSegment}" is already in use in this location` },
          { status: 409 },
        )
      }

      if (type === 'folder') {
        await req.payload.update({
          collection: folderSlug as CollectionSlug,
          id,
          data: { [segmentFieldName]: slugifiedSegment },
          context: { updateSlugs: true, slugChangeReason: 'edit-url' },
          ...userRead(req),
        })
      } else {
        await req.payload.update({
          collection: collection as CollectionSlug,
          id,
          data: { [pageSegmentFieldName]: slugifiedSegment },
          context: { updateSlugs: true, slugChangeReason: 'edit-url' },
          ...userRead(req),
        })
      }

      return Response.json({ success: true })
    } catch (error) {
      console.error('[payload-page-tree] Edit URL error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Edit URL failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * GET /api/page-tree/check-segment
 *
 * Lightweight availability check used by the EditUrlModal's debounced live check.
 * Query params:
 *   - type: 'page' | 'folder'
 *   - parentId: string | (omitted for root)
 *   - segment: string (will be slugified server-side)
 *   - excludeId: string (the record being edited, so its own segment doesn't count as taken)
 *   - collection: string (required when type === 'page')
 */
export function createCheckSegmentHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

  return async (req) => {
    try {
      if (!req.url) {
        return Response.json({ error: 'Invalid request URL' }, { status: 400 })
      }
      const url = new URL(req.url)
      const type = url.searchParams.get('type') as 'page' | 'folder' | null
      const parentIdParam = url.searchParams.get('parentId')
      const segment = url.searchParams.get('segment')
      const excludeIdParam = url.searchParams.get('excludeId')
      const collection = url.searchParams.get('collection')

      if (!type || !segment) {
        return Response.json(
          { error: 'Missing required params: type, segment' },
          { status: 400 },
        )
      }
      if (type !== 'folder' && type !== 'page') {
        return Response.json({ error: 'type must be "page" or "folder"' }, { status: 400 })
      }
      if (type === 'page' && !collection) {
        return Response.json(
          { error: 'collection is required when type is "page"' },
          { status: 400 },
        )
      }
      if (type === 'page' && collection && !collections.includes(collection)) {
        return Response.json(
          { error: `Collection "${collection}" is not configured for page-tree` },
          { status: 400 },
        )
      }

      const slugifiedSegment = slugifyName(segment)
      const parentId = parentIdParam || null
      const excludeId = excludeIdParam || undefined

      const available = await isSegmentAvailable({
        segmentFieldName: options.segmentFieldName,
        pageSegmentFieldName: options.pageSegmentFieldName,
        payload: req.payload,
        ...trustedRead(req),
        parentId,
        type,
        segment: slugifiedSegment,
        excludeId,
        collection: collection || undefined,
        collections,
        folderSlug,
      })

      return Response.json({ available, slugifiedSegment })
    } catch (error) {
      console.error('[payload-page-tree] Check segment error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Check segment failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * GET /api/page-tree/folder-impact?folderId=123
 *
 * Returns the count of pages whose slugs would be rewritten if this folder's
 * pathSegment changed. Includes pages in nested subfolders.
 *
 * Used by the EditUrlModal cascade-impact warning and the folder-move
 * "Update URLs" type-to-confirm step.
 */
export function createFolderImpactHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

  return async (req) => {
    try {
      if (!req.url) {
        return Response.json({ error: 'Invalid request URL' }, { status: 400 })
      }
      const url = new URL(req.url)
      const folderId = url.searchParams.get('folderId')

      if (!folderId) {
        return Response.json({ error: 'Missing required param: folderId' }, { status: 400 })
      }

      const childPageCount = await countDescendantPages({
        payload: req.payload,
        ...trustedRead(req),
        folderId,
        collections,
        folderSlug,
      })

      return Response.json({ childPageCount })
    } catch (error) {
      console.error('[payload-page-tree] Folder impact error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : 'Folder impact failed' },
        { status: 500 },
      )
    }
  }
}

/**
 * Helper to get all child folder IDs for regenerate endpoint
 */
async function getAllChildFolderIdsForRegenerate(
  parentId: string,
  req: PayloadRequest,
  folderSlug: string,
): Promise<string[]> {
  const result = await req.payload.find({
    ...userRead(req),
    collection: folderSlug as CollectionSlug,
    where: {
      folder: { equals: parentId },
    },
    limit: 0,
    depth: 0,
  })

  const childIds = result.docs.map((doc: any) => String(doc.id))

  // Recursively get grandchildren
  const grandchildIds: string[] = []
  for (const childId of childIds) {
    const descendants = await getAllChildFolderIdsForRegenerate(childId, req, folderSlug)
    grandchildIds.push(...descendants)
  }

  return [...childIds, ...grandchildIds]
}
