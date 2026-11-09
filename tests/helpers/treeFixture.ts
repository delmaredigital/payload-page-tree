import { vi } from 'vitest'
import { commitTransaction, initTransaction, killTransaction } from 'payload'
import type { Config, PayloadRequest } from 'payload'
import { pageTreePlugin } from '../../src/index.js'

export function treeFixture(customFields = false) {
  const segmentFieldName = customFields ? 'folderSegment' : 'pathSegment'
  const pageSegmentFieldName = customFields ? 'urlSegment' : 'pageSegment'
  const options = { collections: ['pages', 'posts'], folderSlug: 'payload-folders', segmentFieldName, pageSegmentFieldName }
  const config = pageTreePlugin(options)({
    collections: options.collections.map(slug => ({ slug, fields: [] })),
  } as unknown as Config)
  const folderConfig = (config.folders as any).collectionOverrides[0]({ collection: { fields: [] } })
  const rows: Record<string, Record<string, any>[]> = {
    'payload-folders': [
      { id: 'root', name: 'Root', [segmentFieldName]: 'guides' },
      { id: 'middle', name: 'Middle', folder: 'root', [segmentFieldName]: '' },
      { id: 'leaf', name: 'Leaf', folder: 'middle', [segmentFieldName]: 'advanced' },
      { id: 'hidden-folder', name: 'Secret', hidden: true, folder: 'root', [segmentFieldName]: 'secret' },
    ],
    pages: [
      { id: '1', title: 'Welcome', folder: 'leaf', [pageSegmentFieldName]: 'welcome', slug: 'old/welcome', slugHistory: [{ slug: 'previous' }] },
      { id: 'hidden-page', hidden: true, title: 'Secret', folder: 'root', [pageSegmentFieldName]: 'secret', slug: 'secret', slugHistory: [{ slug: 'hidden-old' }] },
    ],
    posts: [{ id: '1', title: 'Same ID post', slug: 'post', [pageSegmentFieldName]: 'post', folder: 'leaf' }],
  }
  function matches(row: Record<string, any>, where?: Record<string, any>): boolean {
    if (!where) return true
    return Object.entries(where).every(([field, clause]) => {
      if (field === 'and') return clause.every((part: any) => matches(row, part))
      if (field === 'or') return clause.some((part: any) => matches(row, part))
      return Object.entries(clause).every(([op, value]) => {
        const actual = row[field] ?? null
        if (op === 'equals') return actual === value
        if (op === 'not_equals') return actual !== value
        if (op === 'exists') return (actual !== null) === value
        if (op === 'in') return (value as unknown[]).includes(actual)
        throw new Error(`Unhandled operator: ${op}`)
      })
    })
  }
  const readable = (row: any, opts: any) => opts.overrideAccess !== false || (!row.hidden && opts.req?.user?.id === 'reader')
  const find = vi.fn(async (opts: any) => {
    const docs = (rows[opts.collection] || []).filter(row => (!row.deletedAt || opts.trash === true) && readable(row, opts) && matches(row, opts.where))
    return { docs, totalDocs: docs.length }
  })
  const findByID = vi.fn(async (opts: any) => {
    const doc = rows[opts.collection]?.find(row => String(row.id) === String(opts.id) && (!row.deletedAt || opts.trash === true) && readable(row, opts))
    if (!doc) throw Object.assign(new Error('Not found'), { status: 404 })
    return doc
  })
  const persistedUpdates = vi.fn()
  const update = vi.fn(async (opts: any) => {
    try {
      const shouldCommit = await initTransaction(opts.req)
      const result = await performUpdate(opts)
      if (shouldCommit) await commitTransaction(opts.req)
      return result
    } catch (error) {
      await killTransaction(opts.req)
      throw error
    }
  })
  async function performUpdate(opts: any) {
    const doc = rows[opts.collection].find(row => row.id === opts.id && (!row.deletedAt || opts.trash === true))!
    if (!doc) throw Object.assign(new Error('Not found'), { status: 404 })
    if (opts.overrideAccess === false && doc.updateDenied) {
      throw Object.assign(new Error('Update denied'), { status: doc.updateDenied })
    }
    const previousDoc = { ...doc }
    let data = { ...opts.data }
    const context = opts.context || {}
    if (opts.collection !== options.folderSlug) {
      const hook = config.collections!.find(c => c.slug === opts.collection)!.hooks!.beforeChange![0]
      data = await hook({ data, req: opts.req, operation: 'update', originalDoc: previousDoc, context } as any)
    }
    if (opts.collection === options.folderSlug) {
      for (const hook of folderConfig.hooks.beforeChange) {
        data = await hook({ data, originalDoc: previousDoc, req: opts.req, operation: 'update', context })
      }
    }
    persistedUpdates({ collection: opts.collection, id: opts.id, data })
    Object.assign(doc, data)
    if (opts.collection === options.folderSlug) {
      await folderConfig.hooks.afterChange[0]({ doc, previousDoc, req: opts.req, context })
    }
    return doc
  }
  const create = vi.fn(async (opts: any) => {
    let data = { ...opts.data }
    if (opts.collection !== options.folderSlug) {
      const hook = config.collections!.find(c => c.slug === opts.collection)!.hooks!.beforeChange![0]
      data = await hook({ data, req: opts.req, operation: 'create', context: {} } as any)
    }
    const doc = { id: `created-${rows[opts.collection].length}`, ...data }
    rows[opts.collection].push(doc)
    return doc
  })
  const remove = vi.fn(async (opts: any) => {
    const index = rows[opts.collection].findIndex(row => String(row.id) === String(opts.id) && (!row.deletedAt || opts.trash === true))
    if (index < 0) throw Object.assign(new Error('Not found'), { status: 404 })
    if (opts.overrideAccess === false && rows[opts.collection][index].undeletable) {
      throw Object.assign(new Error('Forbidden'), { status: 403 })
    }
    return rows[opts.collection].splice(index, 1)[0]
  })
  const duplicate = vi.fn(async () => ({ id: 'copy' }))
  let snapshot: typeof rows | undefined
  const db = {
    beginTransaction: vi.fn(async () => { snapshot = structuredClone(rows); return 'delete-txn' }),
    commitTransaction: vi.fn(async (_id: unknown) => { snapshot = undefined }),
    rollbackTransaction: vi.fn(async (_id: unknown) => {
      if (snapshot) {
        for (const key of Object.keys(rows)) rows[key] = snapshot[key]
        snapshot = undefined
      }
    }),
  }
  const payload = { db, find, findByID, update, create, delete: remove, duplicate,
    collections: { pages: { config: { trash: false } }, posts: { config: { trash: false } },
      'payload-folders': { config: { trash: false } } } }
  const req = { payload, user: { id: 'reader' } } as unknown as PayloadRequest
  async function call(path: string, body?: Record<string, unknown>, query = '') {
    req.url = `http://localhost/api/page-tree/${path}${query ? `?${query}` : ''}`
    req.json = async () => body
    return config.endpoints!.find(e => e.path === `/page-tree/${path}`)!.handler(req)
  }
  return { options, config, folderConfig, rows, req, payload, find, findByID, update, create, remove, duplicate, persistedUpdates, call }
}
