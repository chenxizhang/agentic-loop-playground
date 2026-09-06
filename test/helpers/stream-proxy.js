import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";

// A loopback-only fault fixture, not an application proxy or an SSH substitute.
export async function createStreamProxy(target, { fragment = false, holdMs = 0, seed = 431 } = {}) {
  const upstreamOrigin = new URL(target);
  const sockets = new Set();
  const requests = new Set();
  const metrics = { seed, bytes: 0, fragments: 0, maximumChunk: 0, lane: "fault-proxy" };
  let random = seed;
  const server = createServer((incoming, outgoing) => {
    const upstream = httpRequest(new URL(incoming.url, upstreamOrigin), {
      method: incoming.method,
      headers: {
        ...incoming.headers,
        host: upstreamOrigin.host,
        ...(incoming.headers.origin ? { origin: upstreamOrigin.origin } : {})
      }
    });
    requests.add(upstream);
    upstream.on("close", () => requests.delete(upstream));
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(`Fixture upstream failed: ${error.message}`);
    });
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
    upstream.on("response", async (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      const streaming = response.headers["content-type"]?.startsWith("text/event-stream");
      try {
        if (streaming && holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
        for await (const chunk of response) {
          metrics.maximumChunk = Math.max(metrics.maximumChunk, chunk.length);
          for (let offset = 0; offset < chunk.length;) {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            const size = streaming && fragment ? 1 + random % 97 : chunk.length;
            const part = chunk.subarray(offset, offset + size);
            offset += part.length;
            metrics.bytes += part.length;
            metrics.fragments++;
            if (outgoing.destroyed) break;
            if (!outgoing.write(part)) await once(outgoing, "drain", { signal: AbortSignal.timeout(5000) });
          }
        }
        outgoing.end();
      } catch (error) {
        if (!outgoing.destroyed) outgoing.destroy(error);
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    metrics,
    async close() {
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
