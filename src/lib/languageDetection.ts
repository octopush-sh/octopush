import { getExtension } from './getExtension';

// Extension table 2 of 3 — see getExtension.ts for the cross-reference
// (fileIcons.ts and editorLang.ts hold the other two).
export function detectLanguageFromName(filename: string): string {
  const extension = getExtension(filename);

  // Map of extensions to language identifiers
  const extensionMap: Record<string, string> = {
    // Web
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    xml: 'xml',

    // Server-side
    py: 'python',
    rb: 'ruby',
    php: 'php',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',

    // Database & markup
    sql: 'sql',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',

    // Shell
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
  };

  return extensionMap[extension] || 'plaintext';
}
