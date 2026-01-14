export interface PageTreePluginConfig {
  /**
   * Collections to add folder-based slugs to
   * @default ['pages', 'posts']
   * @example ['pages', 'posts', 'articles']
   */
  collections?: string[]

  /**
   * Custom slug for the folders collection
   * @default 'payload-folders'
   */
  folderSlug?: string

  /**
   * Field name for the URL path segment on folders
   * @default 'pathSegment'
   */
  segmentFieldName?: string

  /**
   * Field name for the page's own URL segment
   * @default 'pageSegment'
   */
  pageSegmentFieldName?: string

  /**
   * Disable the plugin while preserving schema for migrations
   * @default false
   */
  disabled?: boolean

  /**
   * Admin view configuration
   */
  adminView?: {
    /**
     * Enable the Page Tree admin view
     * @default true
     */
    enabled?: boolean
    /**
     * Navigation label for the Page Tree link
     * @default 'Page Tree'
     */
    navLabel?: string
    /**
     * Path for the Page Tree view
     * @default '/page-tree'
     */
    path?: string
  }
}

/**
 * Tree node for displaying folders and pages (react-arborist compatible)
 */
export interface TreeNode {
  /** Unique ID for react-arborist (prefixed: 'folder-1' or 'page-1') */
  id: string
  /** Raw database ID without prefix (for API calls) */
  rawId?: string
  type: 'folder' | 'page'
  name: string
  slug?: string
  pathSegment?: string
  status?: 'draft' | 'published'
  children: TreeNode[]
  pageCount: number
  folderId?: string | null
  sortOrder: number
  collection?: string
  /** Audit trail of previous slugs (pages only) */
  slugHistory?: SlugHistoryEntry[]
}

/**
 * Slug change reason for audit trail
 */
export type SlugChangeReason = 'move' | 'rename' | 'regenerate' | 'restore' | 'manual'

/**
 * Entry in the slug history audit trail
 */
export interface SlugHistoryEntry {
  /** The previous slug value */
  slug: string
  /** When this slug was replaced */
  changedAt: Date | string
  /** Why the slug was changed */
  reason?: SlugChangeReason
}

/**
 * Page document with minimal fields for tree view
 */
export interface PageDocument {
  id: number | string
  title?: string
  slug?: string
  folder?: number | string | FolderDocument | null
  _status?: 'draft' | 'published'
  sortOrder?: number
  /** Audit trail of previous slugs (max 20 entries) */
  slugHistory?: SlugHistoryEntry[]
}

export interface FolderDocument {
  id: number | string
  name: string
  pathSegment?: string
  folder?: number | string | FolderDocument | null
  sortOrder?: number
  /**
   * Restrict which collection types can be added to this folder.
   * If null/undefined/empty, all collections are allowed.
   */
  folderType?: string[] | null
}

/**
 * Move operation payload
 */
export interface MovePayload {
  type: 'page' | 'folder'
  id: string
  newParentId: string | null
  newIndex: number
}

/**
 * Reorder operation payload
 */
export interface ReorderPayload {
  type: 'page' | 'folder'
  items: Array<{ id: string; sortOrder: number }>
}

/**
 * Create operation payload
 */
export interface CreatePayload {
  type: 'page' | 'folder'
  parentId: string | null
  name: string
  collection?: string
}

/**
 * Context menu action types
 */
export type ContextMenuAction =
  | 'edit'
  | 'editInNewTab'
  | 'editInPayload'
  | 'rename'
  | 'duplicate'
  | 'delete'
  | 'newPage'
  | 'newFolder'
  | 'viewOnSite'
  | 'copySlug'
  | 'publish'
  | 'unpublish'
  | 'expandAll'
  | 'collapseAll'
  | 'regenerateSlugs'
  | 'urlHistory'
  | 'moveTo'
