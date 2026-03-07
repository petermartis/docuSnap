#!/usr/bin/env node
/**
 * docuSnap demo — ID R&D liveness proxy
 * ─────────────────────────────────────
 * The ID R&D cloud API (idlivedoc-rest-api.idrnd.net) is a server-side API
 * that does not emit CORS headers, so browsers cannot call it directly.
 *
 * Run this tiny proxy on your local machine and point the demo's
 * "Liveness proxy URL" field at it (default: http://localhost:3001).
 *
 * Usage:
 *   node demo/proxy.js
 *   # or:
 *   PROXY_PORT=3001 IDRND_API_KEY=your_key node demo/proxy.js
 *
 * No npm install required — uses only Node.js built-ins.
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT         = parseInt(process.env.PROXY_PORT  || '3001', 10);
const IDRND_KEY    = process.env.IDRND_API_KEY || 'ouwWh6b3AB7rOIVVF3I5daGP20M0ncq83S0funej';
const IDRND_HOST   = 'idlivedoc-rest-api.idrnd.net';
const IDRND_PATH   = '/check_liveness';
const CONFIG_FILE  = path.join(__dirname, 'config.json');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
};

const server = http.createServer(function (req, res) {
  // ── CORS pre-flight ───────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // ── Shared config read/write ────────────────────────────────────────────
  if (req.url === '/config') {
    if (req.method === 'GET') {
      fs.readFile(CONFIG_FILE, 'utf8', function (err, data) {
        if (err) {
          res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
        res.end(data);
      });
      return;
    }
    if (req.method === 'POST') {
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        try {
          var incoming = JSON.parse(Buffer.concat(chunks).toString());
          // Read existing config, merge, write back
          var existing = {};
          try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { /* new file */ }
          Object.assign(existing, incoming);
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2) + '\n');
          res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  if (req.method !== 'POST' || req.url !== '/check_liveness') {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, CORS_HEADERS));
    res.end('Not found. POST /check_liveness or GET/POST /config');
    return;
  }

  // ── Collect request body ──────────────────────────────────────────────────
  var chunks = [];
  req.on('data', function (chunk) { chunks.push(chunk); });
  req.on('end', function () {
    var body = Buffer.concat(chunks);

    // ── Forward to ID R&D ─────────────────────────────────────────────────
    var options = {
      hostname: IDRND_HOST,
      port:     443,
      path:     IDRND_PATH,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': body.length,
        'x-api-key':      IDRND_KEY,
      },
    };

    var upstream = https.request(options, function (upRes) {
      var upChunks = [];
      upRes.on('data', function (c) { upChunks.push(c); });
      upRes.on('end', function () {
        var respHeaders = Object.assign(
          { 'Content-Type': 'application/json' },
          CORS_HEADERS
        );
        res.writeHead(upRes.statusCode, respHeaders);
        res.end(Buffer.concat(upChunks));
      });
    });

    upstream.on('error', function (err) {
      console.error('[proxy] upstream error:', err.message);
      res.writeHead(502, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
      res.end(JSON.stringify({ error: 'Upstream error: ' + err.message }));
    });

    upstream.write(body);
    upstream.end();
  });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('');
  console.log('  docuSnap liveness proxy running');
  console.log('  ───────────────────────────────');
  console.log('  Listening : http://127.0.0.1:' + PORT);
  console.log('  Forwards  : https://' + IDRND_HOST + IDRND_PATH);
  console.log('  API key   : ' + IDRND_KEY.slice(0, 6) + '…');
  console.log('');
  console.log('  Set "Liveness proxy URL" in the demo to:');
  console.log('  http://localhost:' + PORT);
  console.log('');
});
