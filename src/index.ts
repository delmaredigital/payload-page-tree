import type { Config, CollectionConfig, Field, TextField, NumberField, ArrayField } from 'payload'
import type { PageTreePluginConfig } from './types.js'
import { createBuildSlugHook } from './hooks/buildSlugFromFolder.js'
import { createCascadeSlugUpdatesHook } from './hooks/cascadeSlugUpdates.js'
import { slugify } from './utils/getFolderPath.js'
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

export type { PageTreePluginConfig } from './types.js'
export type { TreeNode, FolderDocument, PageDocument, SlugHistoryEntry, SlugChangeReason } from './types.js'
export { getFolderPath, slugify } from './utils/getFolderPath.js'
export { buildTreeStructure } from './utils/buildTree.js'
export type { BuildTreeOptions } from './utils/buildTree.js'
export { getRedirectMap } from './utils/redirectMap.js'
// Components are exported via /client and /rsc subpaths for proper import map resolution

/**
 * Payload Page Tree Plugin
 *
 * Extends Payload's built-in folders to auto-generate hierarchical URL slugs.
 * Folders define URL structure, pages pick a folder, and slugs are auto-generated.
 *
 * @example
 * ```ts
 * import { pageTreePlugin } from '@delmaredigital/payload-page-tree'
 *
 * export default buildConfig({
 *   plugins: [
 *     // Uses default collections: ['pages', 'posts']
 *     pageTreePlugin(),
 *   ],
 * })
 * ```
 */
export function pageTreePlugin(pluginOptions: PageTreePluginConfig = {}) {
  const {
    collections = ['pages', 'posts'],
    folderSlug = 'payload-folders',
    segmentFieldName = 'pathSegment',
    pageSegmentFieldName = 'pageSegment',
    disabled = false,
    adminView = {},
  } = pluginOptions

  const {
    enabled: adminViewEnabled = true,
    path: adminViewPath = '/page-tree',
  } = adminView

  // The folder field name that Payload's folders feature adds
  const folderFieldName = 'folder'

  return (config: Config): Config => {
    // Even if disabled, we need to add fields to maintain schema consistency
    const shouldAddHooks = !disabled

    // Auto-filter collections to only include ones that actually exist in the config
    // This allows defaulting to ['pages', 'posts'] without errors if 'posts' doesn't exist
    const existingCollectionSlugs = new Set(
      (config.collections || []).map(c => c.slug)
    )
    const validCollections = collections.filter(slug => existingCollectionSlugs.has(slug))

    // If no valid collections, skip plugin setup but still add folder fields
    if (validCollections.length === 0) {
      console.warn('[payload-page-tree] No matching collections found. Plugin will only add folder fields.')
    }

    // Get existing folder config (handle false, undefined, or object)
    const existingFolderConfig =
      config.folders && typeof config.folders === 'object' ? config.folders : {}

    // Add folder collection overrides to extend folders with pathSegment
    config.folders = {
      ...existingFolderConfig,
      collectionOverrides: [
        ...(existingFolderConfig.collectionOverrides || []),
        ({ collection }) => {
          const existingFields = collection.fields || []

          // Add pathSegment field to folders
          const pathSegmentField: TextField = {
            name: segmentFieldName,
            type: 'text',
            admin: {
              position: 'sidebar',
              description: 'URL path segment (e.g., "appeals" for /appeals/...)',
            },
            hooks: {
              beforeValidate: [
                // Auto-slugify the segment
                ({ value, data }: { value?: string; data?: Record<string, unknown> }) => {
                  if (value) return slugify(String(value))
                  if (data?.name) return slugify(String(data.name))
                  return value
                },
              ],
            },
          }

          // Add sortOrder field for tree ordering
          const sortOrderField: NumberField = {
            name: 'sortOrder',
            type: 'number',
            defaultValue: 0,
            admin: {
              hidden: true,
            },
          }

          // Create cascade hook for folder changes
          const cascadeHook = shouldAddHooks
            ? createCascadeSlugUpdatesHook({
                collections: validCollections,
                folderSlug,
                segmentFieldName,
                folderFieldName,
              })
            : undefined

          return {
            ...collection,
            fields: [...existingFields, pathSegmentField, sortOrderField],
            hooks: {
              ...collection.hooks,
              afterChange: [
                ...(collection.hooks?.afterChange || []),
                ...(cascadeHook ? [cascadeHook] : []),
              ],
            },
          }
        },
      ],
    }

    // Process each collection that should have folder-based slugs
    if (config.collections) {
      config.collections = config.collections.map((collection) => {
        // Skip if this collection isn't in the validated list
        if (!validCollections.includes(collection.slug as string)) {
          return collection
        }

        // Enable folders on this collection
        const updatedCollection: CollectionConfig = {
          ...collection,
          folders: true, // Enable Payload's folders feature
        }

        // Add pageSegment field
        const pageSegmentField: TextField = {
          name: pageSegmentFieldName,
          type: 'text',
          admin: {
            position: 'sidebar',
            description: 'URL segment for this page (auto-generated from title if empty)',
          },
          hooks: {
            beforeValidate: [
              // Auto-slugify if provided, otherwise leave empty (will be generated from title)
              ({ value }: { value?: string }) => {
                if (value) return slugify(String(value))
                return value
              },
            ],
          },
        }

        // Add sortOrder field for tree ordering
        const pageSortOrderField: NumberField = {
          name: 'sortOrder',
          type: 'number',
          defaultValue: 0,
          admin: {
            hidden: true,
          },
        }

        // Add slugHistory field for audit trail (max 20 entries)
        const slugHistoryField: ArrayField = {
          name: 'slugHistory',
          type: 'array',
          maxRows: 20,
          admin: {
            readOnly: true,
            position: 'sidebar',
            description: 'Previous URLs for this page (auto-tracked)',
          },
          fields: [
            {
              name: 'slug',
              type: 'text',
              required: true,
            },
            {
              name: 'changedAt',
              type: 'date',
              required: true,
              admin: {
                date: {
                  displayFormat: 'MMM d, yyyy HH:mm',
                },
              },
            },
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
          ],
        }

        // Find and modify the slug field to be read-only
        const modifiedFields: Field[] = updatedCollection.fields.map((field) => {
          if ('name' in field && field.name === 'slug' && field.type === 'text') {
            const textField = field as TextField
            return {
              ...textField,
              admin: {
                ...textField.admin,
                readOnly: true,
                description: 'Auto-generated from folder path + page segment',
              },
            } satisfies TextField
          }
          return field
        })

        // Add the pageSegment, sortOrder, and slugHistory fields
        updatedCollection.fields = [...modifiedFields, pageSegmentField, pageSortOrderField, slugHistoryField]

        // Add beforeChange hook for slug generation
        if (shouldAddHooks) {
          const buildSlugHook = createBuildSlugHook({
            folderSlug,
            segmentFieldName,
            pageSegmentFieldName,
            folderFieldName,
          })

          updatedCollection.hooks = {
            ...updatedCollection.hooks,
            beforeChange: [...(updatedCollection.hooks?.beforeChange || []), buildSlugHook],
          }
        }

        return updatedCollection
      })
    }

    // Store plugin config for admin view to access
    config.custom = {
      ...config.custom,
      pageTree: {
        collections: validCollections,
        folderSlug,
      },
    }

    // Register admin view if enabled
    if (adminViewEnabled) {
      config.admin = {
        ...config.admin,
        components: {
          ...config.admin?.components,
          // Add nav link after existing nav links (client component)
          afterNavLinks: [
            ...(config.admin?.components?.afterNavLinks || []),
            '@delmaredigital/payload-page-tree/client#PageTreeNavLink',
          ],
          // Add custom view (server component)
          views: {
            ...config.admin?.components?.views,
            pageTree: {
              Component: '@delmaredigital/payload-page-tree/rsc#PageTreeView',
              path: adminViewPath as `/${string}`,
            },
          },
        },
      }
    }

    // Register API endpoints for tree operations
    const endpointOptions = { collections: validCollections, folderSlug }
    config.endpoints = [
      ...(config.endpoints || []),
      {
        path: '/page-tree/move',
        method: 'post',
        handler: createMoveHandler(endpointOptions),
      },
      {
        path: '/page-tree/reorder',
        method: 'post',
        handler: createReorderHandler(endpointOptions),
      },
      {
        path: '/page-tree/create',
        method: 'post',
        handler: createCreateHandler(endpointOptions),
      },
      {
        path: '/page-tree/delete',
        method: 'delete',
        handler: createDeleteHandler(endpointOptions),
      },
      {
        path: '/page-tree/duplicate',
        method: 'post',
        handler: createDuplicateHandler(endpointOptions),
      },
      {
        path: '/page-tree/status',
        method: 'post',
        handler: createStatusHandler(endpointOptions),
      },
      {
        path: '/page-tree/rename',
        method: 'post',
        handler: createRenameHandler(endpointOptions),
      },
      {
        path: '/page-tree/regenerate-slugs',
        method: 'post',
        handler: createRegenerateSlugsHandler(endpointOptions),
      },
      {
        path: '/page-tree/migrate',
        method: 'post',
        handler: createMigrateHandler(endpointOptions),
      },
      {
        path: '/page-tree/redirects',
        method: 'get',
        handler: createRedirectsHandler(endpointOptions),
      },
      {
        path: '/page-tree/restore-slug',
        method: 'post',
        handler: createRestoreSlugHandler(endpointOptions),
      },
      {
        path: '/page-tree/edit-url',
        method: 'post',
        handler: createEditUrlHandler(endpointOptions),
      },
    ]

    return config
  }
}

export default pageTreePlugin
