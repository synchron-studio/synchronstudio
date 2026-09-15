const { test } = require('node:test');
const assert = require('node:assert/strict');
const { downloadBlob, waitMedia, seekMedia } = require('../reliability.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function video(overrides = {}) {
  return Object.assign(new EventTarget(), { readyState: 0, currentTime: 0, seeking: false, buffered: { length: 0 }, ...overrides });
}

test('media timeout rejects instead of reporting 100%', async () => {
  const progress = [];
  await assert.rejects(waitMedia(video(), { timeoutMs: 10, onProgress: p => progress.push(p) }), /timed out/);
  assert.ok(!progress.includes(100));
});
test('loaded media succeeds, and unsupported media fails immediately', async () => {
  await waitMedia(video({readyState:3}));
  await assert.rejects(waitMedia(video({error:{code:4}})), /Video error/);
});
test('no-op seek completes without a four-second delay', async () => {
  await seekMedia(video(), 0, {timeoutMs:10});
});
test('stalled seek rejects and removes its polling timer', async () => {
  await assert.rejects(seekMedia(video({seeking:true}), 2, {timeoutMs:10}), /timed out/);
});
test('cancelled media waits do not report readiness', async () => {
  const controller = new AbortController();
  const waiting = waitMedia(video(), {signal:controller.signal});
  controller.abort();
  await assert.rejects(waiting, {name:'AbortError'});
});
test('a slow but progressing download is allowed to finish', async t => {
  t.mock.method(global, 'fetch', async () => new Response(new ReadableStream({
    async start(controller) {
      for (let i=0; i<5; i++) { controller.enqueue(new Uint8Array([i])); await delay(10); }
      controller.close();
    }
  }), {headers:{'content-length':'5'}}));
  const progress = [];
  const blob = await downloadBlob('test', {stallMs:40, onProgress:p=>progress.push(p)});
  assert.equal(blob.size, 5);
  assert.equal(progress.at(-1),100);
});
test('stalled requests abort and release the network request', async t => {
  let aborted = false;
  t.mock.method(global, 'fetch', (url,{signal}) => new Promise((resolve,reject) => {
    signal.addEventListener('abort', () => {aborted=true; reject(new DOMException('aborted','AbortError'));});
  }));
  await assert.rejects(downloadBlob('test',{stallMs:10}), /stalled/);
  assert.equal(aborted,true);
});
test('caller cancellation remains AbortError and does not become a stall', async t => {
  const controller = new AbortController();
  t.mock.method(global, 'fetch', (url,{signal}) => new Promise((resolve,reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted','AbortError')));
  }));
  const waiting = downloadBlob('test',{signal:controller.signal});
  controller.abort();
  await assert.rejects(waiting, {name:'AbortError'});
});
test('HTTP failures and empty downloads are rejected', async t => {
  const mock = t.mock.method(global,'fetch', async()=>new Response('missing',{status:404}));
  await assert.rejects(downloadBlob('test'), /HTTP 404/);
  mock.mock.mockImplementation(async()=>new Response(''));
  await assert.rejects(downloadBlob('test'), /Empty/);
});
