// Weekly digest agent. Every Sunday it reads the last 7 days of thoughts,
// asks the AI (through the call-llm gateway) what you were learning, and saves
// the answer back into your brain as a thought with category "digest".
//
// Deployed with JWT verification OFF so pg_cron can call it without a key.
// Safe to leave open: it only ever summarizes the owner's own thoughts into
// the owner's own brain, and it refuses to run twice within 6 days, so a
// stranger calling it cannot run up your bill. To force a fresh one while
// testing, delete the latest digest row first.
//
// Secrets: OWNER_USER_ID. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided automatically.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const OWNER = Deno.env.get('OWNER_USER_ID') ?? ''
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const MIN_THOUGHTS = 5
const DAY = 24 * 60 * 60 * 1000

const SYSTEM = `You write a short weekly digest of someone's personal notes, addressed to them as "you".
Plain text, no markdown symbols, no emojis, no em dashes.
Sections, each with a short heading line:
What you were learning
Key themes
A question you seem to be exploring`

async function callLlm(prompt: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ prompt, systemPrompt: SYSTEM, maxTokens: 1500, userId: OWNER, source: 'weekly-digest' }),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok || typeof out.text !== 'string') throw new Error(out.error ?? `call-llm returned ${res.status}`)
  return out.text as string
}

Deno.serve(async () => {
  try {
    if (!OWNER) return Response.json({ status: 'skipped', reason: 'OWNER_USER_ID is not set' })

    const since = new Date(Date.now() - 7 * DAY).toISOString()

    const { data: recent } = await db.from('thoughts').select('id')
      .eq('user_id', OWNER).eq('category', 'digest')
      .gte('created_at', new Date(Date.now() - 6 * DAY).toISOString()).limit(1)
    if (recent?.length) return Response.json({ status: 'skipped', reason: 'a digest already exists from the last 6 days' })

    const { data, error } = await db.from('thoughts')
      .select('content, category, tags, summary, created_at')
      .eq('user_id', OWNER).gte('created_at', since)
      .or('category.is.null,category.neq.digest')
      .order('created_at', { ascending: true })
    if (error) throw error

    const thoughts = data ?? []
    if (thoughts.length < MIN_THOUGHTS) {
      console.log(`weekly-digest: only ${thoughts.length} thoughts this week, need ${MIN_THOUGHTS}`)
      return Response.json({ status: 'skipped', reason: `only ${thoughts.length} thoughts this week, need ${MIN_THOUGHTS}` })
    }

    // Group by the category the enrichment agent assigned.
    const groups: Record<string, string[]> = {}
    for (const t of thoughts) {
      const key = t.category ?? 'uncategorized'
      const line = t.summary ?? t.content.slice(0, 600)
      ;(groups[key] ??= []).push(`- ${line}${t.tags?.length ? ` [${t.tags.join(', ')}]` : ''}`)
    }
    const notes = Object.entries(groups).map(([cat, lines]) => `${cat}:\n${lines.join('\n')}`).join('\n\n')

    const text = await callLlm(`Here are my ${thoughts.length} notes from the past 7 days, grouped by category:\n\n${notes}`)
    const week = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' })
    const content = `Weekly digest, week ending ${week}\n\n${text.trim()}`

    const { error: insErr } = await db.from('thoughts').insert({
      content, user_id: OWNER, category: 'digest', enriched_at: new Date().toISOString(),
      metadata: { source: 'weekly-digest', thought_count: thoughts.length },
    })
    if (insErr) throw insErr
    return Response.json({ status: 'saved', thought_count: thoughts.length })
  } catch (e) {
    console.error('weekly-digest error:', e)
    return Response.json({ status: 'error', error: e instanceof Error ? e.message : String(e) })
  }
})
