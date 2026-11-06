#!/usr/bin/env node
'use strict';
/**
 * Upload a picture or an animation to the AJAZZ mouse screen.
 *
 *   node upload.js photo.png
 *   node upload.js animation.gif
 *   node upload.js photo.png --fit cover
 *
 * Requires the official AJAZZ Driver to be running (it owns the gRPC bridge and
 * the HID handle), but the app window does not need to be used.
 */

const fs = require('fs');
const path = require('path');
const { DriverClient, listDevicePaths, pickDevicePath } = require('./ajazz');
const { uploadImage, uploadAnimation } = require('./screen');
const { imageToFrame, rgbaToBytes, DEFAULT_SIZE } = require('./image');
const { decodeGif, limitFrames, MAX_FRAMES } = require('./gif');

function parseArgs(argv) {
  const args = { _: [], fit: 'contain', size: DEFAULT_SIZE, repeat: 1, pace: 6, passes: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fit') args.fit = argv[++i];
    else if (a === '--size') args.size = parseInt(argv[++i], 10);
    else if (a === '--device') args.device = argv[++i];
    else if (a === '--repeat') args.repeat = parseInt(argv[++i], 10);
    else if (a === '--passes') args.passes = parseInt(argv[++i], 10);
    else if (a === '--delay') args.pace = parseFloat(argv[++i]);
    else if (a === '--max-frames') args.maxFrames = parseInt(argv[++i], 10);
    else if (a === '--strict') args.strict = true;
    else if (a === '--raw') args.raw = argv[++i];
    else if (a === '--list') args.list = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node upload.js <image|animation.gif> [options]

Options:
  --fit contain|cover|stretch  how to fit the picture into the screen (default contain)
  --size N                     screen size, default ${DEFAULT_SIZE}
  --device SUBSTR              pick HID path containing SUBSTR (default MI_02)
  --repeat N                   send every chunk N times (default 1)
  --passes N                   send the whole frame N times (default 1)
  --delay MS                   pacing between packets in ms (default 6; lower values drop data)
  --max-frames N               max GIF frames, 1..255 (default 255); extra frames are thinned out
  --strict                     fail instead of thinning when a GIF has too many frames
  --raw FILE                send a raw framebuffer (size*size*2 bytes) instead of an image
  --list                       only list HID interfaces reported by the driver
  --dry-run                    only prepare the frame, do not talk to the device`);
    return;
  }

  const client = new DriverClient();
  try {
    let paths;
    try {
      paths = await listDevicePaths(client);
    } catch (e) {
      throw new Error('cannot reach AJAZZ Driver on 127.0.0.1:3814 - start the AJAZZ Driver app first (' + e.message + ')');
    }
    if (!paths.length) throw new Error('no devices reported by the driver. Is the mouse connected?');
    if (args.list) {
      for (const p of paths) console.log(p);
      return;
    }

    const file = args._[0];
    if (!file && !args.raw) {
      console.error('error: image path is required (or --raw FILE)');
      process.exit(1);
    }

    let frames;
    let animation = false;
    if (args.raw) {
      const bytes = fs.readFileSync(args.raw);
      const size = Math.round(Math.sqrt(bytes.length / 2));
      frames = [{ width: size, height: size, bytes, delayMs: 0 }];
    } else {
      if (!fs.existsSync(file)) {
        console.error('error: file not found: ' + file);
        process.exit(1);
      }
      const isGif = file.toLowerCase().endsWith('.gif');
      console.log(`loading ${path.basename(file)} ...`);
      if (isGif) {
        const gif = decodeGif(file);
        const max = args.maxFrames || MAX_FRAMES;
        if (!Number.isInteger(max) || max < 1 || max > MAX_FRAMES) {
          throw new Error(`--max-frames must be an integer between 1 and ${MAX_FRAMES}`);
        }
        let source = gif.frames;
        if (source.length > max) {
          if (args.strict) {
            throw new Error(`gif has ${source.length} frames, the device supports at most ${max} (drop --strict to thin them out automatically)`);
          }
          console.log(`warning: gif has ${source.length} frames, thinning to ${max}`);
          source = limitFrames(source, max);
        }
        frames = source.map((f) => ({
          width: args.size,
          height: args.size,
          bytes: rgbaToBytes(f.rgba, gif.width, gif.height, args.size, args.fit),
          delayMs: f.delayMs,
        }));
        animation = frames.length > 1;
        console.log(`gif: ${gif.width}x${gif.height}, ${frames.length} frames`);
      } else {
        const frame = await imageToFrame(file, { size: args.size, fit: args.fit });
        frames = [{ ...frame, delayMs: 0 }];
      }
    }

    console.log(`frame: ${frames[0].width}x${frames[0].height}, ${frames[0].bytes.length} bytes`);
    if (args.dryRun) {
      console.log('dry run, nothing sent');
      return;
    }

    console.log('HID interfaces:');
    for (const p of paths) console.log('  ' + p.split('#')[1] + '  ' + p);
    const devicePath = args.device ? pickDevicePath(paths, args.device) : pickDevicePath(paths);
    if (!devicePath) throw new Error('no matching device path');
    console.log('using: ' + devicePath);

    const started = Date.now();
    if (animation) {
      await uploadAnimation(client, devicePath, frames, { repeat: args.repeat, pace: args.pace, log: console.log });
    } else {
      await uploadImage(client, devicePath, frames[0], { repeat: args.repeat, pace: args.pace, passes: args.passes, log: console.log });
    }
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('error: ' + err.message);
  process.exit(1);
});
