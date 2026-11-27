// Small pure helpers for batch mode (kept DOM-free so node can test them).

/**
 * Return `name` unchanged if it is not in `used` (a Set), otherwise append
 * " (2)", " (3)", … before the extension until unique. The chosen name is
 * added to `used`.
 *   uniqueZipName('a-converted.txt', used) -> 'a-converted.txt'
 *   uniqueZipName('a-converted.txt', used) -> 'a-converted (2).txt'
 */
export function uniqueZipName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const m = name.match(/^(.*?)(\.[a-z0-9]+)$/i);
  const base = m ? m[1] : name;
  const ext = m ? m[2] : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}
