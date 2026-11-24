/**
 * The ZIP writer of the fakes (AL-160). A fake of an outside service makes its archives with `zipArchive`. The reader
 * `readZipEntries` of `@mark1russell7/files/archive` reads them as it reads a real archive.
 *
 * This writer is a shortcut. The home of ZIP files is `@mark1russell7/files/archive`, and it has a reader and no writer.
 * The item AL-161 moves this writer into that home. Then the fakes and the tests of the sources import it from there.
 */
import { deflateRawSync } from "node:zlib";
import { crc32 } from "@mark1russell7/files/archive";

/** One entry of an archive: its name and its text in UTF-8. */
export interface ZipEntry {
  readonly name: string;
  readonly text: string;
}

/**
 * This function writes a ZIP archive of the entries. With `deflate`, each entry has the method 8 (deflate), as a real
 * archive has. Without it, each entry is stored with no compression. The same entries give the same bytes.
 */
export function zipArchive(entries: readonly ZipEntry[], deflate = true): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, text } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const packed = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
