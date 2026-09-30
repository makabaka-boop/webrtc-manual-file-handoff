// 可替换 DataChannel 的测试替身。
//
// FakeDataChannel 实现 RTCDataChannel 的最小形状：
//   readyState / send() / bufferedAmount / bufferedAmountLowThreshold /
//   close() / addEventListener / dispatchEvent（EventTarget）
// 由 FakePair 把两个通道连成一对，按定时器搬运消息，并模拟：
//   - 缓冲回落（背压）：接收端“消费”有速率，积压到高水位后暂停投递，
//     降到阈值以下时给发送端派发 bufferedamountlow；
//   - 断开：drop() 立即关闭两端并停止投递；
//   - 坏块：投递前可通过 transform 篡改某条消息。

export class FakeDataChannel extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    // 默认即 open：构造后立即派发一次 open 事件，便于异步流程等待。
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this._pair = null;
  }

  send(data) {
    if (this.readyState !== 'open') {
      // 与真实通道一致：关闭后发送抛错。
      throw new Error('FakeDataChannel: readyState 不是 open');
    }
    const size = typeof data === 'string' ? data.length : data.byteLength ?? data.size ?? 0;
    const message = { kind: typeof data === 'string' ? 'text' : 'binary', data, size };
    this._pair._enqueue(this, message);
    // 与真实 DataChannel 一致：send 返回后 bufferedAmount 立即反映排队积压
    //（待发 + 已交给底层在途）。tick 消费时通过 _consumeFromQueued 同步扣减。
    this.bufferedAmount += size;
  }

  /** 测试辅助：发送方读取“应用待发”字节数（判断背压用）。 */
  get queuedAmount() {
    const q = this._pair._queues.get(this);
    let total = 0;
    for (const m of q) {
      if (m.kind === 'binary') total += m.size;
    }
    return total;
  }

  close() {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing';
    this._pair._requestClose(this);
  }

  /** 测试辅助：触发 bufferedamountlow（通常由 FakePair 在消费后调用）。 */
  _emitLow() {
    this.dispatchEvent(new Event('bufferedamountlow'));
  }

  _emitClose() {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }

  _emitError() {
    this.dispatchEvent(new Event('error'));
  }

  _deliver(message) {
    const event = new Event('message');
    event.data = message.data;
    this.dispatchEvent(event);
  }
}

/**
 * 一对互联的假通道。
 *
 * @param {object}   opts
 * @param {number}   opts.highWaterMark   触发背压的发送缓冲积压（字节），默认 64 KiB
 * @param {number}   opts.lowThreshold    回落判定（字节），默认 16 KiB
 * @param {number}   opts.tickMs          搬运周期（毫秒），默认 1
 * @param {number}   opts.bytesPerTick    每周期最多“消费”的字节，默认 32 KiB；
 *                                        设小一点可让大文件稳定触发背压
 * @param {boolean}  opts.autoOpen        构造后是否立刻 open，默认 true
 */
export class FakePair {
  constructor(opts = {}) {
    this.highWaterMark = opts.highWaterMark ?? 64 * 1024;
    this.lowThreshold = opts.lowThreshold ?? 16 * 1024;
    this.tickMs = opts.tickMs ?? 1;
    this.bytesPerTick = opts.bytesPerTick ?? 32 * 1024;

    this.a = new FakeDataChannel('a');
    this.b = new FakeDataChannel('b');
    this.a._pair = this;
    this.b._pair = this;

    // 每条发送方向各自维护：应用待发队列 + 已交给底层（在途）队列。
    // bufferedAmount = 待发 + 在途 的字节合计。
    this._queues = new Map([
      [this.a, []],
      [this.b, []],
    ]);
    this._inflight = new Map([
      [this.a, []],
      [this.b, []],
    ]);
    this._paused = new Map([
      [this.a, false],
      [this.b, false],
    ]);
    this._closed = false;
    this._transform = null; // (from, message) => message | null

    // 测试可能篡改消息：transform 返回 null 表示丢弃，返回替换对象表示篡改。
    this._closeRequested = new Set();

    if (opts.autoOpen !== false) queueMicrotask(() => this.open());

    // 用 unref 的定时器搬运，避免阻止 Node 测试进程退出。
    this._timer = setInterval(() => this._tick(), this.tickMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** 在投递前篡改/过滤消息（模拟坏块、乱序等）。 */
  setTransform(fn) {
    this._transform = fn;
  }

  open() {
    for (const endpoint of [this.a, this.b]) {
      if (!endpoint._opened) {
        endpoint._opened = true;
        endpoint.dispatchEvent(new Event('open'));
      }
    }
  }

  _enqueue(sender, message) {
    if (this._closed) throw new Error('FakePair: 已断开');
    this._queues.get(sender).push(message);
    // 是否进入背压由 tick 依据积压量统一判断。
  }

  _requestClose(endpoint) {
    this._closeRequested.add(endpoint);
    // DataChannel.close 由底层协商关闭：这里立即双向关闭（测试足够用）。
    this.drop();
  }

  /** 模拟底层断开：停止投递，两端同时 error/close。 */
  drop() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._timer);
    for (const sender of [this.a, this.b]) {
      this._queues.set(sender, []);
      this._inflight.set(sender, []);
      sender.bufferedAmount = 0;
    }
    for (const endpoint of [this.a, this.b]) {
      if (endpoint.readyState !== 'closed') {
        endpoint._emitError();
        endpoint._emitClose();
      }
    }
  }

  /** 测试辅助：立即搬运一个周期（不等待定时器）。 */
  tick() {
    this._tick();
  }

  _tick() {
    if (this._closed) return;
    for (const sender of [this.a, this.b]) {
      const receiver = sender === this.a ? this.b : this.a;
      const queue = this._queues.get(sender);
      const inflight = this._inflight.get(sender);

      // 1) 控制消息立即送达（不占带宽预算）：
      //    - 必须等它前面的在途块送达，保证 meta/end 与数据块的相对顺序；
      //    - 但不要求待发二进制块先入在途——真实 DataChannel 同一条流上，
      //      send() 顺序即发送顺序，控制消息前面没有未 send 的块。
      while (queue.length && queue[0].kind === 'text' && inflight.length === 0) {
        const ctrl = queue.shift();
        receiver._deliver(ctrl);
        sender.bufferedAmount -= ctrl.size;
      }

      // 2) 底层以固定速率消费在途数据块（真正送达对端），缓冲随之下降。
      //    单条消息可以吃满整个周期预算（不要求 size <= budget 的零头）。
      let budget = this.bytesPerTick;
      while (inflight.length && budget > 0) {
        const message = inflight.shift();
        receiver._deliver(message);
        sender.bufferedAmount -= message.size;
        budget -= Math.min(message.size, budget);
      }

      // 3) 待发数据块进入在途：不改变 bufferedAmount（send 时已计入）。
      //    高水位约束的是“已交给底层、尚未送达”的在途量；待发数据留在
      //    应用侧队列（对应发送方文件里尚未读取的块，不占通道缓冲）。
      while (queue.length && queue[0].kind === 'binary') {
        if (this._inflightBytes(sender) >= this.highWaterMark) break;
        let message = queue.shift();
        if (this._transform) {
          const result = this._transform(sender, message);
          if (result === null) {
            sender.bufferedAmount -= message.size; // 丢失：离开缓冲
            continue;
          }
          if (result.size !== message.size) {
            sender.bufferedAmount += result.size - message.size;
          }
          message = result;
        }
        inflight.push(message);
      }

      // 4) 缓冲（待发+在途）降到阈值以下且此前发生过背压：通知发送方恢复。
      if (this._paused.get(sender)) {
        if (sender.bufferedAmount < this.lowThreshold) {
          this._paused.set(sender, false);
          sender._emitLow();
        }
      } else if (this._inflightBytes(sender) >= this.highWaterMark) {
        this._paused.set(sender, true);
      }
    }
  }

  _inflightBytes(sender) {
    let total = 0;
    for (const m of this._inflight.get(sender)) total += m.size;
    return total;
  }

  _consumeBytes(sender, size) {
    sender.bufferedAmount = Math.max(0, sender.bufferedAmount - size);
  }
}
