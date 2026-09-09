import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'
import { defaultPageTreeAccess, withPageTreeAccess } from '../../src/endpoints/access.js'

const ok = () => Response.json({ success: true })

function reqWith(user: unknown): PayloadRequest {
  return { user } as unknown as PayloadRequest
}

describe('defaultPageTreeAccess', () => {
  it('denies anonymous requests', () => {
    expect(defaultPageTreeAccess({ req: reqWith(null) })).toBe(false)
    expect(defaultPageTreeAccess({ req: reqWith(undefined) })).toBe(false)
  })

  it('allows any authenticated user', () => {
    expect(defaultPageTreeAccess({ req: reqWith({ id: 1, role: 'user' }) })).toBe(true)
  })
})

describe('withPageTreeAccess', () => {
  it('returns 401 for anonymous requests by default and never calls the handler', async () => {
    const handler = vi.fn(ok)
    const res = await withPageTreeAccess(handler)(reqWith(null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('calls the handler for authenticated users by default', async () => {
    const handler = vi.fn(ok)
    const res = await withPageTreeAccess(handler)(reqWith({ id: 1 }))
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('returns 403 when a custom gate denies an authenticated user', async () => {
    const handler = vi.fn(ok)
    const adminOnly = ({ req }: { req: PayloadRequest }) =>
      (req.user as { role?: string } | null)?.role === 'admin'
    const guarded = withPageTreeAccess(handler, adminOnly)

    const denied = await guarded(reqWith({ id: 2, role: 'user' }))
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(handler).not.toHaveBeenCalled()

    const allowed = await guarded(reqWith({ id: 1, role: 'admin' }))
    expect(allowed.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('supports async gates', async () => {
    const handler = vi.fn(ok)
    const res = await withPageTreeAccess(handler, async () => true)(reqWith(null))
    expect(res.status).toBe(200)
  })

  it('fails closed when the gate throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = vi.fn(ok)
    const res = await withPageTreeAccess(handler, () => {
      throw new Error('boom')
    })(reqWith({ id: 1 }))
    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
