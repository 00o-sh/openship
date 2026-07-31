import { describe, expect, it, vi } from "vitest";
import { Duplex } from "node:stream";

class FakeTunnel extends Duplex {
  readonly written: Buffer[] = [];

  _read() {}

  _write(chunk: Buffer, _enc: BufferEncoding, done: () => void) {
    this.written.push(Buffer.from(chunk));
    done();
  }

  /** Everything the caller wrote onto the tunnel, byte for byte. */
  get sent(): string {
    return Buffer.concat(this.written).toString("latin1");
  }
}

const active = vi.hoisted(() => ({ tunnel: null as FakeTunnel | null }));

vi.mock("../../src/lib/ssh-manager", () => ({
  sshManager: {
    acquire: async () => ({ forwardPort: async () => active.tunnel }),
  },
}));

import { tunnelRequest } from "../../src/lib/ssh-tunnel";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function openTunnel(): FakeTunnel {
  const tunnel = new FakeTunnel();
  active.tunnel = tunnel;
  return tunnel;
}

/** Resolves once the caller has written its request head onto the tunnel. */
async function awaitRequest(tunnel: FakeTunnel): Promise<string> {
  for (let i = 0; i < 100 && tunnel.written.length === 0; i++) await tick();
  await tick();
  return tunnel.sent;
}

/** Reply to the pending request with `raw`, then close the connection. */
async function reply(tunnel: FakeTunnel, raw: string, close = true) {
  await awaitRequest(tunnel);
  tunnel.push(Buffer.from(raw, "latin1"));
  if (close) tunnel.destroy();
}

const CHUNKED_BODY = '7\r\n{"a":1}\r\n0\r\n\r\n';

describe("tunnelRequest chunked framing", () => {
  it("decodes a lowercase chunked body", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${CHUNKED_BODY}`);

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("decodes a chunked body announced with different casing", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, `HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n${CHUNKED_BODY}`);

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("strips the chunk framing when chunked is listed after another coding", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(
      tunnel,
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n${CHUNKED_BODY}`,
    );

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("leaves a body with no transfer-encoding untouched", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{"a":1}');

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });
});

describe("tunnelRequest truncated responses", () => {
  it("fails a chunked body cut before the terminating chunk", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"a":1}\r\n');

    expect(await pending).toBeNull();
  });

  it("fails a response that delivers fewer bytes than Content-Length", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{"a":1}');

    expect(await pending).toBeNull();
  });

  it("fails a connection that closes before the response head is complete", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, "HTTP/1.1 200 OK\r\nContent-Len");

    expect(await pending).toBeNull();
  });

  it("returns the body of a complete chunked response", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${CHUNKED_BODY}`);

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("returns the buffered body when the response has no length framing", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"a":1}');

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });
});
