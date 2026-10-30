/* Tiny MQTT 3.1.1-over-WebSocket client (QoS 0 only) used as a message relay
   between the phone camera page and the Launchpad computer page.
   No library, account or server of our own: it talks to a free public broker.
   Only small JSON messages (race result ids, winning lane, receipts, pings) are sent. */
(function (root) {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();

  function str(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
  function packet(type, body) {
    const len = []; let n = body.length;
    do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0);
    return new Uint8Array([type, ...len, ...body]);
  }

  class RelayLink {
    /* urls: broker WebSocket URLs to try in order.
       onMessage(topic, object), onState('connecting'|'online'|'offline', url) */
    constructor(urls, { onMessage, onState } = {}) {
      this.urls = urls; this.index = 0; this.subs = new Set();
      this.onMessage = onMessage || (() => {}); this.onState = onState || (() => {});
      this.ws = null; this.online = false; this.closed = false; this.buf = new Uint8Array(0);
      this.packetId = 1; this.retryTimer = null; this.pingTimer = null; this.connectTimer = null; this.failures = 0;
    }
    get url() { return this.urls[this.index]; }
    start(index = this.index) { this.closed = false; this.index = index; this.connect(); }
    useNext() { this.index = (this.index + 1) % this.urls.length; this.reconnectNow(); }
    reconnectNow() { this.dropSocket(); this.connect(); }
    connect() {
      if (this.closed) return;
      clearTimeout(this.retryTimer);
      this.onState('connecting', this.url);
      let ws;
      try { ws = new WebSocket(this.url, ['mqtt']); } catch (e) { return this.scheduleRetry(); }
      ws.binaryType = 'arraybuffer'; this.ws = ws; this.buf = new Uint8Array(0);
      const clientId = 'lpsb-' + Math.random().toString(36).slice(2, 12);
      ws.onopen = () => {
        // CONNECT: protocol "MQTT", level 4, clean session, 30 s keep-alive.
        ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, 0, 30, ...str(clientId)]));
      };
      ws.onmessage = e => { if (this.ws === ws) this.receive(new Uint8Array(e.data)); };
      ws.onclose = ws.onerror = () => { if (this.ws === ws) { this.dropSocket(); this.scheduleRetry(); } };
      // No CONNACK in time: treat as failure.
      this.connectTimer = setTimeout(() => { if (this.ws === ws && !this.online) { this.dropSocket(); this.scheduleRetry(); } }, 7000);
    }
    scheduleRetry() {
      if (this.closed) return;
      this.failures++;
      // After two failures on one broker, try the next public broker.
      if (this.failures % 2 === 0 && this.urls.length > 1) this.index = (this.index + 1) % this.urls.length;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), Math.min(5000, 800 * this.failures));
    }
    dropSocket() {
      clearTimeout(this.connectTimer); clearInterval(this.pingTimer);
      const ws = this.ws; this.ws = null;
      if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch (_) {} }
      if (this.online) { this.online = false; this.onState('offline', this.url); }
    }
    stop() { this.closed = true; clearTimeout(this.retryTimer); this.subs.clear(); this.dropSocket(); }
    receive(chunk) {
      const merged = new Uint8Array(this.buf.length + chunk.length); merged.set(this.buf); merged.set(chunk, this.buf.length);
      let pos = 0;
      while (pos < merged.length) {
        let mult = 1, len = 0, i = pos + 1, byte;
        do { if (i >= merged.length) { this.buf = merged.slice(pos); return; } byte = merged[i++]; len += (byte & 127) * mult; mult *= 128; } while (byte & 128);
        if (i + len > merged.length) { this.buf = merged.slice(pos); return; }
        this.handle(merged[pos], merged.subarray(i, i + len)); pos = i + len;
      }
      this.buf = new Uint8Array(0);
    }
    handle(header, body) {
      const type = header >> 4;
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { this.dropSocket(); return this.scheduleRetry(); }
        clearTimeout(this.connectTimer); this.online = true; this.failures = 0;
        this.subs.forEach(t => this.sendSubscribe(t));
        this.pingTimer = setInterval(() => this.raw(new Uint8Array([0xC0, 0])), 20000);
        this.onState('online', this.url);
      } else if (type === 3) { // PUBLISH
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        const qos = (header >> 1) & 3;
        const payload = dec.decode(body.subarray(2 + tlen + (qos ? 2 : 0)));
        if (payload.length > 2048) return;
        let msg; try { msg = JSON.parse(payload); } catch (_) { return; }
        this.onMessage(topic, msg);
      }
    }
    raw(bytes) { if (this.ws && this.ws.readyState === 1) { this.ws.send(bytes); return true; } return false; }
    sendSubscribe(topic) {
      const id = this.packetId = (this.packetId % 65535) + 1;
      this.raw(packet(0x82, [id >> 8, id & 255, ...str(topic), 0]));
    }
    subscribe(topic) { this.subs.add(topic); if (this.online) this.sendSubscribe(topic); }
    publish(topic, obj) {
      if (!this.online) return false;
      return this.raw(packet(0x30, [...str(topic), ...enc.encode(JSON.stringify(obj))]));
    }
  }

  const api = { RelayLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RelayLink = RelayLink;
})(typeof self !== 'undefined' ? self : this);
