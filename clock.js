#!/usr/bin/env node
'use strict';
/**
 * Live clock on the AJAZZ mouse screen.
 *
 *   node clock.js                 # 24h clock, updates every minute
 *   node clock.js --12h
 *   node clock.js --preview a.png # render the current time to a PNG, no device
 *   node clock.js --once          # push the current time once and exit
 *
 * A transfer takes ~4 s, so the next minute's picture is sent ahead of time and
 * the screen flips right around the minute boundary.
 */

const Jimp = require('jimp');
const { DriverClient, listDevicePaths, pickDevicePath } = require('./ajazz');
const { uploadImage } = require('./screen');
const { rgbaToBytes, DEFAULT_SIZE } = require('./image');

const SIZE = DEFAULT_SIZE;

function parseArgs(argv) {
  const args = { h12: false, lead: 4500, color: 'white', device: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--12h') args.h12 = true;
    else if (a === '--24h') args.h12 = false;
    else if (a === '--once') args.once = true;
    else if (a === '--preview') args.preview = argv[++i];
    else if (a === '--device') args.device = argv[++i];
    else if (a === '--lead') args.lead = parseInt(argv[++i], 10);
    else if (a === '--color') args.color = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else { console.error('unknown option: ' + a); process.exit(1); }
  }
  return args;
}

const FONTS = { white: Jimp.FONT_SANS_64_WHITE, black: Jimp.FONT_SANS_64_BLACK };

function timeParts(date, h12) {
  let h = date.getHours();
  if (h12) h = h % 12 || 12;
  return [String(h).padStart(2, '0'), String(date.getMinutes()).padStart(2, '0')];
}

/** Render HH over MM, centered, on a black 128x128 canvas. */
async function renderTime(date, { h12 = false, color = 'white' } = {}) {
  const font = await Jimp.loadFont(FONTS[color] || FONTS.white);
  const canvas = new Jimp(SIZE, SIZE, 0x000000ff);
  const [hh, mm] = timeParts(date, h12);
  const half = SIZE / 2;
  const align = { alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER, alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE };
  canvas.print(font, 0, 0, { text: hh, ...align }, SIZE, half);
  canvas.print(font, 0, half, { text: mm, ...align }, SIZE, half);
  return canvas;
}

function toFrame(img) {
  return { width: SIZE, height: SIZE, bytes: rgbaToBytes(img.bitmap.data, SIZE, SIZE, SIZE, 'stretch') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const nextMinute = (from) => new Date(Math.floor(from / 60000) * 60000 + 60000);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node clock.js [options]

  --12h | --24h        clock format (default 24h)
  --color white|black  digit color (default white on black)
  --lead MS            start sending this long before the minute changes (default 4500)
  --device SUBSTR      pick HID path containing SUBSTR (default MI_02)
  --once               send the current time once and exit
  --preview FILE       save the picture to FILE instead of sending it`);
    return;
  }

  const opts = { h12: args.h12, color: args.color };

  if (args.preview) {
    await (await renderTime(new Date(), opts)).writeAsync(args.preview);
    console.log('saved ' + args.preview);
    return;
  }

  const client = new DriverClient();
  let stop = false;
  process.on('SIGINT', () => { stop = true; client.close(); console.log('\nbye'); process.exit(0); });

  try {
    let paths;
    try {
      paths = await listDevicePaths(client);
    } catch (e) {
      throw new Error('cannot reach AJAZZ Driver on 127.0.0.1:3814 - start the AJAZZ Driver app first (' + e.message + ')');
    }
    if (!paths.length) throw new Error('no devices reported by the driver. Is the mouse connected?');
    const devicePath = pickDevicePath(paths, args.device || 'MI_02');
    console.log('using: ' + devicePath);

    const push = async (date) => {
      const started = Date.now();
      await uploadImage(client, devicePath, toFrame(await renderTime(date, opts)), { log: () => {} });
      return Date.now() - started;
    };

    // Show the current time right away.
    let lastDuration = await push(new Date());
    console.log(`[${stamp()}] sent ${timeParts(new Date(), args.h12).join(':')} (${lastDuration} ms)`);
    if (args.once) return;

    while (!stop) {
      const target = nextMinute(Date.now());
      // start early enough that the transfer finishes at the minute boundary
      const startAt = target.getTime() - Math.max(lastDuration, 1000) - 300;
      await sleep(Math.max(0, startAt - Date.now()));
      try {
        lastDuration = await push(target);
        console.log(`[${stamp()}] sent ${timeParts(target, args.h12).join(':')} (${lastDuration} ms)`);
      } catch (e) {
        console.error(`[${stamp()}] error: ${e.message} - will retry next minute`);
        client.close(); // reconnect on the next call
        // make sure we do not spin on the same minute
        await sleep(Math.max(0, target.getTime() - Date.now()) + 1000);
      }
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('error: ' + err.message);
  process.exit(1);
});
