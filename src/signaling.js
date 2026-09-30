// 手工信令：不经过任何服务器，由用户在两个页面之间复制粘贴 SDP。
//
//  发起方：createOffer()       -> 得到一段文本，复制给应答方
//  应答方：createAnswer(offer) -> 得到一段文本，复制回发起方
//  发起方：acceptAnswer(answer)
//
// 两端都等待非 trickle ICE 收集完成，使一段文本即包含完整候选。
// 另配一个公共 STUN 服务器，仅用于 NAT 打洞，不经过任何应用服务器，也不上传文件。

export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// 本地/测试环境 ICE 很快；给个上限避免页面永远等下去。
const GATHER_TIMEOUT_MS = 5000;

/** 等待 ICE 收集完成（非 trickle），超时后带着当前候选继续。 */
function waitForGathering(pc, timeoutMs = GATHER_TIMEOUT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onState);
      clearTimeout(timer);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

/** 发起方：建 PeerConnection、DataChannel，生成可复制的 offer 文本。 */
export async function createOffer({ iceServers = DEFAULT_ICE_SERVERS, channelLabel = 'file', timeoutMs } = {}) {
  const pc = new RTCPeerConnection({ iceServers });
  const channel = pc.createDataChannel(channelLabel, { ordered: true, maxRetransmits: null });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForGathering(pc, timeoutMs);
  // 收集完成后 localDescription 已包含候选，序列化它。
  return { pc, channel, payload: serializeSdp(pc.localDescription) };
}

/**
 * 应答方：粘贴 offer，建 PeerConnection，生成可复制的 answer 文本。
 * 注意：此时握手尚未完成，datachannel 事件要等发起方接受 answer 后才会触发，
 * 因此本函数只返回 pc 与 payload；调用方用 waitForChannel(pc) 等待通道。
 */
export async function createAnswer(offerText, { iceServers = DEFAULT_ICE_SERVERS, timeoutMs } = {}) {
  const description = parseSdp(offerText);
  if (!description || description.type !== 'offer') {
    throw new Error('粘贴的内容不是有效的发起方连接信息（offer）');
  }
  const pc = new RTCPeerConnection({ iceServers });
  await pc.setRemoteDescription(description);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForGathering(pc, timeoutMs);
  return { pc, payload: serializeSdp(pc.localDescription) };
}

/** 应答方等待对端发起的 DataChannel（发起方接受 answer 之后才会出现）。 */
export function waitForChannel(pc, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 DataChannel 超时')), timeoutMs);
    pc.addEventListener(
      'datachannel',
      (event) => {
        clearTimeout(timer);
        resolve(event.channel);
      },
      { once: true },
    );
  });
}

/** 发起方：粘贴应答方文本并完成握手。 */
export async function acceptAnswer(pc, answerText) {
  const description = parseSdp(answerText);
  if (!description || description.type !== 'answer') {
    throw new Error('粘贴的内容不是有效的应答方连接信息（answer）');
  }
  await pc.setRemoteDescription(description);
}

/** 序列化为用户可复制的单行文本（JSON）。 */
export function serializeSdp(description) {
  return JSON.stringify({ type: description.type, sdp: description.sdp });
}

/** 解析复制文本；宽松兼容直接粘贴原生 SDP 对象的情况。 */
export function parseSdp(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && (obj.type === 'offer' || obj.type === 'answer') && typeof obj.sdp === 'string') {
      return { type: obj.type, sdp: obj.sdp };
    }
  } catch {
    // 不是 JSON，忽略
  }
  return null;
}

/**
 * 监听连接与 ICE 状态，异常时给出明确失败回调。
 * ICE 短暂断开会先尝试恢复；超过 graceMs 仍未恢复才算失败。
 */
export function monitorConnection(pc, { onFailed, onClosed, graceMs = 8000 } = {}) {
  let graceTimer = null;

  const clearGrace = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const onConnState = () => {
    switch (pc.connectionState) {
      case 'connected':
        clearGrace();
        break;
      case 'disconnected':
        if (!graceTimer) {
          graceTimer = setTimeout(() => onFailed?.(new Error('连接断开且未能恢复')), graceMs);
        }
        break;
      case 'failed':
        clearGrace();
        onFailed?.(new Error('连接失败（ICE/DTLS 传输失败）'));
        break;
      case 'closed':
        clearGrace();
        onClosed?.(new Error('连接已关闭'));
        break;
      default:
        break;
    }
  };

  pc.addEventListener('connectionstatechange', onConnState);
  return () => {
    clearGrace();
    pc.removeEventListener('connectionstatechange', onConnState);
  };
}
