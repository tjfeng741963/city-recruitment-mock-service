import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { PuppetWeChat } from 'wechaty-puppet-wechat';
import { configureWebNavigation } from '../web-navigation.mjs';

test('initializes the SDK while its login long poll keeps the load event pending', { timeout: 30000 }, async () => {
  let polls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/poll') {
      polls++;
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.flushHeaders(); // Deliberately open until the browser closes.
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Login ready</title><body>Scan to log in<script>const s=document.createElement("script");s.src="/poll";document.head.appendChild(s)</script></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const bridge = new PuppetWeChat({ stealthless: true }).bridge;
  bridge.options.memory = { get: async () => [] };
  bridge.entryUrl = () => `http://127.0.0.1:${port}`;
  let title;
  bridge.onLoad = async page => { title = await page.title(); bridge.emit('ready'); };
  bridge.on('error', () => {});
  configureWebNavigation(bridge);
  let timer;
  const started = bridge.start();
  try {
    await Promise.race([
      started,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SDK never became ready while the login poll was open')), 8000); }),
    ]);
    clearTimeout(timer);
    assert.equal(title, 'Login ready');
    assert.ok(polls > 0);
    // The same fix must survive QR expiration/watchdog reloads.
    await Promise.race([
      bridge.reload(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QR reload waited for the login poll')), 8000); }),
    ]);
    clearTimeout(timer);
    assert.equal(await bridge.page.evaluate(() => document.readyState), 'interactive');
  } finally {
    clearTimeout(timer);
    await bridge.stop().catch(() => {});
    bridge.emit('ready'); // Release the upstream ready waiter even on test failure.
    await started.catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
