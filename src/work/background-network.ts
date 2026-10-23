import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";

// Only public HTTPS destinations. Resolve once and connect to that exact address,
// so a hostname cannot rebind to a local Taxi/CDP/SSH service after validation.
export function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false; // IPv6 is deliberately fail-closed in v1.
  const [a = 0, b = 0] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}

export async function backgroundNetwork() {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(403);
    res.end("Public HTTPS CONNECT only");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("connect", async (req, downstream, head) => {
    try {
      const target = new URL(`https://${req.url}`);
      if ((target.port && target.port !== "443") || target.username || target.password || target.pathname !== "/")
        throw new Error("Unsupported target");
      const addresses = await lookup(target.hostname, { family: 4, all: true });
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
        throw new Error("Local target");
      if (downstream.destroyed) return;
      const upstream = connect({ host: addresses[0]!.address, port: 443 });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => downstream.destroy());
      downstream.on("close", () => upstream.destroy());
      upstream.setTimeout(300_000, () => upstream.destroy());
      upstream.once("connect", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
    } catch {
      downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
