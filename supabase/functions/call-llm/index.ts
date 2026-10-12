// LLM gateway. Every AI call your agents make goes through here.
//
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
// Secrets: ANTHROPIC_API_KEY, LLM_PROVIDER (default "anthropic"),
// LLM_MODEL (default "claude-haiku-5-5").
//
// Deployed WITH JWT verification ON. Only callers holding your project's
// service role key get in, which in practice means your own edge functions
// (they read it from Deno.env). Nobody on the internet can spend your credit.
//
// Request:  { prompt, systemPrompt?, model?, maxTokens?, userId?, source? }
// Response: { text } or { error }

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const PROVIDER = (Deno.env.get('LLM_PROVIDER') ?? 'anthropic').toLowerCase()
const DEFAULT_MODEL = Deno.env.get('LLM_MODEL') ?? 'claude-haiku-5-5'

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

// Published price in US dollars per million tokens, for the usage receipt.
// Unknown models log a cost of 0 rather than a guess.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00 },
  'claude-opus-5-5': { input: 4.00, output: 20.00 },
}

type Ask = { prompt: string; systemPrompt?: string; model: string; maxTokens: number }
type Answer = { text: string; inputTokens: number; outputTokens: number }

// One adapter per provider. Adding a provider means adding one function here.
const providers: Record<string, (a: Ask) => Promise<Answer>> = {
  anthropic: async ({ prompt, systemPrompt, model, maxTokens }) => {
    const client = new Anthropic({ apiKey: (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim() })
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // Tagging and summarizing are simple jobs; low effort keeps them fast and cheap.
      output_config: { effort: 'low' },
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    } as Anthropic.MessageCreateParamsNonStreaming)
    if (res.stop_reason === 'refusal') throw new Error('The model declined this request')
    const text = res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('')
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
  },
}

// Usage receipt. Never awaited by the caller and never allowed to throw:
// the AI already answered, so a failed log is a shrug, not an error.
function logUsage(userId: string | undefined, model: string, source: string | undefined, a: Answer) {
  if (!userId) return
  try {
    const price = PRICES[model]
    const cost = price ? (a.inputTokens * price.input + a.outputTokens * price.output) / 1_000_000 : 0
    db.from('llm_usage').insert({
      user_id: userId, kind: 'chat', model, source: source ?? null,
      prompt_tokens: a.inputTokens, completion_tokens: a.outputTokens, cost_usd: cost,
    }).then(({ error }) => { if (error) console.warn('usage log failed:', error.message) }, () => {})
  } catch (_) { /* never fail the call */ }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 })
  try {
    const body = await req.json()
    const prompt = String(body.prompt ?? '').trim()
    if (!prompt) return Response.json({ error: 'prompt is required' }, { status: 400 })

    const call = providers[PROVIDER]
    if (!call) return Response.json({ error: `Unknown LLM_PROVIDER: ${PROVIDER}` }, { status: 500 })

    const model = String(body.model ?? DEFAULT_MODEL)
    const answer = await call({
      prompt,
      systemPrompt: body.systemPrompt,
      model,
      maxTokens: Math.min(Number(body.maxTokens) || 1024, 8000),
    })
    logUsage(body.userId, model, body.source, answer)
    return Response.json({ text: answer.text })
  } catch (e) {
    console.error('call-llm error:', e)
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
})
