import { crc32, deflateSync } from 'node:zlib';
import type { Rgb } from './colorMath.js';

export type HdrSpace = 'rec2100-pq' | 'rec2100-hlg';

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** A 1×1, 16-bit RGB PNG. Current browsers can display HDR images without HDR CSS colors. */
export function hdrSwatchUrl(rgb: Rgb, space: HdrSpace): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); // Width
  header.writeUInt32BE(1, 4); // Height
  header[8] = 16;
  header[9] = 2; // Truecolor RGB
  const scanline = Buffer.alloc(7); // Filter byte 0, then three big-endian samples.
  rgb.forEach((value, channel) => scanline.writeUInt16BE(Math.round(value * 65535), 1 + channel * 2));
  // PNG Third Edition cICP: BT.2020 primaries, PQ or HLG, identity matrix, full range.
  // https://www.w3.org/TR/png-3/#cICP-chunk
  const color = Buffer.from([9, space === 'rec2100-pq' ? 16 : 18, 0, 1]);
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('cICP', color),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
