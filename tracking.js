/*
 * Einwilligung + Meta Pixel + UTM, eingebunden auf allen Seiten:
 *   <script src="/tracking.js" defer></script>
 *
 * - Pixel-ID kommt vom Server (/api/config, Coolify-Variable META_PIXEL_ID).
 *   Ohne Pixel-ID: kein Banner, kein Pixel.
 * - Der Pixel lädt erst nach "Accept" (Marketing). Entscheidung in
 *   localStorage "hf_consent" = "accepted" | "declined".
 *   Statistik läuft über Umami (ohne Cookies, braucht keine Einwilligung).
 * - PageView auf jeder Seite, Lead nur über window.hfLead() nach erfolgreicher
 *   Server-Antwort (subscribe-form.js, ARC-Formular).
 * - UTM-Parameter der Einstiegsseite bleiben für die Sitzung erhalten
 *   (sessionStorage "hf_utm") und gehen mit dem Formular an den Server.
 * - window.hfConsent.open() öffnet das Banner erneut (Link in der Datenschutzerklärung).
 */
(function () {
  var KEY = 'hf_consent'
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']

  function lsGet(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function lsSet(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }

  // ── UTM ──
  try {
    var q = new URLSearchParams(location.search)
    var utm = {}
    UTM_KEYS.forEach(function (k) {
      var v = (q.get(k) || '').trim().slice(0, 60)
      if (v) utm[k] = v
    })
    if (utm.utm_source) sessionStorage.setItem('hf_utm', JSON.stringify(utm))
  } catch (e) {}
  window.hfUtm = function () {
    try { return JSON.parse(sessionStorage.getItem('hf_utm') || 'null') } catch (e) { return null }
  }

  var pixelId = null
  function marketingOk() { return lsGet(KEY) === 'accepted' }

  // ── Meta Pixel ──

  function loadPixel() {
    if (!pixelId || window.fbq) return
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', pixelId)
    window.fbq('track', 'PageView')
  }

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  function dropCookies() {
    ;['_fbp', '_fbc'].forEach(function (n) {
      var base = n + '=; Max-Age=0; path=/'
      document.cookie = base
      document.cookie = base + '; domain=.' + location.hostname.replace(/^www\./, '')
    })
  }

  // Für subscribe-form.js: was der Server für die Conversions API braucht
  window.hfMeta = function () {
    if (!marketingOk()) return { consent: false }
    return { consent: true, fbp: cookie('_fbp'), fbc: cookie('_fbc') }
  }
  // Lead nur nach erfolgreicher Server-Antwort aufrufen
  window.hfLead = function (eventId, params) {
    if (marketingOk() && window.fbq) window.fbq('track', 'Lead', params || {}, { eventID: eventId })
  }

  // ── Banner ──
  var bar = null
  function decide(v) {
    var before = lsGet(KEY)
    lsSet(KEY, v)
    if (bar) bar.style.display = 'none'
    if (v === 'accepted') loadPixel()
    else if (before === 'accepted') { dropCookies(); location.reload() } // Pixel ist geladen, nur Neuladen entfernt ihn
  }

  function buildBar() {
    var css = document.createElement('style')
    css.textContent =
      '#hf-consent{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:rgba(8,6,15,0.97);' +
      'border-top:1px solid rgba(45,212,191,0.18);backdrop-filter:blur(8px);padding:1rem 1rem calc(1rem + env(safe-area-inset-bottom))}' +
      '#hf-consent .in{max-width:960px;margin:0 auto;display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap}' +
      '#hf-consent p{flex:1 1 420px;margin:0;font-family:"Literata",Georgia,serif;font-size:0.98rem;line-height:1.5;color:#d4cfc4}' +
      '#hf-consent a{color:#2dd4bf;text-decoration:none;border-bottom:1px solid rgba(45,212,191,0.3)}' +
      '#hf-consent .btns{display:flex;gap:0.6rem;flex:0 0 auto}' +
      '#hf-consent button{font-family:"Josefin Sans",sans-serif;font-size:0.62rem;font-weight:400;letter-spacing:0.15em;' +
      'text-transform:uppercase;padding:0.7rem 1.3rem;border-radius:6px;cursor:pointer;border:1px solid #2dd4bf;min-width:7.5rem}' +
      '#hf-consent .no{background:transparent;color:#2dd4bf}#hf-consent .yes{background:#2dd4bf;color:#08060f}' +
      '#hf-consent button:focus-visible{outline:2px solid #5eead4;outline-offset:2px}' +
      '@media (max-width:540px){#hf-consent .btns{width:100%}#hf-consent button{flex:1}}'
    document.head.appendChild(css)

    bar = document.createElement('div')
    bar.id = 'hf-consent'
    bar.setAttribute('role', 'dialog')
    bar.setAttribute('aria-label', 'Cookie settings')
    bar.innerHTML =
      '<div class="in"><p>May I use the Meta Pixel? It shows me whether my ads on Instagram and Facebook work. ' +
      'It sets cookies and sends information about your visit to Meta. Decline and the site works just the same. ' +
      'You can change your mind at any time. ' +
      '<a href="/privacy#cookies">Privacy policy</a></p>' +
      '<div class="btns"><button type="button" class="no">Decline</button><button type="button" class="yes">Accept</button></div></div>'
    bar.querySelector('.no').addEventListener('click', function () { decide('declined') })
    bar.querySelector('.yes').addEventListener('click', function () { decide('accepted') })
    document.body.appendChild(bar)
  }

  function showBar() {
    if (!pixelId) return
    if (!document.body) return document.addEventListener('DOMContentLoaded', showBar)
    if (!bar) buildBar()
    bar.style.display = 'block'
  }
  window.hfConsent = { open: showBar, marketing: marketingOk }

  // ── Start ──
  fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : {} })
    .then(function (c) {
      pixelId = c && /^\d{5,20}$/.test(c.metaPixelId || '') ? c.metaPixelId : null
      if (!pixelId) return
      var choice = lsGet(KEY)
      if (choice === 'accepted') loadPixel()
      else if (choice !== 'declined') showBar()
    })
    .catch(function () {})
})()
