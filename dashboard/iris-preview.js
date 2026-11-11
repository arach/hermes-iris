/*
Iris artifact preview. Survey of ~/.hermes/hermes-agent (read-only, 2026-11-11).
No .env, auth.json, or credential store was opened.

A plugin may use these public surfaces:

- Desktop SDK @hermes/plugin-sdk, apps/desktop/src/sdk/index.ts, documented in
  website/docs/developer-guide/desktop-plugin-sdk.md (UI kit + SandboxedFrame).
  Preview-relevant exports: MessageTextContent and Streamdown (markdown),
  CopyButton, writeClipboardText (CopyButton's clipboard path), LogView (mono
  log chrome only; it does not parse ANSI), SandboxedFrame. SandboxedFrame
  accepts an http(s) or data src and a title. srcdoc is not a prop. An empty
  sandbox is rewritten to allow-scripts (apps/desktop/src/components/ui/sandboxed-frame.tsx).
- Dashboard host window.__HERMES_PLUGIN_SDK__ (web/src/plugins/sdk.d.ts,
  exposePluginSDK in web/src/plugins/registry.ts, contract 1.1.0). Public
  components: Card, Badge, Button, Checkbox, ConfirmDialog, Dialog*, Input,
  Label, Select, Separator, Tabs*, Toast, PluginSlot, plus React. registerSlot
  exists. There is no artifact-preview slot. Markdown, code, diff, JSON, image,
  and ANSI are not on that map. web/src/components/Markdown.tsx is internal.

Present in the app, not a public SDK export, so a plugin may not import them:

- Code: apps/desktop/src/components/chat/code-editor.tsx, code-card.tsx,
  shiki-highlight-cache.ts
- Diff: apps/desktop/src/components/chat/diff-lines.tsx, syntax-diff.tsx,
  components/ui/diff-count.tsx
- JSON: apps/desktop/src/components/chat/json-document-editor.tsx
- ANSI: apps/desktop/src/components/assistant-ui/ansi-text.tsx (lib/ansi.ts)
- Image: apps/desktop/src/components/chat/zoomable-image.tsx, preview-attachment.tsx
- HTML srcdoc: apps/desktop/src/components/ui/preview-document-frame.tsx
  (browser-hosted path forces allow-scripts). Not exported.
- Log tail: apps/desktop/src/components/chat/log-tail.tsx

This file calls a Hermes component only when that function is actually on
@hermes/plugin-sdk or window.__HERMES_PLUGIN_SDK__. HTML always uses a raw
iframe with sandbox="" and srcdoc, because the public frame cannot express
that posture. Every kind has a dependency-free fallback.

When window.IrisCM is present (dashboard/vendor/codemirror.bundle.js), code,
JSON, unified diffs, logs, and markdown source render in a read-only
CodeMirror 6 view (line numbers, folding, Ctrl/Cmd-F). The painters below
remain in place when IrisCM is absent. Checked 2026-11-11: the Hermes plugin
catalog, `hermes plugins`, and ~/.hermes have no web code viewer a dashboard
page can load. Desktop viewers (devkit, git-review) stay inside the desktop app.
*/
(function (root, factory) {
  var api = factory()
  root.IrisPreview = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var KINDS = { code: 1, markdown: 1, diff: 1, json: 1, image: 1, html: 1, text: 1, log: 1 }
  var MAX_LINES = 4000
  var HOST_SPEC = {
    markdown: ['MessageTextContent', 'Streamdown', 'Markdown', 'MarkdownTextContent'],
    code: ['CodeBlock', 'CodeView'],
    diff: ['DiffLines', 'DiffView'],
    json: ['JsonView', 'JsonTree'],
    image: ['ZoomableImage'],
    log: ['AnsiText'],
    html: []
  }
  var EXT_LANG = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go',
    rs: 'rust', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    md: 'markdown', mdx: 'markdown', html: 'html', htm: 'html', xml: 'xml',
    css: 'css', scss: 'css', sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', diff: 'diff', patch: 'diff', txt: 'text', log: 'log'
  }
  var LANG_ALIAS = {
    js: 'javascript', jsx: 'javascript', node: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell',
    zsh: 'shell', shell: 'shell', yml: 'yaml', md: 'markdown', markdown: 'markdown',
    htm: 'html', xml: 'html', rs: 'rust', rb: 'ruby', plaintext: 'text', text: 'text',
    jsonc: 'json', diff: 'diff', patch: 'diff'
  }
  var KEYWORDS = {
    javascript: words('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var void while with yield await of async null undefined true false'),
    typescript: words('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var void while with yield await of async null undefined true false type interface implements public private protected readonly as enum namespace declare abstract string number boolean any unknown never'),
    python: words('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'),
    shell: words('if then else elif fi for while do done case esac function return in local export'),
    ruby: words('BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'),
    go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'),
    rust: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
    sql: words('select from where and or not insert into update set delete join left right inner outer on group by order limit offset as create table drop alter values null true false'),
    css: words(''),
    html: words(''),
    json: words('true false null'),
    yaml: words('true false null yes no'),
    markdown: words(''),
    diff: words(''),
    text: words('')
  }

  var deskPromise = null

  function words(list) {
    var map = Object.create(null)
    var parts = list.split(' ')
    for (var i = 0; i < parts.length; i++) if (parts[i]) map[parts[i]] = 1
    return map
  }

  function doc() {
    return typeof document !== 'undefined' ? document : null
  }

  function dashboardSdk() {
    var sdk = rootSdk()
    return sdk && typeof sdk === 'object' ? sdk : null
  }

  function rootSdk() {
    var g = typeof globalThis !== 'undefined' ? globalThis : null
    if (!g) return null
    return g.__HERMES_PLUGIN_SDK__ || null
  }

  function desktopLikely() {
    var g = typeof globalThis !== 'undefined' ? globalThis : null
    var d = doc()
    if (!g || !d) return false
    if (g.hermesDesktop) return true
    try {
      var maps = d.querySelectorAll ? d.querySelectorAll('script[type="importmap"]') : []
      for (var i = 0; i < maps.length; i++) {
        var text = maps[i].textContent || ''
        if (text.indexOf('@hermes/plugin-sdk') !== -1) return true
      }
    } catch (err) { /* no import map */ }
    return false
  }

  function loadDesktopSdk() {
    if (deskPromise) return deskPromise
    if (!desktopLikely()) {
      deskPromise = Promise.resolve(null)
      return deskPromise
    }
    deskPromise = import('@hermes/plugin-sdk').then(function (mod) {
      return mod || null
    }).catch(function () {
      return null
    })
    return deskPromise
  }

  function findReact(dash, desk) {
    if (dash && dash.React) return dash.React
    if (typeof globalThis !== 'undefined' && globalThis.React) return globalThis.React
    if (desk && desk.React) return desk.React
    return null
  }

  function findCreateRoot(dash, desk) {
    var list = []
    if (typeof globalThis !== 'undefined') list.push(globalThis.ReactDOM)
    if (dash) list.push(dash.ReactDOM)
    if (desk) list.push(desk.ReactDOM)
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i].createRoot === 'function') return list[i].createRoot
    }
    return null
  }

  function pickExport(dash, desk, names) {
    for (var i = 0; i < names.length; i++) {
      var name = names[i]
      if (desk && typeof desk[name] === 'function') return { name: name, Comp: desk[name], from: 'desktop' }
      var bag = dash && dash.components
      if (bag && typeof bag[name] === 'function') return { name: name, Comp: bag[name], from: 'dashboard' }
      if (dash && typeof dash[name] === 'function') return { name: name, Comp: dash[name], from: 'dashboard' }
    }
    return null
  }

  function hostProps(name, art) {
    var text = art.content || ''
    if (name === 'Streamdown') return { children: text }
    if (name === 'Markdown') return { content: text }
    if (name === 'MessageTextContent' || name === 'MarkdownTextContent') {
      return { text: text, media: false, previewOnly: true }
    }
    if (name === 'AnsiText') return { text: text }
    if (name === 'DiffLines' || name === 'DiffView') return { text: text, diff: text }
    if (name === 'JsonView' || name === 'JsonTree') return { text: text, value: art.jsonValue, data: art.jsonValue }
    if (name === 'ZoomableImage') return { src: art.url || art.content, alt: art.name }
    if (name === 'CodeBlock' || name === 'CodeView') return { code: text, text: text, language: art.language || 'text' }
    return { text: text, content: text }
  }

  function mountHost(body, art, picked, dash, desk) {
    var React = findReact(dash, desk)
    var createRoot = findCreateRoot(dash, desk)
    if (!React || !createRoot || !picked) return null
    var props = hostProps(picked.name, art)
    var children = props.children
    var rest = {}
    var key
    for (key in props) if (key !== 'children') rest[key] = props[key]
    var node = React.createElement(picked.Comp, rest, children)
    var failed = false
    var Boundary = function Boundary() { return null }
    if (typeof React.Component === 'function') {
      Boundary = class IrisHostBoundary extends React.Component {
        constructor(p) {
          super(p)
          this.state = { err: false }
        }
        static getDerivedStateFromError() { return { err: true } }
        componentDidCatch() { failed = true }
        render() {
          if (this.state.err) return null
          return this.props.children
        }
      }
      node = React.createElement(Boundary, null, node)
    }
    var root = createRoot(body)
    root.render(node)
    if (failed) {
      try { root.unmount() } catch (err) { /* already torn down */ }
      return null
    }
    return { root: root, name: picked.name, from: picked.from }
  }

  function ensureStyles() {
    var d = doc()
    if (!d || !d.head || !d.getElementById) return
    if (d.getElementById('iris-pv-styles')) return
    var style = d.createElement('style')
    style.id = 'iris-pv-styles'
    style.textContent = CSS
    d.head.appendChild(style)
  }

  function h(tag, className, text) {
    var node = doc().createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function append(parent, child) {
    if (child) parent.appendChild(child)
    return child
  }

  function render(el, artifact) {
    if (!el || typeof el.replaceChildren !== 'function') {
      throw new TypeError('IrisPreview.render expects an element')
    }
    ensureStyles()
    if (el.__irisPvRoot && typeof el.__irisPvRoot.unmount === 'function') {
      try { el.__irisPvRoot.unmount() } catch (err) { /* host root already gone */ }
      el.__irisPvRoot = null
    }
    var art = normalizeArtifact(artifact)
    destroyCm(el)
    var gen = (el.__irisPvGen = (el.__irisPvGen || 0) + 1)
    var shell
    try {
      shell = paintShell(art)
      el.replaceChildren(shell.root)
      paintFallback(shell.body, art)
    } catch (err) {
      var fail = h('div', 'iris-pv iris-pv-error', 'Preview failed')
      el.replaceChildren(fail)
      return
    }
    var dash = dashboardSdk()
    var pickedNow = pickExport(dash, null, HOST_SPEC[art.kind] || [])
    if (pickedNow) applyHost(el, shell, art, pickedNow, dash, null, gen)
    loadDesktopSdk().then(function (desk) {
      if (!desk || el.__irisPvGen !== gen) return
      var picked = pickExport(dashboardSdk(), desk, HOST_SPEC[art.kind] || [])
      if (!picked) return
      applyHost(el, shell, art, picked, dashboardSdk(), desk, gen)
    })
  }

  function applyHost(el, shell, art, picked, dash, desk, gen) {
    if (el.__irisPvGen !== gen) return
    var mounted
    try {
      destroyCm(shell.body)
      shell.body.replaceChildren()
      mounted = mountHost(shell.body, art, picked, dash, desk)
    } catch (err) {
      mounted = null
    }
    if (!mounted) {
      try { paintFallback(shell.body, art) } catch (err2) { /* keep the shell */ }
      return
    }
    el.__irisPvRoot = mounted.root
    shell.chip.textContent = 'Hermes'
    shell.chip.hidden = false
    shell.chip.setAttribute('data-iris-host', mounted.name)
  }

  function paintShell(art) {
    var root = h('div', 'iris-pv')
    root.setAttribute('data-iris-kind', art.kind)
    var bar = h('div', 'iris-pv-bar')
    append(bar, h('span', 'iris-pv-kind', art.kind))
    append(bar, h('span', 'iris-pv-name', art.name || 'artifact'))
    if (art.language && art.kind === 'code') append(bar, h('span', 'iris-pv-lang', art.language))
    var chip = h('span', 'iris-pv-host')
    chip.hidden = true
    append(bar, chip)
    var copy = h('button', 'iris-pv-copy', 'Copy')
    copy.type = 'button'
    copy.addEventListener('click', function () {
      var payload = art.content || art.url || ''
      copyText(payload).then(function (ok) {
        copy.textContent = ok ? 'Copied' : 'Failed'
        setTimeout(function () { copy.textContent = 'Copy' }, 1200)
      })
    })
    append(bar, copy)
    var body = h('div', 'iris-pv-body')
    append(root, bar)
    append(root, body)
    return { root: root, body: body, chip: chip }
  }

  function cmApi() {
    var g = typeof globalThis !== 'undefined' ? globalThis : null
    var cm = g && g.IrisCM
    if (!cm || typeof cm.createViewer !== 'function') return null
    return cm
  }

  function destroyCm(el) {
    if (!el) return
    var nodes = []
    if (el.getAttribute && el.getAttribute('data-iris-cm-host') != null) nodes.push(el)
    if (el.querySelectorAll) {
      var found = el.querySelectorAll('[data-iris-cm-host]')
      for (var i = 0; i < found.length; i++) nodes.push(found[i])
    }
    for (var j = 0; j < nodes.length; j++) {
      var view = nodes[j].__irisCmView
      nodes[j].__irisCmView = null
      if (view && typeof view.destroy === 'function') {
        try { view.destroy() } catch (err) { /* view already gone */ }
      }
    }
  }

  function clipLines(text) {
    var raw = String(text == null ? '' : text)
    var lines = raw.split(/\r\n|\n|\r/)
    var clipped = lines.length > MAX_LINES
    if (clipped) lines = lines.slice(0, MAX_LINES)
    return { text: lines.join('\n'), clipped: clipped, empty: raw.length === 0 }
  }

  function stripAnsi(text) {
    return String(text)
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  }

  function mountCm(body, opts) {
    var cm = cmApi()
    if (!cm) return false
    if (opts.diff && typeof cm.createDiff !== 'function') return false
    var box = h('div', 'iris-pv-cm-wrap')
    if (opts.banner) append(box, h('div', 'iris-pv-note', opts.banner))
    var host = h('div', 'iris-pv-cm')
    host.setAttribute('data-iris-cm-host', '1')
    append(box, host)
    if (opts.note) append(box, h('div', 'iris-pv-note', opts.note))
    append(body, box)
    try {
      var view = opts.diff ? cm.createDiff(host, opts.diffSpec) : cm.createViewer(host, opts.view)
      if (!view || typeof view.destroy !== 'function') throw new Error('IrisCM')
      host.__irisCmView = view
      return true
    } catch (err) {
      if (box.parentNode) box.parentNode.removeChild(box)
      return false
    }
  }

  function paintFallback(body, art) {
    destroyCm(body)
    body.replaceChildren()
    if (art.kind === 'code') return paintCode(body, art)
    if (art.kind === 'markdown') return paintMarkdown(body, art.content || '')
    if (art.kind === 'diff') return paintDiff(body, art.content || '')
    if (art.kind === 'json') return paintJson(body, art)
    if (art.kind === 'image') return paintImage(body, art)
    if (art.kind === 'html') return paintHtml(body, art)
    if (art.kind === 'log') return paintLog(body, art.content || '')
    return paintText(body, art.content || art.url || '')
  }

  function paintText(body, text) {
    var pre = h('pre', 'iris-pv-text')
    pre.textContent = clipText(text)
    append(body, pre)
  }

  function paintCode(body, art) {
    if (cmApi()) {
      if (!(art.content || '').length) {
        append(body, h('div', 'iris-pv-empty', 'Empty file'))
        return
      }
      var parsedCm = splitNumbered(art.content || '')
      var cmLines = parsedCm.lines
      var cmClipped = cmLines.length > MAX_LINES
      if (cmClipped) cmLines = cmLines.slice(0, MAX_LINES)
      if (mountCm(body, {
        view: { doc: cmLines.join('\n'), lang: art.language || 'text', readOnly: true },
        note: cmClipped ? 'Showing the first ' + MAX_LINES + ' lines' : ''
      })) return
    }
    var raw = art.content || ''
    var parsed = splitNumbered(raw)
    var lines = parsed.lines
    var clipped = lines.length > MAX_LINES
    if (clipped) lines = lines.slice(0, MAX_LINES)
    var wrap = h('div', 'iris-pv-code')
    var width = String(lines.length + parsed.start).length
    for (var i = 0; i < lines.length; i++) {
      var row = h('div', 'iris-pv-row')
      var gutter = h('span', 'iris-pv-gutter', String(parsed.numbers ? parsed.numbers[i] : i + 1))
      gutter.style.minWidth = width + 'ch'
      var line = h('span', 'iris-pv-line')
      paintTokens(line, tokenize(lines[i], art.language || 'text'))
      append(row, gutter)
      append(row, line)
      append(wrap, row)
    }
    if (!lines.length) append(wrap, h('div', 'iris-pv-empty', 'Empty file'))
    append(body, wrap)
    if (clipped) append(body, h('div', 'iris-pv-note', 'Showing the first ' + MAX_LINES + ' lines'))
  }

  function paintTokens(line, tokens) {
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i]
      var span = h('span', 'iris-pv-tok iris-pv-tok-' + tok[0], tok[1])
      append(line, span)
    }
  }

  function paintDiff(body, text) {
    if (cmApi()) {
      if (!String(text).length) {
        append(body, h('div', 'iris-pv-empty', 'Empty diff'))
        return
      }
      var clippedCm = clipLines(text)
      if (mountCm(body, {
        diff: true,
        diffSpec: clippedCm.text,
        note: clippedCm.clipped ? 'Showing the first ' + MAX_LINES + ' lines' : ''
      })) return
    }
    var lines = String(text).split(/\r\n|\n|\r/)
    var clipped = lines.length > MAX_LINES
    if (clipped) lines = lines.slice(0, MAX_LINES)
    var wrap = h('div', 'iris-pv-diff')
    for (var i = 0; i < lines.length; i++) {
      var row = h('div', 'iris-pv-diff-line ' + diffClass(lines[i]))
      row.textContent = lines[i].length ? lines[i] : ' '
      append(wrap, row)
    }
    if (!String(text).length) append(wrap, h('div', 'iris-pv-empty', 'Empty diff'))
    append(body, wrap)
    if (clipped) append(body, h('div', 'iris-pv-note', 'Showing the first ' + MAX_LINES + ' lines'))
  }

  function diffClass(line) {
    if (line.indexOf('diff ') === 0 || line.indexOf('index ') === 0 || line.indexOf('--- ') === 0 || line.indexOf('+++ ') === 0) {
      return 'iris-pv-diff-meta'
    }
    if (line.indexOf('@@') === 0) return 'iris-pv-diff-hunk'
    if (line.indexOf('+') === 0) return 'iris-pv-diff-add'
    if (line.indexOf('-') === 0) return 'iris-pv-diff-del'
    if (line.indexOf('\\') === 0) return 'iris-pv-diff-note'
    return 'iris-pv-diff-ctx'
  }

  function paintJson(body, art) {
    if (cmApi()) {
      var rawJson = art.content || ''
      var pretty = rawJson
      var invalid = false
      if (art.jsonValue !== undefined) {
        try { pretty = JSON.stringify(art.jsonValue, null, 2) } catch (err) { pretty = rawJson }
      } else if (rawJson && rawJson.length <= 200000) {
        try { pretty = JSON.stringify(JSON.parse(rawJson), null, 2) } catch (err) { invalid = true }
      }
      var clippedCm = clipLines(pretty)
      if (clippedCm.empty) {
        append(body, h('div', 'iris-pv-empty', 'Empty JSON'))
        return
      }
      if (mountCm(body, {
        banner: invalid ? 'Invalid JSON' : '',
        view: { doc: clippedCm.text, lang: 'json', readOnly: true },
        note: clippedCm.clipped ? 'Showing the first ' + MAX_LINES + ' lines' : ''
      })) return
    }
    if ((art.content || '').length > 200000) {
      append(body, h('div', 'iris-pv-note', 'JSON is too large to expand here'))
      paintText(body, String(art.content || '').slice(0, 4000))
      return
    }
    var value = art.jsonValue
    if (value === undefined) {
      try { value = JSON.parse(art.content || '') } catch (err) { value = undefined }
    }
    if (value === undefined) {
      append(body, h('div', 'iris-pv-note', 'Invalid JSON'))
      paintCode(body, { content: art.content || '', language: 'json' })
      return
    }
    var tree = h('div', 'iris-pv-json')
    tree.setAttribute('role', 'tree')
    append(tree, jsonNode(value, '', 0))
    append(body, tree)
  }

  function jsonNode(value, key, depth) {
    var row = h('div', 'iris-pv-json-node')
    var type = jsonType(value)
    if (type === 'array' || type === 'object') {
      var open = depth < 2
      var toggle = h('button', 'iris-pv-twist' + (open ? ' iris-pv-open' : ''))
      toggle.type = 'button'
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      toggle.textContent = '>'
      var label = h('span', 'iris-pv-json-label')
      if (key) append(label, h('span', 'iris-pv-tok iris-pv-tok-key', key))
      var count = type === 'array' ? value.length : Object.keys(value).length
      append(label, h('span', 'iris-pv-json-meta', (key ? ' ' : '') + (type === 'array' ? '[' + count + ']' : '{' + count + '}')))
      var kids = h('div', 'iris-pv-json-kids')
      if (!open) kids.hidden = true
      fillJsonKids(kids, value, type, depth)
      toggle.addEventListener('click', function () {
        var next = toggle.getAttribute('aria-expanded') !== 'true'
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false')
        toggle.className = 'iris-pv-twist' + (next ? ' iris-pv-open' : '')
        kids.hidden = !next
      })
      append(row, toggle)
      append(row, label)
      append(row, kids)
      return row
    }
    var leaf = h('div', 'iris-pv-json-leaf')
    if (key) {
      append(leaf, h('span', 'iris-pv-tok iris-pv-tok-key', key))
      append(leaf, h('span', 'iris-pv-tok iris-pv-tok-punct', ': '))
    }
    append(leaf, h('span', 'iris-pv-tok iris-pv-tok-' + type, jsonPreview(value, type)))
    append(row, leaf)
    return row
  }

  function fillJsonKids(kids, value, type, depth) {
    var keys = type === 'array' ? value.map(function (_, i) { return String(i) }) : Object.keys(value)
    var cap = 200
    var n = Math.min(keys.length, cap)
    for (var i = 0; i < n; i++) {
      var child = type === 'array' ? value[i] : value[keys[i]]
      append(kids, jsonNode(child, type === 'array' ? '' : keys[i], depth + 1))
    }
    if (keys.length > cap) append(kids, h('div', 'iris-pv-note', (keys.length - cap) + ' more'))
  }

  function jsonType(value) {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    var t = typeof value
    if (t === 'string') return 'str'
    if (t === 'number') return 'num'
    if (t === 'boolean') return 'bool'
    if (t === 'object') return 'object'
    return 'str'
  }

  function jsonPreview(value, type) {
    if (type === 'str') return JSON.stringify(value)
    if (value === null) return 'null'
    return String(value)
  }

  function paintImage(body, art) {
    var url = safeImageUrl(art.url || '')
    if (!url && art.content && /^data:image\//i.test(art.content)) url = art.content.trim()
    if (!url && art.mime && /^image\//i.test(art.mime) && art.content && !/^data:/i.test(art.content)) {
      url = 'data:' + art.mime + ';base64,' + art.content.replace(/\s+/g, '')
    }
    if (!url) {
      append(body, h('div', 'iris-pv-note', 'No displayable image URL'))
      if (art.content) paintText(body, art.content)
      return
    }
    var img = h('img', 'iris-pv-img')
    img.alt = art.name || 'image'
    img.src = url
    append(body, img)
  }

  function paintHtml(body, art) {
    var html = art.content || ''
    if (!html && art.url) html = htmlFromDataUrl(art.url)
    if (!html && art.url) html = blockedHtml(art.url)
    var frame = h('iframe', 'iris-pv-frame')
    frame.setAttribute('sandbox', '')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.title = art.name || 'HTML preview'
    frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'">' + (html || '')
    append(body, frame)
  }

  function blockedHtml(url) {
    return '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#0b0d12;color:#c5c8d0;font:13px/1.45 ui-sans-serif,system-ui"><p style="padding:16px">This frame only inlines HTML. The URL was not loaded.</p><p style="padding:0 16px;word-break:break-all">' + escapeHtml(url) + '</p></body></html>'
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function htmlFromDataUrl(url) {
    var match = String(url).match(/^data:text\/html(?:;charset=[^,;]*)?(;base64)?,(.*)$/i)
    if (!match) return ''
    try {
      if (match[1]) return decodeBase64(match[2])
      return decodeURIComponent(match[2])
    } catch (err) {
      return ''
    }
  }

  function decodeBase64(value) {
    if (typeof atob === 'function') return atob(value.replace(/\s+/g, ''))
    return ''
  }

  function paintLog(body, text) {
    if (cmApi()) {
      if (!String(text).length) {
        append(body, h('div', 'iris-pv-empty', 'Empty log'))
        return
      }
      var clippedCm = clipLines(stripAnsi(text))
      if (mountCm(body, {
        view: { doc: clippedCm.text, lang: 'text', readOnly: true, wrap: true },
        note: clippedCm.clipped ? 'Showing the first ' + MAX_LINES + ' lines' : ''
      })) return
    }
    var lines = String(text).split(/\r\n|\n|\r/)
    var clipped = lines.length > MAX_LINES
    if (clipped) lines = lines.slice(0, MAX_LINES)
    var wrap = h('div', 'iris-pv-log')
    for (var i = 0; i < lines.length; i++) {
      var level = logLevel(lines[i])
      var row = h('div', 'iris-pv-log-line' + (level ? ' iris-pv-lvl-' + level : ''))
      paintAnsi(row, lines[i])
      append(wrap, row)
    }
    if (!String(text).length) append(wrap, h('div', 'iris-pv-empty', 'Empty log'))
    append(body, wrap)
    if (clipped) append(body, h('div', 'iris-pv-note', 'Showing the first ' + MAX_LINES + ' lines'))
  }

  function logLevel(line) {
    var plain = String(line).replace(/\u001b\[[0-9;]*m/g, '')
    var match = plain.match(/(^|\s)(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)(\s|:|$)/)
    if (!match) return ''
    var word = match[2]
    if (word === 'TRACE' || word === 'DEBUG') return 'debug'
    if (word === 'INFO') return 'info'
    if (word === 'WARN' || word === 'WARNING') return 'warn'
    return 'error'
  }

  function paintAnsi(row, line) {
    var parts = parseAnsi(line)
    if (!parts.length) {
      row.textContent = ' '
      return
    }
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i]
      var cls = 'iris-pv-ansi'
      if (part.bold) cls += ' iris-pv-ansi-bold'
      if (part.dim) cls += ' iris-pv-ansi-dim'
      if (part.italic) cls += ' iris-pv-ansi-italic'
      if (part.underline) cls += ' iris-pv-ansi-ul'
      if (part.fg) cls += ' iris-pv-fg-' + part.fg
      if (part.bg) cls += ' iris-pv-bg-' + part.bg
      var span = h('span', cls, part.text)
      if (part.rgb) span.style.color = part.rgb
      append(row, span)
    }
  }

  function parseAnsi(input) {
    var style = { fg: '', bg: '', bold: false, dim: false, italic: false, underline: false, rgb: '' }
    var parts = []
    var buf = ''
    function push() {
      if (!buf) return
      parts.push({
        text: buf,
        fg: style.fg,
        bg: style.bg,
        bold: style.bold,
        dim: style.dim,
        italic: style.italic,
        underline: style.underline,
        rgb: style.rgb
      })
      buf = ''
    }
    for (var i = 0; i < input.length; i++) {
      if (input.charAt(i) === '\u001b' && input.charAt(i + 1) === '[') {
        push()
        var sgr = input.slice(i).match(/^\u001b\[([0-9;]*)m/)
        if (sgr) {
          applySgr(style, sgr[1])
          i += sgr[0].length - 1
          continue
        }
        var csi = input.slice(i).match(/^\u001b\[[0-9;?]*[ -/]*[@-~]/)
        if (csi) {
          i += csi[0].length - 1
          continue
        }
        continue
      }
      if (input.charAt(i) === '\u001b' && input.charAt(i + 1) === ']') {
        push()
        var osc = input.slice(i).match(/^\u001b\][\s\S]*?(?:\u0007|\u001b\\)/)
        if (osc) {
          i += osc[0].length - 1
          continue
        }
        break
      }
      buf += input.charAt(i)
    }
    push()
    return parts
  }

  function applySgr(style, spec) {
    var nums = spec === '' ? [0] : spec.split(';').map(function (n) { return parseInt(n, 10) || 0 })
    var fgNames = { 30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white', 90: 'bblack', 91: 'bred', 92: 'bgreen', 93: 'byellow', 94: 'bblue', 95: 'bmagenta', 96: 'bcyan', 97: 'bwhite' }
    for (var i = 0; i < nums.length; i++) {
      var n = nums[i]
      if (n === 0) {
        style.fg = ''
        style.bg = ''
        style.bold = false
        style.dim = false
        style.italic = false
        style.underline = false
        style.rgb = ''
      } else if (n === 1) style.bold = true
      else if (n === 2) style.dim = true
      else if (n === 3) style.italic = true
      else if (n === 4) style.underline = true
      else if (n === 22) { style.bold = false; style.dim = false }
      else if (n === 23) style.italic = false
      else if (n === 24) style.underline = false
      else if (n === 39) { style.fg = ''; style.rgb = '' }
      else if (n === 49) style.bg = ''
      else if (fgNames[n]) { style.fg = fgNames[n]; style.rgb = '' }
      else if (n >= 40 && n <= 47) style.bg = fgNames[n - 10]
      else if (n >= 100 && n <= 107) style.bg = fgNames[n - 10]
      else if ((n === 38 || n === 48) && nums[i + 1] === 5) {
        var color = ansi256(nums[i + 2] || 0)
        if (n === 38) { style.fg = color.name; style.rgb = color.rgb }
        else style.bg = color.name
        i += 2
      } else if ((n === 38 || n === 48) && nums[i + 1] === 2) {
        var r = clampByte(nums[i + 2] || 0)
        var g = clampByte(nums[i + 3] || 0)
        var b = clampByte(nums[i + 4] || 0)
        if (n === 38) style.rgb = 'rgb(' + r + ',' + g + ',' + b + ')'
        i += 4
      }
    }
  }

  function clampByte(n) {
    if (n < 0) return 0
    if (n > 255) return 255
    return n
  }

  function ansi256(n) {
    var basic = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'bblack', 'bred', 'bgreen', 'byellow', 'bblue', 'bmagenta', 'bcyan', 'bwhite']
    if (n >= 0 && n < 16) return { name: basic[n], rgb: '' }
    return { name: '', rgb: '' }
  }

  function paintMarkdown(body, src) {
    if (cmApi()) {
      var clippedCm = clipLines(src || '')
      if (clippedCm.empty) {
        append(body, h('div', 'iris-pv-empty', 'Empty markdown'))
        return
      }
      if (mountCm(body, {
        view: { doc: clippedCm.text, lang: 'markdown', readOnly: true, wrap: true },
        note: clippedCm.clipped ? 'Showing the first ' + MAX_LINES + ' lines' : ''
      })) return
    }
    var blocks = markdownBlocks(src)
    var wrap = h('div', 'iris-pv-md')
    for (var i = 0; i < blocks.length; i++) append(wrap, markdownBlock(blocks[i]))
    if (!blocks.length) append(wrap, h('div', 'iris-pv-empty', 'Empty markdown'))
    append(body, wrap)
  }

  function markdownBlocks(src) {
    var lines = String(src).replace(/\r\n/g, '\n').split('\n')
    var blocks = []
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var fence = line.match(/^[ \t]{0,3}```([^\n`]*)\s*$/) || line.match(/^[ \t]{0,3}~~~([^\n`]*)\s*$/)
      if (fence) {
        var lang = (fence[1] || '').trim().split(/\s+/)[0]
        var code = []
        i++
        while (i < lines.length && !/^[ \t]{0,3}```\s*$/.test(lines[i]) && !/^[ \t]{0,3}~~~\s*$/.test(lines[i])) {
          code.push(lines[i])
          i++
        }
        if (i < lines.length) i++
        blocks.push({ type: 'code', lang: lang, text: code.join('\n') })
        continue
      }
      if (/^[ \t]{0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
        blocks.push({ type: 'hr' })
        i++
        continue
      }
      var heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
        i++
        continue
      }
      if (/^[ \t]{0,3}>\s?/.test(line)) {
        var quote = []
        while (i < lines.length && /^[ \t]{0,3}>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^[ \t]{0,3}>\s?/, ''))
          i++
        }
        blocks.push({ type: 'quote', text: quote.join('\n') })
        continue
      }
      if (/^[ \t]{0,3}([-*+]|\d+\.)\s+/.test(line)) {
        var ordered = /^\s*\d+\.\s+/.test(line)
        var items = []
        while (i < lines.length && /^[ \t]{0,3}([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[ \t]{0,3}([-*+]|\d+\.)\s+/, ''))
          i++
        }
        blocks.push({ type: 'list', ordered: ordered, items: items })
        continue
      }
      if (!line.trim()) { i++; continue }
      var para = []
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[ \t]{0,3}(```|~~~)|>\s|([-*+]|\d+\.)\s)/.test(lines[i])) {
        para.push(lines[i])
        i++
      }
      blocks.push({ type: 'p', text: para.join('\n') })
    }
    return blocks
  }

  function markdownBlock(block) {
    if (block.type === 'hr') return h('hr', 'iris-pv-hr')
    if (block.type === 'heading') return h('div', 'iris-pv-h iris-pv-h' + block.level, block.text)
    if (block.type === 'code') {
      var box = h('div', 'iris-pv-md-code')
      paintCode(box, { content: block.text, language: normalizeLang(block.lang) || 'text' })
      return box
    }
    if (block.type === 'quote') {
      var quote = h('blockquote', 'iris-pv-quote')
      paintInlines(quote, block.text)
      return quote
    }
    if (block.type === 'list') {
      var list = h(block.ordered ? 'ol' : 'ul', 'iris-pv-list')
      for (var i = 0; i < block.items.length; i++) {
        var item = h('li', 'iris-pv-li')
        paintInlines(item, block.items[i])
        append(list, item)
      }
      return list
    }
    var p = h('p', 'iris-pv-p')
    paintInlines(p, block.text)
    return p
  }

  function paintInlines(parent, text) {
    var parts = inlineParts(text, 0)
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i]
      if (part.kind === 'text') append(parent, doc().createTextNode(part.text))
      else if (part.kind === 'code') append(parent, h('code', 'iris-pv-icode', part.text))
      else if (part.kind === 'strong') {
        var strong = h('strong', 'iris-pv-strong')
        paintInlines(strong, part.text)
        append(parent, strong)
      } else if (part.kind === 'em') {
        var em = h('em', 'iris-pv-em')
        paintInlines(em, part.text)
        append(parent, em)
      } else if (part.kind === 'link') {
        var a = h('a', 'iris-pv-a', part.text)
        a.href = part.href
        a.rel = 'noopener noreferrer'
        a.target = '_blank'
        append(parent, a)
      } else if (part.kind === 'img') {
        var img = h('img', 'iris-pv-md-img')
        img.alt = part.text || ''
        img.src = part.href
        append(parent, img)
      }
    }
  }

  function inlineParts(text, depth) {
    if (depth > 4) return [{ kind: 'text', text: text }]
    var out = []
    var buf = ''
    function flush() {
      if (buf) out.push({ kind: 'text', text: buf })
      buf = ''
    }
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === '`') {
        var end = text.indexOf('`', i + 1)
        if (end > i) {
          flush()
          out.push({ kind: 'code', text: text.slice(i + 1, end) })
          i = end
          continue
        }
      }
      if (text.charAt(i) === '!' && text.charAt(i + 1) === '[') {
        var img = readLink(text, i + 1)
        if (img && safeImageUrl(img.href)) {
          flush()
          out.push({ kind: 'img', text: img.text, href: safeImageUrl(img.href) })
          i = img.end
          continue
        }
      }
      if (text.charAt(i) === '[') {
        var link = readLink(text, i)
        var href = link && safeLink(link.href)
        if (link && href) {
          flush()
          out.push({ kind: 'link', text: link.text, href: href })
          i = link.end
          continue
        }
      }
      if ((text.substr(i, 2) === '**' || text.substr(i, 2) === '__')) {
        var mark = text.substr(i, 2)
        var close = text.indexOf(mark, i + 2)
        if (close > i + 2) {
          flush()
          out.push({ kind: 'strong', text: text.slice(i + 2, close) })
          i = close + 1
          continue
        }
      }
      if ((text.charAt(i) === '*' || text.charAt(i) === '_') && text.charAt(i + 1) !== text.charAt(i)) {
        var closer = text.indexOf(text.charAt(i), i + 1)
        if (closer > i + 1) {
          flush()
          out.push({ kind: 'em', text: text.slice(i + 1, closer) })
          i = closer
          continue
        }
      }
      buf += text.charAt(i)
    }
    flush()
    return out
  }

  function readLink(text, start) {
    if (text.charAt(start) !== '[') return null
    var labelEnd = text.indexOf(']', start + 1)
    if (labelEnd < 0 || text.charAt(labelEnd + 1) !== '(') return null
    var hrefEnd = text.indexOf(')', labelEnd + 2)
    if (hrefEnd < 0) return null
    return {
      text: text.slice(start + 1, labelEnd),
      href: text.slice(labelEnd + 2, hrefEnd).trim(),
      end: hrefEnd
    }
  }

  function safeLink(href) {
    var value = String(href || '').trim()
    if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value
    return ''
  }

  function safeImageUrl(url) {
    var value = String(url || '').trim()
    if (/^blob:/i.test(value) || /^data:image\/[a-z0-9.+-]+/i.test(value)) return value
    return ''
  }

  function copyText(text) {
    return loadDesktopSdk().then(function (sdk) {
      if (sdk && typeof sdk.writeClipboardText === 'function') {
        return Promise.resolve(sdk.writeClipboardText(text)).then(function () { return true })
      }
      return false
    }).catch(function () { return false }).then(function (done) {
      if (done) return true
      var nav = typeof navigator !== 'undefined' ? navigator : null
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        return nav.clipboard.writeText(text).then(function () { return true }).catch(function () {
          return copyViaSelection(text)
        })
      }
      return copyViaSelection(text)
    })
  }

  function copyViaSelection(text) {
    var d = doc()
    if (!d || typeof d.execCommand !== 'function') return false
    var area = d.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    d.body.appendChild(area)
    area.select()
    var ok = false
    try { ok = d.execCommand('copy') } catch (err) { ok = false }
    area.parentNode.removeChild(area)
    return ok
  }

  function clipText(text) {
    var lines = String(text).split(/\r\n|\n|\r/)
    if (lines.length <= MAX_LINES) return String(text)
    return lines.slice(0, MAX_LINES).join('\n')
  }

  function tokenize(line, lang) {
    var language = normalizeLang(lang) || 'text'
    var keys = KEYWORDS[language] || null
    var tokens = []
    var i = 0
    while (i < line.length) {
      var rest = line.slice(i)
      if (language !== 'json' && (language === 'javascript' || language === 'typescript' || language === 'go' || language === 'rust' || language === 'css' || language === 'sql') && rest.indexOf('//') === 0) {
        tokens.push(['cmt', rest])
        break
      }
      if ((language === 'python' || language === 'shell' || language === 'yaml' || language === 'ruby') && rest.charAt(0) === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
        tokens.push(['cmt', rest])
        break
      }
      if (rest.indexOf('/*') === 0) {
        var end = line.indexOf('*/', i + 2)
        if (end < 0) {
          tokens.push(['cmt', rest])
          break
        }
        tokens.push(['cmt', line.slice(i, end + 2)])
        i = end + 2
        continue
      }
      if (language === 'html' && rest.indexOf('<!--') === 0) {
        var hend = line.indexOf('-->', i + 4)
        var stop = hend < 0 ? line.length : hend + 3
        tokens.push(['cmt', line.slice(i, stop)])
        i = stop
        continue
      }
      var str = readString(line, i, language)
      if (str) {
        tokens.push(['str', str.text])
        i = str.end
        continue
      }
      var num = rest.match(/^(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
      if (num && (i === 0 || /[^A-Za-z_$]/.test(line.charAt(i - 1)))) {
        tokens.push(['num', num[0]])
        i += num[0].length
        continue
      }
      var id = rest.match(/^[A-Za-z_][\w$]*/)
      if (id) {
        var word = id[0]
        var kind = keys && keys[word] ? ((word === 'true' || word === 'false' || word === 'null' || word === 'None' || word === 'True' || word === 'False') ? 'bool' : 'kw') : 'id'
        if (kind === 'id' && language === 'html' && /^<\/?[A-Za-z]/.test(rest)) kind = 'tag'
        tokens.push([kind, word])
        i += word.length
        continue
      }
      if (language === 'html' && (rest.charAt(0) === '<' || rest.charAt(0) === '>' || rest.charAt(0) === '/')) {
        tokens.push(['tag', rest.charAt(0)])
        i++
        continue
      }
      tokens.push(['punct', rest.charAt(0)])
      i++
    }
    if (language === 'json') markJsonKeys(tokens)
    return tokens
  }

  function markJsonKeys(tokens) {
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i][0] !== 'str') continue
      var j = i + 1
      while (j < tokens.length && tokens[j][1].trim() === '') j++
      if (j < tokens.length && tokens[j][1] === ':') tokens[i][0] = 'key'
    }
  }

  function readString(line, i, language) {
    var q = line.charAt(i)
    if (q !== '"' && q !== "'" && q !== '`') return null
    if (q === '`' && language !== 'javascript' && language !== 'typescript') return null
    if (q === "'" && (language === 'json' || language === 'yaml')) return null
    var out = q
    for (var k = i + 1; k < line.length; k++) {
      var ch = line.charAt(k)
      out += ch
      if (ch === '\\') {
        if (k + 1 < line.length) { out += line.charAt(k + 1); k++ }
        continue
      }
      if (ch === q) return { text: out, end: k + 1 }
    }
    return { text: out, end: line.length }
  }

  function normalizeArtifact(artifact) {
    var src = artifact || {}
    var name = src.name != null ? String(src.name) : 'artifact'
    var mime = src.mime != null ? String(src.mime) : ''
    var language = normalizeLang(src.language || langFromName(name))
    var content = contentString(src.content)
    var url = src.url != null ? String(src.url) : ''
    var kind = String(src.kind || src.mime || '').toLowerCase()
    if (kind === 'text/log') kind = 'log'
    if (kind === 'md' || kind === 'text/markdown') kind = 'markdown'
    if (kind === 'plaintext' || kind === 'plain' || kind === 'text/plain') kind = 'text'
    if (kind === 'application/json' || kind === 'text/json') kind = 'json'
    if (kind === 'text/html') kind = 'html'
    if (kind === 'text/x-diff' || kind === 'application/diff') kind = 'diff'
    if (kind.indexOf('image/') === 0) kind = 'image'
    if (!KINDS[kind]) {
      var sniffed = sniff(content || url, { name: name, mime: mime, language: language })
      kind = sniffed.kind
      if (!language) language = sniffed.language
    }
    var jsonValue
    if (kind === 'json') {
      if (src.content && typeof src.content === 'object') jsonValue = src.content
      else {
        try { jsonValue = JSON.parse(content) } catch (err) { jsonValue = undefined }
      }
    }
    return {
      name: name,
      mime: mime || mimeFor(kind),
      kind: kind,
      content: content,
      url: url,
      language: language || (kind === 'code' ? 'text' : ''),
      jsonValue: jsonValue
    }
  }

  function contentString(content) {
    if (content == null) return ''
    if (typeof content === 'string') return content
    if (typeof content === 'object') {
      try { return JSON.stringify(content, null, 2) } catch (err) { return '' }
    }
    return String(content)
  }

  function mimeFor(kind) {
    if (kind === 'json') return 'application/json'
    if (kind === 'markdown') return 'text/markdown'
    if (kind === 'html') return 'text/html'
    if (kind === 'diff') return 'text/x-diff'
    if (kind === 'image') return 'image/*'
    return 'text/plain'
  }

  function normalizeLang(lang) {
    if (!lang) return ''
    var key = String(lang).trim().toLowerCase().replace(/^\./, '')
    if (LANG_ALIAS[key]) return LANG_ALIAS[key]
    if (KEYWORDS[key] || key === 'xml' || key === 'toml') return key === 'xml' ? 'html' : key
    return key.replace(/[^a-z0-9.+-]/g, '').slice(0, 24)
  }

  function langFromName(name) {
    var match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
    if (!match) return ''
    return EXT_LANG[match[1]] || ''
  }

  function sniff(text, hint) {
    var name = hint.name || ''
    var mime = (hint.mime || '').toLowerCase()
    var extLang = langFromName(name)
    if (mime.indexOf('image/') === 0 || extLang === 'image' || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name)) {
      return { kind: 'image', language: '' }
    }
    if (mime === 'text/html' || extLang === 'html') return { kind: 'html', language: 'html' }
    if (mime === 'text/markdown' || extLang === 'markdown') return { kind: 'markdown', language: 'markdown' }
    if (mime === 'application/json' || extLang === 'json') return { kind: 'json', language: 'json' }
    if (extLang === 'diff' || isUnifiedDiff(text)) return { kind: 'diff', language: 'diff' }
    var body = stripLineNumbers(text).trim()
    if (isUnifiedDiff(body)) return { kind: 'diff', language: 'diff' }
    if (looksLikeHtml(body)) return { kind: 'html', language: 'html' }
    if (looksLikeSvg(body)) return { kind: 'html', language: 'html' }
    if (looksLikeJson(body)) return { kind: 'json', language: 'json' }
    if (looksLikeMarkdown(body) && !extLang) return { kind: 'markdown', language: 'markdown' }
    if (hint.tool === 'terminal' || hint.force === 'log' || extLang === 'log') return { kind: 'log', language: '' }
    if (extLang && extLang !== 'text') return { kind: 'code', language: extLang }
    if (looksLikeYaml(body)) return { kind: 'code', language: 'yaml' }
    if (hint.tool === 'read_file' && hasCodeSignals(body)) return { kind: 'code', language: hint.language || 'text' }
    return { kind: 'text', language: '' }
  }

  function isUnifiedDiff(text) {
    var t = String(text || '')
    if (/^diff --git /m.test(t)) return true
    if (/^@@ /m.test(t)) return true
    if (/^--- a\//m.test(t) || /^\+\+\+ b\//m.test(t)) return true
    if (/^--- \S[^\n]*\n\+\+\+ \S/m.test(t)) return true
    return false
  }

  function looksLikeHtml(text) {
    var t = String(text || '').trim().slice(0, 240).toLowerCase()
    return t.indexOf('<!doctype html') === 0 || t.indexOf('<html') === 0
  }

  function looksLikeSvg(text) {
    return /^\s*<svg[\s>]/.test(String(text || '').slice(0, 80))
  }

  function looksLikeJson(text) {
    var t = String(text || '').trim()
    if (!t) return false
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return false
    try { JSON.parse(t); return true } catch (err) { return /[{[]/.test(t.charAt(0)) && /"/.test(t) }
  }

  function looksLikeMarkdown(text) {
    return /^(#{1,6}\s|>\s|[-*]\s|\d+\.\s)/m.test(String(text || ''))
  }

  function looksLikeYaml(text) {
    var lines = String(text || '').split('\n').map(function (line) { return line.trim() }).filter(Boolean).slice(0, 8)
    var keys = []
    for (var i = 0; i < lines.length; i++) {
      if (/^[a-z_][\w.-]*:\s+\S/.test(lines[i]) && lines[i].indexOf('://') === -1) keys.push(lines[i])
    }
    if (keys.length >= 2) return true
    return keys.length === 1 && /^(name|version|description|title|api|path|kind|metadata|spec):/.test(keys[0])
  }

  function hasCodeSignals(text) {
    return /[{}[\]();=<>]/.test(text) || looksLikeYaml(text)
  }

  function stripLineNumbers(text) {
    var lines = String(text || '').split(/\r\n|\n|\r/)
    if (!isNumbered(lines)) return String(text || '')
    return lines.map(function (line) {
      var match = line.match(/^\s*\d+\|(.*)$/)
      return match ? match[1] : line
    }).join('\n')
  }

  function isNumbered(lines) {
    var filled = 0
    var hit = 0
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      filled++
      if (/^\s*\d+\|/.test(lines[i])) hit++
    }
    return filled > 0 && hit / filled >= 0.6
  }

  function splitNumbered(text) {
    var lines = String(text || '').split(/\r\n|\n|\r/)
    if (!isNumbered(lines)) return { lines: lines, numbers: null, start: 1 }
    var numbers = []
    var body = []
    for (var i = 0; i < lines.length; i++) {
      var match = lines[i].match(/^\s*(\d+)\|(.*)$/)
      if (match) {
        numbers.push(match[1])
        body.push(match[2])
      } else {
        numbers.push(String(i + 1))
        body.push(lines[i])
      }
    }
    return { lines: body, numbers: numbers, start: 1 }
  }

  function fromEvent(event) {
    if (event == null) return []
    if (typeof event === 'string') {
      try { return fromEvent(JSON.parse(event)) } catch (err) { return [] }
    }
    if (Array.isArray(event)) {
      var list = []
      for (var i = 0; i < event.length; i++) list.push.apply(list, fromEvent(event[i]))
      return list
    }
    if (typeof event !== 'object') return []
    if (event.format === 'hermes-logviz-events' || (Array.isArray(event.events) && (event.version === 1 || event.format))) {
      return fromEvent(event.events)
    }
    if (Array.isArray(event.messages) && !Array.isArray(event.events)) return fromEvent(event.messages)
    return fromSingle(event)
  }

  function fromSingle(event) {
    var out = []
    var tools = toolList(event.tool_name || event.tool || '')
    var role = event.role || ''
    var kind = event.kind || ''
    if (kind === 'assistant' || role === 'assistant') {
      var text = fieldText(event.detail != null ? event.detail : event.content)
      pushFences(out, text, event)
    }
    if (kind === 'tool_call' || (Array.isArray(event.tool_calls) && (role === 'assistant' || !kind))) {
      pushFileWrites(out, event)
    }
    if (kind === 'tool_result' || role === 'tool') {
      var payload = kind === 'tool_result' ? (event.detail != null ? event.detail : event.content) : (event.content != null ? event.content : event.detail)
      pushToolResult(out, event, payload, tools)
    }
    return out
  }

  function toolList(name) {
    return String(name || '').split(',').map(function (part) { return part.trim() }).filter(Boolean)
  }

  function hasTool(tools, name) {
    for (var i = 0; i < tools.length; i++) if (tools[i] === name) return true
    return false
  }

  function fieldText(value) {
    if (value == null) return ''
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) } catch (err) { return '' }
  }

  function pushFences(out, text, event) {
    var re = /(?:^|\n)[ \t]{0,3}(```|~~~)([^\n`]*)[ \t]*\n([\s\S]*?)(?:\n?[ \t]{0,3}\1|$)/g
    var match
    var n = 0
    while ((match = re.exec(text))) {
      var body = match[3].replace(/\s+$/, '')
      if (!body) continue
      n++
      var lang = normalizeLang((match[2] || '').trim().split(/\s+/)[0])
      var sniffed = sniff(body, { language: lang })
      var kind = lang === 'json' || sniffed.kind === 'json' ? (looksLikeJson(body) && jsonParses(body) ? 'json' : 'code') : (lang === 'markdown' ? 'markdown' : (lang === 'html' ? 'html' : (lang === 'diff' ? 'diff' : 'code')))
      if (lang === 'markdown') kind = 'markdown'
      if (!lang && sniffed.kind === 'diff') kind = 'diff'
      out.push(artifact({
        name: (event.id != null ? 'assistant:' + event.id : 'assistant') + '#' + n,
        kind: kind,
        language: lang || sniffed.language || '',
        content: body,
        event: event,
        tool: ''
      }))
      if (match.index === re.lastIndex) re.lastIndex++
    }
  }

  function jsonParses(text) {
    try { JSON.parse(text); return true } catch (err) { return false }
  }

  function pushFileWrites(out, event) {
    var calls = []
    if (Array.isArray(event.tool_calls)) calls.push.apply(calls, event.tool_calls)
    var detail = asData(event.detail)
    if (Array.isArray(detail)) calls.push.apply(calls, detail)
    else if (detail && Array.isArray(detail.tool_calls)) calls.push.apply(calls, detail.tool_calls)
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i] || {}
      var name = call.name || (call.function && call.function.name) || ''
      if (name !== 'write_file' && name !== 'patch') continue
      var args = callArgs(call)
      if (name === 'write_file') {
        var content = firstString(args, ['content', 'contents', 'text'])
        if (content == null) continue
        var path = firstString(args, ['path', 'file_path', 'file', 'filename']) || 'write_file'
        var sniffed = sniff(content, { name: path, tool: 'write_file' })
        out.push(artifact({
          name: path,
          kind: sniffed.kind,
          language: sniffed.language,
          content: content,
          event: event,
          tool: 'write_file'
        }))
      } else {
        var diffText = firstString(args, ['patch', 'diff'])
        var pathName = firstString(args, ['path', 'file_path', 'file']) || ''
        if (diffText) {
          out.push(artifact({
            name: diffPath(diffText) || pathName || 'patch',
            kind: 'diff',
            language: 'diff',
            content: diffText,
            event: event,
            tool: 'patch'
          }))
        } else if (args.old_string != null || args.new_string != null) {
          var oldS = args.old_string != null ? String(args.old_string) : ''
          var newS = args.new_string != null ? String(args.new_string) : ''
          if (!oldS && !newS) continue
          var file = pathName || 'patch'
          out.push(artifact({
            name: file,
            kind: 'diff',
            language: 'diff',
            content: syntheticDiff(file, oldS, newS),
            event: event,
            tool: 'patch'
          }))
        }
      }
    }
  }

  function syntheticDiff(path, oldS, newS) {
    var oldLines = String(oldS).split('\n')
    var newLines = String(newS).split('\n')
    var body = '--- a/' + path + '\n+++ b/' + path + '\n@@\n'
    for (var i = 0; i < oldLines.length; i++) body += '-' + oldLines[i] + '\n'
    for (var j = 0; j < newLines.length; j++) body += '+' + newLines[j] + '\n'
    return body
  }

  function callArgs(call) {
    var src = call.function && call.function.arguments != null ? call.function.arguments : (call.arguments != null ? call.arguments : call.args)
    if (typeof src === 'string') {
      try { return JSON.parse(src) } catch (err) { return looseFields(src) }
    }
    if (src && typeof src === 'object') return src
    return {}
  }

  function pushToolResult(out, event, payload, tools) {
    if (typeof payload === 'string' && payload.trim() && payload.trim() === (tools[0] || '')) return
    var data = asData(payload)
    var loose = null
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      emitResultObject(out, event, data, tools)
      return
    }
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        if (data[i] && typeof data[i] === 'object') emitResultObject(out, event, data[i], tools)
      }
      return
    }
    if (typeof payload === 'string') {
      loose = looseFields(payload)
      if (hasBodyField(loose)) {
        emitResultObject(out, event, loose, tools)
        return
      }
      if (payload.trim() && payload.trim().charAt(0) !== '{' && payload.trim().charAt(0) !== '[') {
        var rawKind = sniff(payload, { tool: tools[0] || '', name: '' })
        if (hasTool(tools, 'terminal')) rawKind = { kind: 'log', language: '' }
        out.push(artifact({
          name: artifactName(event, tools[0] || 'tool', ''),
          kind: rawKind.kind === 'code' ? 'text' : rawKind.kind,
          language: rawKind.language,
          content: payload,
          event: event,
          tool: tools[0] || ''
        }))
      }
    }
  }

  function hasBodyField(obj) {
    var keys = ['content', 'output', 'stdout', 'stderr', 'diff', 'patch', 'text', 'html', 'markdown', 'code', 'error', 'old_string', 'new_string']
    for (var i = 0; i < keys.length; i++) if (typeof obj[keys[i]] === 'string' && obj[keys[i]]) return true
    return false
  }

  function emitResultObject(out, event, data, tools) {
    var path = firstString(data, ['path', 'file_path', 'file', 'filename']) || diffPath(firstString(data, ['diff', 'patch']) || '')
    var seen = Object.create(null)
    function emit(field, value) {
      if (typeof value !== 'string' || !value || seen[field + value.slice(0, 40)]) return
      seen[field + value.slice(0, 40)] = 1
      var kindHint = 'text'
      var language = ''
      if (field === 'diff' || field === 'patch' || isUnifiedDiff(value)) kindHint = 'diff'
      else if (field === 'html') kindHint = 'html'
      else if (field === 'markdown') kindHint = 'markdown'
      else if (hasTool(tools, 'terminal') && (field === 'output' || field === 'stdout' || field === 'stderr')) kindHint = 'log'
      else if (field === 'error') kindHint = 'text'
      else {
        var sniffed = sniff(value, { name: path, tool: hasTool(tools, 'read_file') ? 'read_file' : (tools[0] || ''), mime: '' })
        kindHint = sniffed.kind
        language = sniffed.language
      }
      if (hasTool(tools, 'patch') && (field === 'diff' || field === 'patch')) kindHint = 'diff'
      out.push(artifact({
        name: path || artifactName(event, tools[0] || field, ''),
        kind: kindHint,
        language: language,
        content: value,
        event: event,
        tool: tools[0] || ''
      }))
    }
    emit('diff', data.diff)
    emit('patch', data.patch)
    emit('content', data.content)
    emit('output', data.output)
    emit('stdout', data.stdout)
    emit('stderr', data.stderr)
    emit('html', data.html)
    emit('markdown', data.markdown)
    emit('text', data.text)
    emit('code', data.code)
    if (!data.output && !data.stdout) emit('error', data.error)
    if (hasTool(tools, 'patch') && data.old_string != null && data.diff == null && data.patch == null) {
      emit('diff', syntheticDiff(path || 'patch', data.old_string, data.new_string || ''))
    }
  }

  function artifact(spec) {
    var item = {
      name: spec.name || 'artifact',
      kind: spec.kind || 'text',
      content: spec.content
    }
    if (spec.language) item.language = spec.language
    if (spec.kind === 'image' && typeof spec.content === 'string' && /^data:image\//i.test(spec.content)) {
      item.url = spec.content
    }
    if (spec.kind === 'html') item.mime = 'text/html'
    if (spec.kind === 'json') item.mime = 'application/json'
    if (spec.kind === 'markdown') item.mime = 'text/markdown'
    if (spec.kind === 'diff') item.mime = 'text/x-diff'
    return item
  }

  function artifactName(event, tool, path) {
    if (path) return path
    var id = event && event.id != null ? String(event.id) : ''
    return [tool || 'artifact', id].filter(Boolean).join(':')
  }

  function firstString(obj, keys) {
    if (!obj) return null
    for (var i = 0; i < keys.length; i++) {
      if (typeof obj[keys[i]] === 'string') return obj[keys[i]]
    }
    return null
  }

  function diffPath(text) {
    var match = String(text || '').match(/^---\s+(?:a\/)?(.+)$/m) || String(text || '').match(/^\+\+\+\s+(?:b\/)?(.+)$/m)
    if (!match) return ''
    var path = match[1].trim()
    if (path === '/dev/null') return ''
    return path
  }

  function asData(detail) {
    if (detail == null) return null
    if (typeof detail === 'object') return detail
    if (typeof detail !== 'string') return null
    var text = detail.trim()
    if (!text) return ''
    try { return JSON.parse(text) } catch (err) { return null }
  }

  function looseFields(raw) {
    var fields = {}
    if (typeof raw !== 'string' || !raw) return fields
    var re = /"([A-Za-z_][\w-]*)"\s*:\s*/g
    var match
    while ((match = re.exec(raw))) {
      var key = match[1]
      var i = match.index + match[0].length
      if (raw.charAt(i) !== '"') continue
      var read = readJsonString(raw, i + 1)
      if (fields[key] == null) fields[key] = read.value
      re.lastIndex = read.index + (read.closed ? 1 : 0)
      if (re.lastIndex <= match.index) re.lastIndex = match.index + match[0].length
    }
    return fields
  }

  function readJsonString(raw, start) {
    var out = ''
    var closed = false
    var i = start
    for (; i < raw.length; i++) {
      var ch = raw.charAt(i)
      if (ch === '\\') {
        if (i + 1 >= raw.length) { out += ch; break }
        var next = raw.charAt(++i)
        if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else if (next === 'r') out += '\r'
        else if (next === 'b') out += '\b'
        else if (next === 'f') out += '\f'
        else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.substr(i + 1, 4))) {
          out += String.fromCharCode(parseInt(raw.substr(i + 1, 4), 16))
          i += 4
        } else out += next
        continue
      }
      if (ch === '"') { closed = true; break }
      out += ch
    }
    return { value: out, closed: closed, index: i }
  }

  var CSS = [
    '.iris-pv{--iris-pv-bg:#0b0d12;--iris-pv-bg-2:#12151c;--iris-pv-line:rgba(255,255,255,.08);--iris-pv-text:#e7e9ee;--iris-pv-muted:#9aa3b2;--iris-pv-dim:#6c7584;--iris-pv-iris:#c084fc;--iris-pv-teal:#7ddea5;--iris-pv-gold:#e6b15a;--iris-pv-red:#ff8b96;--iris-pv-blue:#8ec8ff;color:var(--iris-pv-text);background:linear-gradient(180deg,#12151c 0%,#0b0d12 72px);border:1px solid var(--iris-pv-line);border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.35);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden;min-width:0}',
    '.iris-pv-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--iris-pv-line);background:rgba(255,255,255,.02)}',
    '.iris-pv-kind{font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:#160b22;background:var(--iris-pv-iris);border-radius:999px;padding:3px 7px}',
    '.iris-pv-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--iris-pv-text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
    '.iris-pv-lang,.iris-pv-host{color:var(--iris-pv-muted);font:11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--iris-pv-line);border-radius:999px;padding:3px 6px}',
    '.iris-pv-host{color:var(--iris-pv-teal)}',
    '.iris-pv-copy{appearance:none;border:1px solid var(--iris-pv-line);background:#1a1e28;color:var(--iris-pv-text);border-radius:8px;padding:4px 9px;font:12px/1 inherit;cursor:pointer}',
    '.iris-pv-copy:hover{border-color:rgba(192,132,252,.6)}',
    '.iris-pv-copy:focus-visible{outline:2px solid var(--iris-pv-iris);outline-offset:2px}',
    '.iris-pv-body{overflow:auto;max-height:min(70vh,640px);background:var(--iris-pv-bg)}',
    '.iris-pv-cm-wrap{display:flex;flex-direction:column;min-height:0}',
    '.iris-pv-cm{height:min(58vh,560px);min-height:160px;background:#0b0d12}',
    '.iris-pv-cm .cm-editor{height:100%}',
    '.iris-pv-cm .cm-scroller{overflow:auto}',
    '.iris-pv-code,.iris-pv-diff,.iris-pv-log,.iris-pv-text{margin:0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '.iris-pv-row,.iris-pv-diff-line,.iris-pv-log-line{display:flex;gap:0;min-width:max-content;padding-right:12px}',
    '.iris-pv-row:hover,.iris-pv-diff-line:hover,.iris-pv-log-line:hover{background:rgba(255,255,255,.03)}',
    '.iris-pv-gutter{flex:none;text-align:right;color:var(--iris-pv-dim);padding:0 10px 0 12px;user-select:none}',
    '.iris-pv-line{white-space:pre;padding-right:12px}',
    '.iris-pv-text{white-space:pre-wrap;word-break:break-word;padding:12px 14px;color:var(--iris-pv-text)}',
    '.iris-pv-empty,.iris-pv-note{color:var(--iris-pv-muted);padding:8px 12px;font-size:12px}',
    '.iris-pv-diff-line{white-space:pre;padding:0 12px}',
    '.iris-pv-diff-add{background:rgba(125,222,165,.12);color:#d7ffe9}',
    '.iris-pv-diff-del{background:rgba(255,93,108,.14);color:#ffd5d9}',
    '.iris-pv-diff-meta{color:var(--iris-pv-muted)}',
    '.iris-pv-diff-hunk{color:var(--iris-pv-iris);background:rgba(192,132,252,.08)}',
    '.iris-pv-diff-note{color:var(--iris-pv-dim);font-style:italic}',
    '.iris-pv-diff-ctx{color:var(--iris-pv-text)}',
    '.iris-pv-log{padding:6px 0}',
    '.iris-pv-log-line{white-space:pre-wrap;word-break:break-word;padding:0 12px;min-width:0}',
    '.iris-pv-lvl-debug{color:#8b93a7}',
    '.iris-pv-lvl-info{box-shadow:inset 2px 0 0 #8ec8ff}',
    '.iris-pv-lvl-warn{box-shadow:inset 2px 0 0 var(--iris-pv-gold);color:#f3d7a4}',
    '.iris-pv-lvl-error{box-shadow:inset 2px 0 0 var(--iris-pv-red);color:#ffd0d4}',
    '.iris-pv-ansi-bold{font-weight:700}',
    '.iris-pv-ansi-dim{opacity:.72}',
    '.iris-pv-ansi-italic{font-style:italic}',
    '.iris-pv-ansi-ul{text-decoration:underline}',
    '.iris-pv-fg-black{color:#3a4150}.iris-pv-fg-red{color:#ff8b96}.iris-pv-fg-green{color:#7ddea5}.iris-pv-fg-yellow{color:#e6b15a}.iris-pv-fg-blue{color:#8ec8ff}.iris-pv-fg-magenta{color:#c084fc}.iris-pv-fg-cyan{color:#7ee0e0}.iris-pv-fg-white{color:#f4f6fb}',
    '.iris-pv-fg-bblack{color:#6c7584}.iris-pv-fg-bred{color:#ffb3ba}.iris-pv-fg-bgreen{color:#c8ffdf}.iris-pv-fg-byellow{color:#ffe1a8}.iris-pv-fg-bblue{color:#c5e2ff}.iris-pv-fg-bmagenta{color:#e4c6ff}.iris-pv-fg-bcyan{color:#c9ffff}.iris-pv-fg-bwhite{color:#ffffff}',
    '.iris-pv-bg-red{background:rgba(255,93,108,.25)}.iris-pv-bg-green{background:rgba(125,222,165,.2)}.iris-pv-bg-yellow{background:rgba(230,177,90,.2)}.iris-pv-bg-blue{background:rgba(142,200,255,.18)}',
    '.iris-pv-tok-kw{color:var(--iris-pv-iris)}.iris-pv-tok-str{color:var(--iris-pv-teal)}.iris-pv-tok-num{color:var(--iris-pv-gold)}.iris-pv-tok-cmt{color:var(--iris-pv-dim);font-style:italic}.iris-pv-tok-bool{color:#e4c6ff}.iris-pv-tok-key{color:var(--iris-pv-blue)}.iris-pv-tok-tag{color:#ff9ec4}.iris-pv-tok-punct{color:#b7c0d0}.iris-pv-tok-id{color:var(--iris-pv-text)}',
    '.iris-pv-md{padding:12px 14px}.iris-pv-h{font-weight:650;letter-spacing:-.02em;margin:10px 0 6px}.iris-pv-h1{font-size:22px}.iris-pv-h2{font-size:18px}.iris-pv-h3{font-size:15px}.iris-pv-p{margin:0 0 8px}.iris-pv-list{margin:0 0 8px;padding-left:18px}.iris-pv-icode{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#1a1e28;border-radius:4px;padding:0 4px}.iris-pv-a{color:var(--iris-pv-blue)}.iris-pv-quote{margin:0 0 8px;padding-left:10px;border-left:2px solid var(--iris-pv-iris);color:var(--iris-pv-muted)}.iris-pv-hr{border:0;border-top:1px solid var(--iris-pv-line);margin:10px 0}',
    '.iris-pv-json{padding:8px 10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.iris-pv-json-kids{margin-left:14px}.iris-pv-json-leaf{padding:1px 0}.iris-pv-twist{appearance:none;border:0;background:transparent;color:var(--iris-pv-muted);width:16px;cursor:pointer;font:12px/1 inherit}.iris-pv-twist.iris-pv-open{transform:rotate(90deg)}.iris-pv-json-meta{color:var(--iris-pv-dim)}',
    '.iris-pv-img{display:block;max-width:100%;height:auto;background:repeating-conic-gradient(#161922 0% 25%,#0e1016 0% 50%) 50%/20px 20px}',
    '.iris-pv-frame{display:block;width:100%;min-height:280px;border:0;background:#0b0d12}',
    '.iris-pv-md-img{max-width:100%;height:auto}',
    '.iris-pv-error{padding:12px}',
    '.iris-pv [hidden]{display:none !important}'
  ].join('\n')

  return { render: render, fromEvent: fromEvent }
})
