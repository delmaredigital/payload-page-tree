# Changelog

All notable changes to this project will be documented in this file.

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
