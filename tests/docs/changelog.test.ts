import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
it('lists released versions in descending order without exceeding the package version', () => {
  const versions = [...changelog.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)].map(m => m.slice(1).map(Number))
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const numbers = [pkg.version.split('.').map(Number), ...versions].map(v => v[0] * 1000000 + v[1] * 1000 + v[2])
  expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
})

it('attributes the misnumbered March entries to their actual releases', () => {
  expect(changelog).toMatch(/## \[0\.3\.11\] - 2026-03-18[\s\S]*?Folder rename now updates pathSegment/)
  expect(changelog).toMatch(/## \[0\.3\.10\] - 2026-03-03[\s\S]*?\*\*`buildSlug` callback\*\*/)
})
