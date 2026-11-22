/**
 * POST /api/subscribe — Newsletter-Anmeldung über den eigenen Server.
 * POST /api/arc       — ARC-Bewerbung Buch 3 (gleiche Prüfungen, mehr Felder).
 *
 * Ablauf: Rate-Limit → Honeypot → Mindestzeit → E-Mail-Prüfung →
 * Cloudflare Turnstile → MailerLite-Gruppe (per ID, Umbenennen ist also egal).
 * Double Opt-in bleibt bei MailerLite: neue Abonnenten starten als
 * "unconfirmed" und bekommen die Bestätigungsmail (Konto-Einstellung).
 *
 * Secrets nur als Umgebungsvariablen (Coolify):
 *   MAILERLITE_API_KEY, TURNSTILE_SECRET_KEY
 * Optional: MAILERLITE_GROUP_ID (überschreibt die Standard-Gruppe)
 *
 * UTM-Parameter (Anzeigen-Links) landen im MailerLite-Feld "utm" ("source" ist dort reserviert), z.B.
 * "meta / paid / arc-book3 / title". Ohne UTM bleibt das Feld unverändert.
 * Meta: Lead über die Conversions API nach erfolgreicher ARC-Bewerbung, siehe lib/meta.js.
 */
import express from 'express'
import { sendLead } from './meta.js'

// Newsletter-Gruppe (bis 11/2026 "The Helena Flinn Chronicles"), ID ändert sich beim Umbenennen nicht
const DEFAULT_GROUP_ID = '121933802862806762'
const ML_API = 'https://connect.mailerlite.com/api'
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const MIN_FILL_MS = 3000
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR) || 5
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
const ARC_GROUP_ID = '204658543343699376' // "ARC Team · Book 3"

// Woher die Anmeldung kam (MailerLite-Feld signup_source, für Segmente)
const SOURCES = ['helenaflinn', 'quiz', 'michaelsokolar', 'links', 'arc']

// UTM-Parameter → "quelle / medium / kampagne / motiv" (nur wenn utm_source da ist)
function utmSource(utm) {
  if (!utm || typeof utm !== 'object') return null
  const part = (k) => String(utm[k] || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || '-'
  if (part('utm_source') === '-') return null
  return ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].map(part).join(' / ')
}

// Erste Quelle behalten: bei bestehenden Abonnenten nicht überschreiben
async function existingSource(email) {
  const res = await fetch(`${ML_API}/subscribers/${encodeURIComponent(email)}`, {
    headers: mlHeaders(),
    signal: AbortSignal.timeout(8000),
  })
  if (res.status === 404) return { exists: false }
  if (!res.ok) return { exists: true, source: 'unknown' } // im Zweifel nichts überschreiben
  const { data } = await res.json()
  return { exists: true, source: data?.fields?.signup_source || null }
}

async function addSubscriber({ email, ip, groups, fields, source }) {
  fields = { ...fields }
  if (source) {
    const prev = await existingSource(email)
    if (!prev.source) fields.signup_source = source
  }
  const payload = { email, groups }
  if (fields && Object.keys(fields).length) payload.fields = fields
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

// ── ARC-Bewerbung: Zusatzfelder prüfen ──
const ARC_PLATFORMS = ['Amazon', 'Goodreads', 'Instagram', 'TikTok', 'Blog', 'Other']
const ARC_READ = ['Both', 'Book 1 only', 'Not yet']
const ARC_MSG = {
  name: 'Please enter your name.',
  platforms: 'Please tick at least one place where you review.',
  link: 'Please enter a valid link to your reviewer profile, or leave it empty.',
  read: 'Please tell me whether you have read Books 1 and 2.',
  pledge: 'Please confirm that you will post an honest review in launch week.',
}
function checkArc(b) {
  const name = String(b.name || '').trim().replace(/\s+/g, ' ')
  if (!name || name.length > 100 || /https?:|www\.|[<>]/i.test(name)) return { error: ARC_MSG.name }

  const raw = Array.isArray(b.platforms) ? b.platforms : b.platforms ? [b.platforms] : []
  const platforms = ARC_PLATFORMS.filter((p) => raw.includes(p))
  if (!platforms.length) return { error: ARC_MSG.platforms }

  let link = String(b.profile_link || '').trim()
  if (link) {
    if (!/^https?:\/\//i.test(link)) link = `https://${link}`
    try {
      const u = new URL(link)
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || link.length > 300) throw 0
    } catch {
      return { error: ARC_MSG.link }
    }
  }

  const read = String(b.read_books || '')
  if (!ARC_READ.includes(read)) return { error: ARC_MSG.read }

  if (!b.pledge || b.pledge === 'false') return { error: ARC_MSG.pledge }

  const today = new Date().toISOString().slice(0, 10)
  return {
    fields: {
      name,
      arc_review_platforms: platforms.join(', '),
      arc_profile_link: link,
      arc_read_books_1_and_2: read,
      arc_application: `${today}, honest review pledge: yes`,
    },
  }
}

// ── Gemeinsamer Ablauf für alle Anmeldeformulare ──
function signupHandler({ label, groups, extra, lead }) {
  return async (req, res) => {
    const ip = req.ip
    const b = req.body || {}
    const fail = (status, error, reason) => {
      console.log(`[${label}] abgelehnt (${reason})`)
      res.status(status).json({ ok: false, error })
    }

    if (rateLimited(ip)) return fail(429, MSG.limit, 'rate-limit')

    // Honeypot: Bots bekommen eine scheinbare Erfolgsmeldung
    if (b.website) {
      console.log(`[${label}] abgelehnt (honeypot)`)
      return res.json({ ok: true })
    }

    const elapsed = Number(b.elapsed)
    if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return fail(400, MSG.retry, 'zu-schnell')

    const { email, error } = checkEmail(b.email)
    if (error) return fail(400, error, error === MSG.plus ? 'plus-adresse' : 'ungueltig')

    let fields = {}
    if (extra) {
      const r = extra(b)
      if (r.error) return fail(400, r.error, 'felder')
      fields = r.fields
    }

    try {
      if (!(await verifyTurnstile(b.token, ip))) return fail(400, MSG.retry, 'turnstile')
      const source = SOURCES.includes(b.source) ? b.source : null
      const campaign = utmSource(b.utm)
      if (campaign) fields = { ...fields, utm: campaign }
      const result = await addSubscriber({ email, ip, groups: groups(), fields, source })
      if (result.invalid) return fail(400, MSG.invalid, 'mailerlite-422')
      console.log(`[${label}] OK (status ${result.status}, quelle ${source || '-'}, utm ${campaign || '-'})`)
      res.json({ ok: true })
      if (lead) sendLead({ email, ip, userAgent: req.get('User-Agent'), meta: b.meta, contentName: lead })
    } catch (err) {
      console.error(`[${label}] Fehler:`, err.message)
      res.status(502).json({ ok: false, error: MSG.retry })
    }
  }
}

// ── Router ──
export function subscribeRouter() {
  const router = express.Router()
  const body = [express.json({ limit: '8kb' }), express.urlencoded({ extended: true, limit: '8kb' })]

  // CORS nur für die eigenen Domains (michaelsokolar.com schickt hierher)
  router.use(['/subscribe', '/arc'], (req, res, next) => {
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

  // Newsletter
  router.post('/subscribe', ...body, signupHandler({ label: 'subscribe', groups: () => [groupId()] }))

  // ARC-Bewerbung Buch 3: ARC-Gruppe plus Newsletter, Double Opt-in wie oben
  router.post('/arc', ...body, signupHandler({ label: 'arc', groups: () => [ARC_GROUP_ID, groupId()], extra: checkArc, lead: 'ARC Book 3' }))

  return router
}
