// Open Brain MCP server.
//
// MCP (Model Context Protocol) is an open standard that lets an AI assistant
// call tools. This function speaks it over plain HTTP: the AI sends a JSON-RPC
// 2.0 request ("initialize", "tools/list", "tools/call"), we answer with JSON.
//
// The AI never touches the database. It asks this function, and this function
// asks the database with the service role key, which never leaves Supabase.
//
// Deployed with JWT verification OFF (Claude cannot send a Supabase login
// token), so the function checks its own door: every request must carry
// "Authorization: Bearer <access key>".
//
// Supabase stores only the SHA-256 fingerprint of that key, in
// MCP_ACCESS_KEY_SHA256. The key itself lives only in Claude Desktop's config,
// written there by scripts/setup-claude-mcp.sh. A leaked fingerprint cannot be
// used to log in. (A plain MCP_ACCESS_KEY secret also works, for anyone
// following the course text.)
//
// Secrets: MCP_ACCESS_KEY_SHA256, OWNER_USER_ID. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY') ?? ''
const ACCESS_KEY_SHA256 = (Deno.env.get('MCP_ACCESS_KEY_SHA256') ?? '').trim().toLowerCase()
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

// The service role key skips row level security, so every query filters by
// OWNER_USER_ID by hand and every insert sets it. Without that, a thought
// added here would save with no owner and never show up in your app.
const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

// Constant time comparison, so the response time does not leak the key.
function sameKey(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function sha256(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function authorized(key: string) {
  if (!key) return false
  if (ACCESS_KEY_SHA256) return sameKey(await sha256(key), ACCESS_KEY_SHA256)
  return sameKey(key, ACCESS_KEY)
}

// ---------- the tools the AI can call ----------

const TOOLS = [
  {
    name: 'search_thoughts',
    description: "Keyword search across everything saved in Luis's Open Brain (notes, voice notes, Telegram messages, YouTube transcripts, PDFs, web articles). Returns up to 10 matches, newest first.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Word or phrase to look for' } },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description: 'List the most recently saved thoughts, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many to return, 1 to 50. Default 10.' } },
    },
  },
  {
    name: 'add_thought',
    description: 'Save a new thought to the Open Brain. Only use when the user asks to save something.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The text to save' } },
      required: ['content'],
    },
  },
]

type Row = { id: string; content: string; created_at: string; metadata?: Record<string, unknown> }

function format(rows: Row[]) {
  if (!rows.length) return 'No thoughts found.'
  return rows.map((r) => {
    const src = r.metadata && typeof r.metadata.source === 'string' ? ` [${r.metadata.source}]` : ''
    const text = r.content.length > 4000 ? r.content.slice(0, 4000) + ' ...(truncated)' : r.content
    return `id: ${r.id}\nsaved: ${r.created_at}${src}\n${text}`
  }).join('\n\n---\n\n')
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === 'search_thoughts') {
    const q = String(args.query ?? '').trim()
    if (!q) throw new Error('query is required')
    const pattern = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    const { data, error } = await db.from('thoughts').select('id, content, created_at, metadata')
      .eq('user_id', OWNER_USER_ID).ilike('content', pattern)
      .order('created_at', { ascending: false }).limit(10)
    if (error) throw error
    return format(data ?? [])
  }
  if (name === 'list_recent') {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
    const { data, error } = await db.from('thoughts').select('id, content, created_at, metadata')
      .eq('user_id', OWNER_USER_ID).order('created_at', { ascending: false }).limit(limit)
    if (error) throw error
    return format(data ?? [])
  }
  if (name === 'add_thought') {
    const content = String(args.content ?? '').trim()
    if (!content) throw new Error('content is required')
    const { data, error } = await db.from('thoughts')
      .insert({ content, user_id: OWNER_USER_ID, metadata: { source: 'claude' } })
      .select('id, content, created_at, metadata').single()
    if (error) throw error
    return 'Saved.\n\n' + format([data])
  }
  throw new Error(`Unknown tool: ${name}`)
}

// ---------- JSON-RPC handling ----------

type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }

async function handle(msg: RpcRequest) {
  const id = msg.id ?? null
  // Notifications have no id and get no answer.
  if (msg.id === undefined) return null

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'open-brain', version: '1.0.0' },
          instructions: "Luis's personal knowledge base. Search it when he refers to something he saved, watched, read, or noted.",
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const text = await callTool(name, args)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }
      } catch (e) {
        // Tool failures go back as a normal result flagged isError, so the AI
        // can read what went wrong instead of the whole connection failing.
        const text = e instanceof Error ? e.message : String(e)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + text }], isError: true } }
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // Door check before anything else.
  const auth = req.headers.get('authorization') ?? ''
  const key = auth.replace(/^Bearer\s+/i, '')
  if (!(await authorized(key))) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401)
  }
  if (!OWNER_USER_ID) return json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'OWNER_USER_ID is not set' } }, 500)

  // This server only answers requests; it never opens a stream.
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors })

  let body: RpcRequest | RpcRequest[]
  try {
    body = await req.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean)
    return out.length ? json(out) : new Response(null, { status: 202, headers: cors })
  }
  const out = await handle(body)
  return out ? json(out) : new Response(null, { status: 202, headers: cors })
})
