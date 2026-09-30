// 页面测试共享的浏览器启动参数：
// 在没有 root 安装系统包的沙箱里，通过 LD_LIBRARY_PATH 指向解压出的 Chromium 依赖。
import { existsSync } from 'node:fs';

const localLibDirs = [
  '/home/node/chromelibs/root/usr/lib/aarch64-linux-gnu',
  '/home/node/chromelibs/root/lib/aarch64-linux-gnu',
].filter(existsSync);

export function launchEnv() {
  if (!localLibDirs.length) return undefined;
  return {
    ...process.env,
    LD_LIBRARY_PATH: `${localLibDirs.join(':')}:${process.env.LD_LIBRARY_PATH ?? ''}`,
  };
}

export const launchArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--allow-loopback-in-peer-connection',
];
