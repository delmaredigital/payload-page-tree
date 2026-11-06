import { describe, expect, it, vi } from 'vitest'
import type { Payload, PayloadRequest } from 'payload'
import { findAvailableSegment } from '../../src/utils/segments.js'
import { createBuildSlugHook } from '../../src/hooks/buildSlugFromFolder.js'
import type { BuildSlugFn } from '../../src/types.js'

function fixture(docs: Record<string, unknown>[], trash = false) {
  const find = vi.fn(async ({ where }: { where: Record<string, any> }) => {
    const matches = where.slug
      ? docs.filter((doc) => doc.slug === where.slug.equals)
      : docs.filter((doc) => where.folder.equals
        ? doc.folder === where.folder.equals
        : !doc.folder)
    return { docs: matches, totalDocs: matches.length }
  })
  const findByID = vi.fn(async () => ({ id: 'folder', pathSegment: 'guides' }))
  const payload = { find, findByID, collections: { pages: { config: { trash } } } } as unknown as Payload
  const options = {
    payload, parentId: null as string | null, type: 'page' as const,
    collection: 'pages', collections: ['pages'], folderSlug: 'payload-folders',
    baseSegment: 'welcome',
  }
  return { payload, find, findByID, options }
}

describe('findAvailableSegment', () => {
  it('reserves the slug of a legacy sibling without a stored segment', async () => {
    const { options } = fixture([{ id: 'legacy', slug: 'welcome' }])
    await expect(findAvailableSegment(options)).resolves.toBe('welcome-2')
  })

  it('continues when -2 is taken by slug alone, even outside the sibling folder', async () => {
    const { options, find } = fixture([
      { id: 'legacy', slug: 'welcome' },
      { id: 'other', folder: 'elsewhere', slug: 'welcome-2' },
    ])
    await expect(findAvailableSegment(options)).resolves.toBe('welcome-3')
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: { equals: 'welcome-2' } }, overrideAccess: true,
    }))
  })

  it('checks the full folder path plus candidate segment', async () => {
    const { options, find } = fixture([{ folder: 'folder', slug: 'guides/welcome' }])
    await expect(findAvailableSegment({ ...options, parentId: 'folder' })).resolves.toBe('welcome-2')
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: { equals: 'guides/welcome' } },
    }))
  })

  it('honours the custom buildSlug callback with the candidate document and create operation', async () => {
    const { options } = fixture([{ slug: 'en/welcome' }])
    const buildSlug = vi.fn(({ pageSegment, doc }) => `${doc.language}/${pageSegment}`)
    await expect(findAvailableSegment({
      ...options, buildSlug, doc: { title: 'Welcome', language: 'en' },
    })).resolves.toBe('welcome-2')
    expect(buildSlug).toHaveBeenLastCalledWith({
      folderPath: '', pageSegment: 'welcome-2', operation: 'create',
      doc: { title: 'Welcome', language: 'en', pageSegment: 'welcome-2' },
    })
  })

  it.each(['empty', 'throw'] as const)('shares the hook fallback when the callback returns %s', async (mode) => {
    const { options, payload } = fixture([{ folder: 'folder', slug: 'guides/welcome' }])
    const buildSlug: BuildSlugFn = () => {
      if (mode === 'throw') throw new Error('callback failed')
      return ''
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const segment = await findAvailableSegment({ ...options, parentId: 'folder', buildSlug })
      expect(segment).toBe('welcome-2')
      const hook = createBuildSlugHook({
        folderSlug: options.folderSlug, segmentFieldName: 'pathSegment',
        pageSegmentFieldName: 'pageSegment', folderFieldName: 'folder', buildSlug,
      })
      const data = { folder: 'folder', pageSegment: segment }
      await expect(hook({ data, req: { payload } as PayloadRequest, operation: 'create' } as any))
        .resolves.toEqual({ ...data, slug: 'guides/welcome-2' })
    } finally {
      spy.mockRestore()
    }
  })

  it('counts inaccessible and trashed documents as slug owners', async () => {
    const { options, find } = fixture([{ slug: 'welcome', deletedAt: '2026-11-06' }], true)
    await expect(findAvailableSegment(options)).resolves.toBe('welcome-2')
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: { equals: 'welcome' } }, overrideAccess: true, trash: true,
    }))
  })

  it('continues to reserve sibling segments case-insensitively', async () => {
    const { options } = fixture([{ pageSegment: 'WELCOME' }])
    await expect(findAvailableSegment(options)).resolves.toBe('welcome-2')
  })

  it('keeps folder availability based only on sibling path segments', async () => {
    const { options, find, findByID } = fixture([{ pathSegment: 'welcome', slug: 'welcome-2' }])
    const buildSlug = vi.fn(() => 'unused')
    await expect(findAvailableSegment({ ...options, type: 'folder', buildSlug })).resolves.toBe('welcome-2')
    expect(find).toHaveBeenCalledOnce()
    expect(findByID).not.toHaveBeenCalled()
    expect(buildSlug).not.toHaveBeenCalled()
  })

  it('keeps the 1000-attempt cap when every slug is taken', async () => {
    const { options, find } = fixture([])
    find.mockResolvedValue({ docs: [{ id: 'taken' }], totalDocs: 1 })
    await expect(findAvailableSegment(options)).rejects.toThrow('after 1000 attempts')
    expect(find).toHaveBeenCalledTimes(1001) // One sibling query, then 1000 slug probes.
  })
})
