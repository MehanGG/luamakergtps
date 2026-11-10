'use strict';
// Proxy tipis ke Groq. API key dibaca dari Environment Variable GROQ_API_KEY.
const { streamChat, GroqError } = require('../lib/groq');

const MODEL = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const TOKEN_CAP = () => Number(process.env.MAX_COMPLETION_CAP) || 32000;

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const fail = (res, code, error) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error })); };

function friendly(err) {
  if (err instanceof GroqError) {
    if (err.status === 401) return 'API key Groq ditolak (401). Cek GROQ_API_KEY di Environment Variables.';
    if (err.status === 413) return 'Request terlalu besar untuk limit Groq. Pakai effort lebih rendah, lampiran lebih kecil, atau mulai chat baru.';
    if (err.status === 429) return `Limit Groq tercapai (429). ${err.retryAfter ? `Coba lagi dalam ~${err.retryAfter} detik. ` : ''}${err.message}`;
    return `Groq: ${err.message}`;
  }
  return (err && err.message) || 'Terjadi kesalahan tak terduga.';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail(res, 405, 'Method not allowed'); }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return fail(res, 500, 'GROQ_API_KEY belum diset di Environment Variables (Vercel → Settings → Environment Variables), lalu Redeploy.');

  let body;
  try { body = await readBody(req); } catch { return fail(res, 400, 'Body JSON tidak valid.'); }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const ok = msgs.length > 0 && msgs.length <= 80 && msgs.every((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string');
  if (!ok || msgs[msgs.length - 1].role === 'system') return fail(res, 400, 'Format messages tidak valid.');
  if (msgs.reduce((a, m) => a + m.content.length, 0) > 600000) return fail(res, 413, 'Pesan terlalu besar.');
  const reasoning = ['low', 'medium', 'high'].includes(body.reasoning) ? body.reasoning : 'medium';
  const maxTokens = Math.min(Math.max(Number(body.maxTokens) || 8000, 256), TOKEN_CAP());

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  const send = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const r = await streamChat({
      apiKey, model: MODEL(), messages: msgs, reasoningEffort: reasoning, maxTokens, signal: ac.signal,
      onReasoning: (t) => send({ type: 'reasoning', text: t }),
      onContent: (t) => send({ type: 'content', text: t }),
    });
    send({ type: 'done', usage: r.usage, finish: r.finish });
  } catch (err) {
    if (!(err && err.name === 'AbortError')) send({ type: 'error', message: friendly(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
};
