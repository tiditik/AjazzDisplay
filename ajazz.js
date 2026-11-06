'use strict';
/**
 * Low-level client for the AJAZZ driver (iot_driver_v190.exe).
 *
 * The driver is a Rust/tonic gRPC server hard-wired to 127.0.0.1:3814 and exposes
 * driver.DriverGrpc. This module speaks plain gRPC over HTTP/2 with no external
 * dependencies (Node's built-in http2 module).
 */

const http2 = require('http2');

const HOST = '127.0.0.1';
const PORT = 3814;
const SERVICE = '/driver.DriverGrpc/';

// ---------------------------------------------------------------------------
// protobuf helpers (only the small subset of messages we need)
// ---------------------------------------------------------------------------

function varint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function pbVarint(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function pbString(field, str) {
  const data = Buffer.from(str, 'utf8');
  return Buffer.concat([tag(field, 2), varint(data.length), data]);
}

function pbBytes(field, data) {
  return Buffer.concat([tag(field, 2), varint(data.length), data]);
}

// ---------------------------------------------------------------------------
// message encoders / decoders
// ---------------------------------------------------------------------------

const CheckSumType = { BIT7: 0, BIT8: 1, NONE: 2 };
const DangleDevType = { NONE: 0, KEYBOARD: 1, MOUSE: 2 };
const LightType = { MUSIC: 0, SCREEN: 1, OTHER: 2 };

function encodeSendMsg(devicePath, msg, checksumType = CheckSumType.BIT7, dangleType = DangleDevType.NONE) {
  const parts = [pbString(1, devicePath), pbBytes(2, msg)];
  if (checksumType) parts.push(pbVarint(3, checksumType));
  if (dangleType) parts.push(pbVarint(4, dangleType));
  return Buffer.concat(parts);
}

function encodeSetLight(devicePath, lightType, screenId = 0, dangleType = DangleDevType.NONE) {
  const parts = [pbString(1, devicePath), pbVarint(2, lightType)];
  if (screenId) parts.push(pbVarint(3, screenId));
  if (dangleType) parts.push(pbVarint(4, dangleType));
  return Buffer.concat(parts);
}

function encodeReadMsg(devicePath) {
  return pbString(1, devicePath);
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[offset++];
    value += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80);
  return [value, offset];
}

function decodeFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    let key;
    [key, offset] = readVarint(buf, offset);
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      let value;
      [value, offset] = readVarint(buf, offset);
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      let length;
      [length, offset] = readVarint(buf, offset);
      fields.push({ field, wire, value: buf.slice(offset, offset + length) });
      offset += length;
    } else if (wire === 5) {
      fields.push({ field, wire, value: buf.readUInt32LE(offset) });
      offset += 4;
    } else if (wire === 1) {
      fields.push({ field, wire, value: buf.slice(offset, offset + 8) });
      offset += 8;
    } else {
      break;
    }
  }
  return fields;
}

function decodeResSend(buf) {
  const err = decodeFields(buf).find((f) => f.field === 1 && f.wire === 2);
  return err ? err.value.toString('utf8') : '';
}

function decodeResRead(buf) {
  const fields = decodeFields(buf);
  const err = fields.find((f) => f.field === 1 && f.wire === 2);
  const msg = fields.find((f) => f.field === 2 && f.wire === 2);
  return { err: err ? err.value.toString('utf8') : '', msg: msg ? msg.value : Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// gRPC over HTTP/2
// ---------------------------------------------------------------------------

class DriverClient {
  constructor({ host = HOST, port = PORT, timeout = 15000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.session = null;
  }

  connect() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    this.session = http2.connect(`http://${this.host}:${this.port}`);
    this.session.on('error', () => {});
    return this.session;
  }

  close() {
    if (this.session) {
      try { this.session.close(); } catch (e) { /* ignore */ }
      this.session = null;
    }
  }

  _request(path, payload) {
    const session = this.connect();
    const frame = Buffer.alloc(5);
    frame.writeUInt8(0, 0);
    frame.writeUInt32BE(payload.length, 1);

    return new Promise((resolve, reject) => {
      const req = session.request({
        ':method': 'POST',
        ':path': SERVICE + path,
        'content-type': 'application/grpc',
        te: 'trailers',
        'grpc-accept-encoding': 'identity',
      });

      const chunks = [];
      let status = null;
      let message = null;

      req.setTimeout(this.timeout, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error(`gRPC ${path}: timeout`));
      });

      req.on('response', (headers) => {
        status = headers['grpc-status'];
        message = headers['grpc-message'];
      });
      req.on('trailers', (trailers) => {
        if (trailers['grpc-status'] !== undefined) status = trailers['grpc-status'];
        if (trailers['grpc-message'] !== undefined) message = trailers['grpc-message'];
      });
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('error', reject);
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (status !== null && status !== undefined && String(status) !== '0') {
          return reject(new Error(`gRPC ${path}: status ${status} ${message ? decodeURIComponent(String(message)) : ''}`.trim()));
        }
        if (body.length < 5) return resolve(Buffer.alloc(0));
        const length = body.readUInt32BE(1);
        resolve(body.slice(5, 5 + length));
      });

      req.end(Buffer.concat([frame, payload]));
    });
  }

  /** Unary call returning the raw response message. */
  call(path, payload) {
    return this._request(path, payload);
  }

  /** Server-streaming call; collects frames for `duration` ms. */
  stream(path, payload, duration) {
    const session = this.connect();
    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(payload.length, 1);

    return new Promise((resolve, reject) => {
      const req = session.request({
        ':method': 'POST',
        ':path': SERVICE + path,
        'content-type': 'application/grpc',
        te: 'trailers',
      });
      const frames = [];
      let buffer = Buffer.alloc(0);
      req.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
          const length = buffer.readUInt32BE(1);
          if (buffer.length < 5 + length) break;
          frames.push(buffer.slice(5, 5 + length));
          buffer = buffer.slice(5 + length);
        }
      });
      req.on('error', reject);
      req.end(Buffer.concat([frame, payload]));
      setTimeout(() => {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch (e) { /* ignore */ }
        resolve(frames);
      }, duration);
    });
  }
}

// ---------------------------------------------------------------------------
// AJAZZ protocol
// ---------------------------------------------------------------------------

const CMD_GET_TFT = 0xa5;
const CMD_SET_TFT = 0x25;
const CHUNK_SIZE = 56;

const PATH_RE = /^\\\\\?\\HID#[ -~]*?\}$/;

/** Recursively collect every HID interface path found in a protobuf message. */
function pathLookup(payload, out = []) {
  let fields;
  try { fields = decodeFields(payload); } catch (e) { return out; }
  for (const field of fields) {
    if (field.wire === 2) {
      const value = field.value;
      if (value.length > 10 && value[0] === 0x5c) {
        const text = value.toString('latin1');
        if (PATH_RE.test(text)) {
          if (!out.includes(text)) out.push(text);
          continue;
        }
      }
      // nested message
      if (value.length) pathLookup(value, out);
    }
  }
  return out;
}

async function listDevicePaths(client, waitMs = 1200) {
  const frames = await client.stream('watchDevList', Buffer.alloc(0), waitMs);
  const paths = [];
  for (const frame of frames) {
    for (const p of pathLookup(frame)) if (!paths.includes(p)) paths.push(p);
  }
  return paths;
}

function pickDevicePath(paths, preferred = 'MI_02') {
  if (!paths.length) return null;
  if (preferred) {
    const hit = paths.find((p) => p.toUpperCase().includes(preferred.toUpperCase()));
    if (hit) return hit;
  }
  const vendor = paths.find((p) => !/&COL/i.test(p));
  return vendor || paths[0];
}

function buildHandshake(width, height, { frameIndex = 0, frameCount = 1, frameDelay = 0 } = {}) {
  const total = width * height * 2;
  const header = Buffer.alloc(18);
  header[0] = CMD_GET_TFT;
  header[1] = frameIndex;
  header[2] = frameCount;
  header[3] = frameDelay;
  header.writeUInt32LE(total, 4);
  header[8] = 0;            // left low
  header[9] = 0;            // top low
  header[10] = width & 0xff;  // right low
  header[11] = height & 0xff; // bottom low
  header[12] = 0;
  header[13] = 0;
  header[14] = width >> 8;
  header[15] = height >> 8;
  header[16] = (total >> 16) & 0xff;
  header[17] = (total >> 24) & 0xff;
  return header;
}

function buildChunkHeader(index, length, { frameIndex = 0, frameCount = 1, frameDelay = 0 } = {}) {
  const header = Buffer.alloc(8);
  header[0] = CMD_SET_TFT;
  header[1] = frameIndex;
  header[2] = frameCount;
  header[3] = frameDelay;
  header.writeUInt16LE(index, 4);
  header[6] = length;
  header[7] = 0;
  return header;
}

module.exports = {
  DriverClient,
  CheckSumType,
  DangleDevType,
  LightType,
  encodeSendMsg,
  encodeSetLight,
  encodeReadMsg,
  encodeEmpty: () => Buffer.alloc(0),
  decodeResSend,
  decodeResRead,
  listDevicePaths,
  pickDevicePath,
  buildHandshake,
  buildChunkHeader,
  CHUNK_SIZE,
  CMD_GET_TFT,
  CMD_SET_TFT,
};
