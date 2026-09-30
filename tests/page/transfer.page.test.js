// 页面级测试：两个真实浏览器页面走一次完整的“手工复制 SDP → 建立 DataChannel
// → 发送文件 → 校验 → 下载”流程。文件内容与 SHA-256 在测试进程内独立校验。
import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { startServer } from './static-server.js';
import { launchEnv, launchArgs } from './browser-env.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectTwoPages(baseURL, pageQuery = '/?ice=host') {
  const browser = await chromium.launch({
    headless: true,
    env: launchEnv(),
    args: launchArgs,
  });
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  // 同机测试：只用 host 候选，跳过公网 STUN。
  await pageA.goto(`${baseURL}${pageQuery}`);
  await pageB.goto(`${baseURL}${pageQuery}`);

  // A 作为发起方生成连接信息
  await pageA.click('#offer-btn');
  await expect(pageA.locator('#signal-out')).not.toHaveValue('');
  const offer = await pageA.inputValue('#signal-out');

  // B 选择应答方角色，粘贴 offer，生成应答
  await pageB.check('input[name="role"][value="answer"]');
  await pageB.fill('#signal-in', offer);
  await pageB.click('#answer-btn');
  await expect(pageB.locator('#signal-out')).not.toHaveValue('');
  const answer = await pageB.inputValue('#signal-out');

  // A 粘贴 answer 并接受
  await pageA.fill('#signal-in', answer);
  await pageA.click('#accept-btn');

  // 两端都应明确显示已连接，且传输面板出现
  await expect(pageA.locator('#conn-state')).toHaveText(/已连接/);
  await expect(pageB.locator('#conn-state')).toHaveText(/已连接/);
  await expect(pageA.locator('#transfer-panel')).toBeVisible();
  await expect(pageB.locator('#transfer-panel')).toBeVisible();

  return { browser, pageA, pageB };
}

function patternBytes(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

test('双端页面：手工信令建立连接并完整传输、校验、下载一个文件', async () => {
  const { server } = await startServer(0);
  const baseURL = `http://127.0.0.1:${server.address().port}`;

  const { browser, pageA, pageB } = await connectTwoPages(baseURL);

  try {
    // ---- 先验证超限文件被明确拒绝，且对端无任何反应 ----
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1, 0xab);
    await pageA.setInputFiles('#file-input', { name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: tooBig });
    await pageA.click('#send-btn');
    await expect(pageA.locator('#xfer-state')).toHaveText(/失败/);
    await expect(pageA.locator('#xfer-error')).toContainText(/上限/);
    // 对端不应收到 meta
    await expect(pageB.locator('#xfer-state')).toHaveText(/空闲/);

    // ---- 正常文件：大小刻意非块对齐，覆盖多块 + 尾块 ----
    const size = 50_000;
    const bytes = patternBytes(size);
    const expectedHash = createHash('sha256').update(bytes).digest('hex');

    await pageA.setInputFiles('#file-input', { name: 'greeting.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await pageA.click('#send-btn');

    // 发送方与接收方都显示完成（而非模糊的“已发送”）
    await expect(pageA.locator('#xfer-state')).toHaveText(/完成/, { timeout: 30_000 });
    await expect(pageB.locator('#xfer-state')).toHaveText(/完成/, { timeout: 30_000 });

    // 进度到 100%
    await expect(pageB.locator('#progress-text')).toContainText('100.0%');

    // 仅在哈希校验通过后才出现下载入口，且页面展示的哈希与独立计算一致
    const downloadLink = pageB.locator('#download-box a.download');
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toContainText('greeting.bin');
    await expect(pageB.locator('#hash-box')).toContainText(expectedHash);

    // 主动点击下载并比对内容（Playwright 把 <a download> 转为 download 事件）
    const [download] = await Promise.all([
      pageB.waitForEvent('download', { timeout: 10_000 }),
      downloadLink.click(),
    ]);
    expect(download.suggestedFilename()).toBe('greeting.bin');
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const got = Buffer.concat(chunks);
    expect(got.length).toBe(size);
    expect(got.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(got).digest('hex')).toBe(expectedHash);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

test('双端页面：传输中取消，双方明确显示取消且接收方不提供下载', async () => {
  const { server } = await startServer(0);
  const baseURL = `http://127.0.0.1:${server.address().port}`;

  const { browser, pageA, pageB } = await connectTwoPages(baseURL, '/?ice=host&chunkDelay=10');

  try {
    // 每块 10ms 延迟 + 512 KiB（32 块），制造稳定的“传输进行中”取消窗口
    const bytes = patternBytes(512 * 1024);
    await pageA.setInputFiles('#file-input', { name: 'cancel-me.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await pageA.click('#send-btn');

    // 等接收方进入接收状态后立刻由发送方取消
    await expect(pageB.locator('#xfer-state')).toHaveText(/传输中|计算哈希中/);
    // 等到发送按钮区出现取消按钮再点
    await expect(pageA.locator('#cancel-send')).toBeVisible();
    await pageA.click('#cancel-send');

    await expect(pageA.locator('#xfer-state')).toHaveText(/已取消/, { timeout: 15_000 });
    await expect(pageB.locator('#xfer-state')).toHaveText(/已取消/, { timeout: 15_000 });

    // 关键：没有下载链接，进度被清零
    await expect(pageB.locator('#download-box')).toBeHidden();
    await expect(pageB.locator('#progress-text')).toHaveText('');
    await sleep(200);
    // 取消后迟到数据不会再完成传输
    await expect(pageB.locator('#xfer-state')).toHaveText(/已取消/);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
