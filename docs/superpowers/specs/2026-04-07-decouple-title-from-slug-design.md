# Decouple Title from Slug — Design Spec

**Date:** 2026-04-07
**Status:** Draft, pending implementation
**Scope:** `@delmaredigital/payload-page-tree`

## Problem

The plugin currently couples display fields (`title`, `name`) to URL segments (`pageSegment`, `pathSegment`) in several places, producing two user-visible problems:

1. **False uniqueness errors on display fields.** The rename endpoint blocks two pages in the same folder from sharing a `title` (`treeOperations.ts:627-647`), and blocks two folders in the same parent from sharing a `name` (`treeOperations.ts:582-601`). These checks treat display fields as if they were uniqueness keys. Two pages titled "Thank You" in a `/contact` folder is a perfectly normal CMS scenario, but the plugin refuses it.

2. **Slug rewrites as a side effect of display-field edits.** The rename endpoint can rewrite `pageSegment`/`pathSegment` from a slugified version of the new title/name. For pages this is gated behind an `updateSlugs` flag the client currently never sets, but the capability exists as a foot-gun. For folders, the rewrite is unconditional — folder rename always rewrites `pathSegment` and cascades to all child page slugs. This can silently destroy URLs across an entire site, with severe consequences for SEO, ecommerce checkout flows, and any external links.

A third related problem exists in the create and duplicate flows: when a user creates a page named "Thank You" in a folder that already contains one, the plugin renames the new page to `"Thank You (copy)"` instead of letting the user keep their intended title. The disambiguation should happen at the URL segment level, not the display field.

A fourth related problem: there is currently no collision check on the Edit URL modal at all. A user can set two pages in the same folder to have identical `pageSegment` values without any error, producing duplicate slugs.

## Goals

- Display fields (`title`, `name`) and URL segments (`pageSegment`, `pathSegment`) are fully independent after a record is created. Editing one never writes to the other.
- Slug changes happen only via deliberate, opt-in operations: Create, Duplicate, Move (with explicit "Update URLs" choice), Edit URL modal, and the regenerate-slugs admin tool.
- Collisions on URL segments are resolved automatically and silently during Create and Duplicate, with the resolved URL surfaced in a success toast.
- Cascading slug changes for folders that contain pages require a type-to-confirm safety gate, both in the Edit URL modal and in the Move "Update URLs" path.
- The Edit URL modal performs live (debounced) availability checks as the user types, with a clear visual indicator and disabled save button on collision.

## Non-goals

- No schema changes. All existing fields stay as they are.
- No changes to the slug-derivation hook (`buildSlugFromFolder.ts`). Its current logic — preserve the slug unless `folder` or `pageSegment` actually changed, or `context.updateSlugs` is true — is already correct. Only the *callers* need to stop forcing segment writes during display-field edits.
- No data migration. Existing pages with `"(copy)"` titles or other artifacts of the old behavior are user data; we leave them alone and stop generating new ones.
- No changes to the Move endpoint's server-side behavior. The client gates the dangerous path (Move + Update URLs) before the request fires.
- No new test infrastructure as part of this work. The plugin currently has no tests; introducing one is a separate decision.

## Core invariants

These are the new contracts every endpoint and UI affordance must satisfy.

1. **Display fields are independent of segment fields after create.** No operation that changes only `title` or `name` is allowed to write to `pageSegment`, `pathSegment`, or `slug`.
2. **Segment fields are unique within their parent scope.** Two pages in the same folder cannot have the same `pageSegment`. Two folders with the same parent cannot have the same `pathSegment`.
3. **Segment changes have explicit user intent.** A `pageSegment`/`pathSegment` write only happens via Create, Duplicate, Move-with-Update-URLs, Edit URL modal, or `regenerate-slugs`.
4. **Cascading segment changes for folders with children require type-to-confirm.** Both the Edit URL modal and the Move "Update URLs" path enforce this gate before any write occurs.
5. **The hook layer is the enforcement point for slug derivation.** `buildSlugFromFolder.ts` already implements the right logic. It needs no behavioral change.

## Architecture

The work is divided across three layers:

- **New helper module** (`src/utils/segments.ts`) — pure-ish functions that own all segment availability and auto-increment logic. Single source of truth.
- **Endpoint changes** (`src/endpoints/treeOperations.ts`) — rename becomes a display-field-only write; create/duplicate/edit-url delegate collision logic to the helper module; two new lightweight read endpoints (`check-segment`, `folder-impact`) support the client-side UX.
- **UI changes** (`src/components/EditUrlModal.tsx`, `src/components/PageTreeClient.tsx`, `src/components/ConfirmationModal.tsx`) — live availability check, type-to-confirm gates, removal of the now-obsolete folder-rename confirmation modal.

### Data model

No schema changes. Existing fields:

- `pages.title` — display name, free text, no uniqueness constraint
- `pages.pageSegment` — URL segment, slugified, must be unique within `(folder, pageSegment)` scope
- `pages.slug` — derived: `folderPath + pageSegment`, read-only in admin, unique across the collection
- `folders.name` — display name, free text, no uniqueness constraint
- `folders.pathSegment` — URL segment, slugified, must be unique within `(parent folder, pathSegment)` scope

## New helper module: `src/utils/segments.ts`

Roughly 120 lines. All functions take dependencies as parameters — no module-level state, no class instance, no caching. Matches the functional style of the rest of the codebase (`buildSlugFromFolder.ts`, `cascadeSlugUpdates.ts`, `getFolderPath.ts`).

```ts
import type { Payload, CollectionSlug } from 'payload'
import { slugify } from './getFolderPath.js'

export const slugifyName = slugify

interface SegmentLookupOptions {
  payload: Payload
  parentId: string | number | null
  type: 'page' | 'folder'
  collection?: string         // required when type === 'page'
  collections: string[]
  folderSlug: string
  excludeId?: string | number // for rename/edit-url checks
}

/**
 * Returns all existing segments at the given parent level for the given type.
 * Single database query. Used by both findAvailableSegment and isSegmentAvailable.
 */
async function getExistingSegments(opts: SegmentLookupOptions): Promise<string[]>

/**
 * Checks whether a specific segment is available at the given parent level.
 * Used by the edit-url and check-segment endpoints.
 */
export async function isSegmentAvailable(
  opts: SegmentLookupOptions & { segment: string }
): Promise<boolean>

/**
 * Returns an available segment, auto-incrementing if needed.
 * 'thank-you' → 'thank-you' (if free)
 * 'thank-you' → 'thank-you-2' (if taken)
 * 'thank-you' → 'thank-you-3' (if both taken)
 * Skips '-1' suffix by convention (matches WordPress, Ghost).
 * Used by the create and duplicate endpoints.
 */
export async function findAvailableSegment(
  opts: SegmentLookupOptions & { baseSegment: string }
): Promise<string>

/**
 * Counts all pages whose slugs would be affected if this folder's pathSegment changed.
 * Includes pages in nested subfolders. Single recursive walk + one query per collection.
 * Used by the folder-impact endpoint and the EditUrlModal cascade gate.
 */
export async function countDescendantPages(opts: {
  payload: Payload
  folderId: string | number
  collections: string[]
  folderSlug: string
}): Promise<number>
```

**Auto-increment rule (`findAvailableSegment`):** WordPress-style. Try `base`, then `base-2`, `base-3`, ..., skipping `base-1`. The reason to skip `-1` is convention — `thank-you-1` looks like the first of a sequence; `thank-you` and `thank-you-2` reads as "the original and another one." Matches WordPress, Ghost, and Drupal.

**Query strategy:** `getExistingSegments` does a single `payload.find({ where: { folder: parentId } })` and pulls all segments into memory. The auto-increment loop works against the in-memory set. One database round-trip even when there are 50 collisions to resolve.

## Endpoint changes

### `POST /api/page-tree/rename` — drastically simplified

Becomes purely a display-field write. Drops the `updateSlugs` parameter from its request body.

```ts
// Page rename
await req.payload.update({
  collection,
  id,
  data: { title: name },
  req,
})

// Folder rename
await req.payload.update({
  collection: folderSlug,
  id,
  data: { name },
  req,
})
```

**Removed from this endpoint:**
- Title/name uniqueness checks (`treeOperations.ts:582-601` and `:627-647`)
- `pageSegment` overwrite (`treeOperations.ts:655`)
- `pathSegment` overwrite (`treeOperations.ts:608`)
- `updateSlugs` request parameter
- `slugChangeReason: 'rename'` context tag (no slug is changing)

Two pages and two folders can now share a display name freely.

### `POST /api/page-tree/create` — uses shared collision logic

```ts
// type === 'page'
const baseSegment = slugifyName(name)
const pageSegment = await findAvailableSegment({
  payload: req.payload,
  parentId,
  baseSegment,
  type: 'page',
  collection: collectionSlug,
  collections,
  folderSlug,
})

const result = await req.payload.create({
  collection: collectionSlug,
  draft: true,
  data: {
    title: name,                // unchanged
    pageSegment,                // possibly auto-incremented
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
```

Folder creation gets the analogous treatment with `pathSegment`. The client uses `collisionResolved` in the response to optionally show a "(URL set to /contact/thank-you-2 because /contact/thank-you already exists)" toast.

### `POST /api/page-tree/duplicate` — uses shared rule

The title gets a `(copy)` / `(copy N)` suffix using a small inline helper inside `createDuplicateHandler`. The convention:

- First duplicate of `"Thank You"` → `"Thank You (copy)"`
- Duplicating `"Thank You (copy)"` → `"Thank You (copy 2)"`
- Duplicating `"Thank You (copy 2)"` → `"Thank You (copy 3)"`

This is the same recursive convention used by the current `generateUniqueName`, applied to titles only. The helper takes a base title and a list of existing sibling titles in the target folder, finds the highest existing `(copy N)` suffix, and returns the next one. (The `(copy N)` collision check on titles exists purely so two duplicates of the same source don't end up with identical labels in the tree — it's a UX nicety, not a uniqueness constraint.)

pageSegment is computed independently via `findAvailableSegment` using `slugifyName(originalTitle)` as the base — so duplicating a page titled "Thank You" yields title `"Thank You (copy)"` and pageSegment `thank-you-2`, NOT pageSegment `thank-you-copy`. This unifies the segment collision rule with create.

### `POST /api/page-tree/edit-url` — adds collision check

Before calling `payload.update`, run `isSegmentAvailable` (excluding the current record's id). If unavailable, return HTTP 409 with a clear error message. If available, proceed with the existing update call (which still passes `updateSlugs: true` context, triggering the cascade for folders).

```ts
const slugifiedSegment = slugifyName(segment)
const available = await isSegmentAvailable({
  payload: req.payload,
  parentId,
  segment: slugifiedSegment,
  type,
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

// ... existing update call unchanged
```

This is the server-side guarantee. The client-side debounced check (below) is the primary UX defense — the user shouldn't normally be able to submit a colliding segment because the Save button is disabled. The server check is the final word.

### `GET /api/page-tree/check-segment` — NEW endpoint

Lightweight availability lookup for the EditUrlModal's debounced check. Read-only, no side effects.

```
GET /api/page-tree/check-segment?type=page&parentId=123&segment=thank-you&excludeId=456&collection=pages
→ { available: true | false }
```

Pure wrapper around `isSegmentAvailable`. Validates required query params, returns 400 on missing fields.

### `GET /api/page-tree/folder-impact` — NEW endpoint

Returns the count of pages whose slugs would be rewritten if the given folder's `pathSegment` changed. Used by the EditUrlModal cascade-impact warning and the Move-with-Update-URLs type-to-confirm step.

```
GET /api/page-tree/folder-impact?folderId=123
→ { childPageCount: 47 }
```

Pure wrapper around `countDescendantPages`. Read-only.

### `POST /api/page-tree/move` — no server-side changes

The existing `updateSlugs` parameter and cascade behavior stay exactly as they are. The type-to-confirm gate is implemented entirely on the client. By the time this endpoint is called, the user has already passed the gate.

## UI changes

### `EditUrlModal.tsx` — significant rework

Three new behaviors layered on top of the existing modal.

**(a) Live availability check (debounced)**

Add a `useEffect` that fires whenever `segment` changes, with a 300ms debounce. Calls `GET /api/page-tree/check-segment` with `excludeId={node.id}`. Tracks an `availability` state with four values:

- `idle` — no check has run yet (initial state, also when segment matches the original value)
- `checking` — request in flight
- `available` — last check returned available
- `taken` — last check returned not-available

Visual indicator below the input:
- `idle` → nothing shown
- `checking` → subtle spinner + "Checking..."
- `available` → green check + "Available"
- `taken` → red X + "URL is already in use"

Skip the check entirely when `slugifiedSegment === originalSegment` (the segment value the modal was loaded with) — set state directly to `idle`. This handles the case where a user opens the modal, types a different segment, then reverts to the original; we don't want to flag the page's own segment as "taken".

**(b) Cascade impact display (folders only)**

On modal open for folder nodes, fire `GET /api/page-tree/folder-impact?folderId={id}` once. Store the result in `childPageCount` state.

If `childPageCount > 0`, render a warning row in the modal:

> ⚠ This will update URLs for {N} child pages.

If `childPageCount === 0`, no warning row and no type-to-confirm gate.

**(c) Type-to-confirm gate (folders with children)**

When `node.type === 'folder' && childPageCount > 0`, render a second input field below the warning:

```
Type "spring-2024-v2" to confirm:
[______________]
```

The expected text is the slugified value of the segment input above. It updates live as the user types in the segment input — and when the segment input changes, the confirmation input is cleared (forces re-type, prevents the user from typing once and then editing the URL above).

Save button enablement state machine:

```ts
canSave = (
  slugifiedSegment.length > 0 &&
  availability === 'available' &&
  !saving &&
  (
    node.type === 'page' ||
    childPageCount === 0 ||
    confirmInput === slugifiedSegment
  )
)
```

### `PageTreeClient.tsx` — folder move "Update URLs" gets a type-to-confirm step

The current move confirmation modal shows two buttons (`Update URLs` / `Keep URLs`) for folder moves. New flow:

1. User drags folder → modal appears with both buttons.
2. Clicking **Keep URLs** behaves exactly as today — immediate move with `updateSlugs: false`. No further confirmation.
3. Clicking **Update URLs** transitions the modal into a second screen (or replaces its body):

   ```
   ⚠ This will update URLs for 47 child pages.
   The folder's URL segment will be: spring
   Type "spring" to confirm:
   [_____________]
   [Cancel]  [Confirm and Update URLs]
   ```

   - The "type to confirm" target is the moved folder's `pathSegment` (not the full path — the full path is too long and most of it isn't changing)
   - Confirm button disabled until input matches
4. Fetch the cascade count when the user clicks "Update URLs" via `GET /api/page-tree/folder-impact?folderId={folder.id}`. While waiting, show a loading state.
5. On confirm, fire the existing move API call with `updateSlugs: true`.

### `ConfirmationModal.tsx` — minor enhancement

Add an optional `typeToConfirm` prop to support the folder-move flow:

```ts
interface ConfirmationModalProps {
  // ... existing props
  typeToConfirm?: {
    expectedText: string
    placeholder?: string
    label: string  // e.g., 'Type "spring" to confirm:'
  }
}
```

When `typeToConfirm` is provided, the modal renders the input below the message and disables the primary action button until `userInput === typeToConfirm.expectedText`.

The EditUrlModal does NOT use this enhanced ConfirmationModal — it's already a form-shaped modal with its own state, so it implements its type-to-confirm gate inline. The enhanced ConfirmationModal is used only by the folder-move flow in `PageTreeClient.tsx`.

## Removals and cleanup

These deletions are enabled by the new design and directly serve the work — not unrelated cleanup.

1. **`generateUniqueName` function** (`treeOperations.ts:11-77`) — removed. Its segment-collision responsibility moves to `findAvailableSegment` in the new helper module. Its title-collision responsibility (the recursive `(copy N)` logic) moves into the duplicate endpoint as a small inline helper, applied to titles only.

2. **Title/name uniqueness checks in rename endpoint** — fully removed:
   - Folder branch: `treeOperations.ts:582-601`
   - Page branch: `treeOperations.ts:627-647`

3. **`pageSegment`/`pathSegment` overwrites in rename endpoint** — fully removed:
   - Folder pathSegment overwrite at `treeOperations.ts:608`
   - Page pageSegment overwrite at `treeOperations.ts:655`

4. **`updateSlugs` parameter from rename request body** (`treeOperations.ts:558, 565`) — removed. Rename never updates slugs. The `slugChangeReason: 'rename'` context tag at `:610` and `:657` is also removed.

5. **Rename confirmation modal in `PageTreeClient.tsx`** — removed entirely:
   - Modal markup at `:1072-1091`
   - Supporting state `pendingRename` at `:198`
   - `confirmRename` callback at `:511`
   - `cancelRename` callback at `:522`
   - The `updateSlugs` parameter on `executeRename` becomes the absence of that parameter — `executeRename` simplifies to `(node, newName) => Promise<void>`
   - The branching toast logic at `:466-474` collapses to a single `Renamed to "${newName}"` toast

   Folder rename now just renames the display field. No confirmation needed because no URLs are affected.

6. **`SlugChangeReason` enum** — add a new value `'edit-url'` for slugHistory entries created via the Edit URL modal. The existing `'rename'` value is preserved for backwards compatibility with historical data but is no longer written by any new operation.

## Error handling and edge cases

- **Concurrent modifications:** Two users editing the same folder's URL simultaneously could both pass the client-side availability check and have the second update fail at the server. The 409 from the server is the safety net; the modal surfaces the error message and the user can retry. Acceptable for a CMS admin tool.
- **User changes title to match another page in the same folder:** Allowed. No error. Both pages keep their distinct slugs.
- **User opens Edit URL modal, types a colliding segment, then reverts to the original:** State transitions to `idle`, save button enables (because the operation is a no-op).
- **Folder with zero children:** Edit URL modal shows no warning, no type-to-confirm gate. Save proceeds immediately on click. The folder's pathSegment changes; no cascade runs because there's nothing to cascade.
- **`findAvailableSegment` exhaustion:** Theoretical concern — if 10,000 pages all have segments matching `thank-you-N`, the loop could be slow. In practice this doesn't happen. We can add a sanity cap of `base-1000` and throw if exceeded.
- **Slugify produces empty string** (e.g., user types only emoji): `findAvailableSegment` falls back to a safe default like `untitled` and lets the same auto-increment rule disambiguate (`untitled`, `untitled-2`, ...). The Edit URL modal's existing empty-segment validation (`EditUrlModal.tsx:78-81`) blocks the case where the user explicitly tries to save an empty segment.

## Migration

None. Existing pages with `(copy)` titles or other artifacts of the old behavior are user data — we leave them alone and stop generating new ones. Existing slugHistory entries with `reason: 'rename'` remain valid. No database changes.

## Testing strategy

The plugin currently has no test infrastructure. This work does NOT introduce one — that's a separate decision. Manual verification will cover:

- **Title independence:** Create two pages titled "Thank You" in the same folder. Both succeed. Slugs are `contact/thank-you` and `contact/thank-you-2`.
- **Rename safety:** Edit a page's title via the Payload admin form. Verify the slug does not change. Edit a folder's name via the tree rename. Verify no child slugs change.
- **Edit URL collision (live check):** Open Edit URL on a page. Type a segment used by a sibling page. Verify red indicator appears within ~300ms and Save is disabled.
- **Edit URL cascade safety:** Open Edit URL on a folder containing pages. Verify the warning shows the correct count. Verify the type-to-confirm input appears. Verify Save is disabled until the user types the exact new segment.
- **Move with Update URLs:** Drag a folder containing pages to a new parent. Click "Update URLs". Verify the type-to-confirm step appears with the correct count and segment. Verify the move proceeds only after correct confirmation.
- **Move without Update URLs:** Same as above, but click "Keep URLs". Verify the move happens immediately with no extra confirmation, and child slugs are preserved.
- **Duplicate:** Duplicate a page titled "Thank You". Verify the duplicate has title `"Thank You (copy)"` and pageSegment `thank-you-2`. Duplicate the duplicate. Verify the new one has title `"Thank You (copy 2)"` and pageSegment `thank-you-3`.

## Build sequence

The implementation plan (next phase, via the writing-plans skill) will sequence the work. A reasonable order:

1. New `src/utils/segments.ts` helper module
2. New `check-segment` and `folder-impact` endpoints
3. Refactor `create`, `duplicate`, `edit-url` endpoints to use the helpers
4. Strip rename endpoint down to display-field-only writes
5. Update `EditUrlModal.tsx` with live availability check and cascade gate
6. Add `typeToConfirm` to `ConfirmationModal.tsx`
7. Update `PageTreeClient.tsx`: remove rename confirmation, add move type-to-confirm
8. Manual verification pass against the testing strategy above
9. Version bump and changelog entry
