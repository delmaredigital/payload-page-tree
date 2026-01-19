'use client'

import { useState, useCallback, useRef, useMemo } from 'react'
import { Tree, type TreeApi } from 'react-arborist'
import { Toaster, toast } from 'sonner'
import type { TreeNode as TreeNodeType, ContextMenuAction } from '../types.js'
import { TreeNode } from './TreeNode.js'
import { ContextMenuProvider } from './ContextMenu.js'
import { ConfirmationModal } from './ConfirmationModal.js'
import { SlugHistoryModal } from './SlugHistoryModal.js'
import { FolderSelectModal } from './FolderSelectModal.js'
import { EditUrlModal } from './EditUrlModal.js'

/**
 * Function to generate custom edit URLs for pages
 * @param collection - The collection slug (e.g., 'pages')
 * @param id - The raw document ID
 * @param adminRoute - The admin route prefix (e.g., '/admin')
 * @returns The full URL path to edit the document
 */
export type GetEditUrlFn = (collection: string, id: string, adminRoute: string) => string

interface PageTreeClientProps {
  treeData: TreeNodeType[]
  collections: string[]
  selectedCollection: string
  adminRoute: string
  puckEnabled?: boolean
  /**
   * Custom function to generate edit URLs for pages.
   * Useful for integrating with visual editors like Puck.
   * If not provided, uses default Payload collection URLs.
   */
  getEditUrl?: GetEditUrlFn
}

// Helper to format collection slug as display name
function formatCollectionName(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

interface PendingMove {
  dragIds: string[]
  parentId: string | null
  index: number
  node: TreeNodeType
  affectedCount: number
}

interface BulkMoveItem {
  dragId: string
  node: TreeNodeType
  parentId: string | null
  index: number
  requiresConfirmation: boolean
  affectedCount: number
}

interface PendingBulkMove {
  items: BulkMoveItem[]
  currentIndex: number
  parentId: string | null
  baseIndex: number
}

interface MoveToState {
  nodes: TreeNodeType[]
  excludeIds: string[]
}

type SortOption = 'default' | 'name-asc' | 'name-desc' | 'slug-asc' | 'slug-desc' | 'status'

interface PendingDelete {
  node: TreeNodeType
  pageCount: number
  folderCount: number
}

interface UrlHistoryState {
  node: TreeNodeType
}

interface EditUrlState {
  node: TreeNodeType
  folderPath: string
}

// Helper to extract raw database ID from prefixed tree ID
function getRawId(node: TreeNodeType): string {
  // If rawId is available, use it; otherwise strip the prefix from id
  if (node.rawId) return node.rawId
  // Remove 'folder-' or 'page-' prefix
  return node.id.replace(/^(folder|page)-/, '')
}

// Helper to extract raw ID from a tree ID string (for parent IDs)
function stripIdPrefix(treeId: string | null): string | null {
  if (!treeId) return null
  return treeId.replace(/^(folder|page)-/, '')
}

// Helper to count nested pages and folders
function countNestedItems(node: TreeNodeType): { pages: number; folders: number } {
  let pages = 0
  let folders = 0

  for (const child of node.children) {
    if (child.type === 'page') {
      pages++
    } else {
      folders++
      const nested = countNestedItems(child)
      pages += nested.pages
      folders += nested.folders
    }
  }

  return { pages, folders }
}

// Helper to get all child folder IDs (prevents moving folder into its own children)
function getAllChildFolderIds(node: TreeNodeType): string[] {
  const ids: string[] = []
  for (const child of node.children) {
    if (child.type === 'folder') {
      ids.push(child.id)
      ids.push(...getAllChildFolderIds(child))
    }
  }
  return ids
}

// Default edit URL generator - uses Puck if enabled, otherwise Payload collection URL
const defaultGetEditUrl = (collection: string, id: string, adminRoute: string, puckEnabled: boolean): string => {
  if (puckEnabled) {
    return `${adminRoute}/puck-editor/${collection}/${id}`
  }
  return `${adminRoute}/collections/${collection}/${id}`
}

// Sort tree data recursively
function sortTreeData(nodes: TreeNodeType[], sortOption: SortOption): TreeNodeType[] {
  if (sortOption === 'default') return nodes

  const compare = (a: TreeNodeType, b: TreeNodeType): number => {
    // Folders always come first
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1
    }

    switch (sortOption) {
      case 'name-asc':
        return a.name.localeCompare(b.name)
      case 'name-desc':
        return b.name.localeCompare(a.name)
      case 'slug-asc':
        return (a.slug || '').localeCompare(b.slug || '')
      case 'slug-desc':
        return (b.slug || '').localeCompare(a.slug || '')
      case 'status':
        // Published first, then draft
        const statusA = a.status === 'published' ? 0 : 1
        const statusB = b.status === 'published' ? 0 : 1
        return statusA - statusB || a.name.localeCompare(b.name)
      default:
        return 0
    }
  }

  return nodes
    .map(node => ({
      ...node,
      children: sortTreeData(node.children, sortOption),
    }))
    .sort(compare)
}

export function PageTreeClient({ treeData, collections, selectedCollection, adminRoute, puckEnabled = false, getEditUrl }: PageTreeClientProps) {
  const [data, setData] = useState(treeData)
  const [search, setSearch] = useState('')
  const [sortOption, setSortOption] = useState<SortOption>('default')
  const treeRef = useRef<TreeApi<TreeNodeType>>(null)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const [pendingBulkMove, setPendingBulkMove] = useState<PendingBulkMove | null>(null)
  const [moveToModal, setMoveToModal] = useState<MoveToState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [urlHistory, setUrlHistory] = useState<UrlHistoryState | null>(null)
  const [editUrlState, setEditUrlState] = useState<EditUrlState | null>(null)

  // Compute sorted data
  const sortedData = useMemo(() => sortTreeData(data, sortOption), [data, sortOption])

  // API call helper with error handling
  const apiCall = useCallback(async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(`/api${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    const result = await response.json()

    if (!response.ok || result.error) {
      throw new Error(result.error || 'Operation failed')
    }

    return result
  }, [])

  // Execute the actual move operation
  const executeMove = useCallback(
    async (
      dragIds: string[],
      parentId: string | null,
      index: number,
      node: TreeNodeType,
      updateSlugs: boolean = false,
    ) => {
      // Optimistic update with recalculated page counts
      // Use functional update to ensure each move builds on the previous state
      setData((currentData) => {
        const movedData = moveNodeInTree(currentData, dragIds[0], parentId, index)
        return recalculatePageCounts(movedData)
      })

      // API call - use raw IDs without prefixes
      try {
        await apiCall('/page-tree/move', {
          method: 'POST',
          body: JSON.stringify({
            type: node.type,
            id: getRawId(node),
            newParentId: stripIdPrefix(parentId),
            newIndex: index,
            updateSlugs,
          }),
        })
        if (updateSlugs) {
          if (node.type === 'folder') {
            toast.success('URLs updated to match new folder location')
          } else {
            toast.success('URL updated to match new location')
          }
        }
      } catch (error) {
        console.error('Move failed:', error)
        toast.error('Move failed')
        // Revert on error
        setData(treeData)
      }
    },
    [treeData, apiCall],
  )

  // Handle drag-and-drop move (supports multi-select)
  const handleMove = useCallback(
    ({
      dragIds,
      parentId,
      index,
    }: {
      dragIds: string[]
      parentId: string | null
      index: number
    }) => {
      // Single item move - use original flow for backward compatibility
      if (dragIds.length === 1) {
        const id = dragIds[0]
        const node = findNode(data, id)
        if (!node) return

        // If moving a folder, show confirmation with affected page count
        if (node.type === 'folder') {
          const { pages } = countNestedItems(node)
          if (pages > 0) {
            setPendingMove({ dragIds, parentId, index, node, affectedCount: pages })
            return
          }
        }

        // If moving a page to a different folder, show confirmation for slug update
        if (node.type === 'page') {
          const currentFolderId = node.folderId
          const newFolderId = parentId

          // Check if the folder is actually changing
          if (currentFolderId !== newFolderId) {
            setPendingMove({ dragIds, parentId, index, node, affectedCount: 1 })
            return
          }
        }

        // For reordering within the same location, execute immediately
        executeMove(dragIds, parentId, index, node)
        return
      }

      // Multi-select move - process all items
      const itemsToMove: BulkMoveItem[] = []

      for (let i = 0; i < dragIds.length; i++) {
        const node = findNode(data, dragIds[i])
        if (!node) continue

        const currentFolderId = node.folderId
        const folderChanging = currentFolderId !== parentId

        let requiresConfirmation = false
        let affectedCount = 0

        if (node.type === 'folder') {
          const { pages } = countNestedItems(node)
          requiresConfirmation = pages > 0 && folderChanging
          affectedCount = pages
        } else if (node.type === 'page') {
          requiresConfirmation = folderChanging
          affectedCount = 1
        }

        itemsToMove.push({
          dragId: dragIds[i],
          node,
          parentId,
          index: index + i,
          requiresConfirmation,
          affectedCount,
        })
      }

      if (itemsToMove.length === 0) return

      // Check if any items need confirmation
      const needsConfirmation = itemsToMove.some(item => item.requiresConfirmation)

      if (!needsConfirmation) {
        // Execute all moves immediately
        for (const item of itemsToMove) {
          executeMove([item.dragId], item.parentId, item.index, item.node, false)
        }
        toast.success(`Moved ${itemsToMove.length} item${itemsToMove.length > 1 ? 's' : ''}`)
        return
      }

      // Start bulk move confirmation flow - find first item needing confirmation
      const firstConfirmIndex = itemsToMove.findIndex(item => item.requiresConfirmation)

      // Execute items before the first confirmation
      for (let i = 0; i < firstConfirmIndex; i++) {
        executeMove([itemsToMove[i].dragId], itemsToMove[i].parentId, itemsToMove[i].index, itemsToMove[i].node, false)
      }

      setPendingBulkMove({
        items: itemsToMove,
        currentIndex: firstConfirmIndex,
        parentId,
        baseIndex: index,
      })
    },
    [data, executeMove],
  )

  // Confirm move operation
  const confirmMove = useCallback(
    (updateSlugs: boolean) => {
      if (pendingMove) {
        executeMove(
          pendingMove.dragIds,
          pendingMove.parentId,
          pendingMove.index,
          pendingMove.node,
          updateSlugs,
        )
        setPendingMove(null)
      }
    },
    [pendingMove, executeMove],
  )

  // Cancel move operation
  const cancelMove = useCallback(() => {
    setPendingMove(null)
  }, [])

  // Confirm single item in bulk move
  const confirmBulkMoveItem = useCallback(
    (updateSlugs: boolean) => {
      if (!pendingBulkMove) return

      const currentItem = pendingBulkMove.items[pendingBulkMove.currentIndex]
      executeMove([currentItem.dragId], currentItem.parentId, currentItem.index, currentItem.node, updateSlugs)

      // Find next item that needs confirmation
      let nextIndex = pendingBulkMove.currentIndex + 1
      while (nextIndex < pendingBulkMove.items.length) {
        const item = pendingBulkMove.items[nextIndex]
        if (item.requiresConfirmation) {
          setPendingBulkMove({ ...pendingBulkMove, currentIndex: nextIndex })
          return
        }
        // Execute non-confirmation items automatically
        executeMove([item.dragId], item.parentId, item.index, item.node, false)
        nextIndex++
      }

      // All done
      setPendingBulkMove(null)
    },
    [pendingBulkMove, executeMove],
  )

  // Confirm all remaining items in bulk move
  const confirmBulkMoveAll = useCallback(
    (updateSlugs: boolean) => {
      if (!pendingBulkMove) return

      const remainingCount = pendingBulkMove.items.length - pendingBulkMove.currentIndex

      // Process all remaining items from current index
      for (let i = pendingBulkMove.currentIndex; i < pendingBulkMove.items.length; i++) {
        const item = pendingBulkMove.items[i]
        // Apply updateSlugs to items that need confirmation, false to others
        const shouldUpdateSlugs = item.requiresConfirmation ? updateSlugs : false
        executeMove([item.dragId], item.parentId, item.index, item.node, shouldUpdateSlugs)
      }

      setPendingBulkMove(null)
      toast.success(`Moved ${remainingCount} item${remainingCount > 1 ? 's' : ''}`)
    },
    [pendingBulkMove, executeMove],
  )

  // Cancel bulk move operation
  const cancelBulkMove = useCallback(() => {
    setPendingBulkMove(null)
  }, [])

  // Handle rename
  const handleRename = useCallback(
    async ({ id, name }: { id: string; name: string }) => {
      const node = findNode(data, id)
      if (!node) return

      const originalName = node.name

      // Optimistic update
      const newData = updateNodeInTree(data, id, { name })
      setData(newData)

      // API call - use raw ID without prefix
      try {
        await apiCall('/page-tree/rename', {
          method: 'POST',
          body: JSON.stringify({
            type: node.type,
            id: getRawId(node),
            name,
            collection: node.collection,
          }),
        })
        toast.success(`Renamed to "${name}"`)
      } catch (error) {
        console.error('Rename failed:', error)
        setData(treeData)
        // Show user-friendly error message
        const message = error instanceof Error ? error.message : 'Rename failed'
        if (message.includes('unique') || message.includes('duplicate') || message.includes('already exists')) {
          toast.error(`A ${node.type} named "${name}" already exists in this location`)
        } else {
          toast.error(message)
        }
      }
    },
    [data, treeData, apiCall],
  )

  // Handle context menu actions
  const handleContextAction = useCallback(
    async (node: TreeNodeType, action: ContextMenuAction) => {
      const rawId = getRawId(node)

      switch (action) {
        case 'edit':
          if (node.collection) {
            const editUrl = getEditUrl
              ? getEditUrl(node.collection, rawId, adminRoute)
              : defaultGetEditUrl(node.collection, rawId, adminRoute, puckEnabled)
            window.location.href = editUrl
          }
          break

        case 'editInNewTab':
          if (node.collection) {
            const editUrl = getEditUrl
              ? getEditUrl(node.collection, rawId, adminRoute)
              : defaultGetEditUrl(node.collection, rawId, adminRoute, puckEnabled)
            window.open(editUrl, '_blank')
          }
          break

        case 'editInPayload':
          // Always open in Payload collection editor (for field-level editing)
          // Hardcoded to /admin since this specifically targets Payload's native admin
          if (node.collection) {
            window.location.href = `/admin/collections/${node.collection}/${rawId}`
          }
          break

        case 'viewOnSite':
          if (node.slug) {
            window.open(`/${node.slug}`, '_blank')
          }
          break

        case 'copySlug':
          if (node.slug) {
            navigator.clipboard.writeText(`/${node.slug}`)
          }
          break

        case 'rename':
          treeRef.current?.edit(node.id)
          break

        case 'delete':
          // Show styled confirmation modal
          if (node.type === 'folder') {
            const { pages, folders } = countNestedItems(node)
            setPendingDelete({ node, pageCount: pages, folderCount: folders })
          } else {
            setPendingDelete({ node, pageCount: 0, folderCount: 0 })
          }
          break

        case 'duplicate':
          if (node.type === 'page' && node.collection) {
            try {
              const result = await apiCall(
                `/page-tree/duplicate?id=${rawId}&collection=${node.collection}`,
                { method: 'POST' },
              )
              if (result.success) {
                toast.success('Page duplicated')
                window.location.reload()
              }
            } catch (error) {
              console.error('Duplicate failed:', error)
              const message = error instanceof Error ? error.message : 'Duplicate failed'
              toast.error(message)
            }
          }
          break

        case 'newPage':
          try {
            // Handle 'root' as null (create at root level)
            const pageParentId = node.id === 'root'
              ? null
              : node.type === 'folder' ? rawId : stripIdPrefix(node.folderId ?? null)
            const result = await apiCall('/page-tree/create', {
              method: 'POST',
              body: JSON.stringify({
                type: 'page',
                name: 'New Page',
                parentId: pageParentId,
                collection: selectedCollection,
              }),
            })
            if (result.success) {
              toast.success('Page created')
              window.location.reload()
            }
          } catch (error) {
            console.error('Create page failed:', error)
            const message = error instanceof Error ? error.message : 'Create failed'
            toast.error(message)
          }
          break

        case 'newFolder':
          try {
            // Handle 'root' as null (create at root level)
            const folderParentId = node.id === 'root'
              ? null
              : node.type === 'folder' ? rawId : stripIdPrefix(node.folderId ?? null)
            const result = await apiCall('/page-tree/create', {
              method: 'POST',
              body: JSON.stringify({
                type: 'folder',
                name: 'New Folder',
                parentId: folderParentId,
              }),
            })
            if (result.success) {
              toast.success('Folder created')
              window.location.reload()
            }
          } catch (error) {
            console.error('Create folder failed:', error)
            const message = error instanceof Error ? error.message : 'Create failed'
            toast.error(message)
          }
          break

        case 'publish':
        case 'unpublish':
          if (node.type === 'page' && node.collection) {
            try {
              await apiCall('/page-tree/status', {
                method: 'POST',
                body: JSON.stringify({
                  id: rawId,
                  collection: node.collection,
                  status: action === 'publish' ? 'published' : 'draft',
                }),
              })
              const newData = updateNodeInTree(data, node.id, {
                status: action === 'publish' ? 'published' : 'draft',
              })
              setData(newData)
              toast.success(action === 'publish' ? 'Page published' : 'Page unpublished')
            } catch (error) {
              console.error('Status update failed:', error)
              const message = error instanceof Error ? error.message : 'Status update failed'
              toast.error(message)
            }
          }
          break

        case 'expandAll':
          treeRef.current?.openAll()
          break

        case 'collapseAll':
          treeRef.current?.closeAll()
          break

        case 'regenerateSlugs':
          if (node.type === 'folder') {
            try {
              const result = await apiCall(
                `/page-tree/regenerate-slugs?folderId=${rawId}`,
                { method: 'POST' },
              )
              if (result.success) {
                toast.success(`Updated ${result.count} page URLs`)
                // Refresh to show updated slugs
                window.location.reload()
              }
            } catch (error) {
              console.error('Regenerate slugs failed:', error)
              const message = error instanceof Error ? error.message : 'Regenerate slugs failed'
              toast.error(message)
            }
          }
          break

        case 'urlHistory':
          if (node.type === 'page' && node.slugHistory && node.slugHistory.length > 0) {
            setUrlHistory({ node })
          }
          break

        case 'moveTo': {
          // Get all selected nodes from react-arborist (or just the right-clicked node)
          const selectedIds = treeRef.current?.selectedIds || new Set([node.id])
          const selectedNodes = Array.from(selectedIds)
            .map(id => findNode(data, id))
            .filter((n): n is TreeNodeType => n !== null)

          // If clicked node is not in selection, use just the clicked node
          const nodesToMove = selectedIds.has(node.id) ? selectedNodes : [node]

          // Calculate excluded folder IDs (can't move folder into itself or children)
          const excludeIds: string[] = []
          nodesToMove.forEach(n => {
            if (n.type === 'folder') {
              excludeIds.push(n.id)
              excludeIds.push(...getAllChildFolderIds(n))
            }
          })

          setMoveToModal({ nodes: nodesToMove, excludeIds })
          break
        }

        case 'editUrl': {
          // Get folder path for preview
          // For pages, extract the folder path from the slug (everything except the last segment)
          // For folders, we need to find the parent folder path
          let folderPath = ''
          if (node.type === 'page' && node.slug) {
            const slugParts = node.slug.split('/')
            if (slugParts.length > 1) {
              folderPath = slugParts.slice(0, -1).join('/')
            }
          } else if (node.type === 'folder' && node.folderId) {
            // Find parent folder and get its path
            const parentFolder = findNode(data, `folder-${node.folderId}`)
            if (parentFolder && parentFolder.slug) {
              folderPath = parentFolder.slug
            } else if (parentFolder && parentFolder.pathSegment) {
              // Recursively build path from parent folders
              let currentFolder = parentFolder
              const segments: string[] = []
              while (currentFolder) {
                if (currentFolder.pathSegment) {
                  segments.unshift(currentFolder.pathSegment)
                }
                if (currentFolder.folderId) {
                  currentFolder = findNode(data, `folder-${currentFolder.folderId}`) as TreeNodeType
                } else {
                  break
                }
              }
              folderPath = segments.join('/')
            }
          }
          setEditUrlState({ node, folderPath })
          break
        }
      }
    },
    [data, adminRoute, collections, selectedCollection, apiCall, puckEnabled, getEditUrl],
  )

  // Execute the actual delete operation
  const executeDelete = useCallback(
    async (node: TreeNodeType) => {
      const rawId = getRawId(node)
      try {
        await apiCall(
          `/page-tree/delete?type=${node.type}&id=${rawId}&deleteChildren=true`,
          { method: 'DELETE' },
        )
        // Remove node and recalculate page counts
        const removedData = removeNodeFromTree(data, node.id)
        const newData = recalculatePageCounts(removedData)
        setData(newData)
        toast.success(`${node.type === 'folder' ? 'Folder' : 'Page'} deleted`)
      } catch (error) {
        console.error('Delete failed:', error)
        const message = error instanceof Error ? error.message : 'Delete failed'
        toast.error(message)
      }
    },
    [data, apiCall],
  )

  // Confirm delete operation
  const confirmDelete = useCallback(() => {
    if (pendingDelete) {
      executeDelete(pendingDelete.node)
      setPendingDelete(null)
    }
  }, [pendingDelete, executeDelete])

  // Cancel delete operation
  const cancelDelete = useCallback(() => {
    setPendingDelete(null)
  }, [])

  // Handle URL history restore
  const handleRestoreSlug = useCallback(
    async (slug: string) => {
      if (!urlHistory) return

      const node = urlHistory.node
      const rawId = getRawId(node)

      try {
        const result = await apiCall('/page-tree/restore-slug', {
          method: 'POST',
          body: JSON.stringify({
            id: rawId,
            collection: node.collection,
            slug,
          }),
        })

        if (result.success) {
          toast.success(`URL restored to /${slug}`)
          setUrlHistory(null)
          // Refresh to show updated slug
          window.location.reload()
        }
      } catch (error) {
        console.error('Restore slug failed:', error)
        const message = error instanceof Error ? error.message : 'Failed to restore URL'
        toast.error(message)
      }
    },
    [urlHistory, apiCall],
  )

  // Close URL history modal
  const closeUrlHistory = useCallback(() => {
    setUrlHistory(null)
  }, [])

  // Handle edit URL save
  const handleEditUrlSave = useCallback(
    async (segment: string) => {
      if (!editUrlState) return

      const node = editUrlState.node
      const rawId = getRawId(node)
      const type = node.type

      try {
        await apiCall('/page-tree/edit-url', {
          method: 'POST',
          body: JSON.stringify({
            type,
            id: rawId,
            segment,
            collection: node.collection,
          }),
        })

        toast.success('URL updated')
        setEditUrlState(null)
        // Refresh to show updated slug
        window.location.reload()
      } catch (error) {
        console.error('Edit URL failed:', error)
        const message = error instanceof Error ? error.message : 'Failed to update URL'
        throw new Error(message)
      }
    },
    [editUrlState, apiCall],
  )

  // Close edit URL modal
  const closeEditUrl = useCallback(() => {
    setEditUrlState(null)
  }, [])

  // Handle folder selection from Move To modal
  const handleMoveToSelect = useCallback(
    (destinationFolderId: string | null) => {
      if (!moveToModal) return

      // Build move items (same structure as drag-drop)
      const itemsToMove: BulkMoveItem[] = moveToModal.nodes.map((node, i) => {
        const currentFolderId = node.folderId ?? null
        const folderChanging = currentFolderId !== destinationFolderId

        let requiresConfirmation = false
        let affectedCount = 0

        if (node.type === 'folder') {
          const { pages } = countNestedItems(node)
          requiresConfirmation = pages > 0 && folderChanging
          affectedCount = pages
        } else if (node.type === 'page') {
          requiresConfirmation = folderChanging
          affectedCount = 1
        }

        return {
          dragId: node.id,
          node,
          parentId: destinationFolderId,
          index: i,
          requiresConfirmation,
          affectedCount,
        }
      })

      // Close folder selection modal
      setMoveToModal(null)

      // Check if any items need confirmation
      const needsConfirmation = itemsToMove.some(item => item.requiresConfirmation)

      if (!needsConfirmation) {
        // Execute all moves immediately
        for (const item of itemsToMove) {
          executeMove([item.dragId], item.parentId, item.index, item.node, false)
        }
        toast.success(`Moved ${itemsToMove.length} item${itemsToMove.length > 1 ? 's' : ''}`)
        return
      }

      // Start confirmation flow
      if (itemsToMove.length === 1) {
        // Single item - use regular move confirmation
        const item = itemsToMove[0]
        setPendingMove({
          dragIds: [item.dragId],
          parentId: item.parentId,
          index: item.index,
          node: item.node,
          affectedCount: item.affectedCount,
        })
      } else {
        // Multiple items - use bulk move confirmation
        const firstConfirmIndex = itemsToMove.findIndex(item => item.requiresConfirmation)

        // Execute items before the first confirmation
        for (let i = 0; i < firstConfirmIndex; i++) {
          executeMove([itemsToMove[i].dragId], itemsToMove[i].parentId, itemsToMove[i].index, itemsToMove[i].node, false)
        }

        setPendingBulkMove({
          items: itemsToMove,
          currentIndex: firstConfirmIndex,
          parentId: destinationFolderId,
          baseIndex: 0,
        })
      }
    },
    [moveToModal, executeMove],
  )

  // Cancel Move To modal
  const cancelMoveToModal = useCallback(() => {
    setMoveToModal(null)
  }, [])

  // Handle node action from TreeNode component
  const handleNodeAction = useCallback(
    (nodeId: string, action: string) => {
      const node = findNode(data, nodeId)
      if (node) {
        handleContextAction(node, action as ContextMenuAction)
      }
    },
    [data, handleContextAction],
  )

  return (
    <ContextMenuProvider adminRoute={adminRoute} onAction={handleContextAction} puckEnabled={puckEnabled}>
      {/* Toast notifications */}
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: 'var(--theme-bg)',
            color: 'var(--theme-elevation-800)',
            border: '1px solid var(--theme-elevation-150)',
          },
        }}
      />

      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        {/* Move Confirmation Modal (single item) */}
        <ConfirmationModal
          isOpen={pendingMove !== null}
          title={pendingMove?.node.type === 'folder' ? 'Move Folder' : 'Move Page'}
          message={
            pendingMove?.node.type === 'folder'
              ? `Moving "${pendingMove?.node.name}" - what should happen to page URLs?`
              : `Moving "${pendingMove?.node.name}" to a different folder - what should happen to the URL?`
          }
          details={
            pendingMove?.node.type === 'folder'
              ? `${pendingMove?.affectedCount} page${pendingMove?.affectedCount === 1 ? '' : 's'} in this folder.`
              : `Current URL: /${pendingMove?.node.slug || ''}`
          }
          onCancel={cancelMove}
          actions={[
            {
              label: 'Keep existing URL',
              onClick: () => confirmMove(false),
              variant: 'secondary',
            },
            {
              label: 'Update URL',
              onClick: () => confirmMove(true),
              variant: 'primary',
            },
          ]}
        />

        {/* Bulk Move Confirmation Modal */}
        {pendingBulkMove && (() => {
          const currentItem = pendingBulkMove.items[pendingBulkMove.currentIndex]
          const confirmCount = pendingBulkMove.items.filter(i => i.requiresConfirmation).length
          const currentConfirmNumber = pendingBulkMove.items.slice(0, pendingBulkMove.currentIndex + 1).filter(i => i.requiresConfirmation).length
          const remainingCount = confirmCount - currentConfirmNumber + 1

          return (
            <ConfirmationModal
              isOpen={true}
              title={`Move ${pendingBulkMove.items.length} Items`}
              message={`Moving "${currentItem.node.name}" (${currentConfirmNumber} of ${confirmCount} requiring confirmation)`}
              details={
                currentItem.node.type === 'folder'
                  ? `Contains ${currentItem.affectedCount} page${currentItem.affectedCount === 1 ? '' : 's'}.`
                  : `Current URL: /${currentItem.node.slug || ''}`
              }
              onCancel={cancelBulkMove}
              actions={[
                {
                  label: 'Keep existing URL',
                  onClick: () => confirmBulkMoveItem(false),
                  variant: 'secondary',
                },
                {
                  label: 'Update URL',
                  onClick: () => confirmBulkMoveItem(true),
                  variant: 'primary',
                },
                ...(remainingCount > 1 ? [
                  {
                    label: `Keep All URLs (${remainingCount})`,
                    onClick: () => confirmBulkMoveAll(false),
                    variant: 'secondary' as const,
                  },
                  {
                    label: `Update All URLs (${remainingCount})`,
                    onClick: () => confirmBulkMoveAll(true),
                    variant: 'primary' as const,
                  },
                ] : []),
              ]}
            />
          )
        })()}

        {/* Delete Confirmation Modal */}
        <ConfirmationModal
          isOpen={pendingDelete !== null}
          title={pendingDelete?.node.type === 'folder' ? 'Delete Folder' : 'Delete Page'}
          message={
            pendingDelete?.node.type === 'folder'
              ? `Are you sure you want to delete "${pendingDelete?.node.name}" and all its contents?`
              : `Are you sure you want to delete "${pendingDelete?.node.name}"?`
          }
          details={
            pendingDelete?.node.type === 'folder' && (pendingDelete.pageCount > 0 || pendingDelete.folderCount > 0)
              ? `${pendingDelete.pageCount} page${pendingDelete.pageCount === 1 ? '' : 's'} and ${pendingDelete.folderCount} folder${pendingDelete.folderCount === 1 ? '' : 's'} will be permanently deleted.`
              : 'This action cannot be undone.'
          }
          confirmLabel={pendingDelete?.node.type === 'folder' ? 'Delete All' : 'Delete'}
          danger
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />

        {/* URL History Modal */}
        <SlugHistoryModal
          isOpen={urlHistory !== null}
          pageName={urlHistory?.node.name || ''}
          currentSlug={urlHistory?.node.slug || ''}
          history={urlHistory?.node.slugHistory || []}
          onRestore={handleRestoreSlug}
          onClose={closeUrlHistory}
        />

        {/* Move To Modal */}
        <FolderSelectModal
          isOpen={moveToModal !== null}
          title={moveToModal ? `Move ${moveToModal.nodes.length} item${moveToModal.nodes.length > 1 ? 's' : ''}` : ''}
          treeData={data}
          currentFolderIds={moveToModal?.nodes.map(n => n.folderId ?? null) || []}
          excludeIds={moveToModal?.excludeIds || []}
          onSelect={handleMoveToSelect}
          onCancel={cancelMoveToModal}
        />

        {/* Edit URL Modal */}
        <EditUrlModal
          isOpen={editUrlState !== null}
          node={editUrlState?.node ?? null}
          folderPath={editUrlState?.folderPath ?? ''}
          onSave={handleEditUrlSave}
          onCancel={closeEditUrl}
        />

        {/* Header with search and actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '16px',
            padding: '0 4px',
          }}
        >
          {/* Collection selector */}
          {collections.length > 1 && (
            <select
              value={selectedCollection}
              onChange={(e) => {
                // Navigate to same view with different collection param
                const url = new URL(window.location.href)
                url.searchParams.set('collection', e.target.value)
                window.location.href = url.toString()
              }}
              style={{
                padding: '8px 12px',
                border: '1px solid var(--theme-elevation-150)',
                borderRadius: '4px',
                fontSize: '14px',
                backgroundColor: 'var(--theme-input-bg)',
                color: 'var(--theme-elevation-800)',
                outline: 'none',
                cursor: 'pointer',
                minWidth: '140px',
              }}
            >
              {collections.map((col) => (
                <option key={col} value={col}>
                  {formatCollectionName(col)}
                </option>
              ))}
            </select>
          )}

          {/* Search input */}
          <div style={{ position: 'relative', flex: 1 }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--theme-elevation-400)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                position: 'absolute',
                left: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
              }}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder="Search pages and folders..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px 8px 40px',
                border: '1px solid var(--theme-elevation-150)',
                borderRadius: '4px',
                fontSize: '14px',
                backgroundColor: 'var(--theme-input-bg)',
                color: 'var(--theme-elevation-800)',
                outline: 'none',
              }}
            />
          </div>

          {/* Sort dropdown */}
          <select
            value={sortOption}
            onChange={(e) => setSortOption(e.target.value as SortOption)}
            style={{
              padding: '8px 12px',
              border: '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              fontSize: '14px',
              backgroundColor: 'var(--theme-input-bg)',
              color: 'var(--theme-elevation-800)',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="default">Sort: Default</option>
            <option value="name-asc">Sort: Name A-Z</option>
            <option value="name-desc">Sort: Name Z-A</option>
            <option value="slug-asc">Sort: Slug A-Z</option>
            <option value="slug-desc">Sort: Slug Z-A</option>
            <option value="status">Sort: Status</option>
          </select>

          {/* Expand/Collapse buttons */}
          <button
            onClick={() => treeRef.current?.openAll()}
            style={{
              padding: '8px 12px',
              border: '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              cursor: 'pointer',
              fontSize: '13px',
              color: 'var(--theme-elevation-600)',
            }}
          >
            Expand All
          </button>
          <button
            onClick={() => treeRef.current?.closeAll()}
            style={{
              padding: '8px 12px',
              border: '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              cursor: 'pointer',
              fontSize: '13px',
              color: 'var(--theme-elevation-600)',
            }}
          >
            Collapse All
          </button>

          {/* New buttons */}
          <button
            onClick={() =>
              handleContextAction(
                { id: 'root', type: 'folder', name: '', children: [], pageCount: 0, sortOrder: 0 },
                'newFolder',
              )
            }
            style={{
              padding: '8px 12px',
              border: '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              backgroundColor: 'var(--theme-elevation-50)',
              cursor: 'pointer',
              fontSize: '13px',
              color: 'var(--theme-elevation-700)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            New Folder
          </button>
          <button
            onClick={() =>
              handleContextAction(
                { id: 'root', type: 'folder', name: '', children: [], pageCount: 0, sortOrder: 0 },
                'newPage',
              )
            }
            style={{
              padding: '8px 12px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: 'var(--theme-success-500, #22c55e)',
              cursor: 'pointer',
              fontSize: '13px',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
            New Page
          </button>
        </div>

        {/* Tree content */}
        <div
          style={{
            flex: 1,
            border: '1px solid var(--theme-elevation-100)',
            borderRadius: '8px',
            backgroundColor: 'var(--theme-bg)',
            overflow: 'hidden',
          }}
        >
          {data.length === 0 ? (
            <div
              style={{
                padding: '40px',
                textAlign: 'center',
                color: 'var(--theme-elevation-500)',
              }}
            >
              No pages or folders yet. Create one to get started.
            </div>
          ) : (
            <Tree
              ref={treeRef}
              data={sortedData}
              onMove={handleMove}
              onRename={handleRename}
              searchTerm={search}
              searchMatch={(node, term) =>
                node.data.name.toLowerCase().includes(term.toLowerCase()) ||
                (node.data.slug?.toLowerCase().includes(term.toLowerCase()) ?? false)
              }
              width="100%"
              height={600}
              rowHeight={36}
              indent={24}
              openByDefault={false}
              disableDrag={sortOption !== 'default'}
              disableDrop={sortOption !== 'default'}
            >
              {(props) => (
                <TreeNode {...props} adminRoute={adminRoute} onAction={handleNodeAction} puckEnabled={puckEnabled} />
              )}
            </Tree>
          )}
        </div>

        {/* Keyboard shortcuts hint */}
        <div
          style={{
            marginTop: '12px',
            padding: '8px 12px',
            fontSize: '12px',
            color: 'var(--theme-elevation-400)',
            display: 'flex',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          <span>
            <kbd style={kbdStyle}>Enter</kbd> Edit
          </span>
          <span>
            <kbd style={kbdStyle}>F2</kbd> Rename
          </span>
          <span>
            <kbd style={kbdStyle}>Delete</kbd> Delete
          </span>
          <span>
            <kbd style={kbdStyle}>Space</kbd> Toggle
          </span>
          <span>
            <kbd style={kbdStyle}>Arrows</kbd> Navigate
          </span>
          <span>Right-click for more options</span>
        </div>
      </div>
    </ContextMenuProvider>
  )
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  backgroundColor: 'var(--theme-elevation-100)',
  borderRadius: '3px',
  fontSize: '11px',
  fontFamily: 'monospace',
}

// Helper functions for tree manipulation

function findNode(nodes: TreeNodeType[], id: string): TreeNodeType | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return null
}

/**
 * Recalculate page counts for all folders in the tree
 * Returns a new tree with updated counts
 */
function recalculatePageCounts(nodes: TreeNodeType[]): TreeNodeType[] {
  return nodes.map((node) => {
    if (node.type === 'folder') {
      // Recursively process children first
      const updatedChildren = recalculatePageCounts(node.children)

      // Count pages in this folder (direct children + nested)
      let pageCount = 0
      for (const child of updatedChildren) {
        if (child.type === 'page') {
          pageCount++
        } else if (child.type === 'folder') {
          pageCount += child.pageCount
        }
      }

      return { ...node, children: updatedChildren, pageCount }
    }
    return node
  })
}

function removeNodeFromTree(nodes: TreeNodeType[], id: string): TreeNodeType[] {
  return nodes.filter((node) => {
    if (node.id === id) return false
    node.children = removeNodeFromTree(node.children, id)
    return true
  })
}

function updateNodeInTree(
  nodes: TreeNodeType[],
  id: string,
  updates: Partial<TreeNodeType>,
): TreeNodeType[] {
  return nodes.map((node) => {
    if (node.id === id) {
      return { ...node, ...updates }
    }
    return {
      ...node,
      children: updateNodeInTree(node.children, id, updates),
    }
  })
}

function moveNodeInTree(
  nodes: TreeNodeType[],
  nodeId: string,
  newParentId: string | null,
  index: number,
): TreeNodeType[] {
  // Find and remove the node
  let movedNode: TreeNodeType | null = null
  const withoutNode = removeNodeAndCapture(nodes, nodeId, (n) => {
    movedNode = n
  })

  if (!movedNode) return nodes

  // Store in a const for proper type narrowing
  const nodeToMove: TreeNodeType = movedNode

  // Insert at new location
  if (newParentId === null) {
    // Insert at root level
    const result = [...withoutNode]
    result.splice(index, 0, { ...nodeToMove, folderId: null })
    return result
  }

  // Insert into parent folder
  return insertIntoParent(withoutNode, newParentId, nodeToMove, index)
}

function removeNodeAndCapture(
  nodes: TreeNodeType[],
  id: string,
  capture: (node: TreeNodeType) => void,
): TreeNodeType[] {
  return nodes.filter((node) => {
    if (node.id === id) {
      capture(node)
      return false
    }
    node.children = removeNodeAndCapture(node.children, id, capture)
    return true
  })
}

function insertIntoParent(
  nodes: TreeNodeType[],
  parentId: string,
  nodeToInsert: TreeNodeType,
  index: number,
): TreeNodeType[] {
  return nodes.map((node) => {
    if (node.id === parentId) {
      const newChildren = [...node.children]
      newChildren.splice(index, 0, { ...nodeToInsert, folderId: parentId })
      return { ...node, children: newChildren }
    }
    return {
      ...node,
      children: insertIntoParent(node.children, parentId, nodeToInsert, index),
    }
  })
}

export default PageTreeClient
