// Enrichment agent. Adds tags, a category and a one sentence summary to new
// thoughts.
//
// Triggered by a database trigger on every insert into thoughts, and by a
// catch-up cron job every 15 minutes in case a call was missed.
//
// Deployed with JWT verification OFF, so the database can call it without a
// key. It is safe to leave open because it trusts nothing in the request: it
// ignores the body and simply enriches whatever thoughts in the database are
// still un-enriched. Calling it twice, or a stranger calling it, can only ever
// do the same work the next save would have done anyway.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']
const BATCH = 10

const SYSTEM = `You label notes for a personal knowledge base.
Reply with only a JSON object, no other text:
{"tags": [3 to 5 short lowercase tags], "category": one of ${JSON.stringify(CATEGORIES)}, "summary": "one sentence"}`

// Every AI call goes through the call-llm gateway, never to a provider directly.
async function callLlm(prompt: string, userId: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ prompt, systemPrompt: SYSTEM, maxTokens: 400, userId, source: 'enrich-thought' }),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok || typeof out.text !== 'string') throw new Error(out.error ?? `call-llm returned ${res.status}`)
  return out.text as string
}

function parse(text: string) {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  const raw = JSON.parse(json)
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
    : []
  const category = CATEGORIES.includes(String(raw.category)) ? String(raw.category) : null
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 300) : null
  return { tags, category, summary }
}

Deno.serve(async () => {
  let done = 0, skipped = 0, failed = 0
  try {
    const { data, error } = await db.from('thoughts')
      .select('id, content, user_id, category')
      .is('enriched_at', null)
      .order('created_at', { ascending: false })
      .limit(BATCH)
    if (error) throw error

    for (const t of data ?? []) {
      // Digests are written by the weekly agent and are not re-labelled.
      // Very short notes have nothing to tag; mark them so they are not retried.
      if (t.category === 'digest' || !t.user_id || (t.content ?? '').trim().length < 20) {
        await db.from('thoughts').update({ enriched_at: new Date().toISOString() }).eq('id', t.id)
        skipped++
        continue
      }
      try {
        const text = await callLlm(`Label this note:\n\n${t.content.slice(0, 12000)}`, t.user_id)
        const { tags, category, summary } = parse(text)
        const { error: upErr } = await db.from('thoughts')
          .update({ tags, category, summary, enriched_at: new Date().toISOString() })
          .eq('id', t.id)
        if (upErr) throw upErr
        done++
      } catch (e) {
        // Left un-enriched, so the catch-up job tries again later.
        console.error(`enrich failed for ${t.id}:`, e)
        failed++
      }
    }
  } catch (e) {
    console.error('enrich-thought error:', e)
  }
  // Always 200: a database trigger has nobody to report an error to.
  return Response.json({ enriched: done, skipped, failed })
})
