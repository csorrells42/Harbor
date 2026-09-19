import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Upstreams } from '../src/core/upstreams.mjs';

for (const operation of ['start', 'restart']) {
  for (const running of [false, true]) {
    test(`remove rejects queued ${operation} of a ${running ? 'running' : 'stopped'} upstream without leaking a child`, async t => {
      const config = {
        id: 'fixture', transport: 'stdio', runtime: 'native', command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url))],
        env: {}, autoRestart: false
      };
      const upstreams = new Upstreams([config], () => {});
      // Retain the entry only for failure-safe teardown: the regression can detach it.
      const entry = upstreams.get(config.id);
      t.after(async () => {
        entry.desired = false;
        clearTimeout(entry.retry);
        await entry.queue;
        await upstreams.stopEntry(entry);
        await upstreams.close();
      });
      if (running) await upstreams.start(config.id);
      const originalPid = upstreams.snapshot()[0].pid;
      const [removed, queued] = await Promise.allSettled([
        upstreams.remove(config.id), upstreams[operation](config.id)
      ]);
      const detachedPid = entry.transport?.pid;
      await upstreams.close();
      assert.equal(removed.status, 'fulfilled');
      assert.deepEqual(upstreams.snapshot(), []);
      if (originalPid) assert.throws(() => process.kill(originalPid, 0));
      if (detachedPid) assert.throws(() => process.kill(detachedPid, 0), 'Removed child must not outlive close');
      assert.equal(queued.status, 'rejected', 'Queued work must not start a removed entry');
      assert.match(queued.reason.message, /removed|unknown server/i);
      assert.equal(entry.transport, undefined);
    });
  }
}
