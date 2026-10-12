// Telegram bot for your Open Brain.
//
// Telegram posts every message sent to your bot to this function. Plain text is
// saved as a thought. "/search words" or "? words" searches. "/recent" lists the
// last five.
//
// Deployed with JWT verification OFF, because Telegram cannot send a Supabase
// login token. So this function guards its own door, twice:
//   1. Every request must carry the secret header Telegram adds when the webhook
//      is registered with scripts/set-telegram-webhook.sh. The secret is derived
//      from your bot token, so there is no extra value to store.
//   2. Only your own chat is served. Until OWNER_CHAT_ID is set, the bot only
//      replies with your chat id so you can set it, and saves nothing.
//
// Secrets (Edge Functions -> Secrets): TELEGRAM_BOT_TOKEN, OWNER_USER_ID,
// OWNER_CHAT_ID. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided
// automatically.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const OWNER_CHAT_ID = Deno.env.get('OWNER_CHAT_ID') ?? ''

// The service role key skips row level security, so every query below filters
// by OWNER_USER_ID by hand and every insert sets it.
const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-telegram-bot-api-secret-token',
}
// Always answer Telegram with 200, or it retries the same message for hours.
const ok = () => new Response('ok', { status: 200, headers: cors })

async function webhookSecret(): Promise<string> {
  const bytes = new TextEncoder().encode('open-brain-webhook:' + TOKEN)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48)
}

async function reply(chatId: number, text: string) {
  const body = text.length > 4000 ? text.slice(0, 3990) + '\n...' : text
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
  })
}

function when(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix',
  })
}

function list(rows: { content: string; created_at: string }[]) {
  return rows.map((r, i) => {
    const text = r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content
    return `${i + 1}. ${text}\n   ${when(r.created_at)}`
  }).join('\n\n')
}

const HELP = [
  'Send me any text and I save it to your brain.',
  '/search words  or  ? words : search your brain',
  '/recent : your last 5 thoughts',
].join('\n')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST' || !TOKEN) return ok()

  // Door check 1: the request really came from Telegram's webhook for this bot.
  if (req.headers.get('x-telegram-bot-api-secret-token') !== (await webhookSecret())) return ok()

  let chatId: number | undefined
  try {
    const update = await req.json()
    const msg = update.message ?? update.edited_message
    chatId = msg?.chat?.id
    const text: string = (msg?.text ?? '').trim()
    if (!chatId) return ok()

    // Door check 2: only your own chat.
    if (!OWNER_CHAT_ID) {
      await reply(chatId, `Setup step: your chat id is ${chatId}. Add it as the OWNER_CHAT_ID secret. Nothing was saved.`)
      return ok()
    }
    if (String(chatId) !== OWNER_CHAT_ID) {
      await reply(chatId, 'This is a private bot.')
      return ok()
    }
    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup step: OWNER_USER_ID is not set yet. Nothing was saved.')
      return ok()
    }
    if (!text) {
      await reply(chatId, 'I can only save text for now.')
      return ok()
    }

    if (text === '/start' || text === '/help') {
      await reply(chatId, HELP)
      return ok()
    }

    if (text.startsWith('/recent')) {
      const { data, error } = await db.from('thoughts').select('content, created_at')
        .eq('user_id', OWNER_USER_ID).order('created_at', { ascending: false }).limit(5)
      if (error) throw error
      await reply(chatId, data?.length ? list(data) : 'Your brain is empty so far.')
      return ok()
    }

    if (text.startsWith('/search') || text.startsWith('?')) {
      const q = text.replace(/^\/search(@\w+)?|^\?/, '').trim()
      if (!q) {
        await reply(chatId, 'Search for what? Example: /search measurement')
        return ok()
      }
      const pattern = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
      const { data, error } = await db.from('thoughts').select('content, created_at')
        .eq('user_id', OWNER_USER_ID).ilike('content', pattern)
        .order('created_at', { ascending: false }).limit(5)
      if (error) throw error
      await reply(chatId, data?.length ? `Found ${data.length}:\n\n` + list(data) : `Nothing matches "${q}".`)
      return ok()
    }

    if (text.startsWith('/')) {
      await reply(chatId, HELP)
      return ok()
    }

    const { error } = await db.from('thoughts').insert({
      content: text,
      user_id: OWNER_USER_ID,
      metadata: { source: 'telegram' },
    })
    if (error) throw error
    await reply(chatId, 'Saved to your brain.')
  } catch (e) {
    console.error('telegram-bot error:', e)
    try {
      if (chatId && String(chatId) === OWNER_CHAT_ID) await reply(chatId, 'Something went wrong. Nothing was saved.')
    } catch (_) { /* never fail the webhook */ }
  }
  return ok()
})
