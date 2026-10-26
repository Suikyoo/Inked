/**
 * A small ZIP reader for tests: walks the EOCD and central directory, checks each entry against its
 * local header, and returns the decompressed bytes. It is deliberately independent of the exporter
 * (apart from the format itself) so a round-trip proves more than "the writer agrees with itself".
 */
export interface ReadZipEntry {
  path: string;
  data: Uint8Array;
  method: number;
  flags: number;
  crc: number;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new Error('readZip: DecompressionStream is unavailable');
  const body = new Blob([data.slice().buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export async function readZip(bytes: Uint8Array): Promise<ReadZipEntry[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error('readZip: end of central directory not found');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries: ReadZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('readZip: bad central directory signature');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compressed = dv.getUint32(p + 20, true);
    const uncompressed = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));

    if (dv.getUint32(offset, true) !== 0x04034b50) throw new Error(`readZip: bad local header for ${path}`);
    const localFlags = dv.getUint16(offset + 6, true);
    const localMethod = dv.getUint16(offset + 8, true);
    const localCrc = dv.getUint32(offset + 14, true);
    const localCompressed = dv.getUint32(offset + 18, true);
    const localUncompressed = dv.getUint32(offset + 22, true);
    const localNameLength = dv.getUint16(offset + 26, true);
    const localExtraLength = dv.getUint16(offset + 28, true);
    const localPath = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + localNameLength));
    if (
      localPath !== path ||
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== crc ||
      localCompressed !== compressed ||
      localUncompressed !== uncompressed
    ) {
      throw new Error(`readZip: local header disagrees with the central directory for ${path}`);
    }

    const start = offset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressed);
    entries.push({ path, data: method === 8 ? await inflateRaw(raw) : raw.slice(), method, flags, crc });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
