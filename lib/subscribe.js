/**
 * POST /api/subscribe — Newsletter-Anmeldung über den eigenen Server.
 *
 * Ablauf: Rate-Limit → Honeypot → Mindestzeit → E-Mail-Prüfung →
 * Cloudflare Turnstile → MailerLite-Gruppe (per ID, Umbenennen ist also egal).
 * Double Opt-in bleibt bei MailerLite: neue Abonnenten starten als
 * "unconfirmed" und bekommen die Bestätigungsmail (Konto-Einstellung).
 *
 * Secrets nur als Umgebungsvariablen (Coolify):
 *   MAILERLITE_API_KEY, TURNSTILE_SECRET_KEY
 * Optional: MAILERLITE_GROUP_ID (überschreibt die Standard-Gruppe)
 */
import express from 'express'

// Newsletter-Gruppe (bis 11/2026 "The Helena Flinn Chronicles"), ID ändert sich beim Umbenennen nicht
const DEFAULT_GROUP_ID = '121933802862806762'
const ML_API = 'https://connect.mailerlite.com/api'
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const MIN_FILL_MS = 3000
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60 * 60 * 1000

const ALLOWED_ORIGINS = new Set([
  'https://helenaflinn.com',
  'https://www.helenaflinn.com',
  'https://michaelsokolar.com',
  'https://www.michaelsokolar.com',
])
const isLocalOrigin = (o) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || '')

const MSG = {
  invalid: 'Please enter a valid email address.',
  plus: 'Please use your email address without the "+" part.',
  retry: 'Something went wrong. Please try again in a moment.',
  limit: 'Too many attempts. Please try again later.',
}

// ── Rate-Limit pro IP (im Speicher, reicht für einen Container) ──
const hits = new Map()
function rateLimited(ip) {
  const now = Date.now()
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS)
  list.push(now)
  hits.set(ip, list)
  return list.length > RATE_LIMIT
}
setInterval(() => {
  const now = Date.now()
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(ip)
  }
}, 10 * 60 * 1000).unref()

// ── E-Mail ──
const EMAIL_RE = /^[^\s@"<>()\[\],;:\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
function checkEmail(raw) {
  const email = String(raw || '').trim().toLowerCase()
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { error: MSG.invalid }
  if (email.split('@')[0].includes('+')) return { error: MSG.plus }
  const tld = email.split('.').pop()
  if (tld.length < 2) return { error: MSG.invalid }
  return { email }
}

// ── Turnstile ──
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) throw new Error('TURNSTILE_SECRET_KEY fehlt')
  if (!token) return false
  const body = new URLSearchParams({ secret, response: String(token) })
  if (ip) body.set('remoteip', ip)
  const res = await fetch(TURNSTILE_VERIFY, { method: 'POST', body, signal: AbortSignal.timeout(8000) })
  const data = await res.json()
  if (!data.success) console.warn('[subscribe] turnstile abgelehnt:', (data['error-codes'] || []).join(','))
  return data.success === true
}

// ── MailerLite ──
function mlHeaders() {
  const key = process.env.MAILERLITE_API_KEY
  if (!key) throw new Error('MAILERLITE_API_KEY fehlt')
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

const groupId = () => process.env.MAILERLITE_GROUP_ID || DEFAULT_GROUP_ID

async function addSubscriber(email, ip) {
  const payload = { email, groups: [groupId()] }
  if (ip) payload.ip_address = ip
  const res = await fetch(`${ML_API}/subscribers`, {
    method: 'POST',
    headers: mlHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 422) return { invalid: true }
  if (!res.ok) throw new Error(`MailerLite subscribers ${res.status}`)
  const { data } = await res.json()
  return { status: data?.status }
}

// ── Router ──
export function subscribeRouter() {
  const router = express.Router()

  // CORS nur für die eigenen Domains (michaelsokolar.com schickt hierher)
  router.use('/subscribe', (req, res, next) => {
    const origin = req.get('Origin')
    if (origin && (ALLOWED_ORIGINS.has(origin) || (process.env.NODE_ENV !== 'production' && isLocalOrigin(origin)))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '86400')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  router.post(
    '/subscribe',
    express.json({ limit: '4kb' }),
    express.urlencoded({ extended: false, limit: '4kb' }),
    async (req, res) => {
      const ip = req.ip
      const b = req.body || {}
      const fail = (status, error, reason) => {
        console.log(`[subscribe] abgelehnt (${reason})`)
        res.status(status).json({ ok: false, error })
      }

      if (rateLimited(ip)) return fail(429, MSG.limit, 'rate-limit')

      // Honeypot: Bots bekommen eine scheinbare Erfolgsmeldung
      if (b.website) {
        console.log('[subscribe] abgelehnt (honeypot)')
        return res.json({ ok: true })
      }

      const elapsed = Number(b.elapsed)
      if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return fail(400, MSG.retry, 'zu-schnell')

      const { email, error } = checkEmail(b.email)
      if (error) return fail(400, error, error === MSG.plus ? 'plus-adresse' : 'ungueltig')

      try {
        if (!(await verifyTurnstile(b.token, ip))) return fail(400, MSG.retry, 'turnstile')
        const result = await addSubscriber(email, ip)
        if (result.invalid) return fail(400, MSG.invalid, 'mailerlite-422')
        console.log(`[subscribe] OK (status ${result.status})`)
        res.json({ ok: true })
      } catch (err) {
        console.error('[subscribe] Fehler:', err.message)
        res.status(502).json({ ok: false, error: MSG.retry })
      }
    },
  )

  return router
}
