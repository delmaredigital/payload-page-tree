import type { TreeNode, FolderDocument, PageDocument } from '../types.js'

export interface BuildTreeOptions {
  collections: string[]
}

/**
 * Build tree structure from folders and pages
 * Note: IDs are prefixed with 'folder-' or 'page-' to ensure uniqueness
 * since folders and pages come from different collections and may have the same numeric ID
 */
export function buildTreeStructure(
  folders: FolderDocument[],
  pages: Array<PageDocument & { _collection?: string }>,
  options: BuildTreeOptions,
): TreeNode[] {
  // Create a map of folder IDs to their tree nodes
  // Key is the raw folder ID (without prefix) for easy lookup
  const folderMap = new Map<string, TreeNode>()

  // First pass: create folder nodes
  for (const folder of folders) {
    const rawId = String(folder.id)
    const treeId = `folder-${rawId}` // Prefix for unique tree keys
    const parentRawId = getFolderIdAsString(folder.folder)
    folderMap.set(rawId, {
      id: treeId,
      type: 'folder',
      name: folder.name,
      pathSegment: folder.pathSegment,
      children: [],
      pageCount: 0,
      folderId: parentRawId ? `folder-${parentRawId}` : null,
      sortOrder: folder.sortOrder ?? 0,
      // Store raw ID for API calls
      rawId: rawId,
    })
  }

  // Second pass: build folder hierarchy and count pages
  const rootFolders: TreeNode[] = []

  for (const folder of folders) {
    const rawId = String(folder.id)
    const node = folderMap.get(rawId)!
    const parentRawId = getFolderIdAsString(folder.folder)

    if (parentRawId && folderMap.has(parentRawId)) {
      const parent = folderMap.get(parentRawId)!
      parent.children.push(node)
    } else {
      rootFolders.push(node)
    }
  }

  // Create page nodes and add to folders or root
  const rootPages: TreeNode[] = []

  for (const page of pages) {
    const rawId = String(page.id)
    const treeId = `page-${rawId}` // Prefix for unique tree keys
    const folderRawId = getFolderIdAsString(page.folder)
    const pageNode: TreeNode = {
      id: treeId,
      type: 'page',
      name: page.title || `Page ${page.id}`,
      slug: page.slug,
      status: page._status,
      children: [],
      pageCount: 0,
      folderId: folderRawId ? `folder-${folderRawId}` : null,
      sortOrder: page.sortOrder ?? 0,
      collection: page._collection || options.collections[0],
      // Store raw ID for API calls
      rawId: rawId,
      // Slug history for audit trail
      slugHistory: page.slugHistory,
    }

    if (folderRawId && folderMap.has(folderRawId)) {
      const folder = folderMap.get(folderRawId)!
      folder.children.push(pageNode)
      // Update page counts up the tree
      updatePageCounts(folder, folderMap)
    } else {
      rootPages.push(pageNode)
    }
  }

  // Sort folders and pages within each level by sortOrder, then name
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      // First by sortOrder
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder
      }
      // Then folders first, then pages
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1
      }
      // Then alphabetically by name
      return a.name.localeCompare(b.name)
    })
    // Recursively sort children
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortNodes(node.children)
      }
    }
  }

  const tree = [...rootFolders, ...rootPages]
  sortNodes(tree)

  return tree
}

/**
 * Update page counts for a folder and all its ancestors
 */
function updatePageCounts(
  node: TreeNode,
  folderMap: Map<string, TreeNode>,
) {
  node.pageCount += 1

  if (node.folderId && folderMap.has(node.folderId)) {
    updatePageCounts(folderMap.get(node.folderId)!, folderMap)
  }
}

/**
 * Extract folder ID from potentially populated field as string
 */
function getFolderIdAsString(
  folder: number | string | FolderDocument | null | undefined,
): string | null {
  if (!folder) return null
  if (typeof folder === 'object') return String(folder.id)
  return String(folder)
}

export default buildTreeStructure
