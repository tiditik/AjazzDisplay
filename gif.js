'use strict';
/** GIF decoding into full-size RGBA frames (disposal handled). */

const fs = require('fs');
const { GifReader } = require('omggif');

function clearRect(canvas, width, info) {
  for (let y = info.y; y < info.y + info.height; y++) {
    for (let x = info.x; x < info.x + info.width; x++) {
      const o = (y * width + x) * 4;
      canvas[o] = 0;
      canvas[o + 1] = 0;
      canvas[o + 2] = 0;
      canvas[o + 3] = 0;
    }
  }
}

/**
 * @param {string} file
 * @returns {{width:number,height:number,frames:Array<{rgba:Buffer,delayMs:number}>}}
 */
function decodeGif(file) {
  const reader = new GifReader(fs.readFileSync(file));
  const width = reader.width;
  const height = reader.height;
  const count = reader.numFrames();
  const canvas = Buffer.alloc(width * height * 4);
  const frames = [];
  let previous = null;
  let previousInfo = null;

  for (let index = 0; index < count; index++) {
    if (previousInfo) {
      if (previousInfo.disposal === 2) clearRect(canvas, width, previousInfo);
      else if (previousInfo.disposal === 3 && previous) canvas.set(previous);
    }
    previous = Buffer.from(canvas);
    const info = reader.frameInfo(index);
    reader.decodeAndBlitFrameRGBA(index, canvas);
    const ms = info.delay ? info.delay * 10 : 100;
    frames.push({ rgba: Buffer.from(canvas), delayMs: Math.max(20, Math.min(255, ms)) });
    previousInfo = info;
  }

  return { width, height, frames };
}

/** frameIndex / frameCount are single bytes in the protocol. */
const MAX_FRAMES = 255;

/**
 * Reduce a frame list to at most `max` frames. Frames are split into `max`
 * evenly sized groups; the first frame of each group is kept and its delay
 * becomes the group's total delay (clamped to the firmware limit), so the
 * overall animation speed is preserved as far as possible.
 */
function limitFrames(frames, max = MAX_FRAMES) {
  if (frames.length <= max) return frames;
  const result = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor((i * frames.length) / max);
    const to = Math.floor(((i + 1) * frames.length) / max);
    const total = frames.slice(from, to).reduce((sum, f) => sum + f.delayMs, 0);
    result.push({ ...frames[from], delayMs: Math.min(255, total) });
  }
  return result;
}

module.exports = { decodeGif, limitFrames, MAX_FRAMES };
