// 线上协议常量与编解码。
//
// 控制消息走 DataChannel 的文本通道（JSON），数据块走二进制通道：
//   { kind: 'meta',  id, name, size, chunks, hash }  传输开始
//   { kind: 'end',   id, hash }                     传输结束（hash 供再次校验）
//   ArrayBuffer: 前 4 字节为大端序号，其后为块载荷（<= CHUNK_SIZE 字节）
//
// 每条控制消息都带本次传输 id；序号从 0 起，逐块递增。

export const CHUNK_SIZE = 16 * 1024; // 至多 16 KiB
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 不超过 5 MiB

const CHUNK_HEADER_BYTES = 4;

/** 生成一次传输的唯一 id（随机，避免重连后旧 id 撞上新 id）。 */
export function createTransferId() {
  // 优先使用 Web Crypto；浏览器与 Node >= 19 均提供 globalThis.crypto。
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues) {
    const buf = new Uint8Array(16);
    cryptoRef.getRandomValues(buf);
    // 加时间前缀，进一步降低复用页面时碰撞的概率。
    return `${Date.now().toString(36)}-${[...buf].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 计算 ArrayBuffer / TypedArray / Blob 的 SHA-256（十六进制小写）。 */
export async function sha256(data) {
  let bytes;
  if (data instanceof ArrayBuffer) {
    bytes = data;
  } else if (ArrayBuffer.isView(data)) {
    bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else if (data instanceof Blob) {
    bytes = await data.arrayBuffer();
  } else {
    throw new TypeError('sha256: 不支持的数据类型');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function encodeMeta({ id, name, size, chunks, hash }) {
  return JSON.stringify({ kind: 'meta', id, name, size, chunks, hash });
}

export function encodeEnd({ id, hash }) {
  return JSON.stringify({ kind: 'end', id, hash });
}

/** 解析文本控制消息；非法消息返回 null，由调用方按坏消息处理。 */
export function parseControl(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string' || typeof msg.id !== 'string') {
    return null;
  }
  if (msg.kind === 'meta') {
    const { id, name, size, chunks, hash } = msg;
    if (typeof name !== 'string' || !Number.isInteger(size) || size < 0 || size > MAX_FILE_SIZE) return null;
    if (!Number.isInteger(chunks) || chunks < 0) return null;
    if (typeof hash !== 'string') return null;
    const expectedChunks = Math.ceil(size / CHUNK_SIZE);
    if (chunks !== expectedChunks) return null;
    return { kind: 'meta', id, name, size, chunks, hash };
  }
  if (msg.kind === 'end') {
    if (typeof msg.hash !== 'string') return null;
    return { kind: 'end', id: msg.id, hash: msg.hash };
  }
  if (msg.kind === 'cancel') {
    return { kind: 'cancel', id: msg.id };
  }
  return null;
}

/** 把编号块打包为可直接发送的 ArrayBuffer（4B 大端序号 + 载荷）。 */
export function packChunk(sequence, payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength > CHUNK_SIZE) throw new RangeError(`块超过 ${CHUNK_SIZE} 字节`);
  const out = new ArrayBuffer(CHUNK_HEADER_BYTES + bytes.byteLength);
  new DataView(out).setUint32(0, sequence, false);
  new Uint8Array(out, CHUNK_HEADER_BYTES).set(bytes);
  return out;
}

/**
 * 解析二进制块。返回 { sequence, payload: Uint8Array }；
 * 头部不足或载荷为空时返回 null（坏块）。
 */
export function unpackChunk(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < CHUNK_HEADER_BYTES + 1) return null;
  const sequence = new DataView(buffer, 0, CHUNK_HEADER_BYTES).getUint32(0, false);
  return { sequence, payload: new Uint8Array(buffer, CHUNK_HEADER_BYTES) };
}
