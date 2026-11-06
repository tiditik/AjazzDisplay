'use strict';
/**
 * High-level screen API: push a prepared frame (or animation) to the mouse.
 * Shared by upload.js (CLI) and clock.js (live clock).
 */

const {
  CheckSumType,
  DangleDevType,
  LightType,
  encodeSendMsg,
  encodeSetLight,
  encodeReadMsg,
  decodeResSend,
  decodeResRead,
  buildHandshake,
  buildChunkHeader,
  CHUNK_SIZE,
} = require('./ajazz');

/** Busy-wait; Windows timers are far too coarse (~15 ms) for per-packet pacing. */
function spin(ms) {
  if (!ms) return;
  const end = performance.now() + ms;
  while (performance.now() < end) { /* spin */ }
}

async function sendFrame(client, devicePath, msg, checksum = CheckSumType.BIT7) {
  const response = await client.call('sendRawFeature', encodeSendMsg(devicePath, msg, checksum, DangleDevType.NONE));
  const err = decodeResSend(response);
  if (err) throw new Error('device error: ' + err);
}

/** Stop screen streaming and wait for the panel to accept a transfer. */
async function beginTransfer(client, devicePath, width, height, frameCount, frameDelay, { log = console.log } = {}) {
  try {
    await client.call('setLightType', encodeSetLight(devicePath, LightType.OTHER, 0, DangleDevType.NONE));
  } catch (e) {
    log('warning: setLightType failed: ' + e.message);
  }

  const handshake = buildHandshake(width, height, { frameIndex: 0, frameCount, frameDelay });
  let ready = false;
  for (let attempt = 0; attempt < 10 && !ready; attempt++) {
    await sendFrame(client, devicePath, handshake);
    const answer = decodeResRead(await client.call('readRawFeature', encodeReadMsg(devicePath)));
    if (answer.msg.length > 1 && answer.msg[1] === 1) ready = true;
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('device did not acknowledge the transfer (handshake failed)');
  await new Promise((r) => setTimeout(r, 100));
}

/** Push one 128x128 frame: 586 chunks of 56 bytes. */
async function sendFrameChunks(client, devicePath, frame, frameIndex, frameCount, frameDelay, { repeat = 1, pace = 6 } = {}) {
  const { bytes } = frame;
  const chunks = Math.ceil(bytes.length / CHUNK_SIZE);
  for (let index = 0; index < chunks; index++) {
    const data = bytes.slice(index * CHUNK_SIZE, index * CHUNK_SIZE + CHUNK_SIZE);
    const header = buildChunkHeader(index, data.length, { frameIndex, frameCount, frameDelay });
    const payload = Buffer.concat([header, data]);
    for (let r = 0; r < repeat; r++) {
      await sendFrame(client, devicePath, payload);
      spin(pace);
    }
  }
}

async function finishTransfer(client, devicePath) {
  await sendFrame(client, devicePath, Buffer.from([0xf1]));
  await client.call('readRawFeature', encodeReadMsg(devicePath));
}

async function uploadImage(client, devicePath, frame, { repeat = 1, pace = 6, passes = 1, log = console.log } = {}) {
  await beginTransfer(client, devicePath, frame.width, frame.height, 1, 0, { log });
  for (let pass = 0; pass < passes; pass++) {
    await sendFrameChunks(client, devicePath, frame, 0, 1, 0, { repeat, pace });
    log(`  pass ${pass + 1}/${passes} done`);
  }
  await finishTransfer(client, devicePath);
}

async function uploadAnimation(client, devicePath, frames, { repeat = 1, pace = 6, log = console.log } = {}) {
  const count = frames.length;
  log(`  ${count} frames, delays ${frames.map((f) => f.delayMs).join(', ')} ms`);
  await beginTransfer(client, devicePath, frames[0].width, frames[0].height, count, frames[0].delayMs, { log });
  for (let index = 0; index < count; index++) {
    await sendFrameChunks(client, devicePath, frames[index], index, count, frames[index].delayMs, { repeat, pace });
    log(`  frame ${index + 1}/${count} done`);
  }
  await finishTransfer(client, devicePath);
}

module.exports = { spin, sendFrame, beginTransfer, sendFrameChunks, finishTransfer, uploadImage, uploadAnimation };
