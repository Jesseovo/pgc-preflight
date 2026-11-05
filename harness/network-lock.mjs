import { Socket } from 'node:net';

const port = Number(process.env.PGC_CCB_LOOPBACK_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid CCB loopback port');

const connect = Socket.prototype.connect;
const apply = Reflect.apply;
// Limit the pinned CLI's Socket.connect calls to its task listener. Cloudflare
// separately disables direct container egress.
Object.defineProperty(Socket.prototype, 'connect', {
  configurable: false,
  writable: false,
  value: function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const numeric = typeof values[0] === 'number';
    const target = numeric ? { port: values[0], host: values[1] } : values[0];
    if (!target || typeof target !== 'object' || target.path !== undefined ||
        target.host !== '127.0.0.1' || Number(target.port) !== port) {
      throw Object.assign(new Error('CCB outbound socket denied'), { code: 'PGC_CCB_NETWORK_DENIED' });
    }
    // Native connect must use the checked destination even if the caller's
    // options contain accessors or a mutable, pre-normalized argument array.
    const listener = values[numeric ? 2 : 1];
    return apply(connect, this, [port, '127.0.0.1', listener]);
  },
});
