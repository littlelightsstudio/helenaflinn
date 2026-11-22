/**
 * Meta Pixel (Konfiguration für den Browser) und Conversions API (Lead serverseitig).
 *
 * Umgebungsvariablen (nur in Coolify, nie im Code):
 *   META_PIXEL_ID           Pixel-ID aus dem Events Manager. Ohne sie: kein Banner, kein Pixel, keine CAPI.
 *   META_CAPI_TOKEN         Access Token der Conversions API. Ohne ihn: nur Browser-Pixel.
 *   META_TEST_EVENT_CODE    optional, z.B. TEST12345, dann erscheinen CAPI-Events unter "Test Events".
 *   META_GRAPH_VERSION      optional, Standard v24.0
 *
 * Die CAPI wird nur mit Einwilligung (Banner "Accept") aufgerufen. Browser und Server
 * schicken dieselbe event_id, Meta zählt den Lead dann nur einmal.
 */
import { createHash } from 'node:crypto'

const pixelId = () => (/^\d{5,20}$/.test(process.env.META_PIXEL_ID || '') ? process.env.META_PIXEL_ID : null)

export function metaConfig(_req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json({ metaPixelId: pixelId() })
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const clean = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : undefined)

/**
 * Lead an die Conversions API. Wirft nie, Fehler landen nur im Log.
 * meta = { consent, event_id, fbp, fbc, url } aus dem Formular
 */
export async function sendLead({ email, ip, userAgent, meta, contentName }) {
  const id = pixelId()
  const token = process.env.META_CAPI_TOKEN
  if (!id || !token || !meta || meta.consent !== true) return
  const eventId = clean(meta.event_id, 64)
  if (!eventId) return

  const userData = { em: [sha256(email.trim().toLowerCase())] }
  if (ip) userData.client_ip_address = ip
  if (userAgent) userData.client_user_agent = userAgent.slice(0, 500)
  if (clean(meta.fbp)) userData.fbp = meta.fbp
  if (clean(meta.fbc)) userData.fbc = meta.fbc

  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData,
    custom_data: { content_name: contentName },
  }
  const url = clean(meta.url, 500)
  if (url && /^https:\/\/(www\.)?helenaflinn\.com\//.test(url)) event.event_source_url = url

  const body = { data: [event] }
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE

  const version = process.env.META_GRAPH_VERSION || 'v24.0'
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${id}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.warn(`[meta] CAPI ${res.status}: ${err?.error?.message || 'unbekannt'}`)
    } else {
      console.log('[meta] CAPI Lead OK')
    }
  } catch (err) {
    console.warn('[meta] CAPI Fehler:', err.message)
  }
}
