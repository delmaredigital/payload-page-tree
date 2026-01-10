# @delmaredigital/payload-page-tree

A Payload CMS plugin that extends the built-in folders feature to auto-generate hierarchical URL slugs. Folders define URL structure, pages pick a folder, and slugs are auto-generated.

## Features

- Uses Payload's native folders feature - get the nice folder UI for free
- Auto-generates hierarchical slugs from folder paths (e.g., `/appeals/2024/spring-campaign`)
- Cascades URL updates when folders are renamed or moved
- No "dummy pages" needed - folders are purely organizational
- Works alongside other plugins (Puck, SEO, etc.)

## Installation

```bash
pnpm add @delmaredigital/payload-page-tree
```

## Usage

```typescript
import { buildConfig } from 'payload'
import { pageTreePlugin } from '@delmaredigital/payload-page-tree'

export default buildConfig({
  collections: [
    {
      slug: 'pages',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', required: true, unique: true },
        // ... other fields
      ],
    },
  ],
  plugins: [
    pageTreePlugin({
      collections: ['pages'],
    }),
  ],
})
```

## How It Works

1. **Create folders** in the Payload admin with a `pathSegment` (e.g., "appeals", "2024")
2. **Nest folders** to create hierarchy (e.g., "2024" under "appeals")
3. **Create a page** and select a folder from the dropdown
4. **Slug auto-generates** from folder path + page segment (e.g., `appeals/2024/spring-campaign`)

### Example

```
Folders:
├── appeals (pathSegment: "appeals")
│   ├── 2024 (pathSegment: "2024")
│   └── 2025 (pathSegment: "2025")
└── services (pathSegment: "services")

Page in "2024" folder with pageSegment "spring-campaign":
→ slug: appeals/2024/spring-campaign
→ URL: /appeals/2024/spring-campaign
```

## Configuration Options

```typescript
pageTreePlugin({
  // Required: Collections to add folder-based slugs to
  collections: ['pages'],

  // Optional: Custom folder collection slug (default: 'payload-folders')
  folderSlug: 'payload-folders',

  // Optional: Field name for folder path segment (default: 'pathSegment')
  segmentFieldName: 'pathSegment',

  // Optional: Field name for page segment (default: 'pageSegment')
  pageSegmentFieldName: 'pageSegment',

  // Optional: Disable plugin while preserving schema (default: false)
  disabled: false,
})
```

## Frontend Routing

Your catch-all route should query by the full slug:

```typescript
// app/[...slug]/page.tsx
export default async function Page({ params }: { params: { slug: string[] } }) {
  const fullSlug = params.slug.join('/')

  const { docs } = await payload.find({
    collection: 'pages',
    where: { slug: { equals: fullSlug } },
    limit: 1,
  })

  // ...
}
```

## Cascading Updates

When you rename a folder's `pathSegment` or move it to a different parent, all pages in that folder (and subfolders) automatically have their slugs updated.

## License

MIT
