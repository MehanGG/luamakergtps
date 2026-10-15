// Vercel Serverless Function: /api/dattio  (khusus akun Premium)
// Environment Variables (Vercel):
//   DATTIO_API_KEY  (atau DattioAI)       -> API key Dattio
//   SUPABASE_SERVICE_ROLE_KEY (atau SecretKeySB) -> secret key Supabase (sb_secret_...), HANYA di server
//   SUPABASE_URL, SUPABASE_ANON_KEY       -> opsional (ada default)
//   WEEKLY_TOKEN_LIMIT                    -> opsional, default 1000000
//   DATTIO_BASE_URL                       -> opsional
const BASE = (process.env.DATTIO_BASE_URL || 'https://bandelbanget.xyz/v1').replace(/\/+$/, '');
const SB_URL = process.env.SUPABASE_URL || 'https://dejugqwxyoshbmaedktz.supabase.co';
const SB_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_o4U6tFVLmuuQkKfAU0woNg_7YmMhRar';
const SB_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SecretKeySB;
const KEY = process.env.DATTIO_API_KEY || process.env.DattioAI;
const WEEK = Number(process.env.WEEKLY_TOKEN_LIMIT) || 1000000;
const DAY = Math.floor(WEEK / 7); // 1.000.000 / 7 = 142.857

const svcHeaders = (k) => (k.startsWith('sb_') ? { apikey: k } : { apikey: k, Authorization: 'Bearer ' + k });
const wib = (back = 0) => new Date(Date.now() + 7 * 3600e3 - back * 864e5).toISOString().slice(0, 10);

async function usageOf(uid) {
  const r = await fetch(`${SB_URL}/rest/v1/usage_daily?select=day,tokens&user_id=eq.${uid}&day=gte.${wib(6)}`, {
    headers: svcHeaders(SB_SVC),
  });
  if (!r.ok) throw new Error('Gagal membaca usage (cek tabel usage_daily & SUPABASE_SERVICE_ROLE_KEY)');
  const rows = await r.json();
  const today = wib(0);
  let w = 0, d = 0;
  for (const x of rows) {
    w += Number(x.tokens);
    if (x.day === today) d += Number(x.tokens);
  }
  return { week: { used: w, limit: WEEK }, day: { used: d, limit: DAY } };
}

async function addUsage(uid, tokens) {
  await fetch(`${SB_URL}/rest/v1/rpc/add_usage`, {
    method: 'POST',
    headers: { ...svcHeaders(SB_SVC), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: uid, p_day: wib(0), p_tokens: Math.round(tokens) }),
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!KEY || !SB_SVC) {
    return res.status(500).json({ error: 'Server belum dikonfigurasi: isi DattioAI dan SecretKeySB di Vercel' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Belum login' });

  try {
    // 1) verifikasi login
    const ur = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } });
    if (!ur.ok) return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang' });
    const user = await ur.json();

    // 2) cek premium
    const pr = await fetch(`${SB_URL}/rest/v1/profiles?select=is_premium,premium_until&id=eq.${encodeURIComponent(user.id)}`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` },
    });
    const rows = pr.ok ? await pr.json() : [];
    const p = rows && rows[0];
    const ok = p && p.is_premium && (!p.premium_until || new Date(p.premium_until) > new Date());
    if (!ok) return res.status(403).json({ error: 'Akun kamu belum Premium' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

    // 3) daftar model
    if (body.action === 'models') {
      const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
      res.status(r.status).setHeader('Content-Type', 'application/json');
      return res.send(await r.text());
    }

    // 4) kuota
    if (body.action === 'quota') {
      const u = await usageOf(user.id);
      let provider = null;
      try {
        const r = await fetch(`${BASE}/quota`, { headers: { Authorization: `Bearer ${KEY}` } });
        if (r.ok) provider = await r.json();
      } catch (e) {}
      return res.status(200).json({ ...u, provider });
    }

    // 5) chat
    if (body.action === 'chat') {
      const u = await usageOf(user.id);
      if (u.week.used >= u.week.limit) {
        return res.status(429).json({ error: `Kuota mingguan habis (${u.week.limit.toLocaleString('id-ID')} token). Coba lagi nanti.` });
      }
      if (u.day.used >= u.day.limit) {
        return res.status(429).json({ error: `Kuota harian habis (${u.day.limit.toLocaleString('id-ID')} token). Reset 00:00 WIB.` });
      }

      const a = body.payload || {};
      const payload = {};
      for (const k of ['model', 'messages', 'stream', 'reasoning_effort', 'max_tokens', 'temperature']) {
        if (a[k] !== undefined) payload[k] = a[k];
      }
      const go = (withUsage) =>
        fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
          body: JSON.stringify(withUsage && payload.stream ? { ...payload, stream_options: { include_usage: true } } : payload),
        });
      let up = await go(true);
      if (up.status === 400) up = await go(false);

      const estIn = JSON.stringify(payload.messages || []).length / 3.6;

      if (!payload.stream || !up.ok) {
        const txt = await up.text();
        if (up.ok) {
          let tk = 0;
          try { tk = JSON.parse(txt).usage.total_tokens; } catch (e) {}
          await addUsage(user.id, tk || estIn + txt.length / 3.2).catch(() => {});
        }
        res.status(up.status).setHeader('Content-Type', up.headers.get('content-type') || 'application/json');
        return res.send(txt);
      }

      res.status(200);
      res.setHeader('Content-Type', up.headers.get('content-type') || 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      const rd = up.body.getReader();
      req.on('close', () => rd.cancel().catch(() => {}));
      const dec = new TextDecoder();
      let buf = '', total = 0, outChars = 0;
      try {
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          res.write(Buffer.from(value));
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            try {
              const j = JSON.parse(line.slice(5));
              if (j.usage && j.usage.total_tokens) total = j.usage.total_tokens;
              const d = j.choices && j.choices[0] && j.choices[0].delta;
              if (d) outChars += ((d.content || '') + (d.reasoning_content || d.reasoning || '')).length;
            } catch (e) {}
          }
        }
      } finally {
        const t = total || estIn + outChars / 3.2;
        if (t > 0) await addUsage(user.id, t).catch(() => {});
        res.end();
      }
      return;
    }

    return res.status(400).json({ error: 'action tidak valid' });
  } catch (e) {
    if (!res.headersSent) return res.status(502).json({ error: 'Gagal: ' + e.message });
    res.end();
  }
};
