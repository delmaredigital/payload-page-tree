import type { PayloadHandler, PayloadRequest } from 'payload'
import type { PageTreeAccess } from '../types.js'

/**
 * Default endpoint gate: any authenticated Payload user.
 *
 * Document reads for user operations and user writes enforce collection access
 * rules. Slug maintenance, URL availability, and impact summaries use trusted
 * access in the same request. This gate decides who may reach the endpoints.
 */
export const defaultPageTreeAccess: PageTreeAccess = ({ req }) => Boolean(req.user)

/**
 * Wrap a tree endpoint handler with the plugin's access gate.
 *
 * - Denied without a user  → 401 `{ error: 'Unauthorized' }`
 * - Denied with a user     → 403 `{ error: 'Forbidden' }`
 * - Gate throws            → 403 (fail closed)
 */
export function withPageTreeAccess(
  handler: PayloadHandler,
  access: PageTreeAccess = defaultPageTreeAccess,
): PayloadHandler {
  return async (req: PayloadRequest) => {
    let allowed = false
    try {
      allowed = await access({ req })
    } catch (error) {
      console.error('[payload-page-tree] Access check threw; denying request:', error)
      allowed = false
    }

    if (!allowed) {
      return req.user
        ? Response.json({ error: 'Forbidden' }, { status: 403 })
        : Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return handler(req)
  }
}
