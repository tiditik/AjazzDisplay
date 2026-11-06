'use strict';
/**
 * Image -> device framebuffer conversion.
 *
 * The mouse screen expects 128x128 RGB565 pixels, big-endian, stored column by
 * column (the firmware scans the panel rotated 90 degrees, so the picture has to
 * be transposed). This mirrors exactly what the official app builds before it
 * pushes the data over HID.
 */

const Jimp = require('jimp');

const DEFAULT_SIZE = 128;

function fitContain(img, size) {
  const scale = Math.min(size / img.bitmap.width, size / img.bitmap.height);
  const w = Math.max(1, Math.round(img.bitmap.width * scale));
  const h = Math.max(1, Math.round(img.bitmap.height * scale));
  img.resize(w, h, Jimp.RESIZE_BICUBIC);
  const canvas = new Jimp(size, size, 0x000000ff);
  canvas.composite(img, Math.floor((size - w) / 2), Math.floor((size - h) / 2));
  return canvas;
}

function fitCover(img, size) {
  img.cover(size, size, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
  return img;
}

function fitStretch(img, size) {
  img.resize(size, size, Jimp.RESIZE_BICUBIC);
  return img;
}

/**
 * Convert raw RGBA pixels to the device byte layout.
 * @returns {Buffer} size*size*2 bytes (RGB565, big-endian, transposed)
 */
function rgbaToBytes(rgba, width, height, size = DEFAULT_SIZE, fit = 'contain') {
  const img = new Jimp({ data: Buffer.from(rgba), width, height });
  let prepared;
  if (fit === 'cover') prepared = fitCover(img, size);
  else if (fit === 'stretch') prepared = fitStretch(img, size);
  else prepared = fitContain(img, size);

  const data = prepared.bitmap.data;
  const bytes = Buffer.alloc(size * size * 2);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // transposed source pixel: source row = x, source column = y
      const s = (x * size + y) * 4;
      const r = data[s];
      const g = data[s + 1];
      const b = data[s + 2];
      const value = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
      bytes[offset++] = value >> 8;
      bytes[offset++] = value & 0xff;
    }
  }
  return bytes;
}

/**
 * @param {string} file image path (png/jpg/bmp - first frame)
 * @param {{size?:number, fit?:'contain'|'cover'|'stretch'}} options
 * @returns {Promise<{width:number,height:number,bytes:Buffer}>}
 */
async function imageToFrame(file, { size = DEFAULT_SIZE, fit = 'contain' } = {}) {
  const img = await Jimp.read(file);
  const bytes = rgbaToBytes(img.bitmap.data, img.bitmap.width, img.bitmap.height, size, fit);
  return { width: size, height: size, bytes };
}

module.exports = { imageToFrame, rgbaToBytes, DEFAULT_SIZE };
