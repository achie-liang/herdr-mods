// A page script outlives the extension that injected it: after a reload or update,
// `chrome.runtime` throws "Extension context invalidated" on every call. This wraps
// that boundary so stale copies stop touching their UI and remove themselves once.
(function () {
  const INVALIDATED = /Extension context invalidated|message port closed|Receiving end does not exist/i;
  const isInvalidated = error => INVALIDATED.test(String(error?.message || error || ''));

  function create(runtime, onDispose = () => {}) {
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      onDispose();
    };
    /**
     * Resolves the reply through `reply(response)`; an ordinary worker error arrives as
     * `{ok: false, error}`. Returns false when nothing was sent: the caller's copy of the
     * extension is gone, so it must not retry or update its UI.
     */
    function send(message, reply) {
      if (disposed) return false;
      let connection;
      try {
        connection = runtime();
        if (!connection?.id) { dispose(); return false; }
        connection.sendMessage(message, response => {
          // Read first: an unread lastError is also logged by Chrome itself.
          let error;
          try { error = connection.lastError; } catch (e) { if (isInvalidated(e)) dispose(); return; }
          // A stale copy must not touch the UI that belonged to the replaced extension.
          if (disposed) return;
          try {
            if (error) {
              if (isInvalidated(error)) dispose();
              else if (reply) reply({ ok: false, error: String(error.message || error) });
              return;
            }
            if (reply) reply(response);
          } catch (e) {
            if (isInvalidated(e)) dispose();
          }
        });
        return true;
      } catch (error) {
        if (isInvalidated(error)) dispose();
        return false;
      }
    }
    return { send, dispose, get disposed() { return disposed; } };
  }

  globalThis.__herdrRuntimeConnection = { create, isInvalidated };
})();
