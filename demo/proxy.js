#!/usr/bin/env node
/**
 * docuSnap demo — API proxy (liveness + Anthropic)
 * ─────────────────────────────────────────────────
 * Routes:
 *   POST /check_liveness  → ID R&D liveness API
 *   POST /anthropic       → Anthropic Messages API (Claude Vision)
 *   GET/POST /config      → shared config read/write
 *
 * Run this tiny proxy on your local machine and point the demo's
 * "Liveness proxy URL" field at it (default: http://localhost:3001).
 *
 * Usage:
 *   node demo/proxy.js
 *   # or:
 *   PROXY_PORT=3001 IDRND_API_KEY=your_key ANTHROPIC_API_KEY=sk-ant-... node demo/proxy.js
 *
 * No npm install required — uses only Node.js built-ins.
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT            = parseInt(process.env.PROXY_PORT  || '3001', 10);
const IDRND_KEY       = process.env.IDRND_API_KEY || 'ouwWh6b3AB7rOIVVF3I5daGP20M0ncq83S0funej';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const IDRND_HOST      = 'idlivedoc-rest-api.idrnd.net';
const IDRND_PATH      = '/check_liveness';
const ANTHROPIC_HOST  = 'api.anthropic.com';
const ANTHROPIC_PATH  = '/v1/messages';
const CONFIG_FILE     = path.join(__dirname, 'config.json');

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

  if (req.method !== 'POST') {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, CORS_HEADERS));
    res.end('Not found. POST /check_liveness, POST /anthropic, or GET/POST /config');
    return;
  }

  // ── Route: determine upstream target ────────────────────────────────────
  var upHost, upPath, upHeaders;
  if (req.url === '/check_liveness') {
    upHost = IDRND_HOST;
    upPath = IDRND_PATH;
    upHeaders = { 'Content-Type': 'application/json', 'x-api-key': IDRND_KEY };
  } else if (req.url === '/anthropic') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured. Set env var and restart.' }));
      return;
    }
    upHost = ANTHROPIC_HOST;
    upPath = ANTHROPIC_PATH;
    upHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    };
  } else {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, CORS_HEADERS));
    res.end('Not found. POST /check_liveness, POST /anthropic, or GET/POST /config');
    return;
  }

  // ── Collect request body and forward ────────────────────────────────────
  var chunks = [];
  req.on('data', function (chunk) { chunks.push(chunk); });
  req.on('end', function () {
    var body = Buffer.concat(chunks);
    upHeaders['Content-Length'] = body.length;

    var upstream = https.request({
      hostname: upHost,
      port:     443,
      path:     upPath,
      method:   'POST',
      headers:  upHeaders,
    }, function (upRes) {
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
  console.log('  docuSnap API proxy running');
  console.log('  ─────────────────────────');
  console.log('  Listening  : http://127.0.0.1:' + PORT);
  console.log('  Liveness   : https://' + IDRND_HOST + IDRND_PATH + '  (key: ' + IDRND_KEY.slice(0, 6) + '…)');
  console.log('  Anthropic  : https://' + ANTHROPIC_HOST + ANTHROPIC_PATH + '  (' + (ANTHROPIC_KEY ? 'key: ' + ANTHROPIC_KEY.slice(0, 10) + '…' : 'NOT SET — export ANTHROPIC_API_KEY') + ')');
  console.log('');
  console.log('  Set "Proxy URL" in the demo to: http://localhost:' + PORT);
  console.log('');
});
