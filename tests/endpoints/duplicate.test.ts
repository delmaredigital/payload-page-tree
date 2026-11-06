import { describe, expect, it, vi } from 'vitest'
import type { Config, PayloadRequest } from 'payload'
import { createDuplicateHandler } from '../../src/endpoints/treeOperations.js'
import { pageTreePlugin } from '../../src/index.js'

function fixture(drafts: boolean, overrides: Record<string, unknown> = {}) {
  const original = {
    id: 'original', title: 'Welcome', slug: 'old/path/legacy-segment', folder: { id: 'folder' },
    layout: [{ id: 'block-id', blockType: 'hero', items: [{ id: 'array-id', label: 'Hello' }] }],
    slugHistory: [{ id: 'history-id', slug: 'previous' }], _status: 'published',
    ...overrides,
  }
  const duplicate = vi.fn(async (_options: { data: Record<string, unknown> }) => ({ id: 'copy' }))
  const create = vi.fn(async (_options: { data: Record<string, unknown> }) => ({ id: 'copy' }))
  const findByID = vi.fn(async ({ collection }: { collection: string }) =>
    collection === 'pages' ? original : { id: 'folder', pathSegment: 'guides' })
  const find = vi.fn(async ({ where }: { where: Record<string, any> }) => {
    const docs: Record<string, unknown>[] = where.slug
      ? (where.slug.equals === 'guides/legacy-segment' ? [original] : [])
      : [original, { title: 'Welcome (copy)' }]
    return { docs, totalDocs: docs.length }
  })
  const payload = {
    duplicate, create, findByID, find,
    collections: { pages: { config: { versions: drafts ? { drafts: {} } : false } } },
  }
  const req = {
    url: 'http://localhost/api/page-tree/duplicate?id=original&collection=pages', payload,
  } as unknown as PayloadRequest
  const handler = createDuplicateHandler({ collections: ['pages'], folderSlug: 'payload-folders' })
  return { req, handler, duplicate, create, findByID, find }
}

function expectNoIds(value: unknown) {
  if (!value || typeof value !== 'object') return
  expect(value).not.toHaveProperty('id')
  for (const child of Object.values(value)) expectNoIds(child)
}

describe('createDuplicateHandler', () => {
  it.each([true, false])('uses Payload duplicate with minimal overrides (drafts: %s)', async (drafts) => {
    const { req, handler, duplicate, create, findByID } = fixture(drafts)
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(create).not.toHaveBeenCalled()
    // The original is read from the version Payload duplicates.
    expect(findByID).toHaveBeenNthCalledWith(1, {
      collection: 'pages', id: 'original', req, overrideAccess: false,
      ...(drafts ? { draft: true } : {}),
    })
    expect(duplicate).toHaveBeenCalledExactlyOnceWith({
      collection: 'pages', id: 'original', req, overrideAccess: false,
      ...(drafts ? { draft: true } : {}),
      data: { title: 'Welcome (copy 2)', pageSegment: 'legacy-segment-2', slugHistory: [] },
    })
    const data = duplicate.mock.calls[0][0].data
    expectNoIds(data)
    expect(data).not.toHaveProperty('layout')
    expect(data).not.toHaveProperty('_status')
    await expect(res.json()).resolves.toEqual({
      success: true, id: 'copy', title: 'Welcome (copy 2)', pageSegment: 'legacy-segment-2',
    })
  })

  it.each([
    [{ pageSegment: 'explicit', slug: 'path/legacy' }, 'explicit-2'],
    [{ slug: 'path/from-slug' }, 'from-slug'],
    [{ pageSegment: '', slug: '' }, 'welcome'],
    [{ title: '', slug: '' }, 'untitled'],
  ])('chooses the base segment from segment, slug, title, then fallback: %s', async (overrides, expected) => {
    const { req, handler, duplicate } = fixture(false, overrides)
    expect((await handler(req)).status).toBe(200)
    expect(duplicate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pageSegment: expected }),
    }))
  })

  it.each([undefined, 'http://localhost/api/page-tree/duplicate',
    'http://localhost/api/page-tree/duplicate?id=original',
    'http://localhost/api/page-tree/duplicate?collection=pages'])('returns 400 for missing params: %s', async (url) => {
    const { req, handler, duplicate, create, findByID } = fixture(false)
    req.url = url
    expect((await handler(req)).status).toBe(400)
    expect(findByID).not.toHaveBeenCalled()
    expect(duplicate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('passes the plugin callback to create and duplicate slug availability checks', async () => {
    const buildSlug = vi.fn(({ pageSegment }) => `custom/${pageSegment}`)
    const config = pageTreePlugin({ collections: ['pages'], buildSlug })({
      collections: [{ slug: 'pages', fields: [] }],
    } as unknown as Config)
    for (const path of ['/page-tree/create', '/page-tree/duplicate']) {
      const { req, find, create, duplicate } = fixture(false)
      req.user = { id: 'user' } as PayloadRequest['user']
      req.json = async () => ({ type: 'page', name: 'Welcome' })
      find.mockImplementation(async ({ where }) => {
        const docs = where.slug && ['custom/welcome', 'custom/legacy-segment'].includes(where.slug.equals)
          ? [{ id: 'legacy' }] : []
        return { docs, totalDocs: docs.length }
      })
      const endpoint = config.endpoints!.find((endpoint) => endpoint.path === path)!
      expect((await endpoint.handler(req)).status).toBe(200)
      const mutation = path.endsWith('duplicate') ? duplicate : create
      expect(mutation).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          pageSegment: path.endsWith('duplicate') ? 'legacy-segment-2' : 'welcome-2',
        }),
      }))
    }
    expect(buildSlug).toHaveBeenCalled()
  })
})
