/**
 * fennec-mcp.test.ts — unit contract for the RDP bridge (no device needed).
 *
 * Pins the Firefox 159 protocol facts the live bridge depends on:
 *   - server frames: <len>:<json>, possibly split across TCP segments
 *   - client frames: <len>:<json> (newline barebone dropped in 159)
 *   - hello arrives UNPROMPTED; unclaimed frames buffer until claimed
 */
import { describe, test, expect, afterAll } from "bun:test";
import * as net from "node:net";
import { FennecRDP } from "../src/fennec-mcp.ts";

let clientSock: net.Socket | null = null;

const server = net.createServer((sock) => { clientSock = sock; });
let port = 0;
server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; });
afterAll(() => server.close());

function sendFrame(f: unknown): void {
  const p = Buffer.from(JSON.stringify(f), "utf8");
  clientSock?.write(Buffer.concat([Buffer.from(`${p.length}:`, "ascii"), p]));
}

async function waitPort(): Promise<number> {
  for (let i = 0; i < 20 && !port; i++) await new Promise((r) => setTimeout(r, 25));
  return port;
}

describe("FennecRDP framing (unit)", () => {
  test("hello arrives unprompted and buffers until claimed", async () => {
    const p = await waitPort();
    const rdp = new FennecRDP(p);
    await new Promise((r) => setTimeout(r, 50));
    sendFrame({ from: "root", applicationType: "browser" }); // server pushes hello, no request
    const hello = await rdp.nextFrame(2000);
    expect(hello).not.toBeNull();
    expect(hello!.from).toBe("root");
    rdp.close();
  });

  test("split TCP segments reassemble into one frame", async () => {
    const p = await waitPort();
    const rdp = new FennecRDP(p);
    await new Promise((r) => setTimeout(r, 50));
    const payload = JSON.stringify({ from: "root", tabs: [1, 2, 3] });
    const full = `${payload.length}:${payload}`;
    clientSock!.write(full.slice(0, 3));
    setTimeout(() => clientSock!.write(full.slice(3, 10)), 20);
    setTimeout(() => clientSock!.write(full.slice(10)), 40);
    const f = await rdp.nextFrame(3000);
    expect(f).not.toBeNull();
    expect(f!.tabs).toEqual([1, 2, 3]);
    rdp.close();
  });

  test("client sends are length-prefixed (159 transport)", async () => {
    const p = await waitPort();
    const rdp = new FennecRDP(p);
    await new Promise((r) => setTimeout(r, 50));
    let received = "";
    clientSock!.on("data", (d: Buffer) => (received += d.toString()));
    void rdp.request({ to: "root", type: "listTabs" }, 100);
    await new Promise((r) => setTimeout(r, 80));
    expect(received).toMatch(/^\d+:\{/);
    expect(received).not.toContain("\n");
    rdp.close();
  });

  test("request resolves with the next frame; timeout yields null", async () => {
    const p = await waitPort();
    const rdp = new FennecRDP(p);
    await new Promise((r) => setTimeout(r, 50));
    setTimeout(() => sendFrame({ from: "root", tabs: [] }), 100);
    const f = await rdp.request({ to: "root", type: "listTabs" }, 3000);
    expect(f).not.toBeNull();
    expect(f!.tabs).toEqual([]);
    const none = await rdp.request({ to: "root", type: "listTabs" }, 200);
    expect(none).toBeNull();
    rdp.close();
  });
});
