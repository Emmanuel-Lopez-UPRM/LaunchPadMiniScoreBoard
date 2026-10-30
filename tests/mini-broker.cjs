// Minimal MQTT 3.1.1 broker over WebSocket for tests only (QoS 0, exact-match topics).
// Lets the browser suite exercise the real relay client without internet access.
const http = require('node:http');
const crypto = require('node:crypto');

function startBroker() {
  const clients = new Set();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, 'Sec-WebSocket-Protocol: mqtt', '', ''].join('\r\n'));
    const client = { socket, subs: new Set(), wsBuf: Buffer.alloc(0), mqBuf: Buffer.alloc(0) };
    clients.add(client);
    const sendWs = data => {
      const len = data.length;
      const head = len < 126 ? Buffer.from([0x82, len]) : len < 65536 ? Buffer.from([0x82, 126, len >> 8, len & 255]) : null;
      if (head && !socket.destroyed) socket.write(Buffer.concat([head, data]));
    };
    client.send = sendWs;
    socket.on('data', chunk => {
      client.wsBuf = Buffer.concat([client.wsBuf, chunk]);
      while (client.wsBuf.length >= 2) {
        const b = client.wsBuf, op = b[0] & 15, masked = b[1] & 128;
        let len = b[1] & 127, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { socket.destroy(); return; }
        const total = off + (masked ? 4 : 0) + len;
        if (b.length < total) return;
        const mask = masked ? b.subarray(off, off + 4) : null;
        const payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), total));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        client.wsBuf = b.subarray(total);
        if (op === 8) { socket.end(); return; }
        if (op === 2 || op === 0) onMqtt(client, payload);
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });
  function onMqtt(client, chunk) {
    client.mqBuf = Buffer.concat([client.mqBuf, chunk]);
    for (;;) {
      const b = client.mqBuf; if (b.length < 2) return;
      let mult = 1, len = 0, i = 1, byte;
      do { if (i >= b.length) return; byte = b[i++]; len += (byte & 127) * mult; mult *= 128; } while (byte & 128);
      if (b.length < i + len) return;
      const header = b[0], body = b.subarray(i, i + len), whole = Buffer.from(b.subarray(0, i + len));
      client.mqBuf = b.subarray(i + len);
      const type = header >> 4;
      if (type === 1) client.send(Buffer.from([0x20, 2, 0, 0]));
      else if (type === 8) {
        const topicLen = body.readUInt16BE(2);
        client.subs.add(body.subarray(4, 4 + topicLen).toString());
        client.send(Buffer.from([0x90, 3, body[0], body[1], 0]));
      } else if (type === 3) {
        const topicLen = body.readUInt16BE(0), topic = body.subarray(2, 2 + topicLen).toString();
        for (const c of clients) if (c.subs.has(topic)) c.send(whole);
      } else if (type === 12) client.send(Buffer.from([0xD0, 0]));
      else if (type === 14) client.socket.end();
    }
  }
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `ws://127.0.0.1:${server.address().port}/mqtt`,
    dropAll() { for (const c of clients) c.socket.destroy(); },
    close() { for (const c of clients) c.socket.destroy(); server.close(); }
  })));
}
module.exports = { startBroker };
