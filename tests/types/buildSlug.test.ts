import { expect, it } from 'vitest'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

it('declares BuildSlugArgs.folderPath as string, matching root and nested callback values', () => {
  const path = fileURLToPath(new URL('../../src/types.ts', import.meta.url))
  const program = ts.createProgram([path], { strictNullChecks: true, noResolve: true, noLib: true })
  const source = program.getSourceFile(path)!
  const declaration = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'BuildSlugArgs') as ts.InterfaceDeclaration
  const field = declaration.members.find(node => node.name?.getText(source) === 'folderPath')!
  const checker = program.getTypeChecker()
  expect(checker.typeToString(checker.getTypeAtLocation(field))).toBe('string')
})
