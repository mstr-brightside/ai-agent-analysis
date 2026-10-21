// Normalized tool targets: what a repeated attempt is "the same" as. Paths inside the
// project become project-relative, so full paths (which leak user and client names) do
// not reach reports; paths outside it keep only their last segment.

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimSlashes(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

export function relativePath(filePath: string, projectPath: string | null): string {
  const file = filePath.replaceAll('\\', '/');
  if (projectPath !== null) {
    const root = trimSlashes(projectPath.replaceAll('\\', '/'));
    if (file === root) return '.';
    if (file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  }
  if (!file.startsWith('/') && !/^[a-z]:\//i.test(file)) return file;
  const last = file.split('/').filter((s) => s !== '').at(-1);
  return last === undefined ? file : `…/${last}`;
}

/** Command text with whitespace collapsed and the project path written as `.`. */
export function normalizeCommand(command: string, projectPath: string | null): string {
  const collapsed = collapseWhitespace(command);
  if (projectPath === null || projectPath === '') return collapsed;
  return collapsed.replaceAll(trimSlashes(projectPath), '.');
}
