import type { AdminViewProps, Locale } from 'payload'
import type { FolderDocument, PageDocument } from '../types.js'
import { PageTreeClient } from './PageTreeClient.js'
import { DefaultTemplate } from '@payloadcms/next/templates'
import { getVisibleEntities } from '@payloadcms/ui/shared'
import { buildTreeStructure } from '../utils/buildTree.js'

type PageTreeViewProps = AdminViewProps

export async function PageTreeView({
  initPageResult,
  params,
  searchParams,
}: PageTreeViewProps) {
  // Get payload instance from initPageResult
  const { req } = initPageResult
  const { payload } = req

  // Get admin route from config
  const adminRoute = req.payload.config.routes?.admin || '/admin'

  // Get plugin config from payload.config.custom
  const pageTreeConfig = payload.config.custom?.pageTree as {
    collections: string[]
    folderSlug: string
  } | undefined

  // Fallback to defaults if config not found (shouldn't happen if plugin is properly configured)
  const collections = pageTreeConfig?.collections || ['pages']
  const folderSlug = pageTreeConfig?.folderSlug || 'payload-folders'

  // Get selected collection from URL params, default to first configured collection
  const selectedCollection =
    (searchParams?.collection as string) ||
    collections[0]

  // Validate selected collection is in configured list
  const validSelectedCollection = collections.includes(selectedCollection)
    ? selectedCollection
    : collections[0]

  // Fetch all folders and filter by folderType for the selected collection
  let folders: FolderDocument[] = []
  try {
    const result = await payload.find({
      collection: folderSlug as 'payload-folders',
      limit: 0,
      depth: 1,
    })
    const allFolders = result.docs as unknown as FolderDocument[]

    // Filter folders to only show those that allow the selected collection
    // A folder allows a collection if:
    // 1. folderType is null/undefined/empty (allows all collections)
    // 2. folderType array includes the selected collection
    folders = allFolders.filter(folder => {
      if (!folder.folderType || folder.folderType.length === 0) {
        return true // No restriction, allow all
      }
      return folder.folderType.includes(validSelectedCollection)
    })
  } catch (error) {
    console.error('[payload-page-tree] Error fetching folders:', error)
  }

  // Fetch pages from ONLY the selected collection
  let allPages: Array<PageDocument & { _collection?: string }> = []
  try {
    const result = await payload.find({
      collection: validSelectedCollection as 'pages',
      limit: 0,
      depth: 0,
    })
    // Add collection slug to each page for context menu actions
    const pagesWithCollection = (result.docs as unknown as PageDocument[]).map(page => ({
      ...page,
      _collection: validSelectedCollection,
    }))
    allPages = pagesWithCollection
  } catch (error) {
    console.error(
      `[payload-page-tree] Error fetching ${validSelectedCollection}:`,
      error,
    )
  }

  // Build tree structure
  const treeData = buildTreeStructure(folders, allPages, { collections: [validSelectedCollection] })

  // Get visible entities for the sidebar navigation
  const visibleEntities = getVisibleEntities({ req })

  // Detect if Puck visual editor is installed by checking for puckData field
  // We check the currently selected collection
  // Check both top-level fields and flattenedFields (handles SEO plugin tabbedUI wrapping)
  let puckEnabled = false
  const currentCollection = payload.config.collections.find(c => c.slug === validSelectedCollection)
  if (currentCollection) {
    const hasPuckData = currentCollection.fields.some(
      f => 'name' in f && f.name === 'puckData'
    ) || currentCollection.flattenedFields?.some(f => f.name === 'puckData')
    puckEnabled = hasPuckData
  }

  return (
    <DefaultTemplate
      i18n={req.i18n}
      locale={req.locale as Locale | undefined}
      params={params}
      payload={payload}
      permissions={initPageResult.permissions}
      searchParams={searchParams}
      user={req.user ?? undefined}
      visibleEntities={visibleEntities}
    >
      <div
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          padding: '20px',
        }}
      >
        <div
          style={{
            marginBottom: '24px',
          }}
        >
          <h1
            style={{
              fontSize: '24px',
              fontWeight: 600,
              color: 'var(--theme-elevation-800)',
              margin: 0,
            }}
          >
            Page Tree
          </h1>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--theme-elevation-500)',
              marginTop: '4px',
            }}
          >
            View and navigate your page hierarchy
          </p>
        </div>

        <PageTreeClient
          treeData={treeData}
          collections={collections}
          selectedCollection={validSelectedCollection}
          adminRoute={adminRoute}
          puckEnabled={puckEnabled}
        />
      </div>
    </DefaultTemplate>
  )
}

export default PageTreeView
