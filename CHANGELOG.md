# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
