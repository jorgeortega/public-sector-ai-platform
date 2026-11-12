// The city codes, split into chunks: one per section (`## PAC 5.12.010 Title`),
// and a long section split again at its paragraphs. Each chunk keeps its
// city, so search can filter by city before it ranks (spec R3).

export type Tenant = 'port-alder' | 'kestrel-bay';
export type Chunk = { id: string; tenant: Tenant; section: string; title: string; text: string };

// A chunk id must fit the site's event schema for a cited section.
export const SECTION_ID = /^[a-z0-9][a-z0-9.-]{0,39}$/;
export const MAX_CHARS = 1600;

const HEADING = /^## (PAC|KBC) (note \d+|\d+\.\d+\.\d+) (.+)$/;

export function parseHeading(line: string): { id: string; section: string; title: string } | null {
  const match = HEADING.exec(line.trim());
  if (!match) return null;
  const [, code = '', number = '', title = ''] = match;
  const id = `${code.toLowerCase()}-${number.replace(' ', '-')}`;
  return { id, section: `${code} ${number}`, title: title.trim() };
}

export const tenantOf = (file: string): Tenant => (file.startsWith('port-alder') ? 'port-alder' : 'kestrel-bay');

// Splits a body at blank lines into parts of at most MAX_CHARS.
function split(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const paragraph of body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (current && current.length + paragraph.length + 2 > MAX_CHARS) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function chunkCode(markdown: string, tenant: Tenant): Chunk[] {
  const chunks: Chunk[] = [];
  let heading: ReturnType<typeof parseHeading> = null;
  let body: string[] = [];
  const flush = () => {
    if (!heading) return;
    const parts = split(body.join('\n'));
    parts.forEach((text, i) => {
      chunks.push({ id: i ? `${heading!.id}-${i + 1}` : heading!.id, tenant, section: heading!.section, title: heading!.title, text });
    });
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      flush();
      heading = parseHeading(line);
      if (!heading) throw new Error(`Not a code section heading: ${line}`);
      body = [];
    } else if (heading) {
      body.push(line);
    }
  }
  flush();
  return chunks;
}

// The text that's embedded and searched: the heading carries the section
// number and title, which both kinds of search should see.
export const searchText = (chunk: Chunk) => `${chunk.section} ${chunk.title}\n\n${chunk.text}`;
