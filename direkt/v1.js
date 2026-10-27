/* gc-direkt v1 – Kunden-Funnels senden die Bewerbung direkt an den GreenCareers-Bewerbungseingang
   (Patric, Anleitung „Deine Funnels an unseren Bewerbungseingang anschließen“, Stand 27.10.2026).

   Grundsatz: Ohne aktiven Schalter passiert NICHTS. Der heutige Weg (Make → Sheet → Make-Mail) läuft
   unverändert. Schalter in direkt/config.json: global „aktiv“ UND je Seite „aktiv“. Testmodus nur im
   eigenen Browser: Seite mit ?gc_direkt=test öffnen (gilt für den Tab), ?gc_direkt=aus beendet ihn.

   Ablauf bei aktivem Schalter:
   1. Bewerber klickt sich wie bisher durch den Funnel. Beim Absenden der Kontaktdaten öffnet sich ein
      Abschluss-Schritt mit den Pflichtangaben des Bewerbungseingangs (Bereich, Suchort, Umkreis, Vor-/
      Nachname, Kontaktweg, Erfahrung/Wünsche, WhatsApp-Häkchen, Datenschutz-Lesebestätigung, Turnstile).
   2. POST an den Bewerbungseingang (gleiche submission_id bei Wiederholung).
   3. Erfolg → bisheriger Make-Aufruf mit direkt_v3:"ok" (Sheet läuft weiter, Make schickt KEINE Mail).
      Kein Erfolg → bisheriger Make-Aufruf mit direkt_v3:"fehler" (alter Weg inkl. Make-Mail). So geht
      keine Bewerbung verloren.
   Das Fortsetzungsgeheimnis bleibt im Browser (sessionStorage), nie in URL, Sheet oder Make. */
(function () {
  "use strict";
  if (window.GC_DIREKT) return;
  var BASE = (document.currentScript && document.currentScript.src || "").replace(/[^/]*$/, "") ||
    "https://assets.green-careers.de/direkt/";
  var D = window.GC_DIREKT = { version: "gc-direkt-v1", aktiv: false, grund: "start", log: [] };
  function log(m) { try { D.log.push(new Date().toISOString() + " " + m); } catch (e) {} }

  /* ---------- Schalter ---------- */
  var modus = null;
  try {
    var q = new URLSearchParams(location.search).get("gc_direkt");
    if (q === "test" || q === "aus") sessionStorage.setItem("gc_direkt", q);
    modus = sessionStorage.getItem("gc_direkt");
  } catch (e) {}
  if (modus === "aus") { D.grund = "aus"; return; }
  var seitenKey = location.host + location.pathname.replace(/index\.html$/, "").replace(/\/?$/, "/");
  D.seite_key = seitenKey;

  var CONF = null, SEITE = null, MANIFEST = null;

  fetch(BASE + "config.json?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("config " + r.status); return r.json(); })
    .then(function (c) {
      CONF = c; SEITE = (c.seiten || {})[seitenKey] || null;
      if (!SEITE) { D.grund = "seite_nicht_konfiguriert"; return; }
      var live = c.aktiv === true && SEITE.aktiv === true;
      if (!live && modus !== "test") { D.grund = "schalter_aus"; return; }
      if (!c.turnstile_sitekey) { D.grund = "kein_sitekey"; return; }
      if (typeof window.submit !== "function" || !window.CFG || !window.S) { D.grund = "seite_unbekannt"; return; }
      D.test = !live;
      return ladeManifest().then(function (ok) {
        if (!ok) return;
        einhaengen();
        D.aktiv = true; D.grund = "aktiv"; log("aktiv " + seitenKey + (D.test ? " (test)" : ""));
      });
    })
    .catch(function (e) { D.grund = "config_fehler"; log(String(e)); });

  /* ---------- Stelle / Manifest ---------- */
  function jobSlug() {
    var st = window.S && window.S.stelle;
    if (SEITE.stellen && st && SEITE.stellen[st]) return SEITE.stellen[st];
    return SEITE.job_slug || null;
  }
  var manifestCache = {};
  function rpc(name, body) {
    return fetch(CONF.rest + "/" + name, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", "apikey": CONF.apikey, "Content-Profile": "api", "Accept-Profile": "api" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(name + " " + r.status + " " + (j && (j.code || j.message))); return j; }); });
  }
  function manifestFuer(slug, frisch) {
    if (!frisch && manifestCache[slug]) return Promise.resolve(manifestCache[slug]);
    return rpc("public_bewerbungsformular_s17_v1", { p_slug: slug }).then(function (m) {
      var pj = m && m.public_job;
      var fassung = m && m.datenschutz && m.datenschutz.fassung;
      if (!m || m.anzeige !== "v3" || !pj || !pj.job_slug || !(pj.publication_version >= 1) ||
          !/^[0-9a-f]{64}$/.test(pj.content_digest || "") || !fassung || fassung === "s17-datenschutz-fassung-offen") {
        throw new Error("manifest_ungueltig " + (m && m.anzeige));
      }
      manifestCache[slug] = m; return m;
    });
  }
  function ladeManifest() {
    /* Alle Stellen der Seite vorab prüfen. Ist eine nicht annahmebereit, bleibt die Seite beim alten Weg. */
    var slugs = [];
    if (SEITE.job_slug) slugs.push(SEITE.job_slug);
    for (var k in (SEITE.stellen || {})) if (slugs.indexOf(SEITE.stellen[k]) < 0) slugs.push(SEITE.stellen[k]);
    if (!slugs.length) { D.grund = "keine_stelle"; return Promise.resolve(false); }
    return Promise.all(slugs.map(function (s) { return manifestFuer(s); }))
      .then(function () { return true; })
      .catch(function (e) { D.grund = "manifest_fehler"; log(String(e)); return false; });
  }

  /* ---------- Einhängen in den bestehenden Funnel ---------- */
  var origSubmit, origFetch = window.fetch.bind(window), makeExtra = null, bypass = false;
  var ZUSTAND = null; /* {submission_id, secret, commitment, ergebnis:'ok'|'fehler', extra} */

  function einhaengen() {
    origSubmit = window.submit;
    window.submit = function () {
      if (bypass) return origSubmit.apply(this, arguments);
      var benutzt = false; try { benutzt = !!sessionStorage.getItem("gcf_used_" + window.LEAD_ID); } catch (e) {}
      if (ZUSTAND && ZUSTAND.ergebnis && ZUSTAND.lead === window.LEAD_ID && !benutzt) return sendeMake(ZUSTAND.extra);
      if (benutzt) ZUSTAND = null; /* zweite Bewerbung im selben Tab */
      if (!kontaktGueltig()) return origSubmit.apply(this, arguments); /* zeigt die gewohnten Fehlermeldungen */
      oeffneAbschluss();
    };
    /* Der bisherige Make-Aufruf bekommt die Direkt-Kennung angehängt (nur Teil A, nur einmal). */
    window.fetch = function (url, opt) {
      try {
        if (makeExtra && window.CFG && url === window.CFG.webhook && opt && typeof opt.body === "string") {
          var b = JSON.parse(opt.body);
          if (!b.teil) {
            for (var k in makeExtra) b[k] = makeExtra[k];
            opt = Object.assign({}, opt, { body: JSON.stringify(b) });
            makeExtra = null;
          }
        }
      } catch (e) {}
      return origFetch(url, opt);
    };
    /* Die alte Datenschutz-Zeile ersetzt im Direkt-Weg die Lesebestätigung des Bewerbungseingangs. */
    stil(); document.documentElement.classList.add("gcd-aktiv");
    ladeTurnstile();
  }
  function kontaktGueltig() {
    var n = val("fName"), t = val("fTel"), m = val("fMail");
    return n.length >= 2 && t.replace(/\D/g, "").length >= 7 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m);
  }
  function val(id) { var e = document.getElementById(id); return e ? String(e.value || "").trim() : ""; }

  function sendeMake(extra) {
    makeExtra = extra;
    var c = document.getElementById("fConsent"); if (c) c.checked = true;
    bypass = true;
    try { origSubmit(); } finally { bypass = false; }
    if (extra.direkt_v3 === "ok" && ZUSTAND && ZUSTAND.meldung) zeigeQuittung(ZUSTAND.meldung);
  }
  function zeigeQuittung(text) {
    var tries = 0, t = setInterval(function () {
      var s = document.getElementById("s-done");
      if (s && s.classList.contains("active") || ++tries > 40) {
        clearInterval(t);
        if (s && !document.getElementById("gcdQuittung")) {
          var p = document.createElement("p"); p.id = "gcdQuittung"; p.className = "gcd-quittung"; p.textContent = text;
          var h = s.querySelector("h1,h2,h3");
          if (h && h.parentNode) h.parentNode.insertBefore(p, h.nextSibling); else s.insertBefore(p, s.firstChild);
        }
      }
    }, 150);
  }

  /* ---------- Turnstile ---------- */
  var tsId = null, tsToken = null, tsWarten = [];
  function ladeTurnstile() {
    if (window.turnstile || document.getElementById("gcdTs")) return;
    var s = document.createElement("script"); s.id = "gcdTs"; s.async = true; s.defer = true;
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    document.head.appendChild(s);
  }
  function renderTurnstile(el) {
    if (!window.turnstile) { setTimeout(function () { renderTurnstile(el); }, 200); return; }
    if (tsId !== null) { try { window.turnstile.remove(tsId); } catch (e) {} }
    tsToken = null;
    tsId = window.turnstile.render(el, {
      sitekey: CONF.turnstile_sitekey, action: "bewerbung-eingang-v3", language: "de", appearance: "interaction-only",
      callback: function (t) { tsToken = t; var w = tsWarten; tsWarten = []; w.forEach(function (f) { f(t); }); },
      "expired-callback": function () { tsToken = null; },
      "error-callback": function () { tsToken = null; }
    });
  }
  function holeToken(neu) {
    if (neu && tsId !== null) { tsToken = null; try { window.turnstile.reset(tsId); } catch (e) {} }
    if (tsToken) { var t = tsToken; tsToken = null; return Promise.resolve(t); }
    return new Promise(function (res, rej) {
      var to = setTimeout(function () { rej(new Error("turnstile_timeout")); }, 30000);
      tsWarten.push(function (t) { clearTimeout(to); tsToken = null; res(t); });
    });
  }

  /* ---------- Hilfen ---------- */
  function b64url(bytes) {
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function sha256hex(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    });
  }
  function uuid4() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function neueAbgabe() {
    var secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
    return sha256hex("green-careers:website-direktbewerbung-v3:fortsetzung:" + secret).then(function (c) {
      var z = { submission_id: uuid4(), secret: secret, commitment: c, lead: window.LEAD_ID };
      try { sessionStorage.setItem("gcd_fortsetzung_" + z.submission_id, secret); } catch (e) {}
      return z;
    });
  }
  /* Telefon → E.164 (+49/+43/+41). Ohne Ländervorwahl gilt Deutschland. */
  function e164(raw) {
    var t = String(raw || "").replace(/[\s\-\/().]/g, "");
    if (/^00/.test(t)) t = "+" + t.slice(2);
    if (/^0/.test(t)) t = "+49" + t.slice(1);
    if (/^\+(49|43|41)0/.test(t)) t = t.slice(0, 3) + t.slice(4);
    return /^\+(49|43|41)[1-9]\d{3,12}$/.test(t) && t.length <= 16 ? t : null;
  }
  function namensTeile(n) {
    var p = String(n || "").trim().split(/\s+/);
    if (p.length < 2) return [p[0] || "", ""];
    return [p.slice(0, -1).join(" "), p[p.length - 1]];
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var BEREICHE = [["galabau", "Garten- & Landschaftsbau"], ["gruenpflege", "Grünpflege"], ["baumpflege", "Baumpflege"],
    ["forst", "Forst"], ["tiefbau", "Tiefbau"], ["baumschule", "Baumschule"], ["gaertnerei", "Gärtnerei"],
    ["gartencenter", "Gartencenter"], ["friedhofsgaertnerei", "Friedhofsgärtnerei"]];
  var UMKREIS = [["up_to_25_km", "Bis 25 km"], ["up_to_50_km", "Bis 50 km"], ["over_50_km", "Über 50 km"], ["relocation_possible", "Umzug möglich"]];

  /* ---------- Abschluss-Schritt ---------- */
  var ORTE = [], ortWahl = null;
  function oeffneAbschluss() {
    stil();
    var alt = document.getElementById("gcdBox"); if (alt) alt.remove();
    var S = window.S || {}, nt = namensTeile(val("fName"));
    var vorschlag = (SEITE.bereich_vorschlag || []);
    var umk = S.umkreis_code || null;
    var info = [];
    if (S.qualifikation) info.push("Qualifikation: " + S.qualifikation);
    if (S.erfahrung) info.push("Berufserfahrung: " + S.erfahrung);
    if (S.fuehrerschein) info.push("Führerschein: " + S.fuehrerschein);
    var box = document.createElement("div");
    box.id = "gcdBox"; box.className = "gcd"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    box.innerHTML =
      '<div class="gcd-in">' +
      '<button type="button" class="gcd-x" aria-label="Zurück" id="gcdZu">×</button>' +
      '<p class="gcd-kicker">Letzter Schritt</p><h2 class="gcd-h">Fast geschafft – noch kurz bestätigen</h2>' +
      (D.test ? '<p class="gcd-test">TESTMODUS – Bewerbung geht an den Bewerbungseingang (Test)</p>' : "") +
      '<form id="gcdForm" novalidate>' +
      '<fieldset class="gcd-f"><legend>In welchem Bereich arbeitest du?</legend><div class="gcd-chips">' +
      BEREICHE.map(function (b) {
        return '<label class="gcd-chip"><input type="checkbox" name="gcdBereich" value="' + b[0] + '"' + (vorschlag.indexOf(b[0]) >= 0 ? " checked" : "") + '><span>' + b[1] + "</span></label>";
      }).join("") + "</div></fieldset>" +
      '<fieldset class="gcd-f"><legend>Wo suchst du?</legend>' +
      '<div class="gcd-row"><input id="gcdOrtSuche" type="text" inputmode="text" autocomplete="postal-code" placeholder="PLZ oder Ort" value="' + esc(S.plz_ort || "") + '"><button type="button" class="gcd-btn2" id="gcdOrtBtn">Suchen</button></div>' +
      '<div id="gcdOrte" class="gcd-orte"></div></fieldset>' +
      '<fieldset class="gcd-f"><legend>Wie weit darf der Betrieb entfernt sein?</legend><div class="gcd-chips">' +
      UMKREIS.map(function (u) {
        return '<label class="gcd-chip"><input type="radio" name="gcdUmkreis" value="' + u[0] + '"' + (umk === u[0] ? " checked" : "") + '><span>' + u[1] + "</span></label>";
      }).join("") + "</div></fieldset>" +
      '<fieldset class="gcd-f"><legend>Deine Kontaktdaten</legend><div class="gcd-row2">' +
      '<input id="gcdVor" type="text" autocomplete="given-name" placeholder="Vorname" value="' + esc(nt[0]) + '">' +
      '<input id="gcdNach" type="text" autocomplete="family-name" placeholder="Nachname" value="' + esc(nt[1]) + '"></div>' +
      '<div class="gcd-row2"><input id="gcdTel" type="tel" autocomplete="tel" placeholder="Handynummer" value="' + esc(val("fTel")) + '">' +
      '<input id="gcdMail" type="email" autocomplete="email" placeholder="E-Mail" value="' + esc(val("fMail")) + '"></div></fieldset>' +
      '<fieldset class="gcd-f"><legend>Bevorzugter Kontaktweg</legend><div class="gcd-chips">' +
      '<label class="gcd-chip"><input type="radio" name="gcdWeg" value="whatsapp"><span>WhatsApp</span></label>' +
      '<label class="gcd-chip"><input type="radio" name="gcdWeg" value="email"><span>E-Mail</span></label></div></fieldset>' +
      '<fieldset class="gcd-f"><legend>Möchtest du uns noch etwas zu deiner Erfahrung oder deinen Wünschen mitgeben?</legend>' +
      '<textarea id="gcdText" rows="4" maxlength="2000">' + esc(info.join("\n")) + "</textarea></fieldset>" +
      '<label class="gcd-cb"><input type="checkbox" id="gcdWa"><span>' + esc(CONF.whatsapp_text) + "</span></label>" +
      '<label class="gcd-cb"><input type="checkbox" id="gcdDs"><span>' + esc(CONF.privacy_text) + ' <a href="' + esc(CONF.datenschutz_url) + '" target="_blank" rel="noopener">Datenschutzhinweise</a></span></label>' +
      '<div id="gcdTs" class="gcd-ts"></div>' +
      '<p id="gcdErr" class="gcd-err" role="alert"></p>' +
      '<button type="submit" class="gcd-btn" id="gcdSend">Jetzt Job-Angebot erhalten →</button>' +
      "</form></div>";
    document.body.appendChild(box);
    document.documentElement.classList.add("gcd-offen");
    document.getElementById("gcdZu").onclick = schliessen;
    document.getElementById("gcdOrtBtn").onclick = function () { sucheOrt(val("gcdOrtSuche")); };
    document.getElementById("gcdOrtSuche").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sucheOrt(val("gcdOrtSuche")); } });
    document.getElementById("gcdForm").addEventListener("submit", function (e) { e.preventDefault(); absenden(); });
    renderTurnstile(document.getElementById("gcdTs"));
    if (S.plz_ort) sucheOrt(S.plz_ort);
  }
  function schliessen() { var b = document.getElementById("gcdBox"); if (b) b.remove(); document.documentElement.classList.remove("gcd-offen"); }
  function sucheOrt(text) {
    var el = document.getElementById("gcdOrte"); if (!el) return;
    ortWahl = null; ORTE = [];
    var m = String(text || "").match(/\b\d{5}\b/), such = m ? m[0] : String(text || "").trim();
    if (such.length < 2) { el.innerHTML = ""; return; }
    el.innerHTML = '<p class="gcd-hint">Suche …</p>';
    rpc("public_bewerbungsorte_v1", { p_suche: such, p_limit: 8 }).then(function (r) {
      ORTE = (r && r.orte) || [];
      if (!ORTE.length) { el.innerHTML = '<p class="gcd-hint">Kein Ort gefunden. Bitte PLZ eingeben.</p>'; return; }
      el.innerHTML = ORTE.map(function (o, i) {
        return '<label class="gcd-chip gcd-ort"><input type="radio" name="gcdOrt" value="' + i + '"' + (ORTE.length === 1 ? " checked" : "") + "><span>" + esc(o.postal_code + " " + o.city) + ' <small>' + esc(o.region) + "</small></span></label>";
      }).join("");
      if (ORTE.length === 1) ortWahl = ORTE[0];
      el.querySelectorAll("input").forEach(function (i) { i.onchange = function () { ortWahl = ORTE[+i.value]; }; });
    }).catch(function (e) { log(String(e)); el.innerHTML = '<p class="gcd-hint">Ortssuche gerade nicht erreichbar. Bitte gleich nochmal „Suchen“.</p>'; });
  }
  function fehler(t) { var e = document.getElementById("gcdErr"); if (e) { e.textContent = t; e.classList.add("show"); e.scrollIntoView({ block: "nearest" }); } }

  function sammle() {
    var f = document.getElementById("gcdForm");
    var bereiche = [].map.call(f.querySelectorAll('input[name="gcdBereich"]:checked'), function (i) { return i.value; });
    var umk = (f.querySelector('input[name="gcdUmkreis"]:checked') || {}).value;
    var weg = (f.querySelector('input[name="gcdWeg"]:checked') || {}).value;
    var vor = val("gcdVor"), nach = val("gcdNach"), mail = val("gcdMail"), tel = e164(val("gcdTel")), text = val("gcdText");
    if (!bereiche.length) return fehler("Bitte wähle mindestens einen Bereich.");
    if (!ortWahl) return fehler("Bitte wähle deinen Suchort aus der Liste.");
    if (!umk) return fehler("Bitte wähle, wie weit der Betrieb entfernt sein darf.");
    if (vor.length < 2 || vor.length > 80) return fehler("Bitte gib deinen Vornamen ein.");
    if (nach.length < 2 || nach.length > 80) return fehler("Bitte gib deinen Nachnamen ein.");
    if (!tel) return fehler("Bitte gib eine gültige Handynummer ein (Deutschland, Österreich oder Schweiz).");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail) || mail.length > 254) return fehler("Bitte gib eine gültige E-Mail-Adresse ein.");
    if (!weg) return fehler("Bitte wähle deinen bevorzugten Kontaktweg.");
    if (text.length < 2) return fehler("Bitte schreib kurz etwas zu deiner Erfahrung oder deinen Wünschen.");
    if (!document.getElementById("gcdDs").checked) return fehler("Bitte bestätige, dass du die Datenschutzhinweise gelesen hast.");
    return {
      a1_areas: bereiche,
      a3_location: { location_ref: ortWahl.location_ref, country_code: ortWahl.country_code, postal_code: ortWahl.postal_code, city: ortWahl.city, region: ortWahl.region },
      a4_radius: umk,
      a5_contact: { first_name: vor, last_name: nach, email: mail, phone_e164: tel },
      a6_contact_way: weg,
      a7_experience_wishes: text.slice(0, 2000),
      _wa: document.getElementById("gcdWa").checked
    };
  }

  var laeuft = false;
  function absenden() {
    if (laeuft) return;
    var e = document.getElementById("gcdErr"); if (e) e.classList.remove("show");
    var a = sammle(); if (!a) return;
    var slug = jobSlug(), m = manifestCache[slug];
    if (!slug || !m) return ausweichen("keine_stelle");
    laeuft = true; knopf(true);
    var wa = a._wa; delete a._wa;
    var fingerprint = JSON.stringify([a, wa, slug]);
    var start = (ZUSTAND && ZUSTAND.offen && ZUSTAND.fp === fingerprint) ? Promise.resolve(ZUSTAND) : neueAbgabe();
    start.then(function (z) {
      ZUSTAND = z; z.fp = fingerprint; z.offen = true;
      var body = {
        operation: "base_submit", contract_version: "website_direct_application_v3",
        submission_id: z.submission_id,
        source_url: (location.origin + location.pathname.replace(/index\.html$/, "")).slice(0, 2048),
        public_job: { job_slug: m.public_job.job_slug, publication_version: m.public_job.publication_version, content_digest: m.public_job.content_digest },
        answers: a,
        whatsapp_reachable: !!wa,
        continuation: { version: 1, scheme: "sha256-client-secret-v1", commitment: z.commitment },
        declaration_profile: "privacy_notice_acknowledged_v1",
        privacy_notice_acknowledged: true,
        privacy_notice_text: CONF.privacy_text,
        privacy_version: m.datenschutz.fassung
      };
      if (wa) body.whatsapp_consent_version = CONF.whatsapp_version;
      return versuche(body, 0);
    }).catch(function (err) { log(String(err)); ausweichen("client_" + String(err && err.message || err).slice(0, 60)); });
  }
  function knopf(an) { var b = document.getElementById("gcdSend"); if (b) { b.disabled = an; b.textContent = an ? "Wird gesendet…" : "Jetzt Job-Angebot erhalten →"; } }

  var MAX = 3;
  function versuche(body, n) {
    return holeToken(n > 0).then(function (tok) {
      body.turnstile_token = tok;
      var ctl = window.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
      return origFetch(CONF.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined })
        .then(function (r) { clearTimeout(to); return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, j: j, h: r.headers }; }); },
              function (err) { clearTimeout(to); return { status: 0, j: null, netz: String(err) }; });
    }).then(function (r) {
      var code = (r.j && (r.j.code || r.j.error)) || ("http_" + r.status);
      log("versuch " + (n + 1) + " → " + r.status + " " + code);
      if (r.status === 200 && r.j && r.j.receipt && r.j.receipt.ok === true && (r.j.effect === "created" || r.j.effect === "replay")) {
        ZUSTAND.offen = false; ZUSTAND.ergebnis = "ok"; ZUSTAND.meldung = r.j.receipt.message || "";
        ZUSTAND.extra = { direkt_v3: "ok", direkt_referenz: r.j.receipt.reference || "", direkt_submission_id: body.submission_id, direkt_version: D.version };
        laeuft = false; schliessen(); sendeMake(ZUSTAND.extra); return;
      }
      /* Vom Bewerber korrigierbar: im Abschluss-Schritt bleiben, neue Abgabe-ID beim nächsten Senden. */
      if (r.status === 422) {
        if (code === "turnstile_failed" && n + 1 < MAX) return versuche(body, n + 1);
        ZUSTAND.offen = false; laeuft = false; knopf(false);
        return fehler(code === "turnstile_failed" ? "Die Sicherheitsprüfung hat nicht geklappt. Bitte versuch es noch einmal." :
          "Bitte prüfe deine Angaben" + (r.j && r.j.message ? ": " + r.j.message : "."));
      }
      /* Unklar oder vorübergehend: dieselbe Abgabe wiederholen. */
      if ((r.status === 0 || r.status === 429 || r.status >= 500) && n + 1 < MAX) {
        var warte = r.status === 429 ? Math.min(10000, 1000 * (+(r.h && r.h.get("Retry-After")) || (r.j && r.j.retry_after_seconds) || 4)) : [1500, 4000][n] || 4000;
        return new Promise(function (res) { setTimeout(res, warte); }).then(function () { return versuche(body, n + 1); });
      }
      ausweichen(code);
    });
  }
  /* Kein Erfolg beim Bewerbungseingang → heutiger Weg über Make (inkl. Make-Bestätigung). */
  function ausweichen(code) {
    laeuft = false;
    var z = ZUSTAND || {};
    z.ergebnis = "fehler"; z.lead = window.LEAD_ID;
    z.extra = { direkt_v3: "fehler", direkt_fehler: String(code || "unbekannt").slice(0, 80), direkt_submission_id: z.submission_id || "", direkt_version: D.version };
    ZUSTAND = z;
    schliessen(); sendeMake(z.extra);
  }

  /* ---------- Stil (nutzt die Farben der Funnel-Seite) ---------- */
  function stil() {
    if (document.getElementById("gcdStil")) return;
    var s = document.createElement("style"); s.id = "gcdStil";
    s.textContent =
      "html.gcd-offen,html.gcd-offen body{overflow:hidden}html.gcd-aktiv label:has(#fConsent){display:none!important}" +
      ".gcd{position:fixed;inset:0;z-index:2147483000;background:var(--bg,#f6f8f4);overflow-y:auto;-webkit-overflow-scrolling:touch;font-family:inherit;color:var(--ink,#14181c)}" +
      ".gcd-in{max-width:520px;margin:0 auto;padding:22px 18px 40px;position:relative}" +
      ".gcd-x{position:absolute;top:10px;right:10px;width:44px;height:44px;border:0;background:transparent;font-size:30px;line-height:1;cursor:pointer;color:inherit}" +
      ".gcd-kicker{margin:6px 0 2px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--primary-text,var(--primary,#126440))}" +
      ".gcd-h{margin:0 46px 14px 0;font-size:22px;line-height:1.25}" +
      ".gcd-test{background:#fff3cd;border:1px solid #f0c36d;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:700}" +
      ".gcd-f{border:0;margin:0 0 16px;padding:0}.gcd-f legend{font-weight:700;font-size:15px;margin:0 0 8px;padding:0}" +
      ".gcd-chips,.gcd-orte{display:flex;flex-wrap:wrap;gap:8px}" +
      ".gcd-chip{display:flex;align-items:center;gap:8px;border:1.5px solid var(--line,#dfe5ea);background:var(--card,#fff);border-radius:12px;padding:10px 12px;font-size:14px;cursor:pointer}" +
      ".gcd-chip input{accent-color:var(--primary,#126440);width:18px;height:18px;margin:0}.gcd-chip:has(input:checked){border-color:var(--primary,#126440)}" +
      ".gcd-ort{width:100%}.gcd-ort small{color:var(--ink-soft,#5b6770)}" +
      ".gcd input[type=text],.gcd input[type=tel],.gcd input[type=email],.gcd textarea{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px;border:1.5px solid var(--line,#dfe5ea);border-radius:12px;background:#fff;color:#14181c}" +
      ".gcd-row{display:flex;gap:8px;margin-bottom:8px}.gcd-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}" +
      "@media(max-width:400px){.gcd-row2{grid-template-columns:1fr}}" +
      ".gcd-btn2{flex:none;border:1.5px solid var(--primary,#126440);background:#fff;color:var(--primary,#126440);border-radius:12px;padding:0 14px;font:inherit;font-weight:700;cursor:pointer}" +
      ".gcd-cb{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;margin:0 0 10px;padding:11px 12px;border:1.5px solid var(--line,#dfe5ea);border-radius:12px;background:#fff;cursor:pointer}" +
      ".gcd-cb input{width:20px;height:20px;flex:none;margin:1px 0 0;accent-color:var(--primary,#126440)}.gcd-cb a{color:inherit;font-weight:700}" +
      ".gcd-hint{font-size:13px;color:var(--ink-soft,#5b6770);margin:4px 0}" +
      ".gcd-ts{margin:8px 0}.gcd-err{display:none;color:var(--err,#b42318);font-weight:600;font-size:14px}.gcd-err.show{display:block}" +
      ".gcd-btn{width:100%;border:0;border-radius:14px;padding:16px;font:inherit;font-size:17px;font-weight:700;background:var(--primary,#126440);color:var(--on-primary,#fff);cursor:pointer}" +
      ".gcd-btn:disabled{opacity:.6}.gcd-quittung{font-weight:600;margin:8px 0 12px}";
    document.head.appendChild(s);
  }
})();
