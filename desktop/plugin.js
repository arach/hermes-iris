// Iris desktop surface.
// Disk plugins load this file uncompiled. The only import specifiers that
// resolve are @hermes/plugin-sdk, react, and react/jsx-runtime.
// The 3D scene lives in dashboard/index.html. This file does not import three.js.
//
// SandboxedFrame only accepts an absolute http(s) URL and gives the guest an
// opaque origin, which blocks the one-pager from fetching its own sample.
// The page therefore uses a plain iframe of the dashboard URL when that URL
// is absolute, and always prints the dashboard path.

import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { host, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'

const PAGE = '/iris'
const VISUALIZER = '/dashboard-plugins/iris/iris.html'
const FRAME_URL = 'http://127.0.0.1:9119' + VISUALIZER
const KIND_LIMIT = 8
const LIST_LIMIT = 5

const EMPTY = {
  status: 'loading',
  note: 'Reading /api/plugins/iris/events.',
  sessions: null,
  events: null,
  kinds: [],
  errors: [],
  tools: [],
  stamp: '',
}

export default {
  id: 'iris',
  name: 'Iris',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Iris',
      data: { placement: 'right', width: '360px' },
      render: function () {
        return jsx(IrisPane, { ctx: ctx })
      },
    })
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: PAGE },
      render: function () {
        return jsx(IrisPage, { ctx: ctx })
      },
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: PAGE, label: 'Iris', codicon: 'pulse' },
    })
  },
}

function IrisPage(props) {
  const ctx = props.ctx
  const [frameNote, setFrameNote] = useState('')

  return jsxs('div', {
    style: {
      boxSizing: 'border-box',
      height: '100%',
      minHeight: '480px',
      display: 'flex',
      flexDirection: 'column',
      background: '#07090c',
      color: '#d5ddd8',
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(232, 244, 239, 0.12)',
          fontFamily: MONO,
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: '#8ea098',
        },
        children: [
          jsx('span', { style: { color: TEAL }, children: 'Iris 3D' }),
          jsx('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }, children: VISUALIZER }),
          jsx('button', {
            type: 'button',
            style: quietButton,
            onClick: function () {
              openExternal(ctx, FRAME_URL, setFrameNote)
            },
            children: 'Browser',
          }),
        ],
      }),
      frameNote
        ? jsx('div', {
            style: { padding: '6px 12px', fontFamily: MONO, fontSize: '11px', color: '#8ea098' },
            children: frameNote,
          })
        : null,
      jsx('iframe', {
        title: 'Iris 3D view',
        src: FRAME_URL,
        style: {
          flex: 1,
          width: '100%',
          border: '0',
          background: '#07090c',
        },
      }),
    ],
  })
}

function IrisPane(props) {
  const ctx = props.ctx
  const [snap, setSnap] = useState(EMPTY)

  useEffect(function () {
    let alive = true

    function pull() {
      ctx
        .rest('/events')
        .then(function (body) {
          if (!alive) return
          setSnap(summarize(body))
        })
        .catch(function () {
          if (!alive) return
          ctx
            .rest('/health')
            .then(function (health) {
              if (!alive) return
              setSnap(function (prev) {
                return keepOrOffline(prev, healthNote(health))
              })
            })
            .catch(function () {
              if (!alive) return
              setSnap(function (prev) {
                return keepOrOffline(prev, 'Events route is not reachable. The 3D page still opens the dashboard path.')
              })
            })
        })
    }

    pull()
    const stop = typeof ctx.setInterval === 'function' ? ctx.setInterval(pull, 5000) : function () {}
    return function () {
      alive = false
      stop()
    }
  }, [ctx])

  function openView() {
    try {
      host.navigate(PAGE)
    } catch (err) {
      setSnap(function (prev) {
        return Object.assign({}, prev, { note: VISUALIZER })
      })
    }
  }

  const maxKind = snap.kinds.length ? snap.kinds[0][1] : 1

  return jsxs('div', {
    style: paneStyle,
    children: [
      jsx('div', { style: accentRule }),
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
        children: [
          jsx('div', { style: kicker, children: 'Iris' }),
          jsx('div', { style: badgeStyle(snap.status), children: statusLabel(snap.status) }),
        ],
      }),
      jsx('button', {
        type: 'button',
        style: primaryButton,
        onClick: openView,
        children: 'Open 3D view',
      }),
      jsx('div', { style: pathStyle, children: VISUALIZER }),
      jsxs('div', {
        style: cardStyle,
        children: [
          jsxs('div', {
            style: { display: 'flex', gap: '16px' },
            children: [
              metric('Sessions', snap.sessions),
              metric('Events', snap.events),
            ],
          }),
        ],
      }),
      section('By kind', kindMeters(snap.kinds, maxKind)),
      section('Recent errors', errorList(snap.errors, snap.status)),
      section('Last tool calls', toolList(snap.tools, snap.status)),
      jsx('div', { style: footStyle, children: snap.note }),
      snap.stamp
        ? jsx('div', { style: footStyle, children: snap.stamp })
        : null,
    ],
  })
}

function metric(label, value) {
  return jsxs('div', {
    style: { flex: 1, minWidth: 0 },
    children: [
      jsx('div', { style: kicker, children: label }),
      jsx('div', {
        style: {
          marginTop: '4px',
          fontFamily: MONO,
          fontSize: '28px',
          lineHeight: 1,
          color: '#e7fff8',
          fontVariantNumeric: 'tabular-nums',
        },
        children: value == null ? '—' : String(value),
      }),
    ],
  })
}

function section(title, body) {
  return jsxs('section', {
    style: cardStyle,
    children: [
      jsx('div', { style: Object.assign({}, kicker, { marginBottom: '8px' }), children: title }),
      body,
    ],
  })
}

function kindMeters(kinds, maxKind) {
  if (!kinds.length) {
    return jsx('div', { style: mutedStyle, children: 'No events yet.' })
  }
  const shown = kinds.slice(0, KIND_LIMIT)
  const hidden = kinds.length - shown.length
  const rows = shown.map(function (row) {
    const name = row[0]
    const count = row[1]
    const width = Math.max(3, Math.round((count / maxKind) * 100))
    return jsxs(
      'div',
      {
        style: { display: 'grid', gridTemplateColumns: '92px 1fr 28px', gap: '8px', alignItems: 'center' },
        children: [
          jsx('span', { style: rowLabel, children: name.replace(/_/g, ' ') }),
          jsx('span', {
            style: trackStyle,
            children: jsx('span', { style: Object.assign({}, fillStyle, { width: width + '%' }) }),
          }),
          jsx('span', { style: countStyle, children: String(count) }),
        ],
      },
      name,
    )
  })
  if (hidden > 0) {
    rows.push(jsx('div', { style: mutedStyle, children: '+' + hidden + ' more' }, 'more'))
  }
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' }, children: rows })
}

function errorList(errors, status) {
  if (!errors.length) {
    const text = status === 'loading' ? 'Reading…' : status === 'offline' ? 'Unavailable.' : 'No errors in this window.'
    return jsx('div', { style: mutedStyle, children: text })
  }
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '6px' },
    children: errors.map(function (row) {
      return jsxs(
        'div',
        {
          style: { display: 'flex', flexDirection: 'column', gap: '2px' },
          children: [
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', gap: '8px', color: '#ff8d7a', fontFamily: MONO, fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase' },
              children: [
                jsx('span', { children: row.level || 'error' }),
                jsx('span', { children: row.clock }),
              ],
            }),
            jsx('div', { style: { color: '#e7eee9' }, children: row.title }),
          ],
        },
        row.id,
      )
    }),
  })
}

function toolList(tools, status) {
  if (!tools.length) {
    const text = status === 'loading' ? 'Reading…' : status === 'offline' ? 'Unavailable.' : 'No tool calls in this window.'
    return jsx('div', { style: mutedStyle, children: text })
  }
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '6px' },
    children: tools.map(function (row) {
      return jsxs(
        'div',
        {
          style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' },
          children: [
            jsxs('div', {
              style: { minWidth: 0 },
              children: [
                jsx('div', { style: { color: TEAL, fontFamily: MONO, fontSize: '12px' }, children: row.name }),
                row.title && row.title !== row.name
                  ? jsx('div', { style: Object.assign({}, mutedStyle, { marginTop: '2px' }), children: row.title })
                  : null,
              ],
            }),
            jsx('span', { style: countStyle, children: row.clock }),
          ],
        },
        row.id,
      )
    }),
  })
}

function summarize(body) {
  const doc = body && typeof body === 'object' ? body : {}
  const events = Array.isArray(doc.events) ? doc.events : []
  const stats = doc.stats && typeof doc.stats === 'object' ? doc.stats : {}
  const source = doc.source && typeof doc.source === 'object' ? doc.source : {}
  const mode = source.mode === 'live' || source.mode === 'sample' ? source.mode : events.length ? 'live' : 'offline'
  const kinds = kindEntries(stats.kinds, events)
  const note = typeof source.note === 'string' && source.note ? source.note : 'Events loaded.'
  const stamp = typeof doc.generated_at === 'string' ? doc.generated_at : ''
  return {
    status: mode === 'offline' ? 'offline' : mode,
    note: note,
    sessions: countSessions(doc, stats, events),
    events: numberOr(stats.events, events.length),
    kinds: kinds,
    errors: recentErrors(events),
    tools: recentTools(events),
    stamp: stamp,
  }
}

function offlineSnap(note) {
  return {
    status: 'offline',
    note: note,
    sessions: null,
    events: null,
    kinds: [],
    errors: [],
    tools: [],
    stamp: '',
  }
}

function keepOrOffline(prev, note) {
  if (prev && (prev.status === 'live' || prev.status === 'sample')) {
    return Object.assign({}, prev, { note: 'Events route missed a refresh. Showing the last copy.' })
  }
  return offlineSnap(note)
}

function healthNote(health) {
  if (!health || typeof health !== 'object') {
    return 'Events route is not reachable. The 3D page still opens the dashboard path.'
  }
  const visualizer = typeof health.visualizer === 'string' ? health.visualizer : VISUALIZER
  const note = typeof health.note === 'string' ? health.note : 'Health responded. Events did not.'
  return note + ' ' + visualizer
}

function countSessions(doc, stats, events) {
  const seen = Object.create(null)
  let count = 0
  const sessions = Array.isArray(doc.sessions) ? doc.sessions : []
  sessions.forEach(function (session) {
    const id = session && session.id
    if (!id || seen[id]) return
    seen[id] = true
    count += 1
  })
  events.forEach(function (event) {
    const id = event && event.session_id
    if (!id || seen[id]) return
    seen[id] = true
    count += 1
  })
  const reported = Number(stats.sessions)
  if (Number.isFinite(reported) && reported > count) return reported
  if (count || Number.isFinite(reported)) return count
  return 0
}

function kindEntries(raw, events) {
  const counts = Object.create(null)
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(function (name) {
      const count = Number(raw[name])
      if (Number.isFinite(count) && count > 0) counts[name] = count
    })
  }
  if (!Object.keys(counts).length) {
    events.forEach(function (event) {
      const name = event && event.kind ? String(event.kind) : 'log'
      counts[name] = (counts[name] || 0) + 1
    })
  }
  return Object.keys(counts)
    .map(function (name) {
      return [name, counts[name]]
    })
    .sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    })
}

function recentErrors(events) {
  const rows = []
  for (let i = events.length - 1; i >= 0 && rows.length < LIST_LIMIT; i -= 1) {
    const event = events[i]
    if (!event || typeof event !== 'object') continue
    const level = String(event.level || '').toUpperCase()
    if (event.kind !== 'error' && level !== 'ERROR' && level !== 'CRITICAL') continue
    rows.push({
      id: String(event.id || 'error-' + i),
      level: level || 'ERROR',
      title: clip(event.title || event.detail || 'error', 88),
      clock: clockOf(event),
    })
  }
  return rows
}

function recentTools(events) {
  const calls = collectTools(events, function (event) {
    return event.kind === 'tool_call'
  })
  if (calls.length) return calls
  return collectTools(events, function (event) {
    return event.kind === 'tool_result' || !!event.tool_name
  })
}

function collectTools(events, match) {
  const rows = []
  for (let i = events.length - 1; i >= 0 && rows.length < LIST_LIMIT; i -= 1) {
    const event = events[i]
    if (!event || typeof event !== 'object' || !match(event)) continue
    const name = event.tool_name ? String(event.tool_name) : clip(event.title || 'tool', 32)
    rows.push({
      id: String(event.id || 'tool-' + i),
      name: name,
      title: clip(event.title || '', 72),
      clock: clockOf(event),
    })
  }
  return rows
}

function numberOr(value, fallback) {
  const count = Number(value)
  return Number.isFinite(count) ? count : fallback
}

function clockOf(event) {
  const iso = event && typeof event.ts_iso === 'string' ? event.ts_iso : ''
  const match = iso.match(/T(\d{2}:\d{2}:\d{2})/)
  return match ? match[1] : ''
}

function clip(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value
  return value.slice(0, limit - 1) + '…'
}

function statusLabel(status) {
  if (status === 'live') return 'Live'
  if (status === 'sample') return 'Sample'
  if (status === 'offline') return 'Offline'
  return 'Reading'
}

function openExternal(ctx, url, setNote) {
  const open = ctx && ctx.os && ctx.os.openExternal
  if (typeof open !== 'function') {
    setNote(VISUALIZER)
    return
  }
  Promise.resolve(open(url))
    .then(function (ok) {
      if (ok === false) setNote(VISUALIZER)
    })
    .catch(function () {
      setNote(VISUALIZER)
    })
}

const TEAL = '#3ddec8'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const paneStyle = {
  boxSizing: 'border-box',
  height: '100%',
  overflow: 'auto',
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  background: '#07090c',
  color: '#d5ddd8',
  fontSize: '12px',
  lineHeight: 1.4,
}

const accentRule = {
  height: '2px',
  background: TEAL,
  borderRadius: '1px',
}

const kicker = {
  margin: 0,
  fontFamily: MONO,
  fontSize: '10px',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: '#8ea098',
}

const cardStyle = {
  border: '1px solid rgba(232, 244, 239, 0.12)',
  borderRadius: '2px',
  padding: '10px',
  background: 'rgba(8, 12, 14, 0.72)',
}

const pathStyle = {
  fontFamily: MONO,
  fontSize: '10px',
  letterSpacing: '0.04em',
  color: '#8ea098',
  wordBreak: 'break-all',
}

const mutedStyle = {
  color: '#8ea098',
  fontSize: '12px',
}

const rowLabel = {
  fontFamily: MONO,
  fontSize: '10px',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: '#c5d2cb',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const countStyle = {
  fontFamily: MONO,
  fontSize: '10px',
  color: '#8ea098',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

const trackStyle = {
  display: 'block',
  height: '4px',
  background: 'rgba(232, 244, 239, 0.08)',
  border: '1px solid rgba(232, 244, 239, 0.08)',
  borderRadius: '1px',
  overflow: 'hidden',
}

const fillStyle = {
  display: 'block',
  height: '100%',
  background: TEAL,
}

const footStyle = {
  margin: 0,
  color: '#6f7d76',
  fontSize: '11px',
}

const primaryButton = {
  width: '100%',
  border: '1px solid #1c7568',
  background: '#123f3a',
  color: '#e7fff8',
  fontFamily: MONO,
  fontSize: '12px',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  padding: '11px 12px',
  cursor: 'pointer',
  borderRadius: '2px',
}

const quietButton = {
  border: '1px solid rgba(232, 244, 239, 0.16)',
  background: 'transparent',
  color: '#d5ddd8',
  fontFamily: MONO,
  fontSize: '10px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  padding: '4px 8px',
  cursor: 'pointer',
  borderRadius: '2px',
}

function badgeStyle(status) {
  const color = status === 'offline' ? '#ff8d7a' : status === 'loading' ? '#8ea098' : TEAL
  return {
    fontFamily: MONO,
    fontSize: '10px',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: color,
  }
}
