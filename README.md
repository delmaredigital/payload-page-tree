# @delmaredigital/payload-page-tree

A Payload CMS plugin that extends the built-in folders feature to auto-generate hierarchical URL slugs. Folders define URL structure, pages pick a folder, and slugs are auto-generated.

<p align="center">
  <a href="https://demo.delmaredigital.com"><img src="https://img.shields.io/badge/Live_Demo-Try_It_Now-2ea44f?style=for-the-badge&logo=vercel&logoColor=white" alt="Live Demo - Try It Now"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/delmaredigital/dd-starter"><img src="https://img.shields.io/badge/Starter_Template-Use_This-blue?style=for-the-badge&logo=github&logoColor=white" alt="Starter Template - Use This"></a>
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdelmaredigital%2Fdd-starter&project-name=my-payload-site&build-command=pnpm%20run%20ci&env=PAYLOAD_SECRET,BETTER_AUTH_SECRET&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D"><img src="https://vercel.com/button" alt="Deploy with Vercel" height="32"></a>
</p>

## Documentation

**[Full documentation &rarr;](https://delmaredigital.github.io/payload-page-tree/)**

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/delmaredigital/payload-page-tree)

## Installation

```bash
pnpm add @delmaredigital/payload-page-tree
```

## Quick Start

### 1. Add the plugin

```typescript
// src/payload.config.ts
import { buildConfig } from 'payload'
import { pageTreePlugin } from '@delmaredigital/payload-page-tree'
import { Pages } from './collections/Pages'

export default buildConfig({
  collections: [Pages],
  plugins: [
    pageTreePlugin(),  // Auto-detects 'pages' and 'posts' if they exist
  ],
})
```

### 2. Define your collection

Your collections **must** have a `slug` field. The plugin makes it read-only and auto-generates values from folder path + page segment.

```typescript
// src/collections/Pages/index.ts
import type { CollectionConfig } from 'payload'

export const Pages: CollectionConfig = {
  slug: 'pages',
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
  ],
}
```

> **Important:** Do NOT use Payload's `slugField()` helper. Use a plain text field &mdash; the plugin manages slugs via its own hooks.

### 3. Frontend routing

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

That's it! The plugin adds `folder`, `pageSegment`, `sortOrder`, and `slugHistory` fields automatically, and registers the tree view at `/admin/page-tree`.

---

For configuration options, tree view features, URL history, organization scoping, extensibility, and more, see the **[full documentation](https://delmaredigital.github.io/payload-page-tree/)**.

## License

MIT
