// Runs in MAIN world to inspect framework instances (React Fiber, Vue, Svelte, Vite Inspector)
// and reply to ISOLATED world content.js via custom DOM events / dataset attributes.
(function () {
  if (window.__herdrPageHookInstalled) return;
  window.__herdrPageHookInstalled = true;

  function cleanFilePath(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim();
    // Strip URL origin if it's http://localhost:xxxx/src/...
    try {
      if (/^https?:\/\//i.test(s)) {
        const u = new URL(s);
        s = decodeURIComponent(u.pathname);
      }
    } catch {}
    s = s
      .replace(/^webpack-internal:\/\/\/(\.\/)?/, "")
      .replace(/^vite:\/\/\/?/, "")
      .replace(/^\/@fs\//, "/")
      .replace(/^file:\/\//, "")
      .replace(/\?.*$/, "");
    return s || null;
  }

  function parseReact19DebugStack(stackStr) {
    if (!stackStr || typeof stackStr !== "string") return null;
    const lines = stackStr.split("\n");
    for (const line of lines) {
      if (
        line.includes("node_modules") ||
        line.includes("react-dom") ||
        line.includes("react/jsx")
      ) {
        continue;
      }
      // Match (http://localhost:5173/src/App.tsx:42:13) or at http://.../src/App.tsx:42:13
      const m =
        line.match(/\(([^()]+?):(\d+):(\d+)\)\s*$/) ||
        line.match(/at\s+([^\s()]+?):(\d+):(\d+)\s*$/);
      if (m) {
        const fileName = cleanFilePath(m[1]);
        if (fileName && !fileName.includes("node_modules")) {
          return {
            fileName,
            lineNumber: Number(m[2]),
            columnNumber: Number(m[3]),
          };
        }
      }
    }
    return null;
  }

  function getReactFiber(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const keys = Object.keys(cur);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (
          k.startsWith("__reactFiber$") ||
          k.startsWith("__reactInternalInstance$")
        ) {
          return cur[k];
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function getComponentName(type) {
    if (!type) return null;
    if (typeof type === "string") return null;
    if (typeof type === "function") {
      return type.displayName || type.name || null;
    }
    if (typeof type === "object") {
      return (
        type.displayName ||
        type.render?.displayName ||
        type.render?.name ||
        type.type?.displayName ||
        type.type?.name ||
        null
      );
    }
    return null;
  }

  function isNoiseComponentName(name) {
    if (!name || name.length <= 1) return true;
    return /^(Fragment|Suspense|StrictMode|Profiler|Provider|Consumer|Context|ForwardRef|Memo|Primitive|Slot|Slottable|Presence|Portal|MotionComponent|Styled\(|_c\d*)$/.test(
      name,
    );
  }

  function inspectReact(el) {
    const fiber = getReactFiber(el);
    if (!fiber) return null;

    let source = null;
    const names = [];
    let cur = fiber;
    let steps = 0;

    while (cur && steps < 45) {
      steps++;
      const name = getComponentName(cur.type);
      if (
        name &&
        !isNoiseComponentName(name) &&
        names[names.length - 1] !== name
      ) {
        names.push(name);
      }

      if (!source) {
        const dbg =
          cur._debugSource ||
          cur._debugOwner?._debugSource ||
          (cur._debugStack && parseReact19DebugStack(cur._debugStack.stack)) ||
          (cur._debugOwner?._debugStack &&
            parseReact19DebugStack(cur._debugOwner._debugStack.stack));
        if (dbg && dbg.fileName) {
          const cleaned = cleanFilePath(dbg.fileName);
          if (cleaned && !cleaned.includes("node_modules")) {
            source = {
              fileName: cleaned,
              lineNumber: Number(dbg.lineNumber) || null,
              columnNumber: Number(dbg.columnNumber) || null,
            };
          }
        }
      }

      cur = cur.return;
    }

    if (!source && names.length === 0) return null;
    const chain = names.slice(0, 4).reverse().join(" > ");
    return {
      framework: "react",
      fileName: source?.fileName || null,
      lineNumber: source?.lineNumber || null,
      columnNumber: source?.columnNumber || null,
      componentPath: chain || null,
    };
  }

  function inspectVue(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (cur.__vueParentComponent) {
        let comp = cur.__vueParentComponent;
        let fileName = null;
        const names = [];
        let steps = 0;
        while (comp && steps < 25) {
          steps++;
          const t = comp.type || {};
          const name = t.name || t.__name;
          if (name && names[names.length - 1] !== name) {
            names.push(name);
          }
          if (!fileName && t.__file) {
            fileName = cleanFilePath(t.__file);
          }
          comp = comp.parent;
        }
        return {
          framework: "vue",
          fileName,
          lineNumber: null,
          columnNumber: null,
          componentPath: names.slice(0, 4).reverse().join(" > ") || null,
        };
      }
      if (cur.__vue__) {
        const vm = cur.__vue__;
        const file = cleanFilePath(vm.$options?.__file);
        const name = vm.$options?.name || vm.$options?._componentTag;
        return {
          framework: "vue2",
          fileName: file,
          lineNumber: null,
          columnNumber: null,
          componentPath: name || null,
        };
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function inspectSvelteOrAttrs(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      // Vite / Vue / React inspector attributes
      const vInsp =
        cur.getAttribute?.("data-v-inspector") ||
        cur.getAttribute?.("data-source-loc") ||
        cur.getAttribute?.("data-inspector- path");
      if (vInsp) {
        const m = vInsp.match(/^(.*?):(\d+)(?::(\d+))?$/);
        if (m) {
          return {
            framework: "inspector",
            fileName: cleanFilePath(m[1]),
            lineNumber: Number(m[2]) || null,
            columnNumber: Number(m[3]) || null,
            componentPath: null,
          };
        }
      }
      const astroFile = cur.getAttribute?.("data-astro-source-file");
      if (astroFile) {
        const loc = cur.getAttribute?.("data-astro-source-loc") || "";
        const m = loc.match(/^(\d+)(?::(\d+))?/);
        return {
          framework: "astro",
          fileName: cleanFilePath(astroFile),
          lineNumber: m ? Number(m[1]) : null,
          columnNumber: m && m[2] ? Number(m[2]) : null,
          componentPath: null,
        };
      }
      if (cur.__svelte_meta?.loc) {
        const loc = cur.__svelte_meta.loc;
        return {
          framework: "svelte",
          fileName: cleanFilePath(loc.file),
          lineNumber: Number(loc.line) || null,
          columnNumber: Number(loc.column) || null,
          componentPath: null,
        };
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function inspectElementSource(el) {
    if (!el || !(el instanceof Element)) return null;
    const attrSource = inspectSvelteOrAttrs(el);
    const reactSource = inspectReact(el);
    const vueSource = !reactSource ? inspectVue(el) : null;

    if (attrSource && reactSource) {
      return {
        ...reactSource,
        fileName: attrSource.fileName || reactSource.fileName,
        lineNumber: attrSource.lineNumber || reactSource.lineNumber,
      };
    }
    if (attrSource && vueSource) {
      return {
        ...vueSource,
        fileName: attrSource.fileName || vueSource.fileName,
        lineNumber: attrSource.lineNumber || vueSource.lineNumber,
      };
    }
    return reactSource || vueSource || attrSource || null;
  }

  document.addEventListener(
    "__herdr_inspect_request",
    function (e) {
      const target = e.target;
      const result = inspectElementSource(target);
      window.dispatchEvent(
        new CustomEvent("__herdr_inspect_response", {
          detail: {
            reqId: e.detail?.reqId,
            source: result,
          },
        }),
      );
    },
    true,
  );
})();
