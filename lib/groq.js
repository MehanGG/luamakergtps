'use strict';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

class GroqError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

/** Stream satu panggilan chat completion ke Groq. */
async function streamChat({ apiKey, model, messages, reasoningEffort, maxTokens, temperature = 0.6, signal, onReasoning, onContent }) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, messages, stream: true, temperature, top_p: 1,
      max_completion_tokens: maxTokens,
      reasoning_effort: reasoningEffort,
      include_reasoning: true,
    }),
  });

  if (!resp.ok) {
    let msg = `Groq error ${resp.status}`;
    try { const j = await resp.json(); msg = j?.error?.message || msg; } catch { /* ignore */ }
    throw new GroqError(resp.status, msg, resp.headers.get('retry-after'));
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', usage = null, finish = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new GroqError(500, j.error.message || 'Groq stream error');
      const ch = j.choices && j.choices[0];
      if (ch) {
        const d = ch.delta || {};
        const r = d.reasoning ?? d.reasoning_content;
        if (r) { reasoning += r; onReasoning && onReasoning(r); }
        if (d.content) { content += d.content; onContent && onContent(d.content); }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
      const u = (j.x_groq && j.x_groq.usage) || j.usage;
      if (u) usage = u;
    }
  }
  return { content, reasoning, usage, finish };
}

module.exports = { streamChat, GroqError };
