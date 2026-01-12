import type { Payload, CollectionSlug } from 'payload'
import type { SlugHistoryEntry } from '../types.js'

interface RedirectEntry {
  from: string
  to: string
}

/**
 * Generate a redirect map from slugHistory entries across all pages in a collection
 *
 * @param payload - The Payload instance
 * @param collection - Collection slug to get redirects for (e.g., 'pages')
 * @returns Array of redirect entries mapping old URLs to new URLs
 *
 * @example
 * ```typescript
 * import { getRedirectMap } from '@delmaredigital/payload-page-tree'
 *
 * const redirects = await getRedirectMap(payload, 'pages')
 * // Returns: [{ from: '/old-url', to: '/new-url' }, ...]
 *
 * // Use in Next.js middleware:
 * const redirect = redirects.find(r => r.from === pathname)
 * if (redirect) {
 *   return NextResponse.redirect(new URL(redirect.to, request.url), 301)
 * }
 * ```
 */
export async function getRedirectMap(
  payload: Payload,
  collection: string,
): Promise<RedirectEntry[]> {
  // Find all pages with slug history
  const { docs: pages } = await payload.find({
    collection: collection as CollectionSlug,
    where: {
      slugHistory: { exists: true },
    },
    limit: 0,
    depth: 0,
  })

  // Build redirect map from slugHistory
  const redirects: RedirectEntry[] = []

  for (const page of pages) {
    const pageDoc = page as unknown as { slug: string; slugHistory?: SlugHistoryEntry[] }
    if (pageDoc.slug && pageDoc.slugHistory?.length) {
      for (const entry of pageDoc.slugHistory) {
        // Only add if the old slug is different from current
        if (entry.slug && entry.slug !== pageDoc.slug) {
          // Add leading slash for URL format
          const from = entry.slug.startsWith('/') ? entry.slug : `/${entry.slug}`
          const to = pageDoc.slug.startsWith('/') ? pageDoc.slug : `/${pageDoc.slug}`
          redirects.push({ from, to })
        }
      }
    }
  }

  return redirects
}

export default getRedirectMap
