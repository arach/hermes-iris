(function () {
  'use strict';
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;
  var React = SDK.React;
  function IrisPage() {
    return React.createElement('iframe', {
      title: 'Iris — Hermes sessions in 3D',
      src: '/dashboard-plugins/iris/iris.html?v=0.1.0-' + Date.now(),
      style: { width: '100%', height: 'calc(100vh - 100px)', minHeight: '560px', border: 0, background: '#080b12' }
    });
  }
  window.__HERMES_PLUGINS__.register('iris', IrisPage);
})();
