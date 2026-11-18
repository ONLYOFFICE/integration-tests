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
 * page is given, in window.__oitEditorConfig. Docs' api.js creates DocsAPI with
 * `window.DocsAPI = window.DocsAPI || {}` and assigns DocEditor to it afterwards, so both are
 * trapped with setters; DocEditor itself is wrapped in a Proxy, which leaves its static members
 * (DocEditor.version() and the like) and its behaviour untouched.
 */
export const CAPTURE_EDITOR_CONFIG = `(() => {
  if (window.__oitCaptureInstalled) return;
  window.__oitCaptureInstalled = true;

  const record = (config) => {
    try {
      window.__oitEditorConfig = JSON.parse(JSON.stringify(config));
    } catch (e) {}
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
