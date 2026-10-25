// Injected as the first script of a game under review. Runs inside a
// sandboxed iframe (opaque origin) and talks to the 审核 page via postMessage.
(function () {
  var P = { errors: [], probeNotes: [], audioCtx: 0, starts: [], firstInputAt: 0 };
  function send(type, data) { parent.postMessage({ __forge: true, type: type, data: data }, "*"); }
  function note(msg) { if (P.errors.length < 30) P.errors.push(String(msg).slice(0, 300)); }

  addEventListener("error", function (e) { note((e.message || "error") + (e.lineno ? " @" + e.lineno : "")); });
  addEventListener("unhandledrejection", function (e) { note("Promise: " + (e.reason && e.reason.message || e.reason)); });
  var ce = console.error;
  console.error = function () { note([].slice.call(arguments).join(" ")); return ce.apply(this, arguments); };

  // The sandbox has no storage; give the game an in-memory one so a missing
  // try/catch around localStorage is not misreported as a crash.
  try {
    var mem = {};
    var store = {
      getItem: function (k) { return k in mem ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; },
      clear: function () { mem = {}; },
      key: function (i) { return Object.keys(mem)[i] || null; },
      get length() { return Object.keys(mem).length; },
    };
    Object.defineProperty(window, "localStorage", { value: store, configurable: true });
    Object.defineProperty(window, "sessionStorage", { value: store, configurable: true });
  } catch (e) {}

  // Synthetic pointers have no real pointer id to capture.
  try {
    var spc = Element.prototype.setPointerCapture, rpc = Element.prototype.releasePointerCapture;
    Element.prototype.setPointerCapture = function (id) { try { return spc.call(this, id); } catch (e) {} };
    Element.prototype.releasePointerCapture = function (id) { try { return rpc.call(this, id); } catch (e) {} };
  } catch (e) {}

  // Count audio: a game with BGM keeps starting sources long after the first tap.
  ["AudioContext", "webkitAudioContext"].forEach(function (k) {
    var C = window[k];
    if (!C) return;
    var W = function () { var c = new (Function.prototype.bind.apply(C, [null].concat([].slice.call(arguments))))(); P.audioCtx++; return c; };
    W.prototype = C.prototype;
    window[k] = W;
  });
  try {
    var st = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function () { P.starts.push(performance.now()); return st.apply(this, arguments); };
  } catch (e) {}

  function mainCanvas() {
    var best = null, area = 0;
    document.querySelectorAll("canvas").forEach(function (c) {
      if (!c.width || !c.height) return;
      var r = c.getBoundingClientRect(), a = r.width * r.height;
      if (a > area) { area = a; best = c; }
    });
    return best;
  }

  function pageColor() {
    var b = getComputedStyle(document.body).backgroundColor;
    if (!b || b === "rgba(0, 0, 0, 0)" || b === "transparent") b = getComputedStyle(document.documentElement).backgroundColor;
    return !b || b === "rgba(0, 0, 0, 0)" || b === "transparent" ? "#ffffff" : b;
  }

  // Whole phone screen as the player sees it: page background + canvas at its real rect.
  function snap() {
    var c = mainCanvas();
    var w = 360, s = w / innerWidth, h = Math.round(innerHeight * s);
    var o = document.createElement("canvas");
    o.width = w; o.height = h;
    var x = o.getContext("2d");
    x.fillStyle = pageColor();
    x.fillRect(0, 0, w, h);
    if (c) {
      var r = c.getBoundingClientRect();
      try { x.drawImage(c, r.left * s, r.top * s, r.width * s, r.height * s); } catch (e) { P.probeNotes.push("截图失败：" + e.message); }
    }
    return { img: o.toDataURL("image/jpeg", 0.82), bands: bands(o) };
  }

  // Share of the top/bottom 5% that is one flat colour: a letterbox looks like ~1.0.
  function bands(o) {
    try {
      var x = o.getContext("2d"), h = Math.max(4, Math.round(o.height * 0.05));
      function flat(y0) {
        var d = x.getImageData(0, y0, o.width, h).data, counts = {}, max = 0;
        for (var i = 0; i < d.length; i += 4) {
          var k = (d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4);
          counts[k] = (counts[k] || 0) + 1;
          if (counts[k] > max) max = counts[k];
        }
        return +(max / (d.length / 4)).toFixed(3);
      }
      return { top: flat(0), bottom: flat(o.height - h) };
    } catch (e) { return null; }
  }

  function layout() {
    var c = mainCanvas();
    if (!c) return { canvas: false, vw: innerWidth, vh: innerHeight };
    var r = c.getBoundingClientRect();
    return {
      canvas: true, vw: innerWidth, vh: innerHeight,
      coverW: +(Math.min(r.width, innerWidth) / innerWidth).toFixed(3),
      coverH: +(Math.min(r.height, innerHeight) / innerHeight).toFixed(3),
      buffer: c.width + "x" + c.height,
    };
  }

  function fire(target, type, x, y) {
    var o = { clientX: x, clientY: y, screenX: x, screenY: y, pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1 };
    try { target.dispatchEvent(new PointerEvent(type, o)); } catch (e) {}
    var m = { pointerdown: "mousedown", pointerup: "mouseup" }[type];
    if (m) try { target.dispatchEvent(new MouseEvent(m, o)); } catch (e) {}
    var t = { pointerdown: "touchstart", pointerup: "touchend" }[type];
    if (t) try {
      var touch = new Touch({ identifier: 1, target: target, clientX: x, clientY: y });
      target.dispatchEvent(new TouchEvent(t, { touches: t === "touchend" ? [] : [touch], changedTouches: [touch], bubbles: true, cancelable: true }));
    } catch (e) {}
  }

  function tap() {
    var c = mainCanvas() || document.body, r = c.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height * 0.6;
    if (!P.firstInputAt) P.firstInputAt = performance.now();
    fire(c, "pointerdown", x, y);
    setTimeout(function () { fire(c, "pointerup", x, y); try { c.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true })); } catch (e) {} }, 90);
  }

  function report() {
    var t0 = P.firstInputAt, after = t0 ? P.starts.filter(function (t) { return t > t0 + 1500; }) : [];
    // Music keeps hitting new half-second slots; sound effects come in a few bursts.
    var slots = {};
    if (t0) P.starts.forEach(function (t) { if (t > t0 + 1000 && t < t0 + 9000) slots[Math.floor((t - t0) / 500)] = 1; });
    var text = (document.body && document.body.innerText || "").slice(0, 2000);
    return {
      errors: P.errors,
      probeNotes: P.probeNotes,
      audioContexts: P.audioCtx,
      audioStarts: P.starts.length,
      audioStartsLater: after.length,
      audioSpanSec: after.length > 1 ? +((after[after.length - 1] - after[0]) / 1000).toFixed(1) : 0,
      audioSlots: Object.keys(slots).length,
      hasGAME: !!(window.GAME && typeof window.GAME.step === "function"),
      domText: text,
      title: document.title,
      cjkVisible: /[一-鿿]/.test(text),
    };
  }

  // Lazy strategies through the window.GAME test hook: if they survive the
  // whole window, the game has no real fail condition for them.
  function bots() {
    var G = window.GAME;
    if (!G || typeof G.step !== "function") return null;
    var out = {}, LIMIT = 150, dt = 1 / 60;
    var strategies = {
      idle: function () {},
      tapSpam: function (t) { if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) try { G.act && G.act("tap"); } catch (e) {} },
    };
    Object.keys(strategies).forEach(function (name) {
      try {
        if (G.start) G.start();
        var t = 0, s = null;
        for (; t < LIMIT; t += dt) {
          strategies[name](t);
          G.step(dt);
          s = G.state ? G.state() : null;
          if (s && /over|dead|lose|win|end/i.test(String(s.mode || s.state || ""))) break;
        }
        out[name] = { survivedSec: +t.toFixed(1), limitSec: LIMIT, finalState: s ? JSON.parse(JSON.stringify(s)) : null };
      } catch (e) { out[name] = { error: String(e && e.message || e) }; }
    });
    return out;
  }

  addEventListener("message", function (e) {
    var m = e.data;
    if (!m || !m.__forge) return;
    var reply = { id: m.id };
    if (m.cmd === "snap") { var s = snap(); reply.img = s.img; reply.bands = s.bands; reply.layout = layout(); }
    else if (m.cmd === "tap") tap();
    else if (m.cmd === "report") reply.report = report();
    else if (m.cmd === "bots") reply.bots = bots();
    send("reply", reply);
  });
  addEventListener("load", function () { send("ready", {}); });
})();
