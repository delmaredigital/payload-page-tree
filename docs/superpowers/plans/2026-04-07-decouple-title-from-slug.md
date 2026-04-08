# Decouple Title from Slug — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple display fields (`title`/`name`) from URL segments (`pageSegment`/`pathSegment`) so that editing a display field never changes a slug, two pages can share a title in the same folder, and cascading slug changes for folders with children require an explicit type-to-confirm safety gate.

**Architecture:** Introduce a new `src/utils/segments.ts` helper module owning all segment availability and auto-increment logic. Refactor four endpoints (`create`, `duplicate`, `edit-url`, `rename`) to delegate to it. Strip `rename` to a display-field-only write. Add two new lightweight read endpoints (`check-segment`, `folder-impact`) backing the EditUrlModal's live availability check and cascade-impact warning. Add type-to-confirm gates to both EditUrlModal (when editing a folder URL with children) and PageTreeClient's folder-move "Update URLs" path. Remove the now-obsolete folder-rename confirmation modal.

**Tech Stack:** TypeScript, Payload CMS plugin (CollectionConfig hooks + custom endpoints), React 19 client components, react-arborist for the tree, sonner for toasts, pnpm for build.

**Spec:** `docs/superpowers/specs/2026-04-07-decouple-title-from-slug-design.md`

**No test infrastructure:** This plugin has no test framework. Verification for each task is `pnpm build` (TypeScript type-check + emit) plus, where noted, manual smoke testing in the consuming app (`../cc-lms`). The user is responsible for the manual smoke pass at the end.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/utils/segments.ts` | **Create** | Pure helpers: `isSegmentAvailable`, `findAvailableSegment`, `countDescendantPages`, `slugifyName` (re-export). Single source of truth for collision/availability/cascade-impact logic. |
| `src/types.ts` | Modify | Add `'edit-url'` to `SlugChangeReason` union. |
| `src/endpoints/treeOperations.ts` | Modify | Refactor `createCreateHandler`, `createDuplicateHandler`, `createEditUrlHandler` to delegate to `segments.ts`. Strip `createRenameHandler` to display-field-only. Delete `generateUniqueName`. Add `createCheckSegmentHandler` and `createFolderImpactHandler`. |
| `src/index.ts` | Modify | Register `/page-tree/check-segment` and `/page-tree/folder-impact` endpoints. Add `'edit-url'` to the slugHistory select-field options. |
| `src/components/EditUrlModal.tsx` | Modify | Add live debounced availability check, cascade-impact warning for folders, type-to-confirm gate for folders with children. |
| `src/components/ConfirmationModal.tsx` | Modify | Add optional `typeToConfirm` prop that renders an input field and gates the primary action button. |
| `src/components/PageTreeClient.tsx` | Modify | Remove rename confirmation modal entirely. Simplify `executeRename`. Add type-to-confirm transition to single and bulk folder-move "Update URLs" flows. |

---

## Tasks

### Task 1: Add `'edit-url'` to SlugChangeReason

**Files:**
- Modify: `src/types.ts:163`
- Modify: `src/index.ts:241-247` (slugHistory field options)

- [ ] **Step 1: Add the new enum value to the type**

In `src/types.ts`, change line 163 from:

```ts
export type SlugChangeReason = 'move' | 'rename' | 'regenerate' | 'restore' | 'manual'
```

to:

```ts
export type SlugChangeReason = 'move' | 'rename' | 'regenerate' | 'restore' | 'manual' | 'edit-url'
```

- [ ] **Step 2: Add the matching admin field option**

In `src/index.ts`, find the `slugHistoryField` array field's `reason` select options (around line 241):

```ts
{
  name: 'reason',
  type: 'select',
  options: [
    { label: 'Moved', value: 'move' },
    { label: 'Renamed', value: 'rename' },
    { label: 'Regenerated', value: 'regenerate' },
    { label: 'Restored', value: 'restore' },
    { label: 'Manual', value: 'manual' },
  ],
},
```

Add the new option:

```ts
{
  name: 'reason',
  type: 'select',
  options: [
    { label: 'Moved', value: 'move' },
    { label: 'Renamed', value: 'rename' },
    { label: 'Regenerated', value: 'regenerate' },
    { label: 'Restored', value: 'restore' },
    { label: 'Manual', value: 'manual' },
    { label: 'URL Edited', value: 'edit-url' },
  ],
},
```

- [ ] **Step 3: Build to verify**

Run: `pnpm build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/index.ts
git commit -m "feat: add 'edit-url' to SlugChangeReason enum"
```

---

### Task 2: Create `src/utils/segments.ts` helper module

**Files:**
- Create: `src/utils/segments.ts`

- [ ] **Step 1: Create the helper module**

Create `src/utils/segments.ts` with the following content:

```ts
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
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: Build succeeds with no TypeScript errors. The new file compiles to `dist/utils/segments.js`.

- [ ] **Step 3: Commit**

```bash
git add src/utils/segments.ts
git commit -m "feat(segments): add segment availability and auto-increment helpers"
```

---

### Task 3: Refactor create endpoint to use `findAvailableSegment`

**Files:**
- Modify: `src/endpoints/treeOperations.ts:207-278` (`createCreateHandler`)

- [ ] **Step 1: Add the segments import**

At the top of `src/endpoints/treeOperations.ts`, change:

```ts
import { slugify } from '../utils/getFolderPath.js'
```

to:

```ts
import { slugify } from '../utils/getFolderPath.js'
import {
  findAvailableSegment,
  isSegmentAvailable,
  countDescendantPages,
  slugifyName,
} from '../utils/segments.js'
```

(Importing all four now even though some won't be used until later tasks — keeps the import block stable and avoids re-edits.)

- [ ] **Step 2: Replace the body of `createCreateHandler`**

Replace the body of `createCreateHandler` (lines ~210-277) with:

```ts
export function createCreateHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

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
          payload: req.payload,
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
            pathSegment,
            folder: parentId || null,
            sortOrder: 0,
          },
          req,
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
          parentId: parentId || null,
          type: 'page',
          collection: collectionSlug,
          baseSegment,
          collections,
          folderSlug,
        })

        const result = await req.payload.create({
          collection: collectionSlug as CollectionSlug,
          draft: true,
          data: {
            title: name, // unchanged — display field is independent of segment
            pageSegment,
            folder: parentId || null,
            sortOrder: 0,
            _status: 'draft',
          },
          req,
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
```

Note: `generateUniqueName` is no longer called from this handler. It's still called from the duplicate handler, so we don't delete it yet — that happens in Task 5.

- [ ] **Step 3: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/endpoints/treeOperations.ts
git commit -m "feat(create): use findAvailableSegment, keep title/name unchanged"
```

---

### Task 4: Refactor duplicate endpoint to use shared segment rule

**Files:**
- Modify: `src/endpoints/treeOperations.ts` (`createDuplicateHandler`, around lines 440-507)

- [ ] **Step 1: Replace the body of `createDuplicateHandler`**

Replace the entire `createDuplicateHandler` function with:

```ts
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

  // Find the highest existing copy number for this base title
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

export function createDuplicateHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

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

      // Get the original document
      const original = await req.payload.findByID({
        collection: collection as CollectionSlug,
        id,
        req,
      })

      // Strip auto-generated and system fields
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        slug: _slug,
        pageSegment: _pageSegment,
        ...data
      } = original as Record<string, unknown>

      const originalTitle = (data.title as string) || 'Untitled'
      const rawFolder = data.folder
      const parentId = rawFolder
        ? typeof rawFolder === 'object' && rawFolder !== null
          ? String((rawFolder as { id: string | number }).id)
          : String(rawFolder)
        : null

      // Get existing titles in the same folder so we can compute (copy N)
      const { docs: siblings } = await req.payload.find({
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
      const baseSegment = slugifyName(originalTitle)
      const newPageSegment = await findAvailableSegment({
        payload: req.payload,
        parentId,
        type: 'page',
        collection,
        baseSegment,
        collections,
        folderSlug,
      })

      const result = await req.payload.create({
        collection: collection as CollectionSlug,
        data: {
          ...data,
          title: newTitle,
          pageSegment: newPageSegment,
          _status: 'draft',
        },
        req,
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
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/endpoints/treeOperations.ts
git commit -m "feat(duplicate): title gets (copy), pageSegment uses shared auto-increment"
```

---

### Task 5: Remove the obsolete `generateUniqueName` function

**Files:**
- Modify: `src/endpoints/treeOperations.ts:11-81` (delete `generateUniqueName` and `escapeRegex` helper)

- [ ] **Step 1: Verify nothing else uses `generateUniqueName`**

Run: `pnpm exec tsc --noEmit 2>&1 | head -20`

Then search for remaining references:

Use Grep with pattern `generateUniqueName` over `src/`. Expected: only matches inside `treeOperations.ts:11-77` (the function definition itself). If any other file references it, stop and update them first.

- [ ] **Step 2: Delete the function and its helper**

In `src/endpoints/treeOperations.ts`, delete lines 10-81 (the `generateUniqueName` function and the `escapeRegex` helper that supports it). Keep the file's other top-level imports and exports intact.

The block to delete starts at the comment `/** Generate a unique name by checking existing items...` and ends after the closing brace of `escapeRegex`.

- [ ] **Step 3: Build to verify**

Run: `pnpm build`
Expected: Build succeeds. No more references to `generateUniqueName` anywhere.

- [ ] **Step 4: Commit**

```bash
git add src/endpoints/treeOperations.ts
git commit -m "refactor: remove obsolete generateUniqueName helper"
```

---

### Task 6: Add server-side collision check to edit-url endpoint

**Files:**
- Modify: `src/endpoints/treeOperations.ts` (`createEditUrlHandler`, around lines 985-1050)

- [ ] **Step 1: Add `isSegmentAvailable` check before the update**

Replace the body of `createEditUrlHandler` with:

```ts
export function createEditUrlHandler(options: TreeEndpointOptions): PayloadHandler {
  const { collections, folderSlug } = options

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

      // Look up parent so we can check for sibling collisions
      const sourceCollection = type === 'folder' ? folderSlug : collection
      if (!sourceCollection) {
        return Response.json(
          { error: 'Collection is required for page type' },
          { status: 400 },
        )
      }
      if (type === 'page' && !collections.includes(collection!)) {
        return Response.json(
          { error: `Collection "${collection}" is not configured for page-tree` },
          { status: 400 },
        )
      }

      const record = await req.payload.findByID({
        collection: sourceCollection as CollectionSlug,
        id,
        depth: 0,
        req,
      })
      const rawParent = (record as { folder?: unknown }).folder
      const parentId = rawParent
        ? typeof rawParent === 'object' && rawParent !== null
          ? String((rawParent as { id: string | number }).id)
          : String(rawParent)
        : null

      // Server-side guarantee — client should already have caught this
      const available = await isSegmentAvailable({
        payload: req.payload,
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
          data: { pathSegment: slugifiedSegment },
          context: { updateSlugs: true, slugChangeReason: 'edit-url' },
          req,
        })
      } else {
        await req.payload.update({
          collection: collection as CollectionSlug,
          id,
          data: { pageSegment: slugifiedSegment },
          context: { updateSlugs: true, slugChangeReason: 'edit-url' },
          req,
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
```

Note the two changes vs. the previous version:
1. Added the `isSegmentAvailable` check returning HTTP 409 on collision
2. Changed `slugChangeReason: 'rename'` to `slugChangeReason: 'edit-url'` (the new enum value from Task 1)

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/endpoints/treeOperations.ts
git commit -m "feat(edit-url): add server-side collision check, use 'edit-url' reason"
```

---

### Task 7: Add `createCheckSegmentHandler` (read-only availability endpoint)

**Files:**
- Modify: `src/endpoints/treeOperations.ts` (add new exported handler at the end of the file, before `getAllChildFolderIdsForRegenerate`)

- [ ] **Step 1: Add the handler function**

In `src/endpoints/treeOperations.ts`, append a new exported function (place it after `createEditUrlHandler` and before the `getAllChildFolderIdsForRegenerate` helper, around line 1050):

```ts
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
        payload: req.payload,
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
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/endpoints/treeOperations.ts
git commit -m "feat(endpoints): add check-segment availability handler"
```

---

### Task 8: Add `createFolderImpactHandler` (cascade-impact count endpoint)

**Files:**
- Modify: `src/endpoints/treeOperations.ts` (append after `createCheckSegmentHandler`)

- [ ] **Step 1: Add the handler function**

Append directly after `createCheckSegmentHandler`:

```ts
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
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/endpoints/treeOperations.ts
git commit -m "feat(endpoints): add folder-impact count handler"
```

---

### Task 9: Register `check-segment` and `folder-impact` endpoints in `src/index.ts`

**Files:**
- Modify: `src/index.ts:6-19` (imports)
- Modify: `src/index.ts:380-389` (endpoint registrations)

- [ ] **Step 1: Add the imports**

In `src/index.ts`, change the import block:

```ts
import {
  createMoveHandler,
  createReorderHandler,
  createCreateHandler,
  createDeleteHandler,
  createDuplicateHandler,
  createStatusHandler,
  createRenameHandler,
  createRegenerateSlugsHandler,
  createMigrateHandler,
  createRedirectsHandler,
  createRestoreSlugHandler,
  createEditUrlHandler,
} from './endpoints/treeOperations.js'
```

to:

```ts
import {
  createMoveHandler,
  createReorderHandler,
  createCreateHandler,
  createDeleteHandler,
  createDuplicateHandler,
  createStatusHandler,
  createRenameHandler,
  createRegenerateSlugsHandler,
  createMigrateHandler,
  createRedirectsHandler,
  createRestoreSlugHandler,
  createEditUrlHandler,
  createCheckSegmentHandler,
  createFolderImpactHandler,
} from './endpoints/treeOperations.js'
```

- [ ] **Step 2: Register the two new endpoints**

In the same file, find the endpoint registration block (around line 384-389). After the `'/page-tree/edit-url'` registration, append:

```ts
{
  path: '/page-tree/check-segment',
  method: 'get',
  handler: createCheckSegmentHandler(endpointOptions),
},
{
  path: '/page-tree/folder-impact',
  method: 'get',
  handler: createFolderImpactHandler(endpointOptions),
},
```

- [ ] **Step 3: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(plugin): register check-segment and folder-impact endpoints"
```

---

### Task 10: Strip rename endpoint to display-field-only writes

**Files:**
- Modify: `src/endpoints/treeOperations.ts` (`createRenameHandler`, around lines 540-670)

- [ ] **Step 1: Replace the body of `createRenameHandler`**

Replace the entire `createRenameHandler` function with this drastically simplified version:

```ts
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
        await req.payload.update({
          collection: folderSlug as CollectionSlug,
          id,
          data: { name },
          req,
        })
      } else if (collection) {
        if (!collections.includes(collection)) {
          return Response.json(
            { error: `Collection "${collection}" is not configured for page-tree` },
            { status: 400 },
          )
        }
        await req.payload.update({
          collection: collection as CollectionSlug,
          id,
          data: { title: name },
          req,
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
```

What was removed:
- Title/name uniqueness checks (lines ~582-601 and ~627-647 in the old version)
- `pathSegment: slugify(name)` overwrite (line ~608)
- `pageSegment: slugify(name)` overwrite gated by `updateSlugs` (line ~655)
- `updateSlugs` request parameter
- `slugChangeReason: 'rename'` context tag (no slug is changing)

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/endpoints/treeOperations.ts
git commit -m "feat(rename): strip endpoint to display-field-only writes"
```

---

### Task 11: Add `typeToConfirm` prop to `ConfirmationModal`

**Files:**
- Modify: `src/components/ConfirmationModal.tsx`

- [ ] **Step 1: Update the component with new prop and input field**

Replace the entire contents of `src/components/ConfirmationModal.tsx` with:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'

interface ActionButton {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
}

interface TypeToConfirmConfig {
  /** The exact text the user must type to enable the primary action button. */
  expectedText: string
  /** Label shown above the input. e.g., 'Type "spring" to confirm:' */
  label: string
  /** Optional placeholder shown in the empty input. */
  placeholder?: string
}

// NOTE: when typeToConfirm is set AND actions is set, ALL action buttons are
// gated (disabled until the user's input matches expectedText). The Cancel
// button rendered above the actions array is never gated. Today this works
// because the only consumer (folder-move type-to-confirm) passes a single
// "Confirm and Update URLs" action. If a future caller adds a non-gated
// secondary action, this gating model will need a per-action `gated?: boolean`
// flag.

interface ConfirmationModalProps {
  isOpen: boolean
  title: string
  message: string
  details?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm?: () => void
  onCancel: () => void
  /** Custom action buttons - if provided, replaces confirm/cancel pattern */
  actions?: ActionButton[]
  /**
   * If provided, renders a "type to confirm" input below the message.
   * The primary action button (or all action buttons if `actions` is set)
   * will be disabled until the user's input matches `expectedText` exactly.
   */
  typeToConfirm?: TypeToConfirmConfig
}

export function ConfirmationModal({
  isOpen,
  title,
  message,
  details,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  actions,
  typeToConfirm,
}: ConfirmationModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const typeToConfirmInputRef = useRef<HTMLInputElement>(null)
  const [typedText, setTypedText] = useState('')

  // Reset typed text whenever the modal opens or the expected text changes
  useEffect(() => {
    if (isOpen) {
      setTypedText('')
    }
  }, [isOpen, typeToConfirm?.expectedText])

  // Focus the type-to-confirm input if present, otherwise the primary button
  useEffect(() => {
    if (!isOpen) return
    if (typeToConfirm && typeToConfirmInputRef.current) {
      typeToConfirmInputRef.current.focus()
    } else if (actions && firstActionRef.current) {
      firstActionRef.current.focus()
    } else if (confirmButtonRef.current) {
      confirmButtonRef.current.focus()
    }
  }, [isOpen, actions, typeToConfirm])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const confirmGateMet = !typeToConfirm || typedText === typeToConfirm.expectedText

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(2px)',
          zIndex: 10000,
        }}
        onClick={onCancel}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'var(--theme-bg)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.24)',
          padding: '24px',
          minWidth: '360px',
          maxWidth: '480px',
          zIndex: 10001,
        }}
      >
        {/* Title */}
        <h2
          id="modal-title"
          style={{
            margin: '0 0 12px 0',
            fontSize: '18px',
            fontWeight: 600,
            color: 'var(--theme-elevation-800)',
          }}
        >
          {title}
        </h2>

        {/* Message */}
        <p
          style={{
            margin: '0 0 8px 0',
            fontSize: '14px',
            color: 'var(--theme-elevation-600)',
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>

        {/* Details */}
        {details && (
          <p
            style={{
              margin: '0 0 16px 0',
              fontSize: '13px',
              color: 'var(--theme-elevation-500)',
              padding: '12px',
              backgroundColor: danger
                ? 'var(--theme-error-50, #fef2f2)'
                : 'var(--theme-elevation-50)',
              borderRadius: '4px',
              lineHeight: 1.4,
            }}
          >
            {details}
          </p>
        )}

        {/* Type-to-confirm input */}
        {typeToConfirm && (
          <div style={{ marginBottom: '20px' }}>
            <label
              htmlFor="type-to-confirm-input"
              style={{
                display: 'block',
                marginBottom: '6px',
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--theme-elevation-700)',
              }}
            >
              {typeToConfirm.label}
            </label>
            <input
              ref={typeToConfirmInputRef}
              id="type-to-confirm-input"
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder={typeToConfirm.placeholder}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--theme-elevation-150)',
                borderRadius: '4px',
                fontSize: '14px',
                backgroundColor: 'var(--theme-input-bg)',
                color: 'var(--theme-elevation-800)',
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'monospace',
              }}
            />
          </div>
        )}

        {/* Buttons */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '12px',
            marginTop: details || typeToConfirm ? '0' : '24px',
            flexWrap: 'wrap',
          }}
        >
          {actions ? (
            <>
              <button
                onClick={onCancel}
                style={{
                  padding: '8px 16px',
                  border: '1px solid var(--theme-elevation-150)',
                  borderRadius: '4px',
                  backgroundColor: 'transparent',
                  color: 'var(--theme-elevation-600)',
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                {cancelLabel}
              </button>
              {actions.map((action, index) => {
                const getButtonStyles = () => {
                  const base = {
                    padding: '8px 16px',
                    borderRadius: '4px',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: confirmGateMet ? 'pointer' : 'not-allowed',
                    opacity: confirmGateMet ? 1 : 0.5,
                  }
                  switch (action.variant) {
                    case 'danger':
                      return {
                        ...base,
                        border: 'none',
                        backgroundColor: 'var(--theme-error-500, #ef4444)',
                        color: 'white',
                      }
                    case 'secondary':
                      return {
                        ...base,
                        border: '1px solid var(--theme-elevation-250)',
                        backgroundColor: 'var(--theme-elevation-100)',
                        color: 'var(--theme-elevation-800)',
                      }
                    case 'primary':
                    default:
                      return {
                        ...base,
                        border: 'none',
                        backgroundColor: 'var(--theme-success-500, #22c55e)',
                        color: 'white',
                      }
                  }
                }
                return (
                  <button
                    key={action.label}
                    ref={index === 0 ? firstActionRef : undefined}
                    onClick={action.onClick}
                    disabled={!confirmGateMet}
                    style={getButtonStyles()}
                  >
                    {action.label}
                  </button>
                )
              })}
            </>
          ) : (
            <>
              <button
                onClick={onCancel}
                style={{
                  padding: '8px 16px',
                  border: '1px solid var(--theme-elevation-150)',
                  borderRadius: '4px',
                  backgroundColor: 'transparent',
                  color: 'var(--theme-elevation-600)',
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                {cancelLabel}
              </button>
              <button
                ref={confirmButtonRef}
                onClick={onConfirm}
                disabled={!confirmGateMet}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: '4px',
                  backgroundColor: danger
                    ? 'var(--theme-error-500, #ef4444)'
                    : 'var(--theme-success-500, #22c55e)',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: confirmGateMet ? 'pointer' : 'not-allowed',
                  opacity: confirmGateMet ? 1 : 0.5,
                }}
              >
                {confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export default ConfirmationModal
```

Important behavioral note: when `typeToConfirm` is set AND `actions` is set, ALL action buttons are gated (because we don't know which is the "primary" — both Update and Cancel are valid actions). The cancel button at the top of the actions array is NOT gated because it's the modal's escape hatch. In practice for our folder-move use case, the modal will be re-rendered with a single "Confirm and Update URLs" action when the type-to-confirm gate is active, so this works out.

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ConfirmationModal.tsx
git commit -m "feat(modal): add typeToConfirm prop to ConfirmationModal"
```

---

### Task 12: Remove rename confirmation modal from `PageTreeClient`

**Files:**
- Modify: `src/components/PageTreeClient.tsx`

- [ ] **Step 1: Remove the `PendingRename` interface**

In `src/components/PageTreeClient.tsx`, delete the `PendingRename` interface (around lines 91-95):

```ts
interface PendingRename {
  node: TreeNodeType
  newName: string
  affectedCount: number
}
```

- [ ] **Step 2: Remove the `pendingRename` state**

Delete this line (around line 198):

```ts
const [pendingRename, setPendingRename] = useState<PendingRename | null>(null)
```

- [ ] **Step 3: Simplify `executeRename`**

Replace the existing `executeRename` callback (around lines 448-487) with:

```ts
// Execute a rename — display field only, never touches the slug
const executeRename = useCallback(
  async (node: TreeNodeType, newName: string) => {
    // Optimistic update
    const newData = updateNodeInTree(data, node.id, { name: newName })
    setData(newData)

    try {
      await apiCall('/page-tree/rename', {
        method: 'POST',
        body: JSON.stringify({
          type: node.type,
          id: getRawId(node),
          name: newName,
          collection: node.collection,
        }),
      })
      toast.success(`Renamed to "${newName}"`)
    } catch (error) {
      console.error('Rename failed:', error)
      setData(treeData)
      const message = error instanceof Error ? error.message : 'Rename failed'
      toast.error(message)
    }
  },
  [data, treeData, apiCall],
)
```

What changed:
- Removed `updateSlugs: boolean` parameter
- Removed `body.updateSlugs` from request
- Removed conditional toast for `updateSlugs && node.type === 'folder'`
- Removed the `window.location.reload()` (slug never changes, no need to refresh)
- Removed the special-case error message for "unique"/"duplicate"/"already exists" — the rename endpoint no longer produces these errors

- [ ] **Step 4: Simplify `handleRename`**

Replace the existing `handleRename` callback (around lines 489-508) with:

```ts
// Handle rename — display field only, no slug impact
const handleRename = useCallback(
  async ({ id, name }: { id: string; name: string }) => {
    const node = findNode(data, id)
    if (!node) return
    executeRename(node, name)
  },
  [data, executeRename],
)
```

What changed:
- Removed the `node.type === 'folder'` branch that opened the rename confirmation modal
- Removed `countNestedItems(node)` call (no longer needed for rename)
- Just calls `executeRename` directly for both pages and folders

- [ ] **Step 5: Delete `confirmRename` and `cancelRename` callbacks**

Delete the `confirmRename` callback (around lines 510-519) and the `cancelRename` callback (around lines 521-524):

```ts
const confirmRename = useCallback(
  (updateSlugs: boolean) => {
    if (pendingRename) {
      executeRename(pendingRename.node, pendingRename.newName, updateSlugs)
      setPendingRename(null)
    }
  },
  [pendingRename, executeRename],
)

const cancelRename = useCallback(() => {
  setPendingRename(null)
}, [])
```

- [ ] **Step 6: Delete the rename confirmation modal markup**

In the JSX render block (around lines 1072-1091), delete the entire `{/* Rename Confirmation Modal */}` section:

```tsx
{/* Rename Confirmation Modal */}
<ConfirmationModal
  isOpen={pendingRename !== null}
  title="Rename Folder"
  message={`Renaming "${pendingRename?.node.name}" to "${pendingRename?.newName}" - what should happen to child page URLs?`}
  details={`${pendingRename?.affectedCount} page${pendingRename?.affectedCount === 1 ? '' : 's'} in this folder.`}
  onCancel={cancelRename}
  actions={[
    {
      label: 'Keep existing URLs',
      onClick: () => confirmRename(false),
      variant: 'secondary',
    },
    {
      label: 'Update URLs',
      onClick: () => confirmRename(true),
      variant: 'primary',
    },
  ]}
/>
```

- [ ] **Step 7: Build to verify**

Run: `pnpm build`
Expected: Build succeeds. No TypeScript errors about unused identifiers.

- [ ] **Step 8: Commit**

```bash
git add src/components/PageTreeClient.tsx
git commit -m "feat(tree): remove obsolete rename confirmation modal"
```

---

### Task 13: EditUrlModal — add live debounced availability check

**Files:**
- Modify: `src/components/EditUrlModal.tsx`

- [ ] **Step 1: Update the component props and add availability state**

The EditUrlModal currently doesn't know enough to call the check-segment endpoint — it needs the parent ID and an `apiCall` helper. Add new optional props.

Update the props interface near the top:

```ts
type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken'

interface EditUrlModalProps {
  isOpen: boolean
  node: TreeNode | null
  folderPath: string
  /** Folder ID of the parent for collision lookups. Null = root. */
  parentId: string | null
  /** API call helper from PageTreeClient. */
  apiCall: (endpoint: string, options?: RequestInit) => Promise<unknown>
  onSave: (segment: string) => Promise<void>
  onCancel: () => void
}
```

- [ ] **Step 2: Add availability state and original-segment tracking**

Inside the component body, after the existing `useState` declarations, add:

```ts
const [availability, setAvailability] = useState<AvailabilityState>('idle')
const [originalSegment, setOriginalSegment] = useState('')
```

Update the existing "initialize segment when modal opens" effect (currently at lines 40-47) to also capture the original segment:

```ts
// Initialize segment when modal opens
useEffect(() => {
  if (isOpen && node) {
    const currentSegment = node.type === 'folder' ? node.pathSegment : node.slug?.split('/').pop()
    const initial = currentSegment || ''
    setSegment(initial)
    setOriginalSegment(initial)
    setError(null)
    setSaving(false)
    setAvailability('idle')
  }
}, [isOpen, node])
```

- [ ] **Step 3: Add the debounced availability check effect**

Add this new effect after the initialize-segment effect:

```ts
// Debounced live availability check (300ms)
//
// Race-condition guard: we use a closed-over `cancelled` flag rather than
// comparing segment values inside the callback, because the callback's
// closure captures `segment` at effect-run time — comparing it to itself is
// always trivially true and provides no race protection. The cleanup
// function sets cancelled=true so any in-flight fetch from a stale effect
// can short-circuit before calling setAvailability.
useEffect(() => {
  if (!isOpen || !node) return

  const slugifiedSegment = slugify(segment)

  // Empty segment, or unchanged from original — no check needed
  if (!slugifiedSegment || slugifiedSegment === originalSegment) {
    setAvailability('idle')
    return
  }

  setAvailability('checking')

  let cancelled = false
  const timeoutId = setTimeout(async () => {
    try {
      const params = new URLSearchParams({
        type: node.type,
        segment: slugifiedSegment,
        excludeId: node.rawId || node.id.replace(/^(folder|page)-/, ''),
      })
      if (parentId) params.set('parentId', parentId)
      if (node.collection) params.set('collection', node.collection)

      const result = (await apiCall(`/page-tree/check-segment?${params.toString()}`)) as {
        available: boolean
      }

      if (!cancelled) {
        setAvailability(result.available ? 'available' : 'taken')
      }
    } catch (err) {
      if (!cancelled) {
        console.error('Availability check failed:', err)
        setAvailability('idle')
      }
    }
  }, 300)

  return () => {
    cancelled = true
    clearTimeout(timeoutId)
  }
}, [isOpen, node, segment, originalSegment, parentId, apiCall])
```

- [ ] **Step 4: Add the visual indicator below the input**

Find the existing input block (around lines 172-221). After the closing `</input>` tag and before the existing `{error && (...)}` block, add the availability indicator:

```tsx
{availability === 'checking' && (
  <p
    style={{
      margin: '6px 0 0 0',
      fontSize: '12px',
      color: 'var(--theme-elevation-500)',
    }}
  >
    Checking availability...
  </p>
)}
{availability === 'available' && (
  <p
    style={{
      margin: '6px 0 0 0',
      fontSize: '12px',
      color: 'var(--theme-success-500, #22c55e)',
    }}
  >
    ✓ Available
  </p>
)}
{availability === 'taken' && (
  <p
    style={{
      margin: '6px 0 0 0',
      fontSize: '12px',
      color: 'var(--theme-error-500, #ef4444)',
    }}
  >
    ✗ URL is already in use
  </p>
)}
```

- [ ] **Step 5: Gate the Save button on availability**

Find the Save button (around lines 280-296). Replace its `disabled` and `style.cursor` / `style.opacity` logic to incorporate the availability state:

```tsx
<button
  onClick={handleSave}
  disabled={
    saving ||
    !slugify(segment) ||
    availability === 'taken' ||
    availability === 'checking'
  }
  style={{
    padding: '8px 16px',
    border: 'none',
    borderRadius: '4px',
    backgroundColor: 'var(--theme-success-500, #22c55e)',
    color: 'white',
    fontSize: '14px',
    fontWeight: 500,
    cursor:
      saving ||
      !slugify(segment) ||
      availability === 'taken' ||
      availability === 'checking'
        ? 'not-allowed'
        : 'pointer',
    opacity:
      saving ||
      !slugify(segment) ||
      availability === 'taken' ||
      availability === 'checking'
        ? 0.6
        : 1,
  }}
>
  {saving ? 'Saving...' : 'Save'}
</button>
```

- [ ] **Step 6: Update PageTreeClient to pass new props to EditUrlModal**

In `src/components/PageTreeClient.tsx`, find the `<EditUrlModal />` JSX (around lines 1135-1141) and update it:

```tsx
{/* Edit URL Modal */}
<EditUrlModal
  isOpen={editUrlState !== null}
  node={editUrlState?.node ?? null}
  folderPath={editUrlState?.folderPath ?? ''}
  parentId={stripIdPrefix(editUrlState?.node?.folderId ?? null)}
  apiCall={apiCall}
  onSave={handleEditUrlSave}
  onCancel={closeEditUrl}
/>
```

CRITICAL: `node.folderId` from `buildTree.ts:33,71` is the PREFIXED tree ID
(e.g., `folder-42`), NOT the raw database ID. Passing it unchanged would
break every collision check because the server query
`folder: { equals: 'folder-42' }` matches zero records, silently returning
`available: true` for everything. The `stripIdPrefix` helper already exists
in `PageTreeClient.tsx:106-109` and converts `'folder-42'` → `'42'`.

- [ ] **Step 7: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/components/EditUrlModal.tsx src/components/PageTreeClient.tsx
git commit -m "feat(edit-url): live debounced availability check in modal"
```

---

### Task 14: EditUrlModal — add cascade impact display for folders

**Files:**
- Modify: `src/components/EditUrlModal.tsx`

- [ ] **Step 1: Add cascade impact state with discriminated union**

We use a discriminated union (loading / loaded / error) instead of `number | null`
because `null` is ambiguous — it can't distinguish "still fetching" from
"fetch failed" from "not applicable". The error state is critical: if the
count fetch fails, the modal MUST refuse to enter the type-to-confirm flow
to prevent the user approving an unknown-size cascade.

Inside the `EditUrlModal` component body, add:

```ts
type CascadeImpact =
  | { state: 'idle' }     // not a folder, or modal closed
  | { state: 'loading' }
  | { state: 'loaded'; count: number }
  | { state: 'error'; message: string }

const [cascadeImpact, setCascadeImpact] = useState<CascadeImpact>({ state: 'idle' })
```

- [ ] **Step 2: Add an effect to fetch the cascade impact when modal opens for a folder**

After the initialize-segment effect, add:

```ts
// Fetch cascade impact for folders. Errors are surfaced as an explicit
// 'error' state — they MUST NOT degrade silently to 'no children', because
// a missed count would let the user approve a cascade of unknown size.
useEffect(() => {
  if (!isOpen || !node || node.type !== 'folder') {
    setCascadeImpact({ state: 'idle' })
    return
  }

  const folderId = node.rawId || node.id.replace(/^folder-/, '')
  let cancelled = false

  setCascadeImpact({ state: 'loading' })

  ;(async () => {
    try {
      const result = (await apiCall(`/page-tree/folder-impact?folderId=${folderId}`)) as {
        childPageCount: number
      }
      if (!cancelled) {
        setCascadeImpact({ state: 'loaded', count: result.childPageCount })
      }
    } catch (err) {
      if (!cancelled) {
        console.error('Folder impact fetch failed:', err)
        setCascadeImpact({
          state: 'error',
          message: err instanceof Error ? err.message : 'Failed to fetch cascade impact',
        })
      }
    }
  })()

  return () => {
    cancelled = true
  }
}, [isOpen, node, apiCall])
```

- [ ] **Step 3: Render the warning row (and error row) below the description**

Find the existing description paragraph (around lines 159-170). After it and
before the input block, add:

```tsx
{isFolder && cascadeImpact.state === 'loaded' && cascadeImpact.count > 0 && (
  <div
    style={{
      padding: '10px 12px',
      backgroundColor: 'var(--theme-warning-50, #fffbeb)',
      border: '1px solid var(--theme-warning-200, #fde68a)',
      borderRadius: '4px',
      marginBottom: '16px',
      fontSize: '13px',
      color: 'var(--theme-warning-800, #92400e)',
    }}
  >
    Warning: this will update URLs for {cascadeImpact.count} child page
    {cascadeImpact.count === 1 ? '' : 's'}.
  </div>
)}
{isFolder && cascadeImpact.state === 'error' && (
  <div
    style={{
      padding: '10px 12px',
      backgroundColor: 'var(--theme-error-50, #fef2f2)',
      border: '1px solid var(--theme-error-200, #fecaca)',
      borderRadius: '4px',
      marginBottom: '16px',
      fontSize: '13px',
      color: 'var(--theme-error-700, #b91c1c)',
    }}
  >
    Failed to fetch cascade impact: {cascadeImpact.message}. Save is disabled
    until this can be retrieved.
  </div>
)}
```

- [ ] **Step 4: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditUrlModal.tsx
git commit -m "feat(edit-url): show cascade impact count for folder URL edits"
```

---

### Task 15: EditUrlModal — add type-to-confirm gate for folders with children

**Files:**
- Modify: `src/components/EditUrlModal.tsx`

- [ ] **Step 1: Add confirmation input state**

Inside the component body, add:

```ts
const [confirmInput, setConfirmInput] = useState('')
```

- [ ] **Step 2: Reset confirmation input when segment changes or modal opens**

Update the existing "initialize segment when modal opens" effect to also clear confirmInput:

```ts
useEffect(() => {
  if (isOpen && node) {
    const currentSegment = node.type === 'folder' ? node.pathSegment : node.slug?.split('/').pop()
    const initial = currentSegment || ''
    setSegment(initial)
    setOriginalSegment(initial)
    setError(null)
    setSaving(false)
    setAvailability('idle')
    setConfirmInput('')
  }
}, [isOpen, node])
```

Add a new effect that clears confirmInput whenever the segment changes (so editing the URL after typing the confirmation forces a re-type):

```ts
// Clear type-to-confirm input whenever the segment changes
// (forces re-confirmation if the user edits the URL after typing the confirmation)
useEffect(() => {
  setConfirmInput('')
}, [segment])
```

- [ ] **Step 3: Compute whether the type-to-confirm gate applies and is satisfied**

Add these computed values just before the return statement (around line 113, near `const isFolder = node.type === 'folder'`):

```ts
const slugifiedSegmentValue = slugify(segment)
const requiresTypeToConfirm =
  isFolder && cascadeImpact.state === 'loaded' && cascadeImpact.count > 0
const typeToConfirmSatisfied =
  !requiresTypeToConfirm || confirmInput === slugifiedSegmentValue
// If we're editing a folder but the cascade fetch is in flight or failed,
// we MUST NOT allow saving — proceeding would let the user approve a
// cascade of unknown size.
const cascadeFetchBlocking =
  isFolder && (cascadeImpact.state === 'loading' || cascadeImpact.state === 'error')
```

- [ ] **Step 4: Render the type-to-confirm input below the cascade warning**

After the cascade warning block from Task 14 and before the URL Segment input, add:

```tsx
{requiresTypeToConfirm && (
  <div style={{ marginBottom: '16px' }}>
    <label
      htmlFor="type-to-confirm-segment"
      style={{
        display: 'block',
        marginBottom: '6px',
        fontSize: '13px',
        fontWeight: 500,
        color: 'var(--theme-elevation-700)',
      }}
    >
      Type "{slugifiedSegmentValue}" to confirm:
    </label>
    <input
      id="type-to-confirm-segment"
      type="text"
      value={confirmInput}
      onChange={(e) => setConfirmInput(e.target.value)}
      placeholder={slugifiedSegmentValue}
      disabled={!slugifiedSegmentValue}
      style={{
        width: '100%',
        padding: '8px 12px',
        border: '1px solid var(--theme-elevation-150)',
        borderRadius: '4px',
        fontSize: '14px',
        backgroundColor: 'var(--theme-input-bg)',
        color: 'var(--theme-elevation-800)',
        outline: 'none',
        boxSizing: 'border-box',
        fontFamily: 'monospace',
      }}
    />
  </div>
)}
```

Note: this block should appear AFTER the cascade warning (Task 14) and AFTER the URL Segment input block. Order in the modal body:
1. Title
2. Description
3. Cascade warning (Task 14)
4. URL Segment input + availability indicator (existing + Task 13)
5. Preview
6. Type-to-confirm input (this task) — placed AFTER preview so the user sees the new URL before re-typing it
7. Buttons

- [ ] **Step 5: Add the type-to-confirm gate AND cascade-fetch block to the Save button disable logic**

Update the Save button's `disabled` and `cursor`/`opacity` logic to include
both `!typeToConfirmSatisfied` and `cascadeFetchBlocking`:

```tsx
{(() => {
  const isDisabled =
    saving ||
    !slugify(segment) ||
    availability === 'taken' ||
    availability === 'checking' ||
    !typeToConfirmSatisfied ||
    cascadeFetchBlocking
  return (
    <button
      onClick={handleSave}
      disabled={isDisabled}
      style={{
        padding: '8px 16px',
        border: 'none',
        borderRadius: '4px',
        backgroundColor: 'var(--theme-success-500, #22c55e)',
        color: 'white',
        fontSize: '14px',
        fontWeight: 500,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.6 : 1,
      }}
    >
      {saving ? 'Saving...' : 'Save'}
    </button>
  )
})()}
```

The IIFE wrapper extracts the `isDisabled` calculation so it isn't repeated
three times. The previous version of this code would've duplicated the
check inside `disabled`, `cursor`, and `opacity` props — error-prone when
adding new conditions like `cascadeFetchBlocking`.

- [ ] **Step 6: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/EditUrlModal.tsx
git commit -m "feat(edit-url): type-to-confirm gate for folders with children"
```

---

### Task 16: PageTreeClient — add type-to-confirm to single folder-move "Update URLs"

**Files:**
- Modify: `src/components/PageTreeClient.tsx`

- [ ] **Step 1: Add a `pendingMoveConfirmation` state for the second-stage confirmation**

In `PageTreeClient.tsx`, add a new state and interface near the existing `PendingMove` interface (around line 51):

```ts
interface PendingMoveConfirmation {
  /** The original pending move that was confirmed for "Update URLs" */
  pendingMove: PendingMove
  /** The folder's pathSegment, which the user must type to confirm */
  expectedSegment: string
}
```

And in the state declarations (around line 192):

```ts
const [pendingMoveConfirmation, setPendingMoveConfirmation] = useState<PendingMoveConfirmation | null>(null)
```

- [ ] **Step 2: Update `confirmMove` to gate folder moves with children**

Replace the existing `confirmMove` callback (around lines 374-388) with:

```ts
// Confirm move operation
const confirmMove = useCallback(
  (updateSlugs: boolean) => {
    if (!pendingMove) return

    // Folder moves with children + Update URLs require type-to-confirm
    if (
      updateSlugs &&
      pendingMove.node.type === 'folder' &&
      pendingMove.affectedCount > 0
    ) {
      // Look up the folder's pathSegment to use as the type-to-confirm target.
      // SAFETY: if pathSegment is missing or empty, the type-to-confirm gate
      // becomes "type empty string to confirm" which any input satisfies —
      // defeating the entire safety mechanism. Refuse to proceed and surface
      // an error instead.
      const expectedSegment = pendingMove.node.pathSegment
      if (!expectedSegment) {
        toast.error(
          `Cannot update URLs: folder "${pendingMove.node.name}" has no URL segment`,
        )
        setPendingMove(null)
        return
      }
      setPendingMoveConfirmation({ pendingMove, expectedSegment })
      setPendingMove(null)
      return
    }

    // Otherwise proceed immediately (page move, or folder with no children, or Keep URLs)
    executeMove(
      pendingMove.dragIds,
      pendingMove.parentId,
      pendingMove.index,
      pendingMove.node,
      updateSlugs,
    )
    setPendingMove(null)
  },
  [pendingMove, executeMove],
)
```

- [ ] **Step 3: Add confirm and cancel callbacks for the second-stage modal**

Add these callbacks immediately after `confirmMove`:

```ts
// Confirm the type-to-confirm gate for folder move with Update URLs
const confirmMoveTypeGate = useCallback(() => {
  if (!pendingMoveConfirmation) return
  const { pendingMove: pm } = pendingMoveConfirmation
  executeMove(pm.dragIds, pm.parentId, pm.index, pm.node, true)
  setPendingMoveConfirmation(null)
}, [pendingMoveConfirmation, executeMove])

const cancelMoveTypeGate = useCallback(() => {
  setPendingMoveConfirmation(null)
}, [])
```

- [ ] **Step 4: Render the second-stage confirmation modal**

Find the move confirmation modal in the JSX (around lines 997-1024). After it (and before the bulk move modal), add:

```tsx
{/* Move Type-to-Confirm Modal (folder + Update URLs path) */}
<ConfirmationModal
  isOpen={pendingMoveConfirmation !== null}
  title="Confirm URL Update"
  message={
    pendingMoveConfirmation
      ? `This will update URLs for ${pendingMoveConfirmation.pendingMove.affectedCount} child page${pendingMoveConfirmation.pendingMove.affectedCount === 1 ? '' : 's'}.`
      : ''
  }
  details={
    pendingMoveConfirmation
      ? `The folder's URL segment is: ${pendingMoveConfirmation.expectedSegment}`
      : undefined
  }
  onCancel={cancelMoveTypeGate}
  typeToConfirm={
    pendingMoveConfirmation
      ? {
          expectedText: pendingMoveConfirmation.expectedSegment,
          label: `Type "${pendingMoveConfirmation.expectedSegment}" to confirm:`,
          placeholder: pendingMoveConfirmation.expectedSegment,
        }
      : undefined
  }
  actions={[
    {
      label: 'Confirm and Update URLs',
      onClick: confirmMoveTypeGate,
      variant: 'primary',
    },
  ]}
/>
```

- [ ] **Step 5: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/PageTreeClient.tsx
git commit -m "feat(move): type-to-confirm for single folder-move Update URLs path"
```

---

### Task 17: PageTreeClient — add type-to-confirm to bulk folder-move "Update URLs"

**Files:**
- Modify: `src/components/PageTreeClient.tsx`

**Why this is more complex than Task 16:** the bulk move flow has its own
modal state machine (`pendingBulkMove` with a `currentIndex` that walks
through items). When the user clicks "Update URL" or "Update All URLs" on
folder-with-children items, we need to gate them WITHOUT letting the bulk
modal and the type-to-confirm modal render simultaneously, AND without
losing the user's progress through the bulk queue.

**State model:** introduce a single `pendingBulkMoveTypeGate` state. When set,
the bulk modal hides itself and the type-to-confirm modal shows. The gate
holds:
1. The current item being confirmed
2. A queue of *other* folders awaiting confirmation (in case the user clicked
   "Update All" and multiple folders need gating)
3. Whether to resume the bulk flow after the gate finishes (true for the
   per-item path from `confirmBulkMoveItem`, false for the "Update All" path
   from `confirmBulkMoveAll` since that path commits to all remaining items
   atomically)

- [ ] **Step 1: Add bulk move type-gate state**

Near the existing `BulkMoveItem` interface, add:

```ts
interface PendingBulkMoveTypeGate {
  /** The folder currently being type-to-confirmed */
  current: BulkMoveItem
  /** The pre-validated segment the user must type */
  expectedSegment: string
  /** Other folders waiting for type-to-confirm after the current one */
  queue: BulkMoveItem[]
  /** Whether to resume the bulk flow after the gate completes (or is cancelled) */
  resumeBulk: boolean
}
```

In the state declarations (around line 192):

```ts
const [pendingBulkMoveTypeGate, setPendingBulkMoveTypeGate] =
  useState<PendingBulkMoveTypeGate | null>(null)
```

- [ ] **Step 2: Extract a `getValidatedSegment` helper**

Add this near the top of the component (or as a top-level helper function):

```ts
// Returns the folder's pathSegment if non-empty, or null if missing/empty.
// A null result MUST cause the caller to refuse the type-to-confirm flow,
// because an empty expected text trivially satisfies the gate (`'' === ''`)
// and defeats the entire safety mechanism.
function getValidatedSegment(node: TreeNodeType): string | null {
  return node.pathSegment && node.pathSegment.length > 0 ? node.pathSegment : null
}
```

- [ ] **Step 3: Extract an `advanceBulkMove` helper**

The existing `confirmBulkMoveItem` has inline logic to advance to the next
bulk item, auto-executing items that don't require confirmation along the
way. We need to call this from two places now (the existing path AND the
type-gate confirm/cancel paths), so extract it as a helper inside the
component:

```ts
// Advances the bulk move past `fromIndex`, auto-executing items that don't
// require confirmation, and stopping at the next item that does (or clearing
// pendingBulkMove if there are none left). Returns true if the bulk modal
// should remain open, false if it was cleared.
const advanceBulkMove = useCallback(
  (bulk: PendingBulkMove, fromIndex: number): boolean => {
    let nextIndex = fromIndex
    while (nextIndex < bulk.items.length) {
      if (bulk.items[nextIndex].requiresConfirmation) break
      const item = bulk.items[nextIndex]
      executeMove([item.dragId], item.parentId, item.index, item.node, false)
      nextIndex++
    }

    if (nextIndex >= bulk.items.length) {
      setPendingBulkMove(null)
      return false
    }
    setPendingBulkMove({ ...bulk, currentIndex: nextIndex })
    return true
  },
  [executeMove],
)
```

- [ ] **Step 4: Update `confirmBulkMoveItem` to use the type-gate**

Replace the existing `confirmBulkMoveItem` callback (around lines 396-420) with:

```ts
// Confirm single item in bulk move
const confirmBulkMoveItem = useCallback(
  (updateSlugs: boolean) => {
    if (!pendingBulkMove) return

    const currentItem = pendingBulkMove.items[pendingBulkMove.currentIndex]

    // Folder moves with children + Update URLs require type-to-confirm.
    // Pause the bulk flow (the bulk modal will hide via its render guard)
    // and show the gate. The gate's confirm/cancel will resume the bulk
    // flow at the next item.
    if (
      updateSlugs &&
      currentItem.node.type === 'folder' &&
      currentItem.affectedCount > 0
    ) {
      const expectedSegment = getValidatedSegment(currentItem.node)
      if (!expectedSegment) {
        toast.error(
          `Cannot update URLs: folder "${currentItem.node.name}" has no URL segment`,
        )
        // Skip this item entirely — advance bulk to the next
        advanceBulkMove(pendingBulkMove, pendingBulkMove.currentIndex + 1)
        return
      }
      setPendingBulkMoveTypeGate({
        current: currentItem,
        expectedSegment,
        queue: [],
        resumeBulk: true,
      })
      return
    }

    // Existing path: execute and advance
    executeMove(
      [currentItem.dragId],
      currentItem.parentId,
      currentItem.index,
      currentItem.node,
      updateSlugs,
    )
    advanceBulkMove(pendingBulkMove, pendingBulkMove.currentIndex + 1)
  },
  [pendingBulkMove, executeMove, advanceBulkMove],
)
```

- [ ] **Step 5: Update `confirmBulkMoveAll` to use the type-gate**

Replace the existing `confirmBulkMoveAll` callback (around lines 422-441) with:

```ts
// Confirm all remaining items in bulk move
const confirmBulkMoveAll = useCallback(
  (updateSlugs: boolean) => {
    if (!pendingBulkMove) return

    if (!updateSlugs) {
      // Keep all URLs — execute everything immediately, existing behavior
      for (let i = pendingBulkMove.currentIndex; i < pendingBulkMove.items.length; i++) {
        const item = pendingBulkMove.items[i]
        executeMove([item.dragId], item.parentId, item.index, item.node, false)
      }
      setPendingBulkMove(null)
      return
    }

    // Update URLs path: walk remaining items, executing non-folder ones
    // immediately, collecting folder-with-children ones into a type-to-confirm
    // queue. The "Update All" path commits to ALL remaining items atomically,
    // so resumeBulk is false — once the queue is exhausted, we're done.
    const itemsToGate: BulkMoveItem[] = []
    for (let i = pendingBulkMove.currentIndex; i < pendingBulkMove.items.length; i++) {
      const item = pendingBulkMove.items[i]
      const isGatedFolder =
        item.requiresConfirmation &&
        item.node.type === 'folder' &&
        item.affectedCount > 0

      if (isGatedFolder) {
        const seg = getValidatedSegment(item.node)
        if (!seg) {
          toast.error(
            `Cannot update URLs: folder "${item.node.name}" has no URL segment — skipping`,
          )
          continue
        }
        itemsToGate.push(item)
      } else {
        const shouldUpdate = item.requiresConfirmation ? true : false
        executeMove([item.dragId], item.parentId, item.index, item.node, shouldUpdate)
      }
    }

    setPendingBulkMove(null)

    if (itemsToGate.length === 0) return

    const [first, ...rest] = itemsToGate
    setPendingBulkMoveTypeGate({
      current: first,
      expectedSegment: getValidatedSegment(first.node)!, // pre-validated above
      queue: rest,
      resumeBulk: false,
    })
  },
  [pendingBulkMove, executeMove],
)
```

- [ ] **Step 6: Add callbacks for advancing through the bulk type-gate**

Add these callbacks immediately after `confirmBulkMoveAll`:

```ts
// Confirm the current item in the bulk type-gate
const confirmBulkMoveTypeGate = useCallback(() => {
  if (!pendingBulkMoveTypeGate) return

  const { current, queue, resumeBulk } = pendingBulkMoveTypeGate

  // Execute the current gated move
  executeMove([current.dragId], current.parentId, current.index, current.node, true)

  // Pop next from gate queue
  if (queue.length > 0) {
    const [next, ...rest] = queue
    const seg = getValidatedSegment(next.node)
    if (!seg) {
      // Should be unreachable since we pre-validated, but defensive
      toast.error(`Cannot update URLs: folder "${next.node.name}" has no URL segment`)
      setPendingBulkMoveTypeGate(null)
      if (resumeBulk && pendingBulkMove) {
        advanceBulkMove(pendingBulkMove, pendingBulkMove.currentIndex + 1)
      }
      return
    }
    setPendingBulkMoveTypeGate({
      current: next,
      expectedSegment: seg,
      queue: rest,
      resumeBulk,
    })
    return
  }

  // Queue exhausted
  setPendingBulkMoveTypeGate(null)
  if (resumeBulk && pendingBulkMove) {
    advanceBulkMove(pendingBulkMove, pendingBulkMove.currentIndex + 1)
  }
}, [pendingBulkMoveTypeGate, pendingBulkMove, executeMove, advanceBulkMove])

// Cancel the bulk type-gate. Already-executed moves are NOT undone (cannot be).
// If we were resuming the bulk flow, advance past this item (treat cancel as
// "skip this folder, leave its URLs alone").
const cancelBulkMoveTypeGate = useCallback(() => {
  if (!pendingBulkMoveTypeGate) return
  const { resumeBulk } = pendingBulkMoveTypeGate
  setPendingBulkMoveTypeGate(null)
  if (resumeBulk && pendingBulkMove) {
    advanceBulkMove(pendingBulkMove, pendingBulkMove.currentIndex + 1)
  }
}, [pendingBulkMoveTypeGate, pendingBulkMove, advanceBulkMove])
```

- [ ] **Step 7: Hide the bulk modal while the type-gate is active**

Find the existing bulk move modal in the JSX (around lines 1027-1070). Update
its `isOpen` condition so it hides when the type-gate is shown. The current
markup wraps the modal in `{pendingBulkMove && (() => { ... })()}` — change
the guard:

```tsx
{pendingBulkMove && pendingBulkMoveTypeGate === null && (() => {
  const currentItem = pendingBulkMove.items[pendingBulkMove.currentIndex]
  // ... rest of existing markup ...
})()}
```

Without this change, both modals would render simultaneously and stack
backdrops on top of each other.

- [ ] **Step 8: Render the bulk type-gate modal**

In the JSX, after the single-move type-to-confirm modal from Task 16, add:

```tsx
{/* Bulk Move Type-to-Confirm Modal */}
{pendingBulkMoveTypeGate && (
  <ConfirmationModal
    isOpen={true}
    title={
      pendingBulkMoveTypeGate.queue.length > 0
        ? `Confirm URL Update (1 of ${pendingBulkMoveTypeGate.queue.length + 1})`
        : 'Confirm URL Update'
    }
    message={`Updating "${pendingBulkMoveTypeGate.current.node.name}" will rewrite URLs for ${pendingBulkMoveTypeGate.current.affectedCount} child page${pendingBulkMoveTypeGate.current.affectedCount === 1 ? '' : 's'}.`}
    details={
      pendingBulkMoveTypeGate.queue.length > 0
        ? `The folder's URL segment is: ${pendingBulkMoveTypeGate.expectedSegment}\n\n${pendingBulkMoveTypeGate.queue.length} more folder${pendingBulkMoveTypeGate.queue.length === 1 ? '' : 's'} will require confirmation after this.`
        : `The folder's URL segment is: ${pendingBulkMoveTypeGate.expectedSegment}`
    }
    onCancel={cancelBulkMoveTypeGate}
    typeToConfirm={{
      expectedText: pendingBulkMoveTypeGate.expectedSegment,
      label: `Type "${pendingBulkMoveTypeGate.expectedSegment}" to confirm:`,
      placeholder: pendingBulkMoveTypeGate.expectedSegment,
    }}
    actions={[
      {
        label: 'Confirm and Update URLs',
        onClick: confirmBulkMoveTypeGate,
        variant: 'primary',
      },
    ]}
  />
)}
```

- [ ] **Step 9: Build to verify**

Run: `pnpm build`
Expected: Build succeeds with no TypeScript errors. Pay particular attention
to any errors about `PendingBulkMove` not being a defined type — if so,
export the existing `PendingBulkMove` interface from its current file-local
declaration.

- [ ] **Step 10: Commit**

```bash
git add src/components/PageTreeClient.tsx
git commit -m "feat(move): type-to-confirm for bulk folder-move Update URLs path"
```

---

### Task 18: Surface "collisionResolved" in create toast

**Files:**
- Modify: `src/components/PageTreeClient.tsx` — TWO call sites:
  - `case 'newPage':` inside `handleContextAction` (around lines 603-627)
  - `case 'newFolder':` inside `handleContextAction` (around lines 629-652)

There is no `executeCreate` helper — both create call sites are inline in
the `handleContextAction` switch. Both make the API call, check
`result.success`, show a toast, then `window.location.reload()`. We need to
update BOTH places.

- [ ] **Step 1: Verify the current call site shapes**

Use Grep on `/page-tree/create` over `src/components/PageTreeClient.tsx` to
locate both branches. They should look approximately like (annotate any
differences you find):

```ts
case 'newPage': {
  const newName = prompt('New page name:')
  if (!newName) return
  try {
    const result = await apiCall('/page-tree/create', {
      method: 'POST',
      body: JSON.stringify({
        type: 'page',
        name: newName,
        parentId: node.type === 'folder' ? rawId : node.folderId,
        collection: node.collection || selectedCollection,
      }),
    })
    if (result.success) {
      toast.success('Page created')
      window.location.reload()
    }
  } catch (error) {
    // ...
  }
  break
}
```

If the actual code differs significantly, adapt the integration in step 2
accordingly.

- [ ] **Step 2: Update `case 'newPage'` to surface collisionResolved**

Replace the `result.success` branch with:

```ts
const result = (await apiCall('/page-tree/create', {
  method: 'POST',
  body: JSON.stringify({
    type: 'page',
    name: newName,
    parentId: node.type === 'folder' ? rawId : node.folderId,
    collection: node.collection || selectedCollection,
  }),
})) as {
  success: boolean
  type?: 'page' | 'folder'
  title?: string
  pageSegment?: string
  collisionResolved?: boolean
}

if (result.success) {
  if (result.collisionResolved && result.pageSegment) {
    toast.success(
      `Created "${result.title ?? newName}" with URL segment "${result.pageSegment}" (the original was already in use)`,
    )
  } else {
    toast.success(`Created "${result.title ?? newName}"`)
  }
  window.location.reload()
}
```

- [ ] **Step 3: Update `case 'newFolder'` to surface collisionResolved**

Replace the `result.success` branch with:

```ts
const result = (await apiCall('/page-tree/create', {
  method: 'POST',
  body: JSON.stringify({
    type: 'folder',
    name: newName,
    parentId: node.type === 'folder' ? rawId : node.folderId,
  }),
})) as {
  success: boolean
  type?: 'page' | 'folder'
  name?: string
  pathSegment?: string
  collisionResolved?: boolean
}

if (result.success) {
  if (result.collisionResolved && result.pathSegment) {
    toast.success(
      `Created folder "${result.name ?? newName}" with URL segment "${result.pathSegment}" (the original was already in use)`,
    )
  } else {
    toast.success(`Created folder "${result.name ?? newName}"`)
  }
  window.location.reload()
}
```

- [ ] **Step 4: Build to verify**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/PageTreeClient.tsx
git commit -m "feat(create): surface collisionResolved in success toast"
```

---

### Task 19: Manual smoke verification

**Files:** None — this is a manual verification task.

**Prerequisite:** Have the consuming app (`../cc-lms`) running with a recent `pnpm link` or local install of the plugin so changes are picked up.

- [ ] **Step 1: Verify rename safety (page)**

In the cc-lms admin:
1. Navigate to a page in the tree, e.g., `/contact/thank-you`
2. Note the current slug
3. Rename the page via the tree (F2 or context menu) to "Thank You Updated"
4. Verify the toast says `Renamed to "Thank You Updated"` (no mention of URL changes)
5. Verify the slug in the tree is unchanged
6. Open the page in the Payload admin form and verify the slug field still shows the original value

- [ ] **Step 2: Verify rename safety (folder, no confirmation modal)**

1. Find a folder containing pages, e.g., "Contact"
2. Rename it via the tree to "Contact Us"
3. Verify NO confirmation modal appears (this is the deletion from Task 12)
4. Verify the toast says `Renamed to "Contact Us"`
5. Verify all child page slugs still start with `/contact/...` (the original pathSegment)

- [ ] **Step 3: Verify duplicate title is allowed**

1. In the same folder, create or rename two pages to both be titled "Thank You"
2. Verify both creates/renames succeed without error
3. Verify the slugs differ: one is `/contact/thank-you`, the other is `/contact/thank-you-2`

- [ ] **Step 4: Verify create with collision auto-disambiguates**

1. In a folder with an existing "Thank You" page, create a new page named "Thank You"
2. Verify the new page is created successfully
3. Verify the toast surfaces the resolved URL: `Created "Thank You" with URL segment "thank-you-2" (the original was already in use)`
4. Verify the new page has title "Thank You" (NOT "Thank You (copy)") and pageSegment `thank-you-2`

- [ ] **Step 5: Verify duplicate behavior**

1. Right-click an existing page titled "Thank You" → Duplicate
2. Verify the duplicate is created with title `"Thank You (copy)"`
3. Verify its pageSegment is `thank-you-2` (NOT `thank-you-copy`)
4. Duplicate the duplicate
5. Verify the new one has title `"Thank You (copy 2)"` and pageSegment `thank-you-3`

- [ ] **Step 6: Verify Edit URL live availability check (page)**

1. Open Edit URL on a page
2. Type a segment used by a sibling page in the same folder
3. Verify the red "✗ URL is already in use" indicator appears within ~300ms
4. Verify the Save button is disabled
5. Change the segment to something free
6. Verify the green "✓ Available" indicator appears
7. Verify the Save button becomes enabled

- [ ] **Step 7: Verify Edit URL cascade warning (folder, no children)**

1. Find a folder with no child pages
2. Open Edit URL on it
3. Verify NO cascade warning is displayed
4. Verify NO type-to-confirm input is displayed
5. Change the segment to a new value and Save → succeeds immediately

- [ ] **Step 8: Verify Edit URL cascade warning + type-to-confirm (folder with children)**

1. Find a folder with several pages, e.g., "Contact" with 3 pages
2. Open Edit URL on it
3. Verify the cascade warning shows the correct count: `⚠ This will update URLs for 3 child pages.`
4. Verify a type-to-confirm input appears with placeholder showing the new segment
5. Change the segment to `contact-us`
6. Verify the type-to-confirm label updates to `Type "contact-us" to confirm:`
7. Verify the confirmation input is cleared whenever you edit the segment
8. Type `contact-us` exactly into the confirmation input
9. Verify Save becomes enabled
10. Type something wrong → Save disables
11. Type the correct value and click Save → succeeds, all child slugs updated

- [ ] **Step 9: Verify single folder-move type-to-confirm**

1. Drag a folder containing pages to a new parent
2. In the modal, click "Update URL"
3. Verify a second modal appears with the type-to-confirm input
4. Verify the message shows the correct child page count
5. Verify the details show the correct expected segment
6. Type the wrong text → Confirm button stays disabled
7. Type the correct text → Confirm button enables
8. Click Confirm → move proceeds, all child slugs updated

- [ ] **Step 10: Verify "Keep URLs" still works without confirmation**

1. Drag the same folder again
2. Click "Keep existing URL"
3. Verify the move happens immediately with no extra confirmation modal
4. Verify all child slugs are unchanged

- [ ] **Step 11: Verify bulk folder-move type-to-confirm**

1. Select two folders both containing children
2. Drag them to a new parent
3. In the bulk move modal, click "Update URL" for the first
4. Verify the type-to-confirm modal appears for the first folder
5. Type the correct segment, click Confirm
6. Verify the type-to-confirm modal appears for the second folder
7. Type the correct segment, click Confirm
8. Verify both moves complete successfully

- [ ] **Step 12: Verify folder uniqueness via Edit URL only**

1. Find two folders with the same `pathSegment` is impossible — if it exists, this test is moot. If you can create two folders named "Archive" in the same parent, verify their pathSegments are `archive` and `archive-2`.
2. Try to use Edit URL on the second folder to set its pathSegment to `archive`
3. Verify the live availability check shows "✗ URL is already in use" within 300ms
4. Verify Save is disabled

- [ ] **Step 13: Final sanity — admin form rename**

1. Open a page in the Payload admin form (not the tree)
2. Edit only the title field — change "Thank You" to "Thank You Page"
3. Save
4. Verify the slug field is unchanged
5. Verify the slug history is also unchanged (no new entry was created, since the slug didn't change)

If any of these steps fail, capture the failing behavior and STOP. Do not proceed to Task 20.

---

### Task 20: Version bump and changelog

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the version**

Current version is `0.3.12` (from `git log` in the task overview). Run:

```bash
npm version minor --no-git-tag-version
```

This bumps to `0.4.0` (since this is a meaningful behavior change — display fields are now decoupled from slugs, which is technically a breaking change in user-visible behavior even though no API contracts are removed).

Expected: `package.json` is updated to `0.4.0`. No git tag is created yet.

- [ ] **Step 2: Verify the build still passes after version bump**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit the version bump**

```bash
git add package.json
git commit -m "0.4.0"
```

(Matches the existing commit-message convention: previous version bumps are committed as bare version strings — see `git log` for `0.3.12`, `0.3.11`, etc.)

- [ ] **Step 4: Tag and push (USER ACTION)**

This step is for the user to run when ready to publish — NOT done automatically by the implementing agent. Suggest the user run:

```bash
git tag v0.4.0
git push && git push --tags
```

This triggers `.github/workflows/publish.yml` for npm OIDC publishing.

---

## Self-Review

I've reviewed this plan against the spec. Here's the coverage check:

**Spec coverage:**
- Display fields decoupled from URL segments → Tasks 3, 4, 6, 10
- Slug changes only via opt-in operations → Tasks 6, 10 (rename), 16, 17 (move gates)
- Auto-increment with toast → Tasks 3, 18
- Type-to-confirm for folder Edit URL with children → Tasks 14, 15
- Type-to-confirm for folder Move with children → Tasks 16, 17
- Live debounced availability check in EditUrlModal → Task 13
- New `segments.ts` helper module → Task 2
- New `check-segment` and `folder-impact` endpoints → Tasks 7, 8, 9
- Removal of folder-rename confirmation modal → Task 12
- Removal of `generateUniqueName` → Task 5
- Removal of `pathSegment`/`pageSegment` overwrites in rename → Task 10
- Addition of `'edit-url'` to `SlugChangeReason` → Tasks 1, 6
- `typeToConfirm` prop on ConfirmationModal → Task 11
- Manual verification → Task 19
- Version bump → Task 20

All spec sections covered.

**Type consistency:**
- `findAvailableSegment` defined in Task 2 with signature `(opts: SegmentLookupOptions & { baseSegment: string }) => Promise<string>`. Used in Tasks 3 and 4 — both pass the same shape. ✓
- `isSegmentAvailable` defined in Task 2 with signature `(opts: SegmentLookupOptions & { segment: string }) => Promise<boolean>`. Used in Tasks 6 and 7 — both pass the same shape. ✓
- `countDescendantPages` defined in Task 2 with signature `(opts: { payload, folderId, collections, folderSlug }) => Promise<number>`. Used in Task 8 — matches. ✓
- `EditUrlModal` props extended with `parentId` and `apiCall` in Task 13. Updated in Task 13 step 6 in PageTreeClient JSX. ✓
- `ConfirmationModal`'s new `typeToConfirm` prop defined in Task 11, used in Tasks 16 and 17. ✓
- `executeRename` signature changes from `(node, newName, updateSlugs) => Promise<void>` to `(node, newName) => Promise<void>` in Task 12. ✓

**Placeholder scan:**
- Task 18 has language like "the exact integration depends on the current call site shape" — this is a real ambiguity because I haven't fully audited where `executeCreate` lives. Acceptable: Step 1 of that task explicitly tells the implementer to grep for the call site first.
- All other tasks contain concrete code blocks. No "TODO", "TBD", or vague placeholders.

**Scope check:** This is a single coherent change touching 7 files in a coordinated way. Appropriate for a single plan.
