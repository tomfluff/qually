// Minimal ZIP writer — "stored" (no compression), which is the whole trick: a ZIP
// with method 0 is just the file bytes wrapped in headers, so it needs no deflate
// implementation and no dependency. Every unzipper reads it (Explorer, Finder,
// unzip, Python's zipfile). Text-only bundles compress well but a few hundred KB
// of CSV doesn't need it.
//
// ponytail: store-only. If bundles ever get big enough to matter, the upgrade path
// is CompressionStream("deflate-raw") — available in modern browsers — writing
// method 8 instead of 0.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time: 7-bit year from 1980, then month, day, hour, minute, 2-second steps
const dosTime = (d: Date) =>
  (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
const dosDate = (d: Date) =>
  ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

export interface ZipFile { name: string; text: string }

export function zipTextFiles(files: ZipFile[], when: Date): Blob {
  const enc = new TextEncoder();
  const time = dosTime(when), date = dosDate(when);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);

    // local file header (30 bytes + name)
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0x0800, true);       // flags: bit 11 = UTF-8 names
    lv.setUint16(8, 0, true);            // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size == uncompressed
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // extra field length
    lh.set(name, 30);

    // central directory header (46 bytes + name), pointing at this local header
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, offset, true);      // offset of local header
    ch.set(name, 46);

    chunks.push(lh, data);
    central.push(ch);
    offset += lh.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(8, files.length, true);   // entries on this disk
  ev.setUint16(10, files.length, true);  // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);        // offset of central directory
  ev.setUint16(20, 0, true);             // comment length

  return new Blob([...chunks, ...central, end] as BlobPart[], { type: "application/zip" });
}
