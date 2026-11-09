import { describe, expect, it } from 'vitest'
import { treeFixture } from '../helpers/treeFixture.js'

describe('folder cascade history', () => {
  it.each([
    ['move', { folder: 'destination' }, { id: 'destination', name: 'Destination', pathSegment: 'new-parent' }, 'new-parent/guides/advanced/welcome'],
    ['edit-url', { pathSegment: 'renamed' }, undefined, 'renamed/advanced/welcome'],
  ] as const)('records %s on the descendant page history', async (reason, data, destination, slug) => {
    const f = treeFixture()
    if (destination) f.rows['payload-folders'].push(destination)
    await f.payload.update({ collection: 'payload-folders', id: 'root', data, req: f.req,
      overrideAccess: false, context: { updateSlugs: true, slugChangeReason: reason } })
    expect(f.rows.pages[0]).toMatchObject({ slug, slugHistory: [
      { slug: 'old/welcome', reason, changedAt: expect.any(String) }, { slug: 'previous' },
    ] })
    for (const [opts] of [...f.find.mock.calls, ...f.findByID.mock.calls, ...f.update.mock.calls.slice(1)]) {
      expect(opts.req).toBe(f.req)
      expect(opts.overrideAccess).toBe(true)
    }
    expect(f.rows.pages.find(page => page.id === 'hidden-page')?.slug).toBe(
      reason === 'move' ? 'new-parent/guides/secret' : 'renamed/secret',
    )
  })

  it.each([
    [{ pathSegment: 'renamed' }, 'edit-url'],
    [{ folder: null }, 'move'],
  ] as const)('infers a fitting reason when user code requests a cascade without one', async (data, reason) => {
    const f = treeFixture()
    // Call the folder hook directly to inspect the inferred context.
    f.update.mockResolvedValue({ id: '1' })
    const previousDoc = { ...f.rows['payload-folders'][0], ...('folder' in data ? { folder: 'elsewhere' } : {}) }
    const doc = { ...previousDoc, ...data }
    await f.folderConfig.hooks.afterChange[0]({ doc, previousDoc, req: f.req, context: { updateSlugs: true } })
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ slugChangeReason: reason }) }))
  })
})

describe('trusted slug maintenance', () => {
  it('keeps an unreadable ancestor in the stored slug when an editor edits a page', async () => {
    const f = treeFixture()
    f.rows['payload-folders'][0].hidden = true
    f.req.transactionID = 'editor-txn'
    expect((await f.call('edit-url', { type: 'page', collection: 'pages', id: '1', segment: 'edited' })).status).toBe(200)
    expect(f.rows.pages[0].slug).toBe('guides/advanced/edited')
    for (const [opts] of f.findByID.mock.calls.filter(([opts]) => opts.collection === 'payload-folders')) {
      expect(opts.req).toBe(f.req)
      expect(opts.req.transactionID).toBe('editor-txn')
      expect(opts.overrideAccess).toBe(true)
    }
  })

  it('updates unreadable pages beneath unreadable child folders in the original transaction', async () => {
    const f = treeFixture()
    f.rows.pages.find(page => page.id === 'hidden-page')!.folder = 'hidden-folder'
    f.req.transactionID = 'cascade-txn'
    const update = f.update.getMockImplementation()!
    f.update.mockImplementation(async opts => {
      expect(opts.req).toBe(f.req)
      expect(opts.req.transactionID).toBe('cascade-txn')
      return update(opts)
    })
    expect((await f.call('edit-url', { type: 'folder', id: 'root', segment: 'renamed' })).status).toBe(200)
    expect(f.rows.pages.find(page => page.id === 'hidden-page')?.slug).toBe('renamed/secret/secret')
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'hidden-page', overrideAccess: true, req: f.req }))
    for (const [opts] of f.find.mock.calls.filter(([opts]) => opts.where?.folder)) {
      expect(opts.req).toBe(f.req)
      expect(opts.overrideAccess).toBe(true)
    }
  })
})


it('propagates a failed cascade update so the parent operation can roll back', async () => {
  const f = treeFixture()
  const failure = new Error('Database write failed')
  f.update.mockRejectedValue(failure)
  const previousDoc = { ...f.rows['payload-folders'][0] }
  const doc = { ...previousDoc, pathSegment: 'renamed' }
  await expect(f.folderConfig.hooks.afterChange[0]({ doc, previousDoc, req: f.req, context: { updateSlugs: true } }))
    .rejects.toBe(failure)
})
