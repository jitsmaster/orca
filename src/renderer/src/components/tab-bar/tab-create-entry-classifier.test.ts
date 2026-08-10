import { describe, expect, it } from 'vitest'
import { QUICK_OPEN_QUERY_MAX_BYTES } from '../quick-open-search'
import {
  classifyTabEntryQuery,
  getTabEntryOptions,
  TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE,
  validateNewTabEntryAbsolutePath,
  validateNewTabEntryRelativePath
} from './tab-create-entry-action'

const readyFiles = (files: string[]) => ({ files, loading: false, loadError: null })

describe('tab create entry classification', () => {
  // Kept word-for-word in step with the omnibox placeholder (see
  // TabBarCreateEntry.keyboard.test.tsx), so the two never drift apart.
  it('advertises tab search in the empty-query message', () => {
    expect(classifyTabEntryQuery('', readyFiles([]))).toEqual({
      kind: 'empty',
      message: 'Search open tabs, files, URLs, agents…'
    })
  })

  it('accepts explicit http and https URLs only', () => {
    expect(classifyTabEntryQuery(' https://example.com/docs ', readyFiles([]))).toMatchObject({
      kind: 'explicit-url',
      url: 'https://example.com/docs'
    })
    expect(classifyTabEntryQuery('http://localhost:3000', readyFiles([]))).toMatchObject({
      kind: 'explicit-url',
      url: 'http://localhost:3000/'
    })
    expect(classifyTabEntryQuery('ftp://example.com', readyFiles([]))).toMatchObject({
      kind: 'blocked'
    })
  })

  it('lets existing listed files win over bare host-like URLs', () => {
    expect(classifyTabEntryQuery('example.com', readyFiles(['example.com']))).toEqual({
      kind: 'existing-file',
      matchKind: 'exact-path',
      relativePath: 'example.com'
    })
    expect(classifyTabEntryQuery('example.com', readyFiles([]))).toMatchObject({
      kind: 'host-url',
      url: 'https://example.com/'
    })
  })

  it('opens local-dev URLs with root suffixes as browser tabs', () => {
    expect(classifyTabEntryQuery('localhost:3000/', readyFiles([]))).toEqual({
      kind: 'host-url',
      url: 'http://localhost:3000/'
    })
    expect(classifyTabEntryQuery('localhost:3000?debug=1', readyFiles([]))).toEqual({
      kind: 'host-url',
      url: 'http://localhost:3000/?debug=1'
    })
    expect(classifyTabEntryQuery('localhost:3000#preview', readyFiles([]))).toEqual({
      kind: 'host-url',
      url: 'http://localhost:3000/#preview'
    })
  })

  it('keeps the shared legacy local-dev forms in parity with address-bar normalization', () => {
    for (const input of ['0.0.0.0:3000', '[::1]:3000', '[2001:db8::1]:3000/path']) {
      expect(classifyTabEntryQuery(input, readyFiles([]))).toMatchObject({
        kind: 'host-url',
        url: expect.stringMatching(/^http:/)
      })
    }
  })

  it('does not classify invalid numeric hosts as URLs', () => {
    expect(classifyTabEntryQuery('999.999.999.999', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: '999.999.999.999'
    })
  })

  it('keeps common source/document filenames as file candidates', () => {
    expect(classifyTabEntryQuery('README.md', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: 'README.md'
    })
    expect(classifyTabEntryQuery('src/foo.test.ts', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: 'src/foo.test.ts'
    })
    expect(classifyTabEntryQuery('docs/readme.md', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: 'docs/readme.md'
    })
  })

  it('keeps safe URL actions available while the file list is not ready', () => {
    expect(
      classifyTabEntryQuery('example.com', { files: [], loading: true, loadError: null })
    ).toMatchObject({ kind: 'host-url', url: 'https://example.com/' })
    expect(
      classifyTabEntryQuery('https://example.com', { files: [], loading: true, loadError: null })
    ).toMatchObject({ kind: 'explicit-url' })
    expect(
      classifyTabEntryQuery('example.com', {
        files: [],
        loading: false,
        loadError: 'scan failed'
      })
    ).toMatchObject({ kind: 'host-url', url: 'https://example.com/' })
  })

  it('matches exact relative path before basename and fuzzy results', () => {
    const files = readyFiles(['src/index.ts', 'docs/index.ts', 'src/components/Button.tsx'])
    expect(classifyTabEntryQuery('docs/index.ts', files)).toEqual({
      kind: 'existing-file',
      matchKind: 'exact-path',
      relativePath: 'docs/index.ts'
    })
    expect(classifyTabEntryQuery('Button.tsx', files)).toEqual({
      kind: 'existing-file',
      matchKind: 'exact-basename',
      relativePath: 'src/components/Button.tsx'
    })
    expect(classifyTabEntryQuery('btn', files)).toEqual({
      kind: 'search',
      engine: 'google',
      query: 'btn'
    })
  })

  it('returns duplicate basename matches as separate open-file options', () => {
    expect(
      getTabEntryOptions('index.ts', readyFiles(['src/index.ts', 'docs/index.ts'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'existing-file', matchKind: 'exact-basename', relativePath: 'src/index.ts' },
      { kind: 'existing-file', matchKind: 'exact-basename', relativePath: 'docs/index.ts' },
      { kind: 'search', engine: 'google', query: 'index.ts' }
    ])
  })

  it('prefers creating typed file paths over fuzzy matches', () => {
    expect(
      getTabEntryOptions('read.md', readyFiles(['README.md'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'new-file', relativePath: 'read.md' },
      { kind: 'search', engine: 'google', query: 'read.md' },
      { kind: 'existing-file', matchKind: 'fuzzy', relativePath: 'README.md' }
    ])
  })

  it('ranks search before fuzzy files and ordinary create-file actions', () => {
    expect(
      getTabEntryOptions('typescript', readyFiles(['docs/typescript-guide.md'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'search', engine: 'google', query: 'typescript' },
      {
        kind: 'existing-file',
        matchKind: 'fuzzy',
        relativePath: 'docs/typescript-guide.md'
      },
      { kind: 'new-file', relativePath: 'typescript' }
    ])
  })

  it('keeps strong file syntax ahead of search without treating dotted phrases as files', () => {
    expect(
      getTabEntryOptions('README.md', readyFiles(['docs/README-old.md'])).map(
        (option) => option.classification.kind
      )
    ).toEqual(['new-file', 'search', 'existing-file'])
    for (const query of ['node.js tutorial', 'package.json docs', 'what is foo.bar']) {
      expect(classifyTabEntryQuery(query, readyFiles([]))).toMatchObject({
        kind: 'search',
        query
      })
    }
    for (const query of ['.env', '.gitignore']) {
      expect(
        getTabEntryOptions(query, readyFiles([])).map((option) => option.classification.kind)
      ).toEqual(['new-file', 'search'])
    }
  })

  it('searches natural-language colons while blocking explicit unsupported schemes', () => {
    for (const query of ['error: cannot connect', 'node:fs docs', 'site:github.com react']) {
      expect(classifyTabEntryQuery(query, readyFiles([]))).toMatchObject({ kind: 'search', query })
    }
    for (const query of ['ftp:example.com', 'ftp://example.com', 'custom:// bad input']) {
      expect(classifyTabEntryQuery(query, readyFiles([]))).toMatchObject({ kind: 'blocked' })
    }
    expect(classifyTabEntryQuery('foo.ts:123', readyFiles([]))).toMatchObject({
      kind: 'new-file',
      relativePath: 'foo.ts:123'
    })
  })

  it('blocks malformed explicit and host-like URLs unless an exact file exists', () => {
    for (const query of ['https://', 'example.com:', 'example.com:nope', 'example.com:99999']) {
      expect(classifyTabEntryQuery(query, readyFiles([]))).toMatchObject({ kind: 'blocked' })
    }
    expect(classifyTabEntryQuery('example.com:99999', readyFiles(['example.com:99999']))).toEqual({
      kind: 'existing-file',
      matchKind: 'exact-path',
      relativePath: 'example.com:99999'
    })
  })

  it('offers network actions alongside file-index status only when safe', () => {
    const loading = { files: [], loading: true, loadError: null }
    expect(
      getTabEntryOptions('natural language', loading).map((option) => option.classification.kind)
    ).toEqual(['search', 'blocked'])
    expect(
      getTabEntryOptions('example.com', loading).map((option) => option.classification.kind)
    ).toEqual(['host-url', 'blocked'])
    expect(
      getTabEntryOptions('README.md', loading).map((option) => option.classification.kind)
    ).toEqual(['blocked'])
    expect(
      getTabEntryOptions('example.com:99999', loading).map((option) => option.classification.kind)
    ).toEqual(['blocked'])
  })

  it('never turns invalid paths into search actions', () => {
    for (const query of ['../.env', 'foo//bar', 'foo/', 'C:relative.txt', 'src/\u0000file.ts']) {
      expect(classifyTabEntryQuery(query, readyFiles([])), query).toMatchObject({ kind: 'blocked' })
      expect(
        classifyTabEntryQuery(query, { files: [], loading: true, loadError: null }),
        query
      ).toMatchObject({ kind: 'blocked' })
    }
  })

  it('applies the action limit once and leaves index status outside it', () => {
    expect(getTabEntryOptions('query', readyFiles([]), 0)).toEqual([])
    expect(
      getTabEntryOptions('query', { files: [], loading: true, loadError: null }, 0).map(
        (option) => option.id
      )
    ).toEqual(['loading'])
    expect(
      getTabEntryOptions('query', readyFiles(['query.md']), 1).map(
        (option) => option.classification.kind
      )
    ).toEqual(['search'])
  })

  it('forces search before URL, path, and file classification', () => {
    for (const [input, expectedQuery] of [
      ['?react hooks', 'react hooks'],
      ['??foo', '?foo'],
      ['?https://example.com', 'https://example.com'],
      ['?/tmp/file.ts', '/tmp/file.ts']
    ]) {
      expect(classifyTabEntryQuery(input, readyFiles(['/tmp/file.ts']))).toEqual({
        kind: 'search',
        engine: 'google',
        query: expectedQuery
      })
    }
    expect(classifyTabEntryQuery('?', readyFiles([]))).toMatchObject({ kind: 'empty' })
  })

  it('retains the configured engine without building a URL', () => {
    expect(classifyTabEntryQuery('search me', readyFiles([]), { searchEngine: 'kagi' })).toEqual({
      kind: 'search',
      engine: 'kagi',
      query: 'search me'
    })
  })

  it('blocks oversized pasted file-entry queries before reading listed files', () => {
    const oversizedQuery = `src/${'secret-tab-create'.repeat(QUICK_OPEN_QUERY_MAX_BYTES)}.ts`
    const fileList = {
      get files(): string[] {
        throw new Error('oversized queries must not read file lists')
      },
      loading: false,
      loadError: null
    }

    expect(classifyTabEntryQuery(oversizedQuery, fileList)).toEqual({
      kind: 'blocked',
      message: 'Search text is too large.'
    })
  })

  it('blocks oversized whitespace before trimming file-entry queries', () => {
    const fileList = {
      get files(): string[] {
        throw new Error('oversized whitespace queries must not read file lists')
      },
      loading: false,
      loadError: null
    }

    expect(classifyTabEntryQuery(' '.repeat(QUICK_OPEN_QUERY_MAX_BYTES + 1), fileList)).toEqual({
      kind: 'blocked',
      message: 'Search text is too large.'
    })
  })

  it('offers both exact file and URL actions for host-like filenames', () => {
    expect(
      getTabEntryOptions('example.com', readyFiles(['example.com'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'existing-file', matchKind: 'exact-path', relativePath: 'example.com' },
      { kind: 'host-url', url: 'https://example.com/' }
    ])
  })

  it('classifies POSIX absolute paths only for POSIX clients', () => {
    expect(
      classifyTabEntryQuery('/tmp/notes.md', readyFiles([]), {
        allowAbsolutePaths: true,
        localPlatform: 'posix'
      })
    ).toEqual({ kind: 'absolute-file', filePath: '/tmp/notes.md' })
    expect(
      classifyTabEntryQuery('C:\\tmp\\notes.md', readyFiles([]), {
        allowAbsolutePaths: true,
        localPlatform: 'posix'
      })
    ).toMatchObject({ kind: 'blocked', message: 'Enter an absolute path for this computer.' })
  })

  it('classifies drive and UNC paths only for Windows clients', () => {
    for (const [query, filePath] of [
      ['C:\\tmp\\notes.md', 'C:/tmp/notes.md'],
      ['C:/tmp/notes.md', 'C:/tmp/notes.md'],
      ['\\\\server\\share\\notes.md', '//server/share/notes.md'],
      ['//server/share/notes.md', '//server/share/notes.md']
    ]) {
      expect(
        classifyTabEntryQuery(query, readyFiles([]), {
          allowAbsolutePaths: true,
          localPlatform: 'windows'
        })
      ).toEqual({
        kind: 'absolute-file',
        filePath
      })
    }
    expect(
      classifyTabEntryQuery('/tmp/notes.md', readyFiles([]), {
        allowAbsolutePaths: true,
        localPlatform: 'windows'
      })
    ).toMatchObject({ kind: 'blocked', message: 'Enter an absolute path for this computer.' })
  })

  it('blocks absolute paths for remote workspaces', () => {
    for (const query of [
      '/tmp/notes.md',
      'C:\\tmp\\notes.md',
      'C:/tmp/notes.md',
      '\\\\server\\share\\notes.md',
      '//server/share/notes.md'
    ]) {
      expect(classifyTabEntryQuery(query, readyFiles([]))).toMatchObject({
        kind: 'blocked',
        message: TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE
      })
    }
  })
})

describe('tab create entry path validation', () => {
  it('rejects unsafe or non-relative paths', () => {
    for (const path of [
      '',
      '/tmp/file.ts',
      'C:/tmp/file.ts',
      'C:tmp/file.ts',
      '\\\\server\\share\\file.ts',
      '~',
      '~/file.ts',
      'src/',
      'src//file.ts',
      'src/../file.ts',
      'src\\.\\file.ts',
      'src\\..\\file.ts',
      'src/\u0000file.ts'
    ]) {
      expect(() => validateNewTabEntryRelativePath(path), path).toThrow()
    }
  })

  it('allows spaces and normalizes Windows separators after absolute checks', () => {
    expect(validateNewTabEntryRelativePath(' docs/My Note.md ')).toBe('docs/My Note.md')
    expect(validateNewTabEntryRelativePath('src\\new-file.ts')).toBe('src/new-file.ts')
  })

  it('normalizes absolute paths for local open', () => {
    expect(validateNewTabEntryAbsolutePath('/tmp/notes.md', 'posix')).toBe('/tmp/notes.md')
    expect(validateNewTabEntryAbsolutePath('C:\\tmp\\notes.md', 'windows')).toBe('C:/tmp/notes.md')
    expect(validateNewTabEntryAbsolutePath('\\\\server\\share\\notes.md', 'windows')).toBe(
      '//server/share/notes.md'
    )
    expect(validateNewTabEntryAbsolutePath('/repo/../repo/src/file.ts', 'posix')).toBe(
      '/repo/src/file.ts'
    )
  })

  it('rejects path families that are not native to the client', () => {
    expect(() => validateNewTabEntryAbsolutePath('C:\\tmp\\notes.md', 'posix')).toThrow(
      'this computer'
    )
    expect(() => validateNewTabEntryAbsolutePath('\\\\server\\share\\notes.md', 'posix')).toThrow(
      'this computer'
    )
    expect(() => validateNewTabEntryAbsolutePath('/tmp/notes.md', 'windows')).toThrow(
      'this computer'
    )
  })

  it('rejects invalid absolute paths', () => {
    for (const path of ['', '~/file.ts', 'src/file.ts', 'C:tmp/file.ts', '/tmp/']) {
      expect(() => validateNewTabEntryAbsolutePath(path), path).toThrow()
    }
  })
})
