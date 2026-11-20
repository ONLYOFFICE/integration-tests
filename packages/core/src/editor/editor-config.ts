/** The parts of the Docs API editor config the scenarios read */
export interface EditorConfig {
  document: {
    fileType: string;
    key: string;
    title: string;
    url: string;
    permissions?: { edit?: boolean; [key: string]: unknown };
  };
  documentType: string;
  editorConfig: {
    mode?: 'edit' | 'view';
    callbackUrl?: string | null;
    lang?: string;
    user?: { id?: string; name?: string };
    [key: string]: unknown;
  };
  token?: string;
  [key: string]: unknown;
}

/**
 * Init script that records the config every `new DocsAPI.DocEditor(placeholder, config)` on the
 * page is given, in window.__oitEditorConfig, and keeps the editor's onDocumentStateChange in
 * window.__oitDocumentModified: true while the editor holds changes Document Server hasn't got
 * yet (see EditorPage.save()), and in window.__oitDocumentModifiedCount how many times it turned
 * true, so a brief true → false that a poll would miss still shows. Docs' api.js creates DocsAPI with
 * `window.DocsAPI = window.DocsAPI || {}` and assigns DocEditor to it afterwards, so both are
 * trapped with setters; DocEditor itself is wrapped in a Proxy, which leaves its static members
 * (DocEditor.version() and the like) and its behaviour untouched.
 */
export const CAPTURE_EDITOR_CONFIG = `(() => {
  if (window.__oitCaptureInstalled) return;
  window.__oitCaptureInstalled = true;

  // The known module race of Docs (see EditorPage.waitUntilLoaded) breaks the editor's frame; it
  // is told to the host page as a string, which Docs' own message handler drops as not its JSON
  window.addEventListener('error', (event) => {
    const where = String(event.filename || '') + ' ' + String((event.error && event.error.stack) || '');
    if (where.indexOf('ColorPaletteExt.js') !== -1) {
      try {
        window.top.postMessage('oit-editor-broken:' + event.message, '*');
      } catch (e) {}
    }
  });
  window.addEventListener('message', (event) => {
    if (typeof event.data === 'string' && event.data.indexOf('oit-editor-broken:') === 0) {
      window.__oitEditorBroken = event.data.slice('oit-editor-broken:'.length);
    }
  });

  const record = (config) => {
    try {
      window.__oitEditorConfig = JSON.parse(JSON.stringify(config));
    } catch (e) {}
    if (!config || typeof config !== 'object') return;
    config.events = config.events || {};
    const onDocumentStateChange = config.events.onDocumentStateChange;
    config.events.onDocumentStateChange = function (event) {
      window.__oitDocumentModified = !!(event && event.data);
      if (window.__oitDocumentModified) window.__oitDocumentModifiedCount = (window.__oitDocumentModifiedCount || 0) + 1;
      if (typeof onDocumentStateChange === 'function') return onDocumentStateChange.apply(this, arguments);
    };
  };
  const wrap = (DocEditor) =>
    typeof DocEditor === 'function'
      ? new Proxy(DocEditor, {
          construct(target, args, newTarget) {
            record(args[1]);
            return Reflect.construct(target, args, newTarget);
          },
          apply(target, thisArg, args) {
            record(args[1]);
            return Reflect.apply(target, thisArg, args);
          },
        })
      : DocEditor;
  const hook = (api) => {
    if (!api || typeof api !== 'object') return api;
    let editor = wrap(api.DocEditor);
    try {
      Object.defineProperty(api, 'DocEditor', {
        configurable: true,
        enumerable: true,
        get: () => editor,
        set: (value) => { editor = wrap(value); },
      });
    } catch (e) {}
    return api;
  };

  if (window.DocsAPI) {
    hook(window.DocsAPI);
    return;
  }
  let docsApi;
  Object.defineProperty(window, 'DocsAPI', {
    configurable: true,
    get: () => docsApi,
    set: (value) => { docsApi = hook(value); },
  });
})();`;
