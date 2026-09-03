// Dev front proxy: HTTP/2 over TLS on :5173 → vite (:5174) and /api → staging.
//
// Why it exists: the browser caps HTTP/1.1 at ~6 connections per origin, and
// this app legitimately holds 7+ Electric long-polls at once — every other
// request (ingest, chunk PUTs, HMR) then queues behind them and the app feels
// frozen. HTTP/2 multiplexes them all over one connection. Going straight to
// the backend from the browser would also solve it, but its CORS config does
// not expose the electric-* headers the client must read.
//
// Self-signed cert: the browser warns once — proceed via Advanced.
import http2 from 'node:http2';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const CERT_DIR = '/tmp/dev-h2-cert';
if (!fs.existsSync(`${CERT_DIR}/cert.pem`)) {
	fs.mkdirSync(CERT_DIR, { recursive: true });
	execSync(
		`openssl req -x509 -newkey rsa:2048 -keyout ${CERT_DIR}/key.pem -out ${CERT_DIR}/cert.pem ` +
		`-days 30 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
	);
}

const VITE = { host: '127.0.0.1', port: 5174 };
const API = { host: 'buckitup.xyz', prefix: '/electric/v1' };

// The TLS server does not own the port: a front socket sniffs the first byte
// so that http://localhost:5173 answers with a redirect instead of dying as
// "ERR_CONNECTION_CLOSED" (plain HTTP spoken at a TLS socket). Whichever URL
// is typed or restored from a tab, it lands in the right place.
const server = http2.createSecureServer({
	key: fs.readFileSync(`${CERT_DIR}/key.pem`),
	cert: fs.readFileSync(`${CERT_DIR}/cert.pem`),
	allowHTTP1: true,
});

server.on('request', (req, res) => {
	const isApi = req.url.startsWith('/api/') || req.url === '/api';
	const headers = { ...req.headers };
	// h2 pseudo-headers must not travel to an h1 upstream
	for (const k of Object.keys(headers)) if (k.startsWith(':')) delete headers[k];

	let upstreamReq;
	if (isApi) {
		headers.host = API.host;
		upstreamReq = https.request({
			host: API.host,
			path: API.prefix + req.url.slice('/api'.length),
			method: req.method,
			headers,
		});
	} else {
		headers.host = `${VITE.host}:${VITE.port}`;
		upstreamReq = http.request({ ...VITE, path: req.url, method: req.method, headers });
	}

	upstreamReq.on('response', (up) => {
		const h = { ...up.headers };
		// hop-by-hop headers are illegal on an HTTP/2 response
		for (const k of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']) delete h[k];
		res.writeHead(up.statusCode, h);
		up.pipe(res);
	});
	upstreamReq.on('error', (e) => {
		if (!res.headersSent) res.writeHead(502);
		res.end(`proxy error: ${e.message}`);
	});
	req.pipe(upstreamReq);
});

// Vite HMR websocket: browsers open WS over HTTP/1.1, which arrives here as
// an upgrade on an allowHTTP1 connection — pipe it raw to vite.
server.on('upgrade', (req, socket, head) => {
	const target = net.connect(VITE, () => {
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
		target.write(lines.join('\r\n') + '\r\n\r\n');
		if (head?.length) target.write(head);
		socket.pipe(target).pipe(socket);
	});
	target.on('error', () => socket.destroy());
});

server.on('tlsClientError', (e) => console.log('[tls error]', e.message));
server.on('sessionError', (e) => console.log('[session error]', e.message));

// Both real servers listen on loopback; the public port is a byte-sniffing
// front that *pipes* to whichever applies. Piping rather than handing the
// socket over: re-emitting 'connection' on a TLS server after unshifting the
// peeked byte loses the rest of the ClientHello and the handshake times out.
const TLS_PORT = 5175;
const REDIRECT_PORT = 5176;

server.listen(TLS_PORT, '127.0.0.1');

http.createServer((req, res) => {
	// Reflect the Host the client used: the container port and the host port
	// need not match — Docker remaps when the requested host port is taken,
	// and a hardcoded port would bounce the browser somewhere unreachable.
	const host = req.headers.host || 'localhost:5173';
	res.writeHead(301, { Location: `https://${host}${req.url}` });
	res.end('dev stand is https (HTTP/2)\n');
}).listen(REDIRECT_PORT, '127.0.0.1');

net.createServer((socket) => {
	socket.once('readable', () => {
		const first = socket.read();
		if (process.env.SNIFF_DEBUG) console.log('[conn] from', socket.remoteAddress, 'bytes=', first ? first.length : 0, 'first=', first ? first[0] : null);
		if (!first) return socket.destroy();
		// 0x16 is the TLS handshake record type; anything else is plain HTTP,
		// which gets redirected instead of dying as ERR_CONNECTION_CLOSED.
		const target = net.connect(first[0] === 0x16 ? TLS_PORT : REDIRECT_PORT, '127.0.0.1', () => {
			target.write(first);
			socket.pipe(target).pipe(socket);
		});
		target.on('error', () => socket.destroy());
	});
	socket.on('error', () => socket.destroy());
}).listen(5173, '0.0.0.0', () => {
	console.log('dev stand: TLS+h2 on container :5173 (http:// redirects to https on the same host:port) → vite :' + VITE.port + ', /api → ' + API.host + API.prefix);
});
