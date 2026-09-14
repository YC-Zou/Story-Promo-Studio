import http from "node:http";
import https from "node:https";

const listenHost = "127.0.0.1";
const listenPort = Number(process.env.PROXY_PORT || 4174);
const upstream = new URL(process.env.UPSTREAM_ORIGIN || "https://api.openai-next.com");
const localAddress = process.env.UPSTREAM_LOCAL_ADDRESS || undefined;

if (upstream.protocol !== "https:") throw new Error("UPSTREAM_ORIGIN must use HTTPS");
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error("Invalid PROXY_PORT");

const server = http.createServer((request, response) => {
  if (request.url === "/__proxy_health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, upstream: upstream.origin, local_address: localAddress || null }));
    return;
  }

  const headers = { ...request.headers, host: upstream.host };
  delete headers.connection;
  const outgoing = https.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || 443,
    method: request.method,
    path: request.url,
    headers,
    localAddress,
    servername: upstream.hostname,
    rejectUnauthorized: true,
  }, upstreamResponse => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders.connection;
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });

  outgoing.on("error", cause => {
    if (response.headersSent) return response.destroy(cause);
    response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { message: `上游安全连接失败：${cause.message}` } }));
  });
  request.on("aborted", () => outgoing.destroy());
  request.pipe(outgoing);
});

server.listen(listenPort, listenHost, () => {
  console.log(`API interface proxy listening on http://${listenHost}:${listenPort} -> ${upstream.origin}`);
});
