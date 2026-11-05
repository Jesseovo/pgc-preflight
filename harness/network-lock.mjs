import { Socket } from 'node:net';

const port = Number(process.env.PGC_CCB_LOOPBACK_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid CCB loopback port');

const connect = Socket.prototype.connect;
// Node 24 file/process permissions do not restrict network access. Keep the
// pinned CLI on its task's one loopback listener; the container separately
// denies direct egress at the Cloudflare boundary.
Object.defineProperty(Socket.prototype, 'connect', {
  configurable: false,
  writable: false,
  value: function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const target = typeof values[0] === 'number'
      ? { port: values[0], host: values[1] }
      : values[0];
    if (!target || typeof target !== 'object' || target.path !== undefined ||
        target.host !== '127.0.0.1' || Number(target.port) !== port) {
      throw Object.assign(new Error('CCB outbound socket denied'), { code: 'PGC_CCB_NETWORK_DENIED' });
    }
    return Reflect.apply(connect, this, args);
  },
});
