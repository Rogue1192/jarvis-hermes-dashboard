// Resolve a business category (e.g. "Fencing contractor") to a niches row ("Fencing").
// Exact (case-insensitive) name match first; otherwise the niche whose name or slug is contained
// in the category (or vice versa), longest match wins.
export async function findNiche(service: any, category: string | null | undefined, cols = '*'): Promise<any | null> {
  const cat = String(category || '').trim();
  if (!cat) return null;
  const { data: exact } = await service.from('niches').select(cols).ilike('name', cat).limit(1);
  if (exact && exact[0]) return exact[0];
  const { data: all } = await service.from('niches').select(cols === '*' ? '*' : `${cols}, name, slug`);
  const c = cat.toLowerCase();
  let best: any = null; let bestLen = 0;
  for (const n of all ?? []) {
    for (const key of [n.name, String(n.slug || '').replace(/-/g, ' ')]) {
      const k = String(key || '').toLowerCase().trim();
      if (k && (c.includes(k) || k.includes(c)) && k.length > bestLen) { best = n; bestLen = k.length; }
    }
  }
  return best;
}
export function matchNicheName(category: string | null | undefined, names: string[]): string | null {
  const c = String(category || '').toLowerCase().trim();
  if (!c) return null;
  const exact = names.find((n) => n.toLowerCase() === c);
  if (exact) return exact;
  let best: string | null = null;
  for (const n of names) { const k = n.toLowerCase(); if ((c.includes(k) || k.includes(c)) && k.length > (best?.length ?? 0)) best = n; }
  return best;
}
