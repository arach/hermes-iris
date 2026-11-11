/* 1. <script src="iris-addons.js"></script> sets window.IrisAddons (classic or type=module). var iris = window.IrisAddons.
2. iris.mountAgentCostPanel(document.querySelector("#iris-cost"), doc, function (sessionId) { focus that session });
3. Put data-event-id="<event id>" on scene marks, then iris.highlightFailures(doc) toggles .iris-addon-fail.
4. iris.analyzeFailures(doc) -> [{eventId, sessionId, kind, message, causeToolCallId}].
5. iris.costByAgent(doc) -> [{sessionId, label, parentSessionId, tokensIn, tokensOut, durationMs, toolCalls, errors}].
6. iris.startLive(function (batch) { append batch.events (dedupe by id); replace sessions from batch.sessions; keep the sample if batch.message; }, {intervalMs: 3000});
7. startLive polls GET /api/plugins/iris/live then /live?since=<cursor>. Events are newer than that cursor. sessions is a fresh snapshot.
8. iris.stop() when Live is turned off or the page is hidden.
9. On file://, or the first time /live fails, onBatch gets message "Live unavailable — showing sample" and empty events.
10. Pass the previous batch.cursor back only through startLive. Do not read state.db. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) root.IrisAddons = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this, function () {
  var UNAVAILABLE = "Live unavailable — showing sample";
  var STYLE_ID = "iris-addon-styles";
  var generation = 0;
  var timer = null;
  var cursor = null;
  var statusEl = null;
  var downAnnounced = false;

  function ensureStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".iris-addon-panel {",
      "  --iris-addon-bg: var(--iris-bg, #0c0e14);",
      "  --iris-addon-fg: var(--iris-fg, #ebe6dc);",
      "  --iris-addon-muted: var(--iris-muted, #9c968c);",
      "  --iris-addon-line: var(--iris-line, rgba(255,255,255,.08));",
      "  --iris-addon-accent: var(--iris-accent, #e4c27a);",
      "  color: var(--iris-addon-fg);",
      "  background: var(--iris-addon-bg);",
      "  border: 1px solid var(--iris-addon-line);",
      "  border-radius: 16px;",
      "  padding: 14px 14px 8px;",
      "  font: 13px/1.45 Palatino, 'Palatino Linotype', 'Iowan Old Style', Georgia, serif;",
      "  box-shadow: 0 18px 50px rgba(0,0,0,.35);",
      "}",
      ".iris-addon-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }",
      ".iris-addon-mark {",
      "  width: 42px; height: 3px; border-radius: 99px; flex: none;",
      "  background: linear-gradient(90deg, #ff5d73, #ffb020, #ffe56a, #3ddc97, #4cc3ff, #b07cff);",
      "}",
      ".iris-addon-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .01em; }",
      ".iris-addon-meta { margin-left: auto; color: var(--iris-addon-muted); font: 11px/1 ui-sans-serif, system-ui, sans-serif; }",
      ".iris-addon-list { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow: auto; }",
      ".iris-addon-row {",
      "  width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 4px 12px;",
      "  text-align: left; color: inherit; background: transparent;",
      "  border: 0; border-top: 1px solid var(--iris-addon-line);",
      "  padding: 8px 2px; cursor: pointer; font: inherit;",
      "}",
      ".iris-addon-row:hover, .iris-addon-row:focus-visible { background: rgba(255,255,255,.04); outline: none; }",
      ".iris-addon-name { font-weight: 600; }",
      ".iris-addon-tag {",
      "  margin-left: 8px; font: 10px/1.4 ui-sans-serif, system-ui, sans-serif;",
      "  letter-spacing: .08em; text-transform: uppercase; color: var(--iris-addon-accent);",
      "}",
      ".iris-addon-stats { grid-column: 1 / -1; color: var(--iris-addon-muted); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }",
      ".iris-addon-tokens { font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--iris-addon-accent); }",
      ".iris-addon-empty { margin: 4px 0 10px; color: var(--iris-addon-muted); }",
      ".iris-addon-fail {",
      "  box-shadow: inset 3px 0 0 #ff5d73, inset 0 -1px 0 rgba(176,124,255,.45);",
      "}",
      ".iris-addon-live {",
      "  position: fixed; left: 16px; bottom: 16px; z-index: 40;",
      "  max-width: min(420px, calc(100vw - 32px));",
      "  padding: 10px 12px; border-radius: 12px;",
      "  color: var(--iris-fg, #ebe6dc); background: var(--iris-bg, #0c0e14);",
      "  border: 1px solid rgba(255,255,255,.1);",
      "  border-top: 2px solid transparent;",
      "  border-image: linear-gradient(90deg, #ff5d73, #ffb020, #3ddc97, #4cc3ff, #b07cff) 1;",
      "  font: 13px/1.4 Palatino, Georgia, serif;",
      "  box-shadow: 0 12px 40px rgba(0,0,0,.4);",
      "}"
    ].join("\n");
    document.head.appendChild(style);
  }

  function textOf(event) {
    return [event.title, event.detail, event.message, event.content].filter(Boolean).join("\n");
  }

  function oneLine(value, limit) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= limit) return text;
    return text.slice(0, limit - 1) + "…";
  }

  function payloadFailed(text) {
    if (!text) return false;
    if (/returned error/i.test(text)) return true;
    if (/"status"\s*:\s*"error"/i.test(text)) return true;
    if (/"success"\s*:\s*false/.test(text)) return true;
    if (/"exit_code"\s*:\s*(?!0\b)-?\d+/.test(text)) return true;
    var re = /"error"\s*:\s*/g;
    var match;
    while ((match = re.exec(text))) {
      var rest = text.slice(match.index + match[0].length).trim();
      if (rest.indexOf("null") === 0 || rest.indexOf('""') === 0) continue;
      if (rest.charAt(0) === '"' || rest.charAt(0) === "{" || rest.charAt(0) === "[" || rest.charAt(0) === "-" || /\d/.test(rest.charAt(0))) {
        return true;
      }
    }
    return false;
  }

  function isFailure(event) {
    var kind = event.kind || "";
    var level = String(event.level || "").toUpperCase();
    if (kind === "error" || kind === "warning") return true;
    if (level === "ERROR" || level === "CRITICAL" || level === "WARNING") return true;
    if (kind === "tool_result" || kind === "delegate") return payloadFailed(textOf(event));
    return false;
  }

  function toolFromEvent(event) {
    if (event.tool_name) return String(event.tool_name);
    var title = String(event.title || "");
    var titled = title.match(/^(?:tool_call|tool_result):([A-Za-z0-9_.-]+)/);
    if (titled) return titled[1];
    var returned = textOf(event).match(/Tool\s+([A-Za-z0-9_.-]+)\s+returned error/i);
    if (returned) return returned[1];
    if (/^delegate/i.test(title)) return title.split(/\s+/)[0];
    return "";
  }

  function firstCallId(text) {
    var match = String(text || "").match(/\b(call_[A-Za-z0-9]+)\b/);
    return match ? match[1] : null;
  }

  function collectCalls(doc) {
    var calls = [];
    var sessions = (doc && doc.sessions) || [];
    var events = (doc && doc.events) || [];
    sessions.forEach(function (session) {
      (session.messages || []).forEach(function (message) {
        var ts = Number(message.timestamp);
        (message.tool_calls || []).forEach(function (call) {
          if (!call) return;
          var id = call.id || call.tool_call_id || call.call_id;
          var fn = call.function || {};
          var name = call.name || fn.name || "";
          if (id) calls.push({ sessionId: session.id, ts: ts, tool: String(name), id: String(id) });
        });
      });
    });
    events.forEach(function (event) {
      if (event.kind !== "tool_call" && event.kind !== "delegate") return;
      if (/result/i.test(event.title || "") && event.kind === "delegate") return;
      var id = event.tool_call_id || firstCallId(textOf(event));
      if (!id) return;
      calls.push({
        sessionId: event.session_id || null,
        ts: Number(event.ts_unix),
        tool: toolFromEvent(event),
        id: String(id)
      });
    });
    return calls;
  }

  function causeFor(event, calls) {
    if (event.tool_call_id) return String(event.tool_call_id);
    var tool = toolFromEvent(event);
    var sessionId = event.session_id || null;
    var ts = Number(event.ts_unix);
    var embedded = firstCallId(textOf(event));
    if (!sessionId && !tool) return embedded;
    var best = null;
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i];
      if (sessionId && call.sessionId && call.sessionId !== sessionId) continue;
      if (tool && call.tool && call.tool !== tool) continue;
      if (!tool && !sessionId) continue;
      if (Number.isFinite(ts) && Number.isFinite(call.ts) && call.ts > ts + 0.05) continue;
      if (!best || !Number.isFinite(best.ts) || call.ts >= best.ts) best = call;
    }
    return best ? best.id : embedded;
  }

  function analyzeFailures(doc) {
    var events = (doc && doc.events) || [];
    var calls = collectCalls(doc || {});
    var seen = {};
    var failures = [];
    events.forEach(function (event, index) {
      if (!event || !isFailure(event)) return;
      var message = oneLine(event.title || event.detail || event.message || event.kind || "failure", 240);
      var sessionId = event.session_id || null;
      var key = String(sessionId || "") + "|" + String(event.kind || "") + "|" + message;
      if (seen[key]) return;
      seen[key] = true;
      failures.push({
        eventId: event.id != null ? String(event.id) : "f" + index,
        sessionId: sessionId,
        kind: event.kind || "error",
        message: message,
        causeToolCallId: causeFor(event, calls)
      });
    });
    return failures;
  }

  function shortId(id) {
    var text = String(id || "");
    if (text.length <= 14) return text;
    return text.slice(0, 8) + "…" + text.slice(-4);
  }

  function labelFor(session) {
    var title = session.title && String(session.title).trim();
    if (title) return title;
    var parts = [session.source, session.model].filter(Boolean).join(" · ");
    var brief = shortId(session.id);
    if (parts && brief) return parts + " · " + brief;
    return parts || brief || "session";
  }

  function toolCallsFor(session, events) {
    var counted = Number(session.tool_call_count);
    if (Number.isFinite(counted) && counted > 0) return counted;
    var total = 0;
    events.forEach(function (event) {
      if (event.session_id !== session.id) return;
      if (event.kind === "tool_call") total += 1;
      else if (event.kind === "delegate" && !/result/i.test(event.title || "")) total += 1;
    });
    return total;
  }

  function positiveUnix(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }

  function durationFor(session, events) {
    var started = positiveUnix(session.started_at);
    var ended = positiveUnix(session.ended_at);
    if (!Number.isFinite(ended)) {
      (session.messages || []).forEach(function (message) {
        var ts = Number(message.timestamp);
        if (Number.isFinite(ts) && (!Number.isFinite(ended) || ts > ended)) ended = ts;
      });
      (events || []).forEach(function (event) {
        if (!session.id || event.session_id !== session.id) return;
        var ts = Number(event.ts_unix);
        if (Number.isFinite(ts) && (!Number.isFinite(ended) || ts > ended)) ended = ts;
      });
    }
    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
      return Math.round((ended - started) * 1000);
    }
    var wall = session.timings && Number(session.timings.wall_clock_ms);
    return Number.isFinite(wall) && wall >= 0 ? Math.round(wall) : 0;
  }

  function costByAgent(doc) {
    var sessions = (doc && doc.sessions) || [];
    var events = (doc && doc.events) || [];
    var failures = analyzeFailures(doc || {});
    var errors = {};
    failures.forEach(function (failure) {
      if (!failure.sessionId) return;
      errors[failure.sessionId] = (errors[failure.sessionId] || 0) + 1;
    });
    return sessions.map(function (session) {
      return {
        sessionId: session.id,
        label: labelFor(session),
        parentSessionId: session.parent_session_id || null,
        tokensIn: Number(session.input_tokens) || 0,
        tokensOut: Number(session.output_tokens) || 0,
        durationMs: durationFor(session, events),
        toolCalls: toolCallsFor(session, events),
        errors: errors[session.id] || 0
      };
    }).sort(function (a, b) {
      return (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut);
    });
  }

  function compactNumber(value) {
    var number = Number(value) || 0;
    if (number >= 1000000) return (number / 1000000).toFixed(1) + "m";
    if (number >= 1000) return (number / 1000).toFixed(1) + "k";
    return String(number);
  }

  function formatDuration(ms) {
    var seconds = Math.round((Number(ms) || 0) / 1000);
    if (seconds < 60) return seconds + "s";
    var minutes = Math.floor(seconds / 60);
    return minutes + "m " + (seconds % 60) + "s";
  }

  function mountAgentCostPanel(el, doc, onSelectSession) {
    if (!el || typeof el.appendChild !== "function") return el;
    ensureStyles();
    var rows = costByAgent(doc || {});
    el.classList.add("iris-addon-panel");
    el.textContent = "";
    var head = document.createElement("div");
    head.className = "iris-addon-head";
    var mark = document.createElement("span");
    mark.className = "iris-addon-mark";
    mark.setAttribute("aria-hidden", "true");
    var title = document.createElement("h2");
    title.className = "iris-addon-title";
    title.textContent = "Agent cost";
    var meta = document.createElement("span");
    meta.className = "iris-addon-meta";
    meta.textContent = rows.length === 1 ? "1 session" : rows.length + " sessions";
    head.appendChild(mark);
    head.appendChild(title);
    head.appendChild(meta);
    el.appendChild(head);
    if (!rows.length) {
      var empty = document.createElement("p");
      empty.className = "iris-addon-empty";
      empty.textContent = "No session cost yet.";
      el.appendChild(empty);
      return el;
    }
    var list = document.createElement("ol");
    list.className = "iris-addon-list";
    rows.forEach(function (row) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "iris-addon-row";
      button.setAttribute("data-session-id", row.sessionId || "");
      var name = document.createElement("span");
      name.className = "iris-addon-name";
      name.textContent = row.label;
      if (row.parentSessionId) {
        var tag = document.createElement("span");
        tag.className = "iris-addon-tag";
        tag.textContent = "child";
        name.appendChild(tag);
      }
      var tokens = document.createElement("span");
      tokens.className = "iris-addon-tokens";
      tokens.textContent = compactNumber(row.tokensIn + row.tokensOut);
      var stats = document.createElement("span");
      stats.className = "iris-addon-stats";
      stats.textContent = [
        "in " + compactNumber(row.tokensIn),
        "out " + compactNumber(row.tokensOut),
        "tools " + row.toolCalls,
        "errors " + row.errors,
        formatDuration(row.durationMs)
      ].join("  ·  ");
      button.appendChild(name);
      button.appendChild(tokens);
      button.appendChild(stats);
      button.addEventListener("click", function () {
        if (typeof onSelectSession === "function") onSelectSession(row.sessionId, row);
      });
      item.appendChild(button);
      list.appendChild(item);
    });
    el.appendChild(list);
    return el;
  }

  function highlightFailures(doc) {
    var failures = analyzeFailures(doc || {});
    var eventIds = failures.map(function (failure) { return failure.eventId; });
    var byId = {};
    failures.forEach(function (failure) {
      if (failure.eventId) byId[failure.eventId] = failure;
    });
    ensureStyles();
    if (typeof document !== "undefined" && document.querySelectorAll) {
      var nodes = document.querySelectorAll("[data-event-id]");
      for (var i = 0; i < nodes.length; i++) {
        var id = nodes[i].getAttribute("data-event-id");
        if (byId[id]) nodes[i].classList.add("iris-addon-fail");
        else nodes[i].classList.remove("iris-addon-fail");
      }
    }
    return { className: "iris-addon-fail", eventIds: eventIds, byId: byId, failures: failures };
  }

  function showStatus(text) {
    if (typeof document === "undefined") return;
    if (!text) {
      if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
      statusEl = null;
      return;
    }
    ensureStyles();
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.className = "iris-addon-live";
      statusEl.setAttribute("role", "status");
      (document.body || document.documentElement).appendChild(statusEl);
    }
    statusEl.textContent = text;
  }

  function unavailableBatch() {
    return { ok: false, cursor: cursor, events: [], sessions: [], message: UNAVAILABLE };
  }

  function liveUrl() {
    var base = "/api/plugins/iris/live";
    if (cursor == null || cursor === "") return base;
    return base + "?since=" + encodeURIComponent(cursor);
  }

  function stop() {
    generation += 1;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startLive(onBatch, opts) {
    stop();
    var token = generation;
    var intervalMs = 3000;
    if (opts && isFinite(opts.intervalMs) && opts.intervalMs >= 250) {
      intervalMs = opts.intervalMs;
    }
    if (typeof location !== "undefined" && location.protocol === "file:") {
      var offline = unavailableBatch();
      showStatus(UNAVAILABLE);
      if (typeof onBatch === "function") onBatch(offline);
      return;
    }
    async function tick() {
      if (token !== generation) return;
      try {
        var response = await fetch(liveUrl(), { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error("live " + response.status);
        var data = await response.json();
        if (token !== generation) return;
        if (data && data.cursor != null && data.cursor !== "") cursor = String(data.cursor);
        downAnnounced = false;
        showStatus("");
        if (typeof onBatch === "function") onBatch(data);
      } catch (error) {
        if (token !== generation) return;
        showStatus(UNAVAILABLE);
        if (!downAnnounced) {
          downAnnounced = true;
          if (typeof onBatch === "function") onBatch(unavailableBatch());
        }
      }
    }
    tick();
    timer = setInterval(tick, intervalMs);
  }

  return {
    startLive: startLive,
    stop: stop,
    analyzeFailures: analyzeFailures,
    costByAgent: costByAgent,
    mountAgentCostPanel: mountAgentCostPanel,
    highlightFailures: highlightFailures
  };
});
