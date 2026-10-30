'use strict';
/* ─── Zero-dependency mDNS/DNS-SD browser for Castor receivers ──────────────
 *
 * Browses for `_castor._tcp` services (what Castor advertises, see
 * Castor's packages/core/src/mdns.ts) using "legacy unicast queries":
 * the query is sent from an ephemeral UDP port to the multicast group, so
 * responders (avahi / bonjour-service) reply unicast back to this socket —
 * no multicast membership is needed to receive answers.
 *
 * NOTE: a Docker bridge network does not forward LAN multicast, so discovery
 * from inside a bridged container finds nothing. Run the container with
 * `network_mode: host` (see docker-compose.yml) for discovery to work.
 * Manual receiver entry in the UI works regardless of this.
 */

const dgram = require('dgram');
const os = require('os');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_castor._tcp.local';

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

function encodeName(name) {
  const bufs = [];
  for (const label of String(name).replace(/\.$/, '').split('.')) {
    if (!label) continue;
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) return null;
    bufs.push(Buffer.from([bytes.length]), bytes);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

/** Decode a possibly-compressed DNS name. Returns { name, next }. */
function decodeName(buf, off) {
  const labels = [];
  let pos = off;
  let next = -1;
  let guard = 0;
  for (;;) {
    if (pos >= buf.length || guard++ > 128) return { name: labels.join('.'), next: buf.length };
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (next < 0) next = pos + 2;
      pos = ptr;
      continue;
    }
    labels.push(buf.slice(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next };
}

/** Parse every record of an mDNS response (answer + authority + additional). */
function parseResponse(msg) {
  if (msg.length < 12) return [];
  const qd = msg.readUInt16BE(4);
  const an = msg.readUInt16BE(6);
  const ar = msg.readUInt16BE(10);
  let off = 12;
  // Skip the question section.
  for (let i = 0; i < qd && off < msg.length; i++) {
    const n = decodeName(msg, off);
    off = n.next + 4; // QTYPE + QCLASS
  }
  const total = an + msg.readUInt16BE(8) + ar;
  const records = [];
  for (let i = 0; i < total && off + 10 <= msg.length; i++) {
    const n = decodeName(msg, off);
    if (n.next + 10 > msg.length) break;
    const type = msg.readUInt16BE(n.next);
    const dataLen = msg.readUInt16BE(n.next + 8);
    const dataStart = n.next + 10;
    if (dataStart + dataLen > msg.length) break;
    records.push({
      name: n.name.toLowerCase(),
      type,
      dataStart,
      data: msg.slice(dataStart, dataStart + dataLen),
      buf: msg,
    });
    off = dataStart + dataLen;
  }
  return records;
}

function parseTxt(data) {
  const kv = {};
  let off = 0;
  while (off < data.length) {
    const len = data[off];
    if (len === 0) break;
    const entry = data.slice(off + 1, off + 1 + len).toString('utf8');
    off += 1 + len;
    const eq = entry.indexOf('=');
    if (eq > 0) kv[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return kv;
}

/** Build service entries from one response packet. */
function servicesFromResponse(msg, rinfo) {
  const records = parseResponse(msg);
  const ptrs = records.filter(r => r.type === TYPE_PTR && r.name === SERVICE);
  const out = [];
  const SERVICE_SUFFIX = /\._castor\._tcp\.local\.?$/i;
  for (const ptr of ptrs) {
    const fullName = decodeName(ptr.buf, ptr.dataStart).name;
    const instance = fullName.replace(SERVICE_SUFFIX, '');
    const inst = fullName.toLowerCase();
    const srv = records.find(r => r.type === TYPE_SRV && r.name === inst);
    if (!srv) continue;
    const port = srv.data.readUInt16BE(4);
    const target = decodeName(srv.buf, srv.dataStart + 6).name.toLowerCase();
    const a = records.find(r => r.type === TYPE_A && r.name === target);
    const txtRec = records.find(r => r.type === TYPE_TXT && r.name === inst);
    // The responder's source address is authoritative when no A record
    // for the SRV target is included in the packet.
    const ip = a
      ? Array.from(a.data.slice(0, 4)).join('.')
      : rinfo.address;
    out.push({
      name: instance.replace(/\\([.\\])/g, '$1') || ip,
      ip,
      port,
      url: `http://${ip}:${port}`,
      txt: txtRec ? parseTxt(txtRec.data) : {},
    });
  }
  return out;
}

function buildQuery() {
  const header = Buffer.alloc(12);
  // id=0, flags=0, one question. Legacy unicast: sent from an ephemeral
  // port, so responders reply unicast to us.
  header.writeUInt16BE(1, 4); // QDCOUNT
  const qname = encodeName(SERVICE);
  const qtail = Buffer.alloc(4);
  qtail.writeUInt16BE(TYPE_PTR, 0);
  qtail.writeUInt16BE(1, 2); // QCLASS IN
  return Buffer.concat([header, qname, qtail]);
}

/**
 * One receiver can be seen on several addresses when it shares the host with
 * docker bridges (avahi replies on every interface the query reaches). The
 * bridge addresses (172.16.0.0/12, link-local) are usually not routable from
 * the devices that use this browser, so group by instance name + port and
 * keep the most LAN-looking address for each receiver.
 */
function ipScore(ip) {
  if (/^169\.254\./.test(ip)) return 0;
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return 0;
  if (Number(m[1]) === 172 && Number(m[2]) >= 16 && Number(m[2]) <= 31) return 0;
  return 1;
}

function dedupeServices(list) {
  const best = new Map();
  for (const svc of list) {
    const key = svc.name.toLowerCase() + '|' + svc.port;
    const cur = best.get(key);
    if (!cur || ipScore(svc.ip) > ipScore(cur.ip)) best.set(key, svc);
  }
  return [...best.values()];
}

/**
 * Browse the LAN for Castor receivers.
 *
 * The query is sent on every non-internal IPv4 interface: the OS's default
 * multicast egress may be a VPN/tunnel interface that never sees the LAN's
 * multicast traffic (measured on a machine whose default route was a WG
 * tunnel — replies only arrived when querying via the LAN NIC explicitly).
 *
 * @param {number} [timeoutMs] how long to listen for responses
 * @returns {Promise<Array<{name, ip, port, url, txt}>>} deduped by url
 */
function browse(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
      resolve(dedupeServices([...found.values()]));
    };

    const timer = setTimeout(finish, timeoutMs);

    const handleMessage = (msg, rinfo) => {
      if (rinfo.address.startsWith('127.')) return;
      for (const svc of servicesFromResponse(msg, rinfo)) {
        if (!found.has(svc.url)) found.set(svc.url, svc);
      }
    };

    // One egress target per LAN interface; fall back to the default route.
    const targets = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) targets.push(a.address);
      }
    }
    if (targets.length === 0) targets.push(null);

    const query = buildQuery();
    if (!query) return finish();

    for (const addr of targets) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(sock);
      sock.on('message', handleMessage);
      sock.on('error', () => { try { sock.close(); } catch { /* closed */ } });
      sock.bind(() => {
        if (addr) {
          try { sock.setMulticastInterface(addr); } catch { /* default egress */ }
        }
        const sendQuery = () => sock.send(query, MDNS_PORT, MDNS_GROUP, () => {});
        sendQuery();
        // A second query improves reliability against packet loss.
        setTimeout(() => { if (!closed) sendQuery(); }, 400);
      });
    }
  });
}

module.exports = { browse };