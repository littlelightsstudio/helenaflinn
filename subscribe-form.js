/*
 * Newsletter-Formulare → POST /api/subscribe (helenaflinn.com)
 * Wird auch von michaelsokolar.com eingebunden.
 *
 * Markup: <form data-subscribe data-success="#id" data-hide="#id"> mit einem
 * <input type="email"> und einem Submit-Button. Honeypot und Turnstile-
 * Container fügt dieses Skript selbst ein.
 */
(function () {
  var SITE_KEY = '0x4AAAAAAGKOD2auQXJxe55i'
  var API = 'https://helenaflinn.com/api/subscribe'

  var host = location.hostname
  var local = host === 'localhost' || host === '127.0.0.1'
  if (/(^|\.)helenaflinn\.com$/.test(host)) API = '/api/subscribe'
  if (local) {
    SITE_KEY = '1x00000000000000000000AA' // Cloudflare-Testschlüssel, besteht immer
    API = location.port === '3000' ? '/api/subscribe' : 'http://localhost:3000/api/subscribe'
  }

  var loadedAt = Date.now()
  var forms = [].slice.call(document.querySelectorAll('form[data-subscribe]'))
  if (!forms.length) return

  var MSG_RETRY = 'Something went wrong. Please try again in a moment.'

  forms.forEach(function (form) {
    // Honeypot (für Menschen unsichtbar, auch für Screenreader)
    var hp = document.createElement('div')
    hp.setAttribute('aria-hidden', 'true')
    hp.style.cssText = 'position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden'
    hp.innerHTML = '<input type="text" name="website" tabindex="-1" autocomplete="off">'
    form.appendChild(hp)

    // Turnstile-Container (zeigt nur etwas, wenn Cloudflare nachfragen muss)
    var box = document.createElement('div')
    box.className = 'subscribe-turnstile'
    box.style.cssText = 'flex-basis:100%;width:100%'
    form.parentNode.insertBefore(box, form.nextSibling)
    form._tsBox = box

    // Fehlerzeile
    var err = document.createElement('p')
    err.setAttribute('role', 'alert')
    err.className = form.getAttribute('data-error-class') || ''
    err.style.cssText = 'display:none;color:#e07a7a;font-size:0.75rem;margin-top:0.6rem'
    box.parentNode.insertBefore(err, box.nextSibling)
    form._err = err

    form.addEventListener('submit', onSubmit)
  })

  // Turnstile laden und pro Formular rendern
  window.__hfTurnstileReady = function () {
    forms.forEach(function (form) {
      form._tsId = window.turnstile.render(form._tsBox, {
        sitekey: SITE_KEY,
        execution: 'execute',
        appearance: 'interaction-only',
        callback: function (token) { if (form._tsResolve) form._tsResolve(token) },
        'error-callback': function () { if (form._tsReject) form._tsReject(new Error('turnstile')) },
        'expired-callback': function () { window.turnstile.reset(form._tsId) },
      })
    })
  }
  var s = document.createElement('script')
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__hfTurnstileReady'
  s.async = true
  s.defer = true
  document.head.appendChild(s)

  function getToken(form) {
    return new Promise(function (resolve, reject) {
      if (!window.turnstile || form._tsId === undefined) return reject(new Error('turnstile not ready'))
      form._tsResolve = resolve
      form._tsReject = reject
      window.turnstile.execute(form._tsId)
      setTimeout(function () { reject(new Error('turnstile timeout')) }, 60000)
    })
  }

  function showError(form, text) {
    form._err.textContent = text
    form._err.style.display = 'block'
  }

  function onSubmit(e) {
    e.preventDefault()
    var form = e.currentTarget
    var input = form.querySelector('input[type="email"]')
    var btn = form.querySelector('[type="submit"]')
    if (!input.value) return input.focus()
    form._err.style.display = 'none'

    var label = btn.textContent
    btn.disabled = true
    btn.textContent = 'Sending…'
    function restore() { btn.disabled = false; btn.textContent = label }

    getToken(form)
      .then(function (token) {
        return fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: input.value,
            website: form.querySelector('input[name="website"]').value,
            elapsed: Date.now() - loadedAt,
            token: token,
          }),
        })
      })
      .then(function (res) { return res.json().catch(function () { return { ok: false } }) })
      .then(function (data) {
        try { window.turnstile.reset(form._tsId) } catch (x) {}
        if (data && data.ok) {
          var hide = form.getAttribute('data-hide')
          var show = form.getAttribute('data-success')
          ;(hide ? document.querySelector(hide) : form).style.display = 'none'
          if (show) document.querySelector(show).style.display = 'block'
          form._tsBox.style.display = 'none'
          if (window.umami) window.umami.track('newsletter-signup')
        } else {
          restore()
          showError(form, (data && data.error) || MSG_RETRY)
        }
      })
      .catch(function () {
        try { window.turnstile.reset(form._tsId) } catch (x) {}
        restore()
        showError(form, MSG_RETRY)
      })
  }
})()
