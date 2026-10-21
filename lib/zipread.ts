/**
 * Reads a .zip in the browser one file at a time (random access with File.slice), so a zip with 800+ photos
 * never has to be loaded into memory at once. Handles stored + deflated entries and ZIP64.
 */
import { inflateSync } from "fflate";

export type ZipEntry = { name: string; method: number; compSize: number; size: number; offset: number; encrypted: boolean };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const bytes = async (f: Blob, start: number, end: number) => new Uint8Array(await f.slice(start, end).arrayBuffer());

export async function listZip(file: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(file.size, 65557);
  const tail = await bytes(file, file.size - tailLen, file.size);
  let p = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error("This isn't a .zip file (or it's damaged).");
  let count = u16(tail, p + 10), cdSize = u32(tail, p + 12), cdOff = u32(tail, p + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    // ZIP64: the locator sits just before the normal end record
    const locAt = file.size - tailLen + p - 20;
    const loc = await bytes(file, locAt, locAt + 20);
    if (u32(loc, 0) === 0x07064b50) {
      const recAt = u64(loc, 8);
      const rec = await bytes(file, recAt, recAt + 56);
      if (u32(rec, 0) === 0x06064b50) { count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48); }
    }
  }
  const cd = await bytes(file, cdOff, cdOff + cdSize);
  const out: ZipEntry[] = [];
  const utf8 = new TextDecoder("utf-8"), latin = new TextDecoder("latin1");
  for (let o = 0; o + 46 <= cd.length && out.length < count + 5; ) {
    if (u32(cd, o) !== 0x02014b50) break;
    const flags = u16(cd, o + 8), method = u16(cd, o + 10);
    let compSize = u32(cd, o + 20), size = u32(cd, o + 24), offset = u32(cd, o + 42);
    const nLen = u16(cd, o + 28), xLen = u16(cd, o + 30), cLen = u16(cd, o + 32);
    const nameB = cd.subarray(o + 46, o + 46 + nLen);
    const name = (flags & 0x800 ? utf8 : latin).decode(nameB);
    // ZIP64 sizes / offset in the extra field
    let x = o + 46 + nLen;
    const xEnd = x + xLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x), len = u16(cd, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); q += 8; }
      }
      x += 4 + len;
    }
    if (!name.endsWith("/")) out.push({ name, method, compSize, size, offset, encrypted: !!(flags & 1) });
    o += 46 + nLen + xLen + cLen;
  }
  return out;
}

export async function readEntry(file: Blob, e: ZipEntry): Promise<Uint8Array> {
  if (e.encrypted) throw new Error("password-protected");
  const lh = await bytes(file, e.offset, e.offset + 30);
  if (u32(lh, 0) !== 0x04034b50) throw new Error("damaged zip entry");
  const start = e.offset + 30 + u16(lh, 26) + u16(lh, 28);
  const data = await bytes(file, start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateSync(data);
  throw new Error(`unsupported compression (${e.method})`);
}

const IMG = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
/** Photos in a zip (macOS "__MACOSX" / "._" helper files are not photos). */
export const isPhoto = (name: string) => IMG.test(name) && !/(^|\/)__MACOSX\//.test(name) && !/(^|\/)\._/.test(name);
export const baseName = (name: string) => name.split("/").pop() || name;
