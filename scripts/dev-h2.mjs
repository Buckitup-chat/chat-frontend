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

server.listen(5173, '0.0.0.0', () => {
	console.log('h2 dev proxy on https://localhost:5173 → vite :5174, /api → ' + API.host + API.prefix);
});
