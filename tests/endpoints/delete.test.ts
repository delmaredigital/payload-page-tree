import { describe, expect, it, vi } from 'vitest'
import { treeFixture } from '../helpers/treeFixture.js'

describe('collection-specific page deletion', () => {
  it('deletes only the selected collection when another collection has the same id', async () => {
    const f = treeFixture()
    expect((await f.call('delete', undefined, 'type=page&id=1&collection=posts')).status).toBe(200)
    expect(f.remove).toHaveBeenCalledExactlyOnceWith({ collection: 'posts', id: '1', req: f.req, overrideAccess: false })
    expect(f.rows.pages.some(row => row.id === '1')).toBe(true)
    expect(f.rows.posts).toEqual([])
  })

  it.each(['', '&collection=unconfigured', '&collection=payload-folders'])('rejects invalid page collection: %s', async (query) => {
    const f = treeFixture()
    expect((await f.call('delete', undefined, `type=page&id=1${query}`)).status).toBe(400)
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('returns 404 in the selected collection without trying another', async () => {
    const f = treeFixture()
    f.rows.posts = []
    expect((await f.call('delete', undefined, 'type=page&id=1&collection=posts')).status).toBe(404)
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.findByID).toHaveBeenCalledExactlyOnceWith({ collection: 'posts', id: '1', depth: 0, req: f.req, overrideAccess: false })
    expect(f.rows.pages.some(row => row.id === '1')).toBe(true)
  })

  it('preserves access errors without trying another collection', async () => {
    const f = treeFixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.remove.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    try {
      expect((await f.call('delete', undefined, 'type=page&id=1&collection=posts')).status).toBe(403)
      expect(f.remove).toHaveBeenCalledTimes(1)
    } finally { log.mockRestore() }
  })

  it('rejects an invalid node type', async () => {
    const f = treeFixture()
    expect((await f.call('delete', undefined, 'type=unknown&id=1&collection=posts')).status).toBe(400)
    expect(f.remove).not.toHaveBeenCalled()
  })
})

describe('atomic recursive folder deletion', () => {
  it.each(['page', 'folder'] as const)('rolls back earlier deletes when a later %s denies DELETE', async type => {
    const f = treeFixture()
    for (const rows of Object.values(f.rows)) for (const row of rows) delete row.hidden
    if (type === 'page') f.rows.posts[0].undeletable = true
    else f.rows['payload-folders'].find(folder => folder.id === 'middle')!.undeletable = true
    const before = structuredClone(f.rows)
    for (const read of [f.find, f.findByID]) {
      const implementation = read.getMockImplementation()!
      read.mockImplementation(async opts => {
        expect(opts.req).toBe(f.req)
        expect(opts.req.transactionID).toBe('delete-txn')
        return implementation(opts)
      })
    }
    const remove = f.remove.getMockImplementation()!
    f.remove.mockImplementation(async opts => {
      expect(opts.req).toBe(f.req)
      expect(opts.req.transactionID).toBe('delete-txn')
      expect(opts.overrideAccess).toBe(false)
      return remove(opts)
    })
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(403)
    expect(f.remove.mock.calls.length).toBeGreaterThan(1)
    expect(f.rows).toEqual(before)
    expect(f.payload.db.rollbackTransaction).toHaveBeenCalledWith('delete-txn')
    expect(f.payload.db.commitTransaction).not.toHaveBeenCalled()
  })

  it.each(['page', 'folder'] as const)('rejects an unreadable descendant %s before deleting anything', async type => {
    const f = treeFixture()
    if (type === 'page') delete f.rows['payload-folders'].find(folder => folder.id === 'hidden-folder')!.hidden
    else delete f.rows.pages.find(page => page.id === 'hidden-page')!.hidden
    const before = structuredClone(f.rows)
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(403)
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.rows).toEqual(before)
  })

  it('commits all descendants together on success', async () => {
    const f = treeFixture()
    for (const rows of Object.values(f.rows)) for (const row of rows) delete row.hidden
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(200)
    expect(Object.values(f.rows).flat()).toEqual([])
    expect(f.payload.db.commitTransaction).toHaveBeenCalledWith('delete-txn')
    expect(f.payload.db.rollbackTransaction).not.toHaveBeenCalled()
  })
})


describe('recursive delete transaction ownership', () => {
  it('reuses and rolls back an inherited transaction on denied DELETE', async () => {
    const f = treeFixture()
    for (const rows of Object.values(f.rows)) for (const row of rows) delete row.hidden
    f.rows.posts[0].undeletable = true
    const before = structuredClone(f.rows)
    f.req.transactionID = await f.payload.db.beginTransaction()
    f.payload.db.beginTransaction.mockClear()
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(403)
    expect(f.rows).toEqual(before)
    expect(f.payload.db.beginTransaction).not.toHaveBeenCalled()
    expect(f.payload.db.rollbackTransaction).toHaveBeenCalledWith('delete-txn')
    expect(f.payload.db.commitTransaction).not.toHaveBeenCalled()
  })

  it('leaves committing an inherited successful transaction to its owner', async () => {
    const f = treeFixture()
    for (const rows of Object.values(f.rows)) for (const row of rows) delete row.hidden
    f.req.transactionID = await f.payload.db.beginTransaction()
    f.payload.db.beginTransaction.mockClear()
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(200)
    expect(f.payload.db.beginTransaction).not.toHaveBeenCalled()
    expect(f.payload.db.commitTransaction).not.toHaveBeenCalled()
    expect(f.req.transactionID).toBe('delete-txn')
  })

  it.each(['disabled', 'absent'])('without transactions (%s), still preflights READ before any delete', async mode => {
    const setup = () => {
      const f = treeFixture()
      if (mode === 'disabled') f.payload.db.beginTransaction.mockResolvedValue(null as any)
      else delete (f.payload.db as any).beginTransaction
      return f
    }
    // A hidden descendant: rejected, nothing deleted
    const hidden = setup()
    const before = structuredClone(hidden.rows)
    expect((await hidden.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(403)
    expect(hidden.remove).not.toHaveBeenCalled()
    expect(hidden.rows).toEqual(before)
    // A fully readable subtree: deleted without a transaction
    const readable = setup()
    for (const rows of Object.values(readable.rows)) for (const row of rows) delete row.hidden
    expect((await readable.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(200)
    expect(readable.remove).toHaveBeenCalled()
    expect(readable.req.transactionID).toBeUndefined()
  })
})

describe('recursive deletion includes trashed documents', () => {
  function setup() {
    const f = treeFixture()
    for (const rows of Object.values(f.rows)) for (const row of rows) delete row.hidden
    f.payload.collections.pages.config.trash = true
    f.payload.collections['payload-folders'].config.trash = true
    f.rows['payload-folders'].push({ id: 'trashed-folder', folder: 'root', deletedAt: '2026-11-01T00:00:00Z' })
    f.rows['payload-folders'].push({ id: 'nested-folder', folder: 'trashed-folder' })
    f.rows.pages.push({ id: 'trashed-page', folder: 'trashed-folder', deletedAt: '2026-11-01T00:00:00Z' })
    f.rows.posts.push({ id: 'nested-post', folder: 'nested-folder' })
    return f
  }

  it.each([true, false])('permanently deletes trash and descendants with the same request (transactions: %s)', async transactions => {
    const f = setup()
    if (!transactions) f.payload.db.beginTransaction.mockResolvedValue(null as any)
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(200)
    expect(Object.values(f.rows).flat()).toEqual([])
    for (const calls of [f.find.mock.calls, f.findByID.mock.calls, f.remove.mock.calls]) {
      for (const [opts] of calls) {
        expect(opts.req).toBe(f.req)
        if (opts.collection === 'posts') expect(opts.trash).toBeUndefined()
        else expect(opts.trash).toBe(true)
      }
    }
    expect(f.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'trashed-page', trash: true, overrideAccess: false }))
    expect(f.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'trashed-folder', trash: true, overrideAccess: false }))
    if (transactions) expect(f.payload.db.commitTransaction).toHaveBeenCalledWith('delete-txn')
    else expect(f.payload.db.commitTransaction).not.toHaveBeenCalled()
  })

  it.each(['page', 'folder'])('preflights an unreadable trashed %s before any delete', async type => {
    const f = setup()
    const collection = type === 'page' ? 'pages' : 'payload-folders'
    f.rows[collection].find(row => row.id === `trashed-${type}`)!.hidden = true
    const before = structuredClone(f.rows)
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(403)
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.rows).toEqual(before)
  })

  it('rolls back earlier deletes when a trashed document denies DELETE', async () => {
    const f = setup()
    f.rows['payload-folders'].find(row => row.id === 'trashed-folder')!.undeletable = true
    const before = structuredClone(f.rows)
    expect((await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')).status).toBe(403)
    expect(f.remove.mock.calls.length).toBeGreaterThan(1)
    expect(f.rows).toEqual(before)
    expect(f.payload.db.rollbackTransaction).toHaveBeenCalledWith('delete-txn')
  })
})
