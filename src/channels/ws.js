/**
 * ws.js — a ~120 line RFC 6455 WebSocket *client*.
 *
 * Node 20 has no stable global WebSocket, and Pinch refuses to pull in a
 * dependency tree just to listen to Discord. This implements exactly what the
 * Discord gateway needs: client masking, text frames, fragmentation, ping/pong,
 * close, and reconnect. It is not a general-purpose server implementation.
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { URL } from "node:url";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2 + 4);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4 + 4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10 + 4);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  mask.copy(header, header.length - 4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}

export class WebSocketClient extends EventEmitter {
  constructor(url, { headers = {}, timeoutMs = 15000 } = {}) {
    super();
    this.url = new URL(url);
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.open = false;
    this.closed = false;
  }

  connect() {
    const secure = this.url.protocol === "wss:";
    const key = randomBytes(16).toString("base64");
    const port = this.url.port || (secure ? 443 : 80);
    const options = {
      host: this.url.hostname,
      port: Number(port),
      servername: secure ? this.url.hostname : undefined,
    };
    const socket = secure ? tlsConnect(options) : netConnect(options);
    this.socket = socket;
    socket.setNoDelay(true);

    const onError = (err) => {
      if (!this.closed) this.emit("error", err);
    };
    socket.once("error", onError);

    const handshake = () => {
      socket.write(
        `GET ${this.url.pathname}${this.url.search} HTTP/1.1\r\n` +
          `Host: ${this.url.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          Object.entries(this.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") +
          `\r\n`
      );
    };

    socket.once(secure ? "secureConnect" : "connect", handshake);

    let handshakeDone = false;
    const timer = setTimeout(() => {
      if (!handshakeDone) {
        socket.destroy();
        this.emit("error", new Error("WebSocket handshake timed out"));
      }
    }, this.timeoutMs);

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);

      if (!handshakeDone) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = this.buffer.subarray(0, end).toString();
        this.buffer = this.buffer.subarray(end + 4);
        const status = Number(head.split(" ")[1] || 0);
        const accept = /sec-websocket-accept:\s*(.+)/i.exec(head)?.[1]?.trim();
        const expected = createHash("sha1").update(key + GUID).digest("base64");
        if (status !== 101 || accept !== expected) {
          socket.destroy();
          return this.emit("error", new Error(`WebSocket handshake failed (${status})`));
        }
        handshakeDone = true;
        clearTimeout(timer);
        socket.removeListener("error", onError);
        socket.on("error", (err) => this.emit("error", err));
        this.open = true;
        this.emit("open");
      }

      this._drain();
    });

    socket.on("close", () => {
      clearTimeout(timer);
      this.open = false;
      if (!this.closed) this.emit("close");
    });
    return this;
  }

  _drain() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }
      this.buffer = this.buffer.subarray(offset + maskLen + len);

      if (opcode === OP.PING) {
        this.socket.write(encodeFrame(OP.PONG, payload));
      } else if (opcode === OP.PONG) {
        this.emit("pong");
      } else if (opcode === OP.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.socket.write(encodeFrame(OP.CLOSE, payload.subarray(0, 2)));
        this.socket.destroy();
        this.open = false;
        if (!this.closed) this.emit("close", code);
        return;
      } else if (opcode === OP.TEXT || opcode === OP.BIN) {
        if (fin) {
          this.emit("message", payload.toString("utf8"));
        } else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        }
      } else if (opcode === OP.CONT) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.fragmentOpcode = null;
          this.emit("message", full);
        }
      }
    }
  }

  send(text) {
    if (!this.open) throw new Error("socket not open");
    this.socket.write(encodeFrame(OP.TEXT, text));
  }

  close(code = 1000) {
    this.closed = true;
    if (this.socket && this.open) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      try { this.socket.write(encodeFrame(OP.CLOSE, payload)); } catch {}
    }
    setTimeout(() => this.socket?.destroy(), 200);
  }
}

export default WebSocketClient;
