# Changelog

All notable changes to this project will be documented in this file.

## [0.3.13] - 2026-04-08

### Changed

- **Title and URL are now independent**: Renaming a page or folder display name no longer touches the URL segment. Previously, folder rename via the tree could cascade slug updates to all nested pages, and duplicate page/folder titles in the same parent were blocked. The new rule: display fields (`title`, `name`) and URL segments (`pageSegment`, `pathSegment`) are fully independent after create. To change a URL segment, use the **Edit URL** action explicitly.
- **Folder rename no longer prompts**: The "Keep URLs / Update URLs" confirmation that appeared when renaming a folder with children has been removed. Folder rename now just renames — it never touches child page slugs. If you want to change a folder's URL segment and cascade to children, use **Edit URL** on the folder instead (which has its own explicit confirmation with type-to-confirm safety gate).
- **Duplicate page behavior**: Duplicating a page still appends "(copy)" / "(copy 2)" to the title, but the new page's URL segment now auto-increments independently (`thank-you`, `thank-you-2`, `thank-you-3`) instead of being derived from the mangled title (`thank-you-copy`).
- **Create allows duplicate titles**: Creating a new page or folder with a title that already exists in the same parent is now allowed. The display name is kept as-is; only the URL segment is auto-disambiguated. The success toast surfaces the resolved URL when a collision is resolved.

### Added

- **Live URL availability check in Edit URL modal**: As you type a new URL segment, the modal performs a debounced server-side check (300ms) and shows a green "Available" or red "URL is already in use" indicator. The Save button is disabled until a valid, available segment is entered. Closes a data-integrity hole where duplicate segments could previously be saved silently.
- **Folder cascade safety gate**: Editing a folder's URL segment (via Edit URL) or moving a folder with children while choosing "Update URLs" now requires a type-to-confirm step. The modal shows the exact number of child pages affected and requires the user to type the new pathSegment to proceed. Applies to both single and bulk folder moves. Prevents accidental cascading URL rewrites.
- **Two new API endpoints**:
  - `GET /api/page-tree/check-segment` — lightweight availability lookup backing the live check in the Edit URL modal.
  - `GET /api/page-tree/folder-impact?folderId=X` — returns the count of pages whose slugs would be rewritten if the folder's URL segment changed.
- **New `'edit-url'` value in `SlugChangeReason`**: Slug history entries created via the Edit URL modal now use this reason instead of `'rename'`. Existing history entries are unchanged.

### Fixed

- **Renaming a page no longer changes its URL**: The rename endpoint previously had a code path that could rewrite `pageSegment` as a side effect of renaming. This was gated behind a flag the client never set, but the capability existed as a foot-gun. It has been removed entirely. Rename is now strictly a display-field-only write.
- **`countDescendantPages` no longer swallows errors**: If a per-collection query fails, the error now propagates to the endpoint (which returns 500) and the modal refuses to proceed, rather than silently undercounting and misleading the user about cascade impact.

### Removed

- **`generateUniqueName` internal helper**: Replaced by the new `src/utils/segments.ts` module which owns all segment availability and auto-increment logic (`findAvailableSegment`, `isSegmentAvailable`, `countDescendantPages`). This is an internal refactor and does not affect the plugin's public API.
- **`updateSlugs` parameter from rename request body**: Previously optional and unused by the tree UI. External callers (if any) that were passing this field will have it silently ignored.

**Migration:** None. No schema changes, no database migrations, no config changes. Existing pages with `"(copy)"` titles and existing slug history entries with `reason: 'rename'` remain valid. The behavior changes are all in how the tree UI and its endpoints respond to user actions — existing data is untouched.

---

## [0.3.12] - 2026-03-20

### Fixed

- **"Keep existing URL" ignored on move**: Choosing "Keep existing URL" when moving a page or folder still regenerated the slug. The hook now uses strict equality (`=== false`) to distinguish an explicit "don't update" from the default unset state.
- **Slug loses folder path when editing pageSegment in admin UI**: Editing the `pageSegment` field through Payload's admin panel produced a slug with no folder prefix (e.g. `complete` instead of `registration/complete`). The hook now treats `data.folder=null` from admin form serialization as unchanged, only accepting null as an intentional "move to root" during tree operations.
- **pageSegment overwritten with slugified title during moves**: Moving a page could replace its `pageSegment` with `slugify(title)` if the segment field was empty-string or null (rather than undefined). The fallback now uses a loose check and restricts auto-generation from title to `create` operations only.

---

## [0.4.1] - 2026-03-18

### Fixed

- **Folder rename now updates pathSegment**: Renaming a folder correctly updates its URL segment to match the new name. Previously, the folder's `pathSegment` was only updated when "Update URLs" was explicitly chosen, leaving the slug out of sync with the folder name.
- **Context menu viewport overflow**: Right-click context menu now repositions to stay within the viewport when opened near the bottom or right edge of the screen.

### Added

- **Rename confirmation for folders with children**: Renaming a folder that contains pages now prompts whether to update child page URLs or keep them unchanged, preventing accidental URL changes.

---

## [0.4.0] - 2026-03-03

### Added

- **`buildSlug` callback**: Optional custom slug builder function that replaces the default `folderPath/pageSegment` concatenation. Use this when you want flat slugs (tree is organizational only), random IDs, or any custom slug pattern. ([#1](https://github.com/delmaredigital/payload-page-tree/issues/1))

```ts
pageTreePlugin({
  // Flat slugs — ignore folder hierarchy
  buildSlug: ({ pageSegment }) => pageSegment,

  // Random IDs
  buildSlug: ({ doc }) => doc.customId as string || nanoid(),
})
```

This is a fully additive, non-breaking change. Existing configurations work identically without any modifications.

---

## [0.3.8] - 2026-01-28

### Fixed

#### Reduced Published Package Size

Disabled source maps (`.js.map`) and declaration maps (`.d.ts.map`) from the published package. These files doubled the unpacked size and served no purpose since source files are no longer included in the package.

#### Package Exports Pointing to Source Files

Fixed issue where the published package's `exports` field pointed to TypeScript source files (`src/`) instead of compiled JavaScript (`dist/`). This caused "Unknown module type" errors with Turbopack. Changed to point `exports` directly to `dist/`.

---

## [0.3.7] - 2026-01-28

### Changed

#### Build System Migration to SWC

Migrated from pure TypeScript compilation to SWC for faster builds:

- **Build time**: Significantly faster compilation (~85ms vs several seconds with tsc)
- **TypeScript**: Now only emits declaration files (`.d.ts`)

Build commands remain the same:
```bash
pnpm build      # Full build (SWC + types)
pnpm dev        # Watch mode with SWC
```

---

## [0.3.6] - 2026-01-24

### Added

- **`customizeFolderCollection` option**: Callback to customize the folders collection with custom fields, access control, or hooks. Enables organization scoping for multi-tenant apps without coupling the plugin to any specific auth system.

### Fixed

- **Multi-tenant access control**: Tree view now correctly applies access control - passes `req` to all Local API calls and sets `overrideAccess: false` on queries. Previously, users could see pages from all organizations.
- **API endpoint access control**: All tree operation endpoints (move, reorder, create, delete, duplicate, etc.) now pass `req` to respect collection access rules.

---

## [0.3.0] - 2026-01-14

### Added

- **Multi-select drag-and-drop**: Select multiple items with Cmd/Ctrl+click, then drag to move all at once
- **Bulk URL confirmation**: When moving multiple items that need URL updates, "Update All URLs" / "Keep All URLs" buttons for batch confirmation
- **"Move to..." action**: Right-click context menu option to select destination folder without dragging - useful for large trees
- **Sorting options**: Sort tree by name (A-Z, Z-A), slug, or status (published first). Drag-drop is disabled while sorting is active
- **Folder select modal**: New modal component (`FolderSelectModal`) for selecting destination folders with expandable tree view

### Changed

- **Tree node layout**: Restructured with fixed-width columns for consistent alignment (slug: 180px, status: 70px, actions: 88px)
- **Always-visible actions**: Action buttons (edit, copy, view, delete) now always visible at reduced opacity instead of appearing on hover
- **Nav link grouping**: Page Tree nav link now uses `NavGroup` wrapper with "Manage Pages" label

### Fixed

- **Folder deletion**: Fixed bug where deleting folders returned success but didn't actually delete
- **Delete performance**: Optimized recursive delete with parallel batch operations to avoid database transaction timeouts
- **Page not found handling**: Delete endpoint now returns proper 404 when page isn't found in any collection

---

## [0.2.0] - 2026-01-13

### Added

- **URL history tracking**: Automatic audit trail of previous URLs stored in `slugHistory` field (max 20 entries)
- **Redirects endpoint**: `GET /api/page-tree/redirects?collection=pages` returns old→new URL mappings for redirect setup
- **Restore previous URL**: "URL History" context menu action shows previous URLs with ability to restore any of them
- **Collection-aware tree view**: Dropdown selector to switch between configured collections (Pages, Posts, etc.)
- **URL preservation on move**: When moving folders, users can choose to keep existing URLs or update them
- **Regenerate URLs action**: Right-click a folder to regenerate slugs for all nested pages
- **Migration endpoint**: `/api/page-tree/migrate` to batch-update slugs for existing content
- **Admin view configuration**: Options to enable/disable tree view and customize its path
- **Custom edit URLs**: `getEditUrl` prop on `PageTreeClient` for integrating with visual editors
- **Exported utilities**: `buildTreeStructure` function for building tree data in custom components
- **Default theme CSS**: Import `@delmaredigital/payload-page-tree/theme.css` when using outside Payload admin
- **Auto-detect collections**: Plugin now automatically filters to only collections that exist in your config
- **Folder visual distinction**: Folders now have subtle background and left border to differentiate from pages

### Changed

- **Default collections**: Changed from `['pages']` to `['pages', 'posts']` to match common Payload setups
- **Slug preservation**: Existing pages keep their slugs on update unless explicitly regenerated
- **pathSegment field**: Now optional (was incorrectly marked as required), preventing schema conflicts on existing projects

### Fixed

- Schema push errors when adding plugin to existing projects with folder data
- Slug regeneration no longer triggers unexpectedly on page updates
