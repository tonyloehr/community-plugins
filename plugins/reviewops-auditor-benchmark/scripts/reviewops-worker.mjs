#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar2(node) || isCollection(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias2;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap2;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar2;
    exports.isSeq = isSeq2;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum2, line) => sum2 + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum2, line) => sum2 + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "…" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "…";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "…\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep + cb;
              sep = "";
              break;
            }
            case "newline":
              if (comment)
                sep += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap2 = fc.start.source === "{";
      const fcName = isMap2 ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap2 && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap2 && !sep && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap2 && !props.found && ctx.options.strict) {
              if (sep)
                for (const st of sep) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap2) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap2 ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep === " ")
            sep = "\n";
          else if (!prevMoreIndented && sep === "\n")
            sep = "\n\n";
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep === "\n")
            value += "\n";
          else
            sep = "\n";
        } else {
          value += sep + content;
          sep = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep === "\n")
            res += sep;
          else
            sep = "\n";
        } else {
          res += sep + match[1];
          sep = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "",
      // Unicode next line
      _: " ",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (false)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep)
        for (const st of sep)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar2 = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar2;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter2 = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter2;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (false)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep;
          if (scalar.end) {
            sep = scalar.end;
            sep.push(this.sourceToken);
            delete scalar.end;
          } else
            sep = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep = it.sep;
                  sep.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep = fc.end.splice(1, fc.end.length);
            sep.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument2(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument2(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument2;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// src/worker.mjs
import { parentPort } from "node:worker_threads";

// src/errors.mjs
var ReviewOpsError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: "BLOCKED" | "ERROR" | "INSUFFICIENT_EVIDENCE", cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "ReviewOpsError";
    this.code = code;
    this.status = options.status ?? "BLOCKED";
  }
};
function fail(code, message, options) {
  throw new ReviewOpsError(code, message, options);
}
function asReviewOpsError(error) {
  if (error instanceof ReviewOpsError) {
    return error;
  }
  return new ReviewOpsError("RO_INTERNAL_ERROR", "Internal analysis failure.", {
    status: "ERROR",
    cause: error
  });
}
function publicError(error) {
  const safe = asReviewOpsError(error);
  return {
    code: safe.code,
    message: safe.message,
    status: safe.status
  };
}

// src/utils.mjs
import { createHash } from "node:crypto";
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}
function textLineShape(value) {
  if (value.length === 0) {
    return { lines: 0, longestLineBytes: 0 };
  }
  let lines = 1;
  let longestLineBytes = 0;
  let currentLineBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13) {
      longestLineBytes = Math.max(longestLineBytes, currentLineBytes);
      currentLineBytes = 0;
      lines += 1;
      if (code === 13 && value.charCodeAt(index + 1) === 10) {
        index += 1;
      }
      continue;
    }
    if (code <= 127) {
      currentLineBytes += 1;
    } else if (code <= 2047) {
      currentLineBytes += 2;
    } else if (code >= 55296 && code <= 56319 && value.charCodeAt(index + 1) >= 56320 && value.charCodeAt(index + 1) <= 57343) {
      currentLineBytes += 4;
      index += 1;
    } else {
      currentLineBytes += 3;
    }
  }
  return {
    lines,
    longestLineBytes: Math.max(longestLineBytes, currentLineBytes)
  };
}
function lineCount(value) {
  return textLineShape(value).lines;
}
function stableJson(value) {
  const seen = /* @__PURE__ */ new Set();
  function serialize(item) {
    if (item === null) {
      return "null";
    }
    if (typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail("RO_NON_FINITE_NUMBER", "Only finite JSON numbers are supported.");
      }
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) {
        fail("RO_CYCLIC_VALUE", "Cyclic values are not supported.");
      }
      seen.add(item);
      const output = "[" + item.map((entry) => serialize(entry)).join(",") + "]";
      seen.delete(item);
      return output;
    }
    if (isPlainObject(item)) {
      if (seen.has(item)) {
        fail("RO_CYCLIC_VALUE", "Cyclic values are not supported.");
      }
      seen.add(item);
      const entries = Object.keys(item).sort().map((key) => JSON.stringify(key) + ":" + serialize(item[key]));
      seen.delete(item);
      return "{" + entries.join(",") + "}";
    }
    fail("RO_NON_JSON_VALUE", "Only JSON-compatible values are supported.");
  }
  return serialize(value);
}
function structuralDigest(projection) {
  return "sha256:" + createHash("sha256").update(stableJson(projection)).digest("hex");
}
function stableSort(values, compare) {
  return values.map((value, index) => ({ value, index })).sort((left, right) => compare(left.value, right.value) || left.index - right.index).map(({ value }) => value);
}
function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// src/redact.mjs
var REDACTED = "[REDACTED]";
var PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/giu;
var PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/giu;
var TEXT_RULES = Object.freeze([
  {
    category: "AUTH_HEADER",
    pattern: /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/giu,
    replacement: (_match, name) => name + ": " + REDACTED
  },
  {
    category: "SECRET_ASSIGNMENT",
    pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*([^\s,;]+)/giu,
    replacement: (_match, name) => name + "=" + REDACTED
  },
  {
    category: "TOKEN",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu
  },
  {
    category: "EMAIL",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu
  },
  {
    category: "URL",
    pattern: /\b(?:https?|ssh):\/\/[^\s<>()\[\]{}"'`]+/giu
  },
  {
    category: "GIT_REMOTE",
    pattern: /\bgit@[^\s:]+:[^\s]+/giu
  },
  {
    category: "HOME_PATH",
    pattern: /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)(?:[/\\][^\s"'`<>]*)?/giu
  },
  {
    category: "PRIVATE_HOST",
    pattern: /\b(?:localhost|(?:[A-Z0-9-]+\.)+(?:internal|local|corp|private))(?::\d+)?\b/giu
  }
]);
var ANSI_ESCAPE = /[\u001B\u009B](?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu;
var CONTROL_AND_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
function addCategory(categories, category, amount) {
  categories[category] = (categories[category] ?? 0) + amount;
}
function redactPrivateKeys(value) {
  let cursor = 0;
  let output = "";
  let count = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  while (true) {
    const begin = PRIVATE_KEY_BEGIN.exec(value);
    if (begin === null) {
      break;
    }
    PRIVATE_KEY_END.lastIndex = PRIVATE_KEY_BEGIN.lastIndex;
    const end = PRIVATE_KEY_END.exec(value);
    if (end === null) {
      output += value.slice(cursor, begin.index) + REDACTED;
      cursor = value.length;
      count += 1;
      break;
    }
    output += value.slice(cursor, begin.index) + REDACTED;
    cursor = PRIVATE_KEY_END.lastIndex;
    PRIVATE_KEY_BEGIN.lastIndex = cursor;
    count += 1;
  }
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  PRIVATE_KEY_END.lastIndex = 0;
  return {
    text: count === 0 ? value : output + value.slice(cursor),
    count
  };
}
function redactText(value) {
  let text = stripUnsafeControls(String(value));
  let count = 0;
  const categories = /* @__PURE__ */ Object.create(null);
  const privateKeys = redactPrivateKeys(text);
  text = privateKeys.text;
  if (privateKeys.count > 0) {
    count += privateKeys.count;
    addCategory(categories, "PRIVATE_KEY", privateKeys.count);
  }
  for (const rule of TEXT_RULES) {
    let matches2 = 0;
    text = text.replace(rule.pattern, (...args) => {
      matches2 += 1;
      if (typeof rule.replacement === "function") {
        const [match, ...captures] = (
          /** @type {string[]} */
          args.slice(0, -2)
        );
        return rule.replacement(match, ...captures);
      }
      return rule.replacement ?? REDACTED;
    });
    if (matches2 > 0) {
      count += matches2;
      addCategory(categories, rule.category, matches2);
    }
  }
  return { text, count, categories };
}
function stripUnsafeControls(value) {
  return value.normalize("NFC").replace(ANSI_ESCAPE, "").replace(CONTROL_AND_BIDI, "").replace(/\r\n|\r/gu, "\n");
}
function escapeUntrustedText(value, options = {}) {
  const redacted = redactText(value);
  const maxChars = options.maxChars ?? 240;
  let text = stripUnsafeControls(redacted.text).replace(/\s+/gu, " ").trim();
  const characters = [...text];
  if (characters.length > maxChars) {
    text = characters.slice(0, Math.max(0, maxChars - 1)).join("") + "…";
  }
  text = text.replace(/[\\`*_{}\[\]()<>#+.!|\-]/gu, "\\$&");
  return { ...redacted, text };
}
function safeEvidenceSummary(value, options) {
  return escapeUntrustedText(value, options);
}
function redactRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    return { text: REDACTED, count: 1, categories: { PATH: 1 } };
  }
  const cleaned = stripUnsafeControls(value);
  const redacted = redactText(cleaned);
  if (cleaned !== value || redacted.count > 0 || redacted.text !== cleaned) {
    return {
      text: REDACTED,
      count: redacted.count + (cleaned === value ? 0 : 1),
      categories: redacted.count > 0 ? { ...redacted.categories } : { CONTROL_CHARACTERS: 1 }
    };
  }
  return { text: cleaned, count: 0, categories: {} };
}
function redactedTextShape(value) {
  const redacted = redactText(value);
  return {
    bytes: utf8Bytes(redacted.text),
    lines: lineCount(redacted.text),
    redactions: redacted.count
  };
}

// src/audit/common.mjs
function makeFinding(input) {
  const pathResult = redactRelativePath(input.path);
  const summary = safeEvidenceSummary(input.evidenceSummary, { maxChars: 240 }).text;
  const remediation = safeEvidenceSummary(input.remediation, { maxChars: 240 }).text;
  const verification = safeEvidenceSummary(input.verification, { maxChars: 240 }).text;
  const claimBoundary = safeEvidenceSummary(input.claimBoundary, {
    maxChars: 240
  }).text;
  const missingEvidence = [...input.missingEvidence ?? []].map((value) => safeEvidenceSummary(value, { maxChars: 120 }).text).sort((left, right) => left.localeCompare(right, "en"));
  const line = input.line;
  const endLine = input.endLine;
  const location = {
    path: pathResult.text,
    ...typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? { line } : {},
    ...typeof endLine === "number" && Number.isSafeInteger(endLine) && endLine > 0 ? { endLine } : {}
  };
  return {
    ruleId: input.ruleId,
    ruleVersion: 1,
    category: input.category,
    evidenceStatus: input.evidenceStatus,
    severity: input.severity,
    confidence: input.confidence,
    location,
    evidenceSummary: summary,
    remediation,
    verification,
    claimBoundary,
    missingEvidence
  };
}
function sortFindings(findings) {
  return stableSort(findings, (left, right) => {
    return left.ruleId.localeCompare(right.ruleId, "en") || left.location.path.localeCompare(right.location.path, "en") || (left.location.line ?? 0) - (right.location.line ?? 0) || left.evidenceSummary.localeCompare(right.evidenceSummary, "en");
  });
}
function firstMatchingLine(text, pattern) {
  const safePattern = new RegExp(pattern.source, pattern.flags.replaceAll("g", ""));
  const match = safePattern.exec(text);
  if (match === null || match.index === void 0) {
    return void 0;
  }
  let line = 1;
  for (let index = 0; index < match.index; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}
function structuralInputSummary(input, facts) {
  const shape = redactedTextShape(input.text);
  const path = redactRelativePath(input.relativePath).text;
  return {
    path,
    bytes: input.bytes ?? shape.bytes,
    lines: input.lines ?? shape.lines,
    redactionCount: shape.redactions,
    structuralDigest: structuralDigest({
      kind: "text-structure",
      bytes: input.bytes ?? shape.bytes,
      lines: input.lines ?? shape.lines,
      redactionCount: shape.redactions,
      facts
    })
  };
}
function objectValue(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  return (
    /** @type {Record<string, unknown>} */
    value
  );
}
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function booleanValue(value) {
  return value === true;
}

// src/audit/prompt.mjs
var PROMPT_RULES = Object.freeze([
  {
    id: "RO-PR-001",
    category: "COST",
    title: "Prompt and context limits are explicit"
  },
  {
    id: "RO-PR-002",
    category: "QUALITY",
    title: "Evidence and uncertainty are required"
  },
  {
    id: "RO-PR-003",
    category: "QUALITY",
    title: "Findings are validated before publishing"
  },
  {
    id: "RO-PR-004",
    category: "NOISE",
    title: "Comment volume and duplicates are bounded"
  }
]);
var LARGE_PROMPT_BYTES = 16 * 1024;
function matches(text, pattern) {
  return new RegExp(pattern.source, pattern.flags.replaceAll("g", "")).test(text);
}
function auditPrompt(input) {
  const text = input.text;
  const bytes = input.bytes ?? utf8Bytes(text);
  const hasExplicitLimit = matches(
    text,
    /\b(?:max(?:imum)?|limit|budget|at most|no more than)\b[\s\S]{0,60}\b(?:tokens?|files?|lines?|comments?|findings?|characters?|bytes?|context)\b/iu
  );
  const hasEvidence = matches(
    text,
    /\b(?:evidence|citation|cite|line number|file path|exact line|proof)\b/iu
  );
  const hasUncertainty = matches(
    text,
    /\b(?:uncertain|uncertainty|unknown|cannot verify|insufficient evidence|confidence)\b/iu
  );
  const hasValidation = matches(
    text,
    /\b(?:validate|validation|verify|verification|prune|suppress unverified|discard unverified)\b/iu
  );
  const hasPublishingGate = matches(
    text,
    /\b(?:before (?:publishing|posting|commenting)|only (?:publish|post|comment)|require evidence)\b/iu
  );
  const hasCommentBudget = matches(
    text,
    /\b(?:max(?:imum)?|at most|no more than|budget)\b[\s\S]{0,50}\b(?:comments?|findings?)\b/iu
  );
  const hasDedupe = matches(
    text,
    /\b(?:deduplicat|de-duplicat|duplicate|suppress|noise)\b/iu
  );
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
  const findings = [];
  if (bytes > LARGE_PROMPT_BYTES || !hasExplicitLimit) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-001",
        category: "COST",
        evidenceStatus: "INFERRED",
        severity: bytes > LARGE_PROMPT_BYTES ? "MEDIUM" : "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(text, /\b(?:max(?:imum)?|limit|budget|context)\b/iu),
        evidenceSummary: bytes > LARGE_PROMPT_BYTES ? "Prompt text exceeds the conservative 16 KiB review threshold." : "No explicit prompt or context limit is visible.",
        remediation: "Declare bounded context, file, token, and finding budgets.",
        verification: "Measure imported run context and token telemetry against the declared limits.",
        claimBoundary: "Static prompt heuristic only; actual context size requires run telemetry.",
        missingEvidence: ["Context receipts", "Token telemetry"]
      })
    );
  }
  if (!hasEvidence || !hasUncertainty) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-002",
        category: "QUALITY",
        evidenceStatus: "INFERRED",
        severity: "MEDIUM",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(
          text,
          /\b(?:evidence|citation|uncertain|unknown|confidence)\b/iu
        ),
        evidenceSummary: !hasEvidence && !hasUncertainty ? "No evidence or uncertainty requirement is visible." : !hasEvidence ? "No evidence requirement is visible." : "No uncertainty requirement is visible.",
        remediation: "Require file-and-line evidence plus explicit uncertainty for unverifiable claims.",
        verification: "Test the prompt on synthetic ambiguous changes and inspect evidence-bearing output.",
        claimBoundary: "Keyword-level heuristic only; prompt compliance requires adjudicated runs.",
        missingEvidence: ["Adjudicated finding evidence"]
      })
    );
  }
  if (!hasValidation || !hasPublishingGate) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-003",
        category: "QUALITY",
        evidenceStatus: "INFERRED",
        severity: "MEDIUM",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(
          text,
          /\b(?:validate|verify|prune|publish|post|comment)\b/iu
        ),
        evidenceSummary: !hasValidation && !hasPublishingGate ? "No validation or publishing gate is visible." : !hasValidation ? "No validation or pruning instruction is visible." : "No pre-publishing gate is visible.",
        remediation: "Require deterministic validation and suppress unverified findings before publishing.",
        verification: "Compare proposed and published finding IDs in imported validator telemetry.",
        claimBoundary: "Static prompt heuristic only; validator behavior is not observed.",
        missingEvidence: ["Validator results tied to finding IDs"]
      })
    );
  }
  if (!hasCommentBudget || !hasDedupe) {
    findings.push(
      makeFinding({
        ruleId: "RO-PR-004",
        category: "NOISE",
        evidenceStatus: "INFERRED",
        severity: "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: firstMatchingLine(
          text,
          /\b(?:comment|finding|deduplicat|duplicate|suppress|noise)\b/iu
        ),
        evidenceSummary: !hasCommentBudget && !hasDedupe ? "No comment budget or duplicate-suppression rule is visible." : !hasCommentBudget ? "No comment or finding budget is visible." : "No duplicate-suppression rule is visible.",
        remediation: "Set a maximum comment budget and deduplicate or suppress repeated findings.",
        verification: "Run synthetic duplicate findings through the publishing policy.",
        claimBoundary: "Static prompt heuristic only; actual comment volume requires telemetry.",
        missingEvidence: ["Published comment telemetry"]
      })
    );
  }
  const summary = structuralInputSummary(input, {
    characters: [...text].length,
    words,
    overConservativeThreshold: bytes > LARGE_PROMPT_BYTES,
    hasExplicitLimit,
    hasEvidence,
    hasUncertainty,
    hasValidation,
    hasPublishingGate,
    hasCommentBudget,
    hasDedupe
  });
  return {
    kind: "prompt",
    summary: {
      ...summary,
      characters: [...text].length,
      words
    },
    findings: sortFindings(findings)
  };
}

// src/audit/telemetry.mjs
var TELEMETRY_RULES = Object.freeze([
  {
    id: "RO-TL-001",
    category: "SECURITY",
    title: "Beyond-diff tools have a bounded read-only contract"
  },
  {
    id: "RO-TL-002",
    category: "RELIABILITY",
    title: "Verification checks are bounded and provenance-backed"
  },
  {
    id: "RO-TL-003",
    category: "QUALITY",
    title: "Validator results tie to findings"
  }
]);
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function records(value) {
  return Array.isArray(value) ? value.filter((item) => isRecord(item)) : [];
}
function evidencePath(telemetry) {
  return telemetry[0]?.relativePath ?? "telemetry-evidence";
}
function auditTelemetryEvidence(inputs = {}) {
  const telemetry = Array.isArray(inputs.telemetry) ? inputs.telemetry : [];
  const toolContracts = records(inputs.toolContracts);
  const validatorResults = records(inputs.validatorResults);
  const path = evidencePath(telemetry);
  const findings = [];
  const warnings = [];
  if (toolContracts.length === 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-TL-001",
        category: "SECURITY",
        evidenceStatus: "UNKNOWN",
        severity: "HIGH",
        confidence: "HIGH",
        path,
        evidenceSummary: "No schema-validated read-only tool contract was supplied.",
        remediation: "Export a versioned bounded read-only tool contract.",
        verification: "Validate the exported contract against the bundled schema.",
        claimBoundary: "No declared tool is invoked by this audit.",
        missingEvidence: ["Tool contract"]
      })
    );
  } else {
    const unsafeContract = toolContracts.some((contract) => {
      const capabilities = Array.isArray(contract.capabilities) ? contract.capabilities : [];
      return capabilities.length === 0 || capabilities.some((capability) => capability !== "READ") || contract.commandPolicy !== "NO_COMMANDS";
    });
    if (unsafeContract) {
      findings.push(
        makeFinding({
          ruleId: "RO-TL-001",
          category: "SECURITY",
          evidenceStatus: "OBSERVED",
          severity: "HIGH",
          confidence: "HIGH",
          path,
          evidenceSummary: "A declared tool contract is not strictly read-only and command-free.",
          remediation: "Use READ-only capabilities and NO_COMMANDS for review context.",
          verification: "Revalidate the exported tool contract.",
          claimBoundary: "Contract metadata only; no declared tool was invoked.",
          missingEvidence: []
        })
      );
    }
  }
  if (validatorResults.length === 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-TL-002",
        category: "RELIABILITY",
        evidenceStatus: "UNKNOWN",
        severity: "HIGH",
        confidence: "HIGH",
        path,
        evidenceSummary: "No schema-validated validator results were supplied.",
        remediation: "Export bounded validator-result records with provenance.",
        verification: "Validate synthetic validator results against the bundled schema.",
        claimBoundary: "No validator command is executed by this audit.",
        missingEvidence: ["Validator results"]
      })
    );
    findings.push(
      makeFinding({
        ruleId: "RO-TL-003",
        category: "QUALITY",
        evidenceStatus: "UNKNOWN",
        severity: "HIGH",
        confidence: "HIGH",
        path,
        evidenceSummary: "Finding-linked validator evidence is unavailable.",
        remediation: "Export validator results tied to opaque finding IDs.",
        verification: "Check every imported validator result for a finding ID.",
        claimBoundary: "Missing imported evidence is not treated as a pass.",
        missingEvidence: ["Finding-linked validator results"]
      })
    );
  } else {
    const contractsByCheck = /* @__PURE__ */ new Map();
    for (const contract of toolContracts) {
      const checkIds = Array.isArray(contract.verificationCheckIds) ? contract.verificationCheckIds.filter((checkId) => typeof checkId === "string") : [];
      for (const checkId of checkIds) {
        const declaredBy = contractsByCheck.get(checkId) ?? [];
        declaredBy.push(contract);
        contractsByCheck.set(checkId, declaredBy);
      }
    }
    const unknownCheck = validatorResults.some(
      (result2) => typeof result2.checkId !== "string" || !contractsByCheck.has(result2.checkId)
    );
    const timeoutExceeded = validatorResults.some((result2) => {
      const durationMs = result2.durationMs;
      if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
        return true;
      }
      const declaredBy = typeof result2.checkId === "string" ? contractsByCheck.get(result2.checkId) ?? [] : [];
      if (declaredBy.length === 0) {
        return true;
      }
      return declaredBy.some((contract) => {
        const timeoutMs = contract.timeoutMs;
        return typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0 || durationMs > timeoutMs;
      });
    });
    if (unknownCheck || timeoutExceeded) {
      findings.push(
        makeFinding({
          ruleId: "RO-TL-002",
          category: "RELIABILITY",
          evidenceStatus: "OBSERVED",
          severity: "HIGH",
          confidence: "HIGH",
          path,
          evidenceSummary: "A validator result is outside its declared check or timeout contract.",
          remediation: "Keep validator results within declared IDs and timeouts.",
          verification: "Compare imported result IDs and durations with the contract.",
          claimBoundary: "Imported metadata only; no validator command was executed.",
          missingEvidence: []
        })
      );
    }
    const seen = /* @__PURE__ */ new Map();
    let untied = false;
    let contradictory = false;
    for (const result2 of validatorResults) {
      const runId = typeof result2.runId === "string" ? result2.runId : "";
      const findingId = typeof result2.findingId === "string" ? result2.findingId : "";
      const checkId = typeof result2.checkId === "string" ? result2.checkId : "";
      if (findingId.length === 0) {
        untied = true;
      }
      const key = `${runId}\0${findingId}\0${checkId}`;
      const status = typeof result2.status === "string" ? result2.status : "";
      if (seen.has(key) && seen.get(key) !== status) {
        contradictory = true;
      }
      seen.set(key, status);
    }
    if (untied || contradictory) {
      findings.push(
        makeFinding({
          ruleId: "RO-TL-003",
          category: "QUALITY",
          evidenceStatus: "OBSERVED",
          severity: "HIGH",
          confidence: "HIGH",
          path,
          evidenceSummary: untied ? "A validator result is not tied to an opaque finding ID." : "Validator results contain contradictory statuses for one finding.",
          remediation: "Export one consistent finding-linked result per check.",
          verification: "Reject untied or contradictory result records.",
          claimBoundary: "Imported evidence only; validator quality is not inferred.",
          missingEvidence: []
        })
      );
    }
  }
  if (telemetry.length > 0 && toolContracts.length === 0 && validatorResults.length === 0) {
    warnings.push(
      "Generic telemetry was bounded and parsed, but no typed tool or validator evidence was supplied."
    );
  }
  const summaries = telemetry.map(
    (input) => structuralInputSummary(input, {
      kind: "telemetry",
      hasToolContracts: toolContracts.length > 0,
      hasValidatorResults: validatorResults.length > 0
    })
  );
  return {
    findings: sortFindings(findings),
    summaries,
    redactionCount: summaries.reduce(
      (total, summary) => total + summary.redactionCount,
      0
    ),
    warnings
  };
}

// src/yaml.mjs
var import_yaml = __toESM(require_dist(), 1);

// src/bounds.mjs
var HARD_LIMITS = Object.freeze({
  maxFiles: 100,
  maxBytesPerFile: 8 * 1024 * 1024,
  maxWorkflowBytes: 2 * 1024 * 1024,
  maxPromptBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxRecords: 1e4,
  maxFindings: 1e3,
  maxEvidenceBytes: 128 * 1024,
  maxStdoutBytes: 2 * 1024 * 1024,
  maxLineBytes: 128 * 1024,
  maxJsonDepth: 32,
  maxYamlNodes: 2e4
});
var DEFAULT_LIMITS = Object.freeze({
  maxFiles: 50,
  maxBytesPerFile: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRecords: 5e3,
  maxLineBytes: 64 * 1024,
  maxJsonDepth: 32,
  maxYamlNodes: 1e4
});
function resolveLimits(requested = {}) {
  if (!isPlainObject(requested)) {
    fail("RO_LIMITS_INVALID", "Limits must be a JSON object.");
  }
  const allowed = /* @__PURE__ */ new Set([
    "maxFiles",
    "maxBytesPerFile",
    "maxTotalBytes",
    "maxRecords",
    "maxLineBytes",
    "maxJsonDepth",
    "maxYamlNodes"
  ]);
  for (const key of Object.keys(requested)) {
    if (!allowed.has(key)) {
      fail("RO_LIMITS_UNKNOWN_FIELD", "Limits contain an unsupported field.");
    }
  }
  const limits = { ...DEFAULT_LIMITS };
  const ceilings = {
    maxFiles: HARD_LIMITS.maxFiles,
    maxBytesPerFile: HARD_LIMITS.maxBytesPerFile,
    maxTotalBytes: HARD_LIMITS.maxTotalBytes,
    maxRecords: HARD_LIMITS.maxRecords,
    maxLineBytes: HARD_LIMITS.maxLineBytes,
    maxJsonDepth: HARD_LIMITS.maxJsonDepth,
    maxYamlNodes: HARD_LIMITS.maxYamlNodes
  };
  for (
    const key of
    /** @type {(keyof Limits)[]} */
    Object.keys(limits)
  ) {
    const value = requested[key];
    if (value === void 0) {
      continue;
    }
    if (!isNonNegativeSafeInteger(value) || value === 0 || value > ceilings[key]) {
      fail(
        "RO_LIMIT_EXCEEDS_CEILING",
        "A configured limit is invalid or exceeds its hard ceiling."
      );
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}
function maxBytesForKind(kind, limits) {
  if (kind === "workflow") {
    return Math.min(limits.maxBytesPerFile, HARD_LIMITS.maxWorkflowBytes);
  }
  if (kind === "prompt") {
    return Math.min(limits.maxBytesPerFile, HARD_LIMITS.maxPromptBytes);
  }
  return Math.min(limits.maxBytesPerFile, HARD_LIMITS.maxBytesPerFile);
}
function assertBoundedText(text, options) {
  if (typeof text !== "string") {
    fail("RO_TEXT_INVALID", "Input must decode as UTF-8 text.");
  }
  if (text.includes("\0")) {
    fail("RO_TEXT_NUL", "Input contains a NUL byte.");
  }
  const limits = options.limits ?? resolveLimits();
  const bytes = utf8Bytes(text);
  if (bytes > maxBytesForKind(options.kind, limits)) {
    fail("RO_FILE_TOO_LARGE", "Input exceeds the per-file byte limit.");
  }
  const lineShape = textLineShape(text);
  if (lineShape.longestLineBytes > limits.maxLineBytes) {
    fail("RO_LINE_TOO_LONG", "Input contains a line that exceeds the byte limit.");
  }
  return { bytes, lines: lineShape.lines };
}

// src/yaml.mjs
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function pointerFor(segments) {
  if (segments.length === 0) {
    return "/";
  }
  return "/" + segments.map((segment) => String(segment).replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/");
}
function lineForNode(node, lineCounter) {
  if (node !== null && typeof node === "object" && "range" in node && Array.isArray(node.range) && typeof node.range[0] === "number") {
    return Math.max(1, lineCounter.linePos(node.range[0]).line);
  }
  return 1;
}
function explicitTag(node) {
  if (node !== null && typeof node === "object" && "tag" in node && typeof node.tag === "string") {
    return node.tag;
  }
  return void 0;
}
function convertNode(node, context) {
  context.state.nodes += 1;
  if (context.state.nodes > context.limits.maxYamlNodes) {
    fail("RO_YAML_NODE_LIMIT", "YAML input exceeds the node limit.");
  }
  if (context.depth > context.limits.maxJsonDepth) {
    fail("RO_YAML_TOO_DEEP", "YAML input exceeds the nesting limit.");
  }
  const pointer = pointerFor(context.path);
  if (context.lineMap[pointer] === void 0) {
    context.lineMap[pointer] = lineForNode(node, context.lineCounter);
  }
  if ((0, import_yaml.isAlias)(node)) {
    fail("RO_YAML_ALIAS", "YAML aliases are not supported.");
  }
  if (explicitTag(node) !== void 0) {
    fail("RO_YAML_TAG", "Explicit YAML tags are not supported.");
  }
  if ((0, import_yaml.isScalar)(node)) {
    const value = node.value;
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    fail("RO_YAML_SCALAR", "YAML contains an unsupported scalar.");
  }
  if ((0, import_yaml.isSeq)(node)) {
    return node.items.map(
      (item, index) => convertNode(item, {
        ...context,
        depth: context.depth + 1,
        path: [...context.path, index]
      })
    );
  }
  if ((0, import_yaml.isMap)(node)) {
    const output = /* @__PURE__ */ Object.create(null);
    const seen = /* @__PURE__ */ new Set();
    for (const pair of node.items) {
      if (!(0, import_yaml.isScalar)(pair.key) || typeof pair.key.value !== "string") {
        fail("RO_YAML_KEY", "YAML mapping keys must be strings.");
      }
      const key = pair.key.value;
      if (key === "<<" || FORBIDDEN_KEYS.has(key)) {
        fail("RO_YAML_KEY", "YAML contains an unsupported mapping key.");
      }
      if (seen.has(key)) {
        fail("RO_YAML_DUPLICATE_KEY", "YAML contains a duplicate mapping key.");
      }
      seen.add(key);
      const childPath = [...context.path, key];
      context.lineMap[pointerFor(childPath)] = lineForNode(
        pair.key,
        context.lineCounter
      );
      output[key] = pair.value === null ? null : convertNode(pair.value, {
        ...context,
        depth: context.depth + 1,
        path: childPath
      });
    }
    return output;
  }
  fail("RO_YAML_NODE", "YAML contains an unsupported node.");
}
function parseSafeYaml(text, options = {}) {
  const limits = options.limits ?? resolveLimits();
  const shape = assertBoundedText(text, { kind: "workflow", limits });
  const lineCounter = new import_yaml.LineCounter();
  const document = (0, import_yaml.parseDocument)(text, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    merge: false,
    resolveKnownTags: false,
    customTags: [],
    prettyErrors: false,
    lineCounter
  });
  if (document.errors.length > 0) {
    if (document.errors.some((error) => error.code === "DUPLICATE_KEY")) {
      fail("RO_YAML_DUPLICATE_KEY", "YAML contains a duplicate mapping key.");
    }
    fail("RO_YAML_INVALID", "YAML input is malformed or unsupported.");
  }
  if (document.warnings.length > 0) {
    fail("RO_YAML_AMBIGUOUS", "YAML input is ambiguous or unsupported.");
  }
  if (document.contents === null) {
    fail("RO_YAML_EMPTY", "YAML input must contain a mapping.");
  }
  const lineMap = /* @__PURE__ */ Object.create(null);
  const state = { nodes: 0 };
  const value = convertNode(document.contents, {
    depth: 0,
    path: [],
    lineCounter,
    lineMap,
    limits,
    state
  });
  return {
    value,
    lineMap,
    bytes: shape.bytes,
    lines: shape.lines,
    nodeCount: state.nodes
  };
}
function parseWorkflowYaml(text, options = {}) {
  const parsed = parseSafeYaml(text, options);
  if (!isPlainObject(parsed.value)) {
    fail("RO_WORKFLOW_ROOT", "Workflow YAML must contain a top-level mapping.");
  }
  return (
    /** @type {ParsedWorkflowYaml} */
    parsed
  );
}
function lineForYamlPath(parsed, segments) {
  return parsed.lineMap[pointerFor(segments)];
}

// src/audit/workflow.mjs
var WORKFLOW_RULES = Object.freeze([
  { id: "RO-WF-001", category: "SECURITY", title: "Permissions are bounded" },
  {
    id: "RO-WF-002",
    category: "SECURITY",
    title: "Triggers avoid privileged untrusted code"
  },
  {
    id: "RO-WF-003",
    category: "SECURITY",
    title: "Remote actions are immutably pinned"
  },
  { id: "RO-WF-004", category: "COST", title: "Triggers avoid duplicate review runs" },
  { id: "RO-WF-005", category: "COST", title: "Concurrency cancels superseded runs" },
  { id: "RO-WF-006", category: "RELIABILITY", title: "Review jobs have timeouts" },
  { id: "RO-WF-007", category: "COST", title: "Context collection is bounded" },
  {
    id: "RO-WF-008",
    category: "SECURITY",
    title: "Untrusted interpolation stays out of shell text"
  },
  { id: "RO-WF-009", category: "NOISE", title: "Writeback is bounded and verified" }
]);
function jobsFromWorkflow(workflow) {
  const jobs = objectValue(workflow.jobs);
  if (jobs === void 0) {
    return [];
  }
  return Object.keys(jobs).sort((left, right) => left.localeCompare(right, "en")).flatMap((jobName) => {
    const job = objectValue(jobs[jobName]);
    if (job === void 0) {
      return [];
    }
    const steps = arrayValue(job.steps).flatMap((value, index) => {
      const step = objectValue(value);
      return step === void 0 ? [] : [{ index, step }];
    });
    return [{ jobName, job, steps }];
  });
}
function collectStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, output);
    }
    return;
  }
  const object = objectValue(value);
  if (object !== void 0) {
    for (const key of Object.keys(object).sort(
      (left, right) => left.localeCompare(right, "en")
    )) {
      collectStrings(object[key], output);
    }
  }
}
function triggerNames(workflow) {
  const trigger = workflow.on;
  if (typeof trigger === "string") {
    return [trigger];
  }
  if (Array.isArray(trigger)) {
    return trigger.filter((value) => typeof value === "string");
  }
  const object = objectValue(trigger);
  return object === void 0 ? [] : Object.keys(object).sort((left, right) => left.localeCompare(right, "en"));
}
function hasPathFilters(workflow) {
  const triggers = objectValue(workflow.on);
  if (triggers === void 0) {
    return false;
  }
  for (const trigger of Object.values(triggers)) {
    const config = objectValue(trigger);
    if (config !== void 0 && ("paths" in config || "paths-ignore" in config)) {
      return true;
    }
  }
  return false;
}
function permissionShape(permissions) {
  if (permissions === void 0 || permissions === null) {
    return { missing: true, writes: false, broad: false };
  }
  if (typeof permissions === "string") {
    return {
      missing: false,
      writes: permissions === "write-all",
      broad: permissions === "write-all" || permissions === "read-all"
    };
  }
  const object = objectValue(permissions);
  if (object === void 0) {
    return { missing: false, writes: false, broad: true };
  }
  const values = Object.values(object);
  return {
    missing: false,
    writes: values.some((value) => value === "write"),
    broad: values.some((value) => value === "write")
  };
}
function effectivePermissionShape(workflow, jobs) {
  const global = permissionShape(workflow.permissions);
  let missing = global.missing && (jobs.length === 0 || jobs.some((job) => !("permissions" in job.job)));
  let writes = global.writes;
  let broad = global.broad;
  for (const job of jobs) {
    if ("permissions" in job.job) {
      const local = permissionShape(job.job.permissions);
      writes ||= local.writes;
      broad ||= local.broad;
    }
  }
  return { missing, writes, broad };
}
function usesEntries(jobs, parsed) {
  const entries = [];
  for (const job of jobs) {
    for (const { index, step } of job.steps) {
      const uses = stringValue(step.uses);
      if (uses !== void 0) {
        entries.push({
          jobName: job.jobName,
          index,
          value: uses,
          line: lineForYamlPath(parsed, ["jobs", job.jobName, "steps", index, "uses"])
        });
      }
    }
  }
  return entries;
}
function isRemoteAction(uses) {
  return !uses.startsWith("./") && !uses.startsWith("../") && uses.includes("/");
}
function isPinnedAction(uses) {
  return /@[0-9a-f]{40}$/iu.test(uses);
}
function auditWorkflow(input, options = {}) {
  const parsed = parseWorkflowYaml(input.text, { limits: options.limits });
  const workflow = parsed.value;
  const jobs = jobsFromWorkflow(workflow);
  const uses = usesEntries(jobs, parsed);
  const triggers = triggerNames(workflow);
  const strings3 = [];
  collectStrings(workflow, strings3);
  const allText = strings3.join("\n");
  const permissions = effectivePermissionShape(workflow, jobs);
  const findings = [];
  if (permissions.missing || permissions.broad || permissions.writes) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-001",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: permissions.writes ? "HIGH" : "MEDIUM",
        confidence: "HIGH",
        path: input.relativePath,
        line: lineForYamlPath(parsed, ["permissions"]) ?? lineForYamlPath(parsed, ["jobs"]),
        evidenceSummary: permissions.writes ? "A workflow or job declares write-capable permissions." : permissions.missing ? "A workflow or job has no explicit permissions declaration." : "A workflow or job declares broad permissions.",
        remediation: "Declare the smallest read-only permissions needed by the reviewer.",
        verification: "Inspect effective workflow and job permissions in a synthetic pull request.",
        claimBoundary: "Static file indicator only; repository and organization defaults are not visible.",
        missingEvidence: ["Effective GitHub permission defaults"]
      })
    );
  }
  const hasPullRequestTarget = triggers.includes("pull_request_target");
  const hasCheckout = uses.some((entry) => /^actions\/checkout@/iu.test(entry.value));
  const hasSecretReference = /\$\{\{\s*secrets\./iu.test(allText);
  if (hasPullRequestTarget) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-002",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: hasCheckout || hasSecretReference ? "HIGH" : "MEDIUM",
        confidence: "HIGH",
        path: input.relativePath,
        line: lineForYamlPath(parsed, ["on", "pull_request_target"]),
        evidenceSummary: hasCheckout || hasSecretReference ? "A privileged pull-request-target trigger appears with checkout or secret references." : "A privileged pull-request-target trigger is present.",
        remediation: "Use an unprivileged trigger or isolate trusted follow-up work from untrusted code.",
        verification: "Confirm the reviewed job never executes or checks out untrusted pull request content with secrets.",
        claimBoundary: "Static indicator only; runtime event data and repository settings are not visible.",
        missingEvidence: ["Runtime event provenance", "Repository secret policy"]
      })
    );
  }
  const unpinned = uses.filter(
    (entry) => isRemoteAction(entry.value) && !isPinnedAction(entry.value)
  );
  if (unpinned.length > 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-003",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: "MEDIUM",
        confidence: "HIGH",
        path: input.relativePath,
        line: unpinned[0]?.line,
        evidenceSummary: String(unpinned.length) + " remote action reference(s) are not pinned to a 40-character commit SHA.",
        remediation: "Pin every remote action to a reviewed immutable commit SHA.",
        verification: "Reparse the workflow and confirm each remote uses reference ends in a 40-character SHA.",
        claimBoundary: "Static reference check only; action provenance is not verified."
      })
    );
  }
  if (triggers.includes("pull_request") && triggers.includes("push") && !hasPathFilters(workflow)) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-004",
        category: "COST",
        evidenceStatus: "INFERRED",
        severity: "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: lineForYamlPath(parsed, ["on"]),
        evidenceSummary: "Pull-request and push triggers are both broad enough to plausibly duplicate review runs.",
        remediation: "Narrow events or path filters after confirming the intended review coverage.",
        verification: "Compare run telemetry for the same commit across trigger types.",
        claimBoundary: "Static heuristic only; duplicate runs require telemetry to confirm.",
        missingEvidence: ["Run telemetry keyed by commit and trigger"]
      })
    );
  }
  const concurrency = objectValue(workflow.concurrency);
  const cancels = concurrency !== void 0 && booleanValue(concurrency["cancel-in-progress"]);
  if (concurrency === void 0 || !cancels) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-005",
        category: "COST",
        evidenceStatus: "OBSERVED",
        severity: "LOW",
        confidence: "HIGH",
        path: input.relativePath,
        line: lineForYamlPath(parsed, ["concurrency"]),
        evidenceSummary: concurrency === void 0 ? "Workflow concurrency is not declared." : "Workflow concurrency does not enable cancel-in-progress.",
        remediation: "Use a stable review concurrency group and cancel superseded runs when safe.",
        verification: "Push two synthetic updates and confirm only the newest review remains active.",
        claimBoundary: "Static configuration check only; cancellation behavior is not observed."
      })
    );
  }
  const jobsWithoutTimeout = jobs.filter(
    (job) => typeof job.job["timeout-minutes"] !== "number"
  );
  if (jobs.length === 0 || jobsWithoutTimeout.length > 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-006",
        category: "RELIABILITY",
        evidenceStatus: jobs.length === 0 ? "UNKNOWN" : "OBSERVED",
        severity: "MEDIUM",
        confidence: jobs.length === 0 ? "LOW" : "HIGH",
        path: input.relativePath,
        line: jobsWithoutTimeout.length > 0 ? lineForYamlPath(parsed, ["jobs", jobsWithoutTimeout[0]?.jobName]) : lineForYamlPath(parsed, ["jobs"]),
        evidenceSummary: jobs.length === 0 ? "No analyzable jobs are declared in this workflow." : String(jobsWithoutTimeout.length) + " job(s) lack timeout-minutes.",
        remediation: "Set bounded job timeouts for review work.",
        verification: "Inspect a synthetic timeout run and confirm the job terminates within the declared bound.",
        claimBoundary: "Static configuration check only; runtime duration is not observed.",
        missingEvidence: jobs.length === 0 ? ["Declared review job"] : []
      })
    );
  }
  const broadCheckout = uses.some((entry) => {
    if (!/^actions\/checkout@/iu.test(entry.value)) {
      return false;
    }
    const job = jobs.find((candidate) => candidate.jobName === entry.jobName);
    const step = job?.steps.find((candidate) => candidate.index === entry.index)?.step;
    const withObject = objectValue(step?.with);
    return withObject === void 0 || withObject["fetch-depth"] === 0 || withObject["fetch-depth"] === "0";
  });
  if (broadCheckout || !hasPathFilters(workflow)) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-007",
        category: "COST",
        evidenceStatus: "INFERRED",
        severity: "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: broadCheckout ? firstMatchingLine(input.text, /actions\/checkout/iu) : lineForYamlPath(parsed, ["on"]),
        evidenceSummary: broadCheckout ? "Checkout appears to use full or implicit history." : "No workflow path filters are visible.",
        remediation: "Bound checkout history and reviewed paths only after validating review coverage.",
        verification: "Compare context receipts and accepted findings before and after narrowing scope.",
        claimBoundary: "Static heuristic only; savings and quality effects require run evidence.",
        missingEvidence: ["Context receipt", "Paired review telemetry"]
      })
    );
  }
  const interpolationPattern = /\$\{\{\s*github\.event\.(?:pull_request\.)?(?:title|body|head_ref|ref|comment\.body|issue\.title|issue\.body)/iu;
  const interpolationLine = firstMatchingLine(input.text, interpolationPattern);
  if (interpolationLine !== void 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-008",
        category: "SECURITY",
        evidenceStatus: "OBSERVED",
        severity: "HIGH",
        confidence: "HIGH",
        path: input.relativePath,
        line: interpolationLine,
        evidenceSummary: "An untrusted event field appears in workflow interpolation.",
        remediation: "Pass untrusted event data as inert input and avoid shell or prompt interpolation.",
        verification: "Use hostile synthetic event text and confirm it cannot alter commands or prompts.",
        claimBoundary: "Static interpolation indicator only; no command is executed."
      })
    );
  }
  const writebackPattern = /\b(?:gh\s+pr\s+comment|create(?:-or-update)?-comment|sticky-pull-request-comment|issues\.createComment|pulls\.createReview)\b/iu;
  const writebackLine = firstMatchingLine(input.text, writebackPattern);
  if (permissions.writes || writebackLine !== void 0) {
    findings.push(
      makeFinding({
        ruleId: "RO-WF-009",
        category: "NOISE",
        evidenceStatus: "INFERRED",
        severity: permissions.writes && writebackLine !== void 0 ? "MEDIUM" : "LOW",
        confidence: "MEDIUM",
        path: input.relativePath,
        line: writebackLine ?? lineForYamlPath(parsed, ["permissions"]),
        evidenceSummary: permissions.writes && writebackLine !== void 0 ? "Write-capable permissions and comment-like writeback indicators are both visible." : "Writeback capability or comment-like behavior is visible without a bounded publishing contract.",
        remediation: "Require evidence, deduplication, and a maximum comment budget before publishing.",
        verification: "Review synthetic duplicate and unverified findings against the publishing gate.",
        claimBoundary: "Static indicator only; actual publishing behavior requires run telemetry.",
        missingEvidence: ["Publishing gate telemetry"]
      })
    );
  }
  const summary = structuralInputSummary(input, {
    jobs: jobs.length,
    steps: jobs.reduce((total, job) => total + job.steps.length, 0),
    remoteActions: uses.filter((entry) => isRemoteAction(entry.value)).length,
    triggers: triggers.length,
    hasPathFilters: hasPathFilters(workflow),
    hasConcurrency: concurrency !== void 0
  });
  return {
    kind: "workflow",
    summary: {
      ...summary,
      jobs: jobs.length,
      steps: jobs.reduce((total, job) => total + job.steps.length, 0),
      remoteActions: uses.filter((entry) => isRemoteAction(entry.value)).length,
      triggers: triggers.length
    },
    findings: sortFindings(findings)
  };
}

// src/audit/index.mjs
function isLoadedTextInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "relativePath" in value && typeof value.relativePath === "string" && "text" in value && typeof value.text === "string";
}
function normalizeInputs(values) {
  if (values === void 0) {
    return [];
  }
  if (!Array.isArray(values) || !values.every((value) => isLoadedTextInput(value))) {
    fail("RO_AUDIT_INPUT_INVALID", "Audit inputs must be loaded bounded text files.");
  }
  return stableSort(
    values,
    (left, right) => left.relativePath.localeCompare(right.relativePath, "en")
  );
}
function auditLoadedInputs(inputs, options = {}) {
  const workflows = normalizeInputs(inputs.workflows);
  const prompts = normalizeInputs(inputs.prompts);
  const telemetry = normalizeInputs(inputs.telemetry);
  const workflowResults = workflows.map(
    (input) => auditWorkflow(input, { limits: options.limits })
  );
  const promptResults = prompts.map((input) => auditPrompt(input));
  const telemetryResult = auditTelemetryEvidence({
    telemetry,
    toolContracts: inputs.toolContracts,
    validatorResults: inputs.validatorResults
  });
  const findings = sortFindings([
    ...workflowResults.flatMap((result2) => result2.findings),
    ...promptResults.flatMap((result2) => result2.findings),
    ...telemetryResult.findings
  ]);
  const workflowSummaries = workflowResults.map((result2) => result2.summary);
  const promptSummaries = promptResults.map((result2) => result2.summary);
  const summaries = [
    ...workflowSummaries,
    ...promptSummaries,
    ...telemetryResult.summaries
  ];
  const warnings = [...telemetryResult.warnings];
  if (!options.optional && workflows.length === 0) {
    warnings.push("No declared workflow input was provided.");
  }
  if (!options.optional && prompts.length === 0) {
    warnings.push("No declared prompt input was provided.");
  }
  const hasTypedTelemetry = Array.isArray(inputs.toolContracts) && inputs.toolContracts.length > 0 || Array.isArray(inputs.validatorResults) && inputs.validatorResults.length > 0;
  return {
    status: workflows.length === 0 && prompts.length === 0 && telemetry.length === 0 && !hasTypedTelemetry ? "PARTIAL" : "COMPLETE",
    findings,
    inputs: {
      workflows: workflowSummaries,
      prompts: promptSummaries,
      telemetry: telemetryResult.summaries
    },
    inputDigests: summaries.map((summary) => summary.structuralDigest).sort((left, right) => left.localeCompare(right, "en")),
    redactionCount: summaries.reduce(
      (total, summary) => total + summary.redactionCount,
      0
    ),
    warnings,
    rules: [...WORKFLOW_RULES, ...PROMPT_RULES, ...TELEMETRY_RULES]
  };
}
function objectRecords(value) {
  return Array.isArray(value) ? value.filter(
    (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
  ) : [];
}
function bindingForFinding(finding, bindings) {
  const binding = objectRecords(bindings).find((candidate) => {
    return candidate.ruleId === finding.ruleId && candidate.path === finding.location.path && candidate.applicableToShadowPath === true && typeof candidate.laneId === "string" && typeof candidate.variantId === "string" && typeof candidate.architectureStructuralDigest === "string";
  });
  return binding ? {
    laneId: binding.laneId,
    variantId: binding.variantId,
    architectureStructuralDigest: binding.architectureStructuralDigest
  } : null;
}
function buildStaticDiagnostics(inputs, options = {}) {
  const core = auditLoadedInputs(inputs, { limits: options.limits, optional: true });
  const blockingRuleIds = new Set(
    Array.isArray(options.blockingStaticRuleIds) ? options.blockingStaticRuleIds.filter((value) => typeof value === "string") : []
  );
  const findings = core.findings.map((finding) => {
    const binding = bindingForFinding(finding, options.bindings);
    const applicableToShadowPath = binding !== null;
    const blocksShadowPath = applicableToShadowPath && blockingRuleIds.has(finding.ruleId) && finding.evidenceStatus === "OBSERVED" && finding.severity === "CRITICAL" && finding.confidence === "HIGH";
    return {
      ruleId: finding.ruleId,
      category: finding.category,
      severity: finding.severity,
      evidenceStatus: finding.evidenceStatus,
      confidence: finding.confidence,
      summary: finding.evidenceSummary,
      claimBoundary: finding.claimBoundary,
      possibleContributorOnly: !blocksShadowPath,
      binding,
      applicableToShadowPath,
      blocksShadowPath,
      path: finding.location.path,
      ...finding.location.line === void 0 ? {} : { line: finding.location.line }
    };
  });
  const observedCount = findings.filter(
    (finding) => finding.evidenceStatus === "OBSERVED"
  ).length;
  const inferredCount = findings.filter(
    (finding) => finding.evidenceStatus === "INFERRED"
  ).length;
  const unknownCount = findings.filter(
    (finding) => finding.evidenceStatus === "UNKNOWN"
  ).length;
  return {
    status: core.status,
    summary: {
      findingCount: findings.length,
      observedCount,
      inferredCount,
      unknownCount
    },
    findings,
    limitations: [
      "Static diagnostics are secondary context and do not establish benchmark causality.",
      ...findings.some((finding) => !finding.applicableToShadowPath) ? ["Unbound findings remain possible contributors only."] : [],
      ...core.warnings
    ]
  };
}

// src/benchmark/shared.mjs
var METRIC_STATUS = Object.freeze({
  AVAILABLE: "AVAILABLE",
  PARTIAL: "PARTIAL",
  UNAVAILABLE: "UNAVAILABLE"
});
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
function stableSort2(values, selector = (value) => value) {
  return [...values].sort(
    (left, right) => compareText(selector(left), selector(right))
  );
}
function uniqueSortedStrings(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return stableSort2([...new Set(values.filter((value) => isNonEmptyString(value)))]);
}
function issue(code, message, details = void 0) {
  const result2 = { code, message };
  if (details !== void 0) {
    result2.details = details;
  }
  return result2;
}
function roundNumber(value, digits = 12) {
  if (!isFiniteNumber(value)) {
    return value;
  }
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}
function sum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return roundNumber(total);
}
function mean(values) {
  return values.length === 0 ? void 0 : roundNumber(sum(values) / values.length);
}
function quantile(values, probability) {
  if (values.length === 0 || !isFiniteNumber(probability)) {
    return void 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) {
    return roundNumber(sorted[0]);
  }
  const bounded = Math.min(1, Math.max(0, probability));
  const position = (sorted.length - 1) * bounded;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return roundNumber(sorted[lowerIndex]);
  }
  const fraction = position - lowerIndex;
  return roundNumber(
    sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction
  );
}
function metricUnavailable(reasonCodes, extras = {}) {
  return {
    status: METRIC_STATUS.UNAVAILABLE,
    value: null,
    numerator: null,
    denominator: null,
    coverage: 0,
    reasonCodes: uniqueSortedStrings(reasonCodes),
    ...extras
  };
}
function metricValue({
  value,
  numerator = null,
  denominator = null,
  eligibleCount,
  totalCount,
  reasonCodes = [],
  ...extras
}) {
  if (!isFiniteNumber(value) || totalCount <= 0 || eligibleCount <= 0) {
    return metricUnavailable(
      reasonCodes.length > 0 ? reasonCodes : ["NO_ELIGIBLE_CASES"],
      extras
    );
  }
  const coverage2 = totalCount > 0 ? roundNumber(eligibleCount / totalCount) : 0;
  return {
    status: eligibleCount === totalCount && totalCount > 0 ? METRIC_STATUS.AVAILABLE : METRIC_STATUS.PARTIAL,
    value: roundNumber(value),
    numerator: isFiniteNumber(numerator) ? roundNumber(numerator) : numerator,
    denominator: isFiniteNumber(denominator) ? roundNumber(denominator) : denominator,
    coverage: coverage2,
    reasonCodes: uniqueSortedStrings(reasonCodes),
    ...extras
  };
}
function metricNumber(metric) {
  if (!isPlainObject2(metric)) {
    return void 0;
  }
  if (metric.status !== METRIC_STATUS.AVAILABLE && metric.status !== METRIC_STATUS.PARTIAL) {
    return void 0;
  }
  return isFiniteNumber(metric.value) ? metric.value : void 0;
}
function parseUtcTimestamp(value) {
  if (!isNonEmptyString(value) || !value.endsWith("Z")) {
    return void 0;
  }
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? epochMs : void 0;
}
function daysBetween(later, earlier) {
  const laterMs = parseUtcTimestamp(later);
  const earlierMs = parseUtcTimestamp(earlier);
  if (laterMs === void 0 || earlierMs === void 0) {
    return void 0;
  }
  return roundNumber((laterMs - earlierMs) / 864e5);
}

// src/benchmark/confidence.mjs
function seedToUint32(seed) {
  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function createRandom(seed) {
  let state = seedToUint32(seed);
  return () => {
    state = state + 1831565813 >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function unavailable(reasonCode, options) {
  return {
    status: "UNAVAILABLE",
    method: "PAIRED_BOOTSTRAP_PERCENTILE",
    estimate: null,
    lower: null,
    upper: null,
    sampleSize: 0,
    confidenceLevel: options.confidenceLevel ?? null,
    iterations: options.iterations ?? null,
    seed: options.seed ?? null,
    reasonCodes: [reasonCode]
  };
}
function pairedBootstrapInterval(values, options = {}) {
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const iterations = options.iterations ?? 1e4;
  const seed = options.seed ?? "reviewops-v1";
  if (!Array.isArray(values) || values.length === 0) {
    return unavailable("NO_PAIRED_VALUES", { confidenceLevel, iterations, seed });
  }
  if (values.some((value) => !isFiniteNumber(value)) || !isFiniteNumber(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1 || !isNonNegativeInteger(iterations) || iterations < 1 || iterations > 1e5) {
    return unavailable("INVALID_BOOTSTRAP_INPUT", {
      confidenceLevel,
      iterations,
      seed
    });
  }
  const statistic = typeof options.statistic === "function" ? options.statistic : mean;
  const estimate = statistic(values);
  if (!isFiniteNumber(estimate)) {
    return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
      confidenceLevel,
      iterations,
      seed
    });
  }
  const random = createRandom(seed);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = [];
    for (let index = 0; index < values.length; index += 1) {
      resample.push(values[Math.floor(random() * values.length)]);
    }
    const sample = statistic(resample);
    if (!isFiniteNumber(sample)) {
      return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
        confidenceLevel,
        iterations,
        seed
      });
    }
    samples.push(sample);
  }
  const alpha = 1 - confidenceLevel;
  return {
    status: "AVAILABLE",
    method: "PAIRED_BOOTSTRAP_PERCENTILE",
    estimate: roundNumber(estimate),
    lower: quantile(samples, alpha / 2),
    upper: quantile(samples, 1 - alpha / 2),
    sampleSize: values.length,
    confidenceLevel,
    iterations,
    seed: String(seed),
    reasonCodes: []
  };
}
function pairedBootstrapStatisticInterval(cases, statistic, options = {}) {
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const iterations = options.iterations ?? 1e4;
  const seed = options.seed ?? "reviewops-v1";
  if (!Array.isArray(cases) || cases.length === 0 || typeof statistic !== "function") {
    return unavailable("NO_PAIRED_VALUES", { confidenceLevel, iterations, seed });
  }
  if (!isFiniteNumber(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1 || !isNonNegativeInteger(iterations) || iterations < 1 || iterations > 1e5) {
    return unavailable("INVALID_BOOTSTRAP_INPUT", {
      confidenceLevel,
      iterations,
      seed
    });
  }
  const estimate = statistic(cases);
  if (!isFiniteNumber(estimate)) {
    return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
      confidenceLevel,
      iterations,
      seed
    });
  }
  const random = createRandom(seed);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = [];
    for (let index = 0; index < cases.length; index += 1) {
      resample.push(cases[Math.floor(random() * cases.length)]);
    }
    const sample = statistic(resample);
    if (!isFiniteNumber(sample)) {
      return unavailable("INVALID_BOOTSTRAP_STATISTIC", {
        confidenceLevel,
        iterations,
        seed
      });
    }
    samples.push(sample);
  }
  const alpha = 1 - confidenceLevel;
  return {
    status: "AVAILABLE",
    method: "PAIRED_BOOTSTRAP_PERCENTILE",
    estimate: roundNumber(estimate),
    lower: quantile(samples, alpha / 2),
    upper: quantile(samples, 1 - alpha / 2),
    sampleSize: cases.length,
    confidenceLevel,
    iterations,
    seed: String(seed),
    reasonCodes: []
  };
}

// src/benchmark/stability.mjs
function confirmedRootCauseSet(run) {
  const confirmed = /* @__PURE__ */ new Set();
  for (const label of run?.adjudication?.findingLabels ?? []) {
    if (label.outcome !== "ACCEPTED") {
      continue;
    }
    for (const rootCauseId of label.matchedRootCauseIds ?? []) {
      confirmed.add(rootCauseId);
    }
  }
  return confirmed;
}
function jaccard(left, right) {
  const union = /* @__PURE__ */ new Set([...left, ...right]);
  if (union.size === 0) {
    return null;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return roundNumber(intersection / union.size);
}
function calculateFindingStability(pairedCases, variantId) {
  const totalCount = Array.isArray(pairedCases) ? pairedCases.length : 0;
  const caseScores = [];
  const exclusions = [];
  let replicatePairCount = 0;
  let unavailablePairCount = 0;
  for (const pairedCase of pairedCases ?? []) {
    const runs = pairedCase?.runsByVariant?.[variantId] ?? [];
    if (!Array.isArray(runs) || runs.length < 2) {
      exclusions.push({
        caseId: pairedCase.caseId,
        reasonCodes: ["MISSING_REPLICATES"]
      });
      continue;
    }
    const scores = [];
    for (let left = 0; left < runs.length; left += 1) {
      for (let right = left + 1; right < runs.length; right += 1) {
        const score = jaccard(
          confirmedRootCauseSet(runs[left]),
          confirmedRootCauseSet(runs[right])
        );
        if (score === null) {
          unavailablePairCount += 1;
        } else {
          scores.push(score);
          replicatePairCount += 1;
        }
      }
    }
    if (scores.length > 0) {
      caseScores.push(mean(scores));
    } else {
      exclusions.push({
        caseId: pairedCase.caseId,
        reasonCodes: ["NO_STABILITY_PAIR_VALUES"]
      });
    }
  }
  const missingness = {
    count: exclusions.length,
    reasonCodes: uniqueSortedStrings(
      exclusions.flatMap((exclusion) => exclusion.reasonCodes)
    )
  };
  if (caseScores.length === 0) {
    return metricUnavailable(["INSUFFICIENT_REPLICATES"], {
      eligibleCount: 0,
      totalCount,
      replicatePairCount,
      unavailablePairCount,
      missingness,
      exclusions
    });
  }
  return metricValue({
    value: mean(caseScores),
    numerator: caseScores.reduce((total, score) => total + score, 0),
    denominator: caseScores.length,
    eligibleCount: caseScores.length,
    totalCount,
    reasonCodes: caseScores.length < totalCount ? ["MISSING_STABILITY_EVIDENCE"] : [],
    replicatePairCount,
    unavailablePairCount,
    missingness,
    exclusions
  });
}

// src/benchmark/metrics.mjs
var REQUIRED_COMPLETE_METRICS = Object.freeze([
  "costPerReviewedCase",
  "severityWeightedAcceptedRecall",
  "highCriticalPreservation",
  "falsePositiveRate",
  "hallucinationRate",
  "latencyP95"
]);
var RESOLVED_FINDING_OUTCOMES = /* @__PURE__ */ new Set(["ACCEPTED", "REJECTED"]);
function completeAdjudication(run) {
  if (!run.adjudication || run.adjudication.status !== "ADJUDICATED") {
    return false;
  }
  if (run.adjudication.findingLabels.length !== run.findings.length) {
    return false;
  }
  const labels = new Set(
    run.adjudication.findingLabels.map((label) => label.findingId)
  );
  return run.adjudication.findingLabels.every(
    (label) => RESOLVED_FINDING_OUTCOMES.has(label.outcome)
  ) && run.findings.every((finding) => labels.has(finding.findingId));
}
function labelsByFinding(run) {
  return new Map(
    (run.adjudication?.findingLabels ?? []).map((label) => [label.findingId, label])
  );
}
function caseStatistics(run, caseLabel, rubric) {
  const labelMap = labelsByFinding(run);
  const complete = completeAdjudication(run);
  const acceptedLabels = [...labelMap.values()].filter(
    (label) => label.outcome === "ACCEPTED"
  );
  const rejectedLabels = [...labelMap.values()].filter(
    (label) => label.outcome === "REJECTED"
  );
  const unknownLabels = [...labelMap.values()].filter(
    (label) => label.outcome === "UNKNOWN"
  );
  const findingsById = new Map(
    run.findings.map((finding) => [finding.findingId, finding])
  );
  const acceptedFindingIds = new Set(acceptedLabels.map((label) => label.findingId));
  const matchedGroundTruthIds = new Set(
    acceptedLabels.flatMap((label) => label.matchedGroundTruthIds)
  );
  const weightFor = (severity) => rubric?.severityWeights?.[severity];
  const groundTruth = caseLabel?.groundTruth ?? [];
  const weightsComplete = groundTruth.every(
    (item) => isFiniteNumber(weightFor(item.severity))
  );
  const totalGroundTruthWeight = weightsComplete ? sum(groundTruth.map((item) => weightFor(item.severity))) : null;
  const acceptedMatchedWeight = weightsComplete ? sum(
    groundTruth.filter((item) => matchedGroundTruthIds.has(item.groundTruthId)).map((item) => weightFor(item.severity))
  ) : null;
  const highCriticalGroundTruth = groundTruth.filter(
    (item) => item.severity === "HIGH" || item.severity === "CRITICAL"
  );
  const highCriticalMatched = highCriticalGroundTruth.filter(
    (item) => matchedGroundTruthIds.has(item.groundTruthId)
  );
  const verificationComplete = run.findings.every(
    (finding) => finding.verification !== null
  );
  const hallucinationIds = new Set(
    run.findings.filter((finding) => finding.verification === "UNVERIFIED").map((finding) => finding.findingId)
  );
  for (const label of rejectedLabels) {
    hallucinationIds.add(label.findingId);
  }
  const crossFileAcceptedCount = [...acceptedFindingIds].filter((findingId) => {
    const tags = findingsById.get(findingId)?.tags ?? [];
    return tags.includes("cross-file") || tags.includes("cross-system");
  }).length;
  return {
    caseId: run.caseId,
    cost: run.cost?.amount ?? null,
    currency: run.cost?.currency ?? null,
    costSource: run.cost?.source ?? null,
    latencyMs: run.latencyMs,
    findingCount: run.findings.length,
    completeAdjudication: complete,
    acceptedCount: acceptedLabels.length,
    rejectedCount: rejectedLabels.length,
    unknownCount: unknownLabels.length,
    acceptedFindingIds,
    totalGroundTruthWeight,
    acceptedMatchedWeight,
    groundTruthReady: Boolean(caseLabel) && Boolean(rubric?.matchingRules) && weightsComplete && complete,
    highCriticalTotal: highCriticalGroundTruth.length,
    highCriticalMatched: highCriticalMatched.length,
    hallucinationCount: hallucinationIds.size,
    hallucinationReady: complete || verificationComplete,
    crossFileAcceptedCount,
    rootCauseScore: isFiniteNumber(run.adjudication?.rootCauseScore) ? run.adjudication.rootCauseScore : null
  };
}
function availableMetric(values, totalCount, { numerator = null, denominator = null, reasonCodes = [], ...extras } = {}) {
  if (values.length === 0) {
    return metricUnavailable(
      reasonCodes.length > 0 ? reasonCodes : ["NO_ELIGIBLE_CASES"],
      extras
    );
  }
  const value = denominator !== null ? denominator === 0 ? void 0 : numerator / denominator : mean(values);
  if (!isFiniteNumber(value)) {
    return metricUnavailable(["ZERO_DENOMINATOR", ...reasonCodes], extras);
  }
  return metricValue({
    value,
    numerator,
    denominator,
    eligibleCount: values.length,
    totalCount,
    reasonCodes,
    ...extras
  });
}
function aggregateVariant(variantId, stats, totalCount) {
  const missingReasons = [];
  const costs = stats.filter((item) => isFiniteNumber(item.cost));
  if (costs.length < totalCount) {
    missingReasons.push("MISSING_COST");
  }
  const costValues = costs.map((item) => item.cost);
  const totalCost = costValues.length > 0 ? sum(costValues) : null;
  const currencySet = new Set(costs.map((item) => item.currency).filter(Boolean));
  const costPerReviewedCase = currencySet.size > 1 ? metricUnavailable(["MIXED_CURRENCY"]) : availableMetric(costValues, totalCount, {
    numerator: totalCost,
    denominator: costValues.length,
    reasonCodes: missingReasons,
    currency: [...currencySet][0] ?? null
  });
  const adjudicated = stats.filter((item) => item.completeAdjudication);
  const costAndAdjudicated = stats.filter(
    (item) => isFiniteNumber(item.cost) && item.completeAdjudication
  );
  const acceptedForCost = /* @__PURE__ */ new Set();
  for (const item of costAndAdjudicated) {
    for (const findingId of item.acceptedFindingIds) {
      acceptedForCost.add(`${item.caseId}\0${findingId}`);
    }
  }
  const acceptedCost = sum(costAndAdjudicated.map((item) => item.cost));
  const costPerAcceptedUniqueFinding = currencySet.size > 1 ? metricUnavailable(["MIXED_CURRENCY"]) : acceptedForCost.size === 0 ? metricUnavailable(["ZERO_DENOMINATOR"], {
    currency: [...currencySet][0] ?? null
  }) : metricValue({
    value: acceptedCost / acceptedForCost.size,
    numerator: acceptedCost,
    denominator: acceptedForCost.size,
    eligibleCount: costAndAdjudicated.length,
    totalCount,
    reasonCodes: costAndAdjudicated.length < totalCount ? ["MISSING_COST_OR_ADJUDICATION"] : [],
    currency: [...currencySet][0] ?? null
  });
  const recallStats = stats.filter((item) => item.groundTruthReady);
  const recallNumerator = sum(recallStats.map((item) => item.acceptedMatchedWeight));
  const recallDenominator = sum(recallStats.map((item) => item.totalGroundTruthWeight));
  const severityWeightedAcceptedRecall = availableMetric(recallStats, totalCount, {
    numerator: recallNumerator,
    denominator: recallDenominator,
    reasonCodes: recallStats.length < totalCount ? ["MISSING_QUALITY_EVIDENCE"] : []
  });
  const precisionNumerator = sum(adjudicated.map((item) => item.acceptedCount));
  const precisionDenominator = sum(
    adjudicated.map((item) => item.acceptedCount + item.rejectedCount)
  );
  const precision = availableMetric(adjudicated, totalCount, {
    numerator: precisionNumerator,
    denominator: precisionDenominator,
    reasonCodes: adjudicated.length < totalCount ? ["INCOMPLETE_ADJUDICATION"] : []
  });
  const falsePositiveRate = availableMetric(adjudicated, totalCount, {
    numerator: sum(adjudicated.map((item) => item.rejectedCount)),
    denominator: precisionDenominator,
    reasonCodes: adjudicated.length < totalCount ? ["INCOMPLETE_ADJUDICATION"] : []
  });
  const highCriticalStats = recallStats.filter((item) => item.highCriticalTotal > 0);
  const highCriticalPreservation = availableMetric(highCriticalStats, totalCount, {
    numerator: sum(highCriticalStats.map((item) => item.highCriticalMatched)),
    denominator: sum(highCriticalStats.map((item) => item.highCriticalTotal)),
    reasonCodes: highCriticalStats.length < totalCount ? ["MISSING_HIGH_CRITICAL_EVIDENCE"] : []
  });
  const hallucinationStats = stats.filter((item) => item.hallucinationReady);
  const hallucinationRate = availableMetric(hallucinationStats, totalCount, {
    numerator: sum(hallucinationStats.map((item) => item.hallucinationCount)),
    denominator: sum(hallucinationStats.map((item) => item.findingCount)),
    reasonCodes: hallucinationStats.length < totalCount ? ["MISSING_HALLUCINATION_EVIDENCE"] : []
  });
  const commentVolume = metricValue({
    value: sum(stats.map((item) => item.findingCount)) / totalCount,
    numerator: sum(stats.map((item) => item.findingCount)),
    denominator: totalCount,
    eligibleCount: stats.length,
    totalCount
  });
  const latencies = stats.map((item) => item.latencyMs).filter(isFiniteNumber);
  const latencyP50 = availableMetric(latencies, totalCount, {
    reasonCodes: latencies.length < totalCount ? ["MISSING_LATENCY"] : [],
    quantile: "p50"
  });
  if (latencyP50.status !== METRIC_STATUS.UNAVAILABLE) {
    latencyP50.value = quantile(latencies, 0.5);
    latencyP50.denominator = latencies.length;
  }
  const latencyP95 = availableMetric(latencies, totalCount, {
    reasonCodes: latencies.length < totalCount ? ["MISSING_LATENCY"] : [],
    quantile: "p95"
  });
  if (latencyP95.status !== METRIC_STATUS.UNAVAILABLE) {
    latencyP95.value = quantile(latencies, 0.95);
    latencyP95.denominator = latencies.length;
  }
  const rootCauseStats = stats.filter((item) => isFiniteNumber(item.rootCauseScore));
  const rootCauseQuality = availableMetric(
    rootCauseStats.map((item) => item.rootCauseScore),
    totalCount,
    {
      reasonCodes: rootCauseStats.length < totalCount ? ["MISSING_ROOT_CAUSE_SCORE"] : []
    }
  );
  const crossFileFindings = adjudicated.length === 0 ? metricUnavailable(["INCOMPLETE_ADJUDICATION"]) : metricValue({
    value: sum(adjudicated.map((item) => item.crossFileAcceptedCount)) / adjudicated.length,
    numerator: sum(adjudicated.map((item) => item.crossFileAcceptedCount)),
    denominator: adjudicated.length,
    eligibleCount: adjudicated.length,
    totalCount,
    reasonCodes: adjudicated.length < totalCount ? ["INCOMPLETE_ADJUDICATION"] : []
  });
  return {
    variantId,
    sampleSize: totalCount,
    costSources: uniqueSortedStrings(costs.map((item) => item.costSource)),
    metrics: {
      costPerReviewedCase,
      costPerAcceptedUniqueFinding,
      severityWeightedAcceptedRecall,
      precision,
      falsePositiveRate,
      highCriticalPreservation,
      hallucinationRate,
      commentVolume,
      latencyP50,
      latencyP95,
      rootCauseQuality,
      crossFileFindings
    },
    _caseStatistics: stats
  };
}
function perCaseValue(stat, metricName) {
  switch (metricName) {
    case "costPerReviewedCase":
      return stat.cost;
    case "severityWeightedAcceptedRecall":
      return stat.groundTruthReady && stat.totalGroundTruthWeight > 0 ? stat.acceptedMatchedWeight / stat.totalGroundTruthWeight : null;
    case "highCriticalPreservation":
      return stat.groundTruthReady && stat.highCriticalTotal > 0 ? stat.highCriticalMatched / stat.highCriticalTotal : null;
    case "falsePositiveRate": {
      const denominator = stat.acceptedCount + stat.rejectedCount;
      return stat.completeAdjudication && denominator > 0 ? stat.rejectedCount / denominator : null;
    }
    case "hallucinationRate":
      return stat.hallucinationReady && stat.findingCount > 0 ? stat.hallucinationCount / stat.findingCount : null;
    case "latencyMs":
      return stat.latencyMs;
    default:
      return null;
  }
}
function comparisonMetric(baseStats, candidateStats, metricName, options) {
  const deltas = [];
  for (let index = 0; index < baseStats.length; index += 1) {
    const baseline = perCaseValue(baseStats[index], metricName);
    const candidate = perCaseValue(candidateStats[index], metricName);
    if (isFiniteNumber(baseline) && isFiniteNumber(candidate)) {
      deltas.push(roundNumber(candidate - baseline));
    }
  }
  if (deltas.length === 0) {
    return {
      status: "UNAVAILABLE",
      delta: null,
      coverage: 0,
      pairedCaseCount: 0,
      interval: pairedBootstrapInterval([], options),
      reasonCodes: ["NO_PAIRED_METRIC_VALUES"]
    };
  }
  const total = baseStats.length;
  return {
    status: deltas.length === total ? "AVAILABLE" : "PARTIAL",
    delta: mean(deltas),
    coverage: roundNumber(deltas.length / total),
    pairedCaseCount: deltas.length,
    interval: pairedBootstrapInterval(deltas, options),
    reasonCodes: deltas.length === total ? [] : ["MISSING_PAIRED_METRIC_VALUES"]
  };
}
function calculateMetrics(normalized, pairing, options = {}) {
  if (!normalized || normalized.status === "BLOCKED" || !pairing || pairing.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      errors: [
        issue(
          "BENCHMARK_INPUT_BLOCKED",
          "Metrics require valid normalized and paired input."
        )
      ],
      warnings: [],
      variants: [],
      comparisons: []
    };
  }
  const totalCount = pairing.pairedCases.length;
  const statsByVariant = /* @__PURE__ */ new Map();
  const variants2 = pairing.variantIds.map((variantId) => {
    const stats = pairing.pairedCases.map(
      ({ caseId, runsByVariant }) => caseStatistics(
        runsByVariant[variantId],
        normalized.caseLabelsById.get(caseId),
        normalized.rubric
      )
    );
    const result2 = aggregateVariant(variantId, stats, totalCount);
    statsByVariant.set(variantId, stats);
    return result2;
  });
  const bootstrapOptions = {
    confidenceLevel: options.confidenceLevel ?? options.decisionPolicy?.confidenceLevel ?? 0.95,
    iterations: options.bootstrapIterations ?? options.decisionPolicy?.bootstrapIterations ?? 1e4,
    seed: options.bootstrapSeed ?? options.decisionPolicy?.bootstrapSeed ?? "reviewops-v1"
  };
  const comparisonNames = [
    "costPerReviewedCase",
    "severityWeightedAcceptedRecall",
    "highCriticalPreservation",
    "falsePositiveRate",
    "hallucinationRate",
    "latencyMs"
  ];
  const comparisons = pairing.comparisons.map((comparison) => {
    const baselineStats = statsByVariant.get(comparison.baselineVariantId) ?? [];
    const candidateStats = statsByVariant.get(comparison.candidateVariantId) ?? [];
    const metrics = {};
    for (const name of comparisonNames) {
      metrics[name] = comparisonMetric(
        baselineStats,
        candidateStats,
        name,
        bootstrapOptions
      );
    }
    return { ...comparison, metrics };
  });
  const cleanVariants = variants2.map(({ _caseStatistics, ...variant }) => variant);
  const warnings = [...normalized.warnings ?? [], ...pairing.warnings ?? []];
  const hasQuality = cleanVariants.every(
    (variant) => variant.metrics.severityWeightedAcceptedRecall.status !== METRIC_STATUS.UNAVAILABLE
  );
  const hasCompleteRequiredMetrics = cleanVariants.every(
    (variant) => REQUIRED_COMPLETE_METRICS.every(
      (metricName) => variant.metrics[metricName]?.status === METRIC_STATUS.AVAILABLE
    )
  );
  return {
    status: totalCount === 0 ? "INSUFFICIENT_EVIDENCE" : hasQuality ? warnings.length > 0 || pairing.status === "PARTIAL" || !hasCompleteRequiredMetrics ? "PARTIAL" : "COMPLETE" : "INSUFFICIENT_EVIDENCE",
    errors: [],
    warnings,
    pairedCaseCount: totalCount,
    variants: cleanVariants,
    comparisons,
    methodology: {
      quantile: "LINEAR_INTERPOLATION",
      confidence: "PAIRED_BOOTSTRAP_PERCENTILE",
      confidenceLevel: bootstrapOptions.confidenceLevel,
      bootstrapIterations: bootstrapOptions.iterations,
      bootstrapSeed: bootstrapOptions.seed
    }
  };
}
var LANE_REQUIRED_METRICS = Object.freeze([
  "highCriticalRootCauseRecall",
  "criticalMissRate",
  "actionablePrecision",
  "hallucinationRate",
  "fullyLoadedCostPerConfirmedHighCriticalRootCause",
  "rootCauseQuality",
  "humanReviewMinutesPerCase",
  "latencyP95"
]);
function completeLaneAdjudication(run) {
  const labels = run?.adjudication?.findingLabels;
  if (run?.adjudication?.status !== "ADJUDICATED" || !Array.isArray(labels)) {
    return false;
  }
  if (labels.length !== (run.findings?.length ?? 0)) {
    return false;
  }
  const ids = new Set(labels.map((label) => label.findingId));
  return ids.size === labels.length && labels.every((label) => RESOLVED_FINDING_OUTCOMES.has(label.outcome)) && (run.findings ?? []).every((finding) => ids.has(finding.findingId));
}
function meanComplete(values, expectedCount) {
  const finite = values.filter(isFiniteNumber);
  return finite.length === expectedCount ? mean(finite) : null;
}
function rootCauseMap(caseLabel) {
  return new Map(
    (caseLabel?.groundTruth ?? []).map((rootCause) => [
      rootCause.rootCauseId,
      rootCause
    ])
  );
}
function laneRunPrimitives(run, caseLabel) {
  const complete = completeLaneAdjudication(run);
  const labels = run?.adjudication?.findingLabels ?? [];
  const groundTruth = rootCauseMap(caseLabel);
  const confirmed = /* @__PURE__ */ new Set();
  const acceptedFindingIds = /* @__PURE__ */ new Set();
  const rejectedFindingIds = /* @__PURE__ */ new Set();
  for (const label of labels) {
    if (label.outcome === "ACCEPTED") {
      acceptedFindingIds.add(label.findingId);
      for (const rootCauseId of label.matchedRootCauseIds ?? []) {
        confirmed.add(rootCauseId);
      }
    }
    if (label.outcome === "REJECTED") {
      rejectedFindingIds.add(label.findingId);
    }
  }
  const highCritical = [...groundTruth.values()].filter(
    (rootCause) => ["HIGH", "CRITICAL"].includes(rootCause.severity)
  );
  const critical = [...groundTruth.values()].filter(
    (rootCause) => rootCause.severity === "CRITICAL"
  );
  const confirmedHighCritical = highCritical.filter(
    (rootCause) => confirmed.has(rootCause.rootCauseId)
  );
  const confirmedCritical = critical.filter(
    (rootCause) => confirmed.has(rootCause.rootCauseId)
  );
  const confirmedCrossSystem = [...confirmed].filter((rootCauseId) => {
    const tags = groundTruth.get(rootCauseId)?.tags ?? [];
    return tags.includes("cross-file") || tags.includes("cross-system");
  });
  const hallucinated = new Set(rejectedFindingIds);
  for (const finding of run?.findings ?? []) {
    if (finding.verification === "UNVERIFIED") {
      hallucinated.add(finding.findingId);
    }
  }
  const qualityByRoot = new Map(
    (run?.adjudication?.rootCauseAssessments ?? []).map((assessment) => [
      assessment.rootCauseId,
      assessment
    ])
  );
  const qualityScores = [...confirmed].map((rootCauseId) => qualityByRoot.get(rootCauseId)?.qualityScore).filter(isFiniteNumber);
  const fullCost = run?.cost?.costBasis === "FULLY_LOADED" && isFiniteNumber(run.cost.amountMicros) ? run.cost.amountMicros : null;
  const modelCost = isFiniteNumber(run?.cost?.components?.modelMicros) ? run.cost.components.modelMicros : null;
  return {
    complete,
    highCriticalConfirmed: complete ? confirmedHighCritical.length : null,
    highCriticalGroundTruth: caseLabel ? highCritical.length : null,
    criticalMisses: complete ? critical.length - confirmedCritical.length : null,
    criticalGroundTruth: caseLabel ? critical.length : null,
    acceptedFindings: complete ? acceptedFindingIds.size : null,
    adjudicatedFindings: complete ? acceptedFindingIds.size + rejectedFindingIds.size : null,
    crossSystemConfirmed: complete ? confirmedCrossSystem.length : null,
    acceptedSymptoms: complete ? acceptedFindingIds.size : null,
    confirmedRoots: complete ? confirmed.size : null,
    hallucinations: complete || (run?.findings ?? []).every((finding) => finding.verification !== null) ? hallucinated.size : null,
    eligibleFindings: complete || (run?.findings ?? []).every((finding) => finding.verification !== null) ? run.findings.length : null,
    humanReviewMinutes: isFiniteNumber(run?.humanReviewMinutes) ? run.humanReviewMinutes : null,
    fullCostMicros: fullCost,
    modelCostMicros: modelCost,
    rootCauseQualityNumerator: complete && qualityScores.length === confirmed.size ? sum(qualityScores) : null,
    rootCauseQualityDenominator: complete && qualityScores.length === confirmed.size ? confirmed.size : null,
    latencyMs: isFiniteNumber(run?.latencyMs) ? run.latencyMs : null,
    findingCount: run?.findings?.length ?? 0,
    tokenCount: run?.usage && isFiniteNumber(run.usage.inputTokens) && isFiniteNumber(run.usage.outputTokens) ? run.usage.inputTokens + run.usage.outputTokens : null
  };
}
function laneCasePrimitives(pairedCase, variantId, caseLabel) {
  const runs = pairedCase?.runsByVariant?.[variantId] ?? [];
  const runStats = runs.map((run) => laneRunPrimitives(run, caseLabel));
  const count = runStats.length;
  const fields = [
    "highCriticalConfirmed",
    "highCriticalGroundTruth",
    "criticalMisses",
    "criticalGroundTruth",
    "acceptedFindings",
    "adjudicatedFindings",
    "crossSystemConfirmed",
    "acceptedSymptoms",
    "confirmedRoots",
    "hallucinations",
    "eligibleFindings",
    "humanReviewMinutes",
    "fullCostMicros",
    "modelCostMicros",
    "rootCauseQualityNumerator",
    "rootCauseQualityDenominator",
    "latencyMs",
    "findingCount",
    "tokenCount"
  ];
  const result2 = {
    caseId: pairedCase.caseId,
    replicateCount: count
  };
  for (const field of fields) {
    result2[field] = meanComplete(
      runStats.map((stat) => stat[field]),
      count
    );
  }
  return result2;
}
function laneUnavailable(reasonCodes, totalCount, extras = {}) {
  return {
    ...metricUnavailable(reasonCodes, extras),
    eligibleCount: 0,
    totalCount
  };
}
function metricEvidence(cases, eligible, reasonCode) {
  const eligibleCaseIds = new Set(eligible.map((item) => item.caseId));
  const exclusions = cases.filter((item) => !eligibleCaseIds.has(item.caseId)).map((item) => ({ caseId: item.caseId, reasonCodes: [reasonCode] }));
  return {
    missingness: {
      count: exclusions.length,
      reasonCodes: exclusions.length === 0 ? [] : [reasonCode]
    },
    exclusions
  };
}
function ratioMetric(cases, numeratorField, denominatorField, totalCount, reasonCode) {
  const eligible = cases.filter(
    (item) => isFiniteNumber(item[numeratorField]) && isFiniteNumber(item[denominatorField])
  );
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, evidence);
  }
  const numerator = sum(eligible.map((item) => item[numeratorField]));
  const denominator = sum(eligible.map((item) => item[denominatorField]));
  if (denominator === 0) {
    return laneUnavailable(["ZERO_DENOMINATOR", reasonCode], totalCount, {
      ...evidence,
      numerator,
      denominator,
      eligibleCount: eligible.length
    });
  }
  return metricValue({
    value: numerator / denominator,
    numerator,
    denominator,
    eligibleCount: eligible.length,
    totalCount,
    reasonCodes: eligible.length < totalCount ? [reasonCode] : [],
    ...evidence
  });
}
function sumMetric(cases, field, totalCount, reasonCode) {
  const eligible = cases.filter((item) => isFiniteNumber(item[field]));
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, evidence);
  }
  const numerator = sum(eligible.map((item) => item[field]));
  return metricValue({
    value: numerator,
    numerator,
    denominator: eligible.length,
    eligibleCount: eligible.length,
    totalCount,
    reasonCodes: eligible.length < totalCount ? [reasonCode] : [],
    ...evidence
  });
}
function meanMetric(cases, field, totalCount, reasonCode) {
  const eligible = cases.filter((item) => isFiniteNumber(item[field]));
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, evidence);
  }
  const values = eligible.map((item) => item[field]);
  return metricValue({
    value: mean(values),
    numerator: sum(values),
    denominator: values.length,
    eligibleCount: values.length,
    totalCount,
    reasonCodes: values.length < totalCount ? [reasonCode] : [],
    ...evidence
  });
}
function quantileMetric(cases, field, probability, totalCount, reasonCode) {
  const eligible = cases.filter((item) => isFiniteNumber(item[field]));
  const evidence = metricEvidence(cases, eligible, reasonCode);
  if (eligible.length === 0) {
    return laneUnavailable([reasonCode], totalCount, {
      ...evidence,
      quantile: "p" + Math.round(probability * 100)
    });
  }
  const values = eligible.map((item) => item[field]);
  return metricValue({
    value: quantile(values, probability),
    numerator: null,
    denominator: values.length,
    eligibleCount: values.length,
    totalCount,
    reasonCodes: values.length < totalCount ? [reasonCode] : [],
    quantile: "p" + Math.round(probability * 100),
    ...evidence
  });
}
function laneVariantMetrics(variantId, cases, pairedCases) {
  const totalCount = cases.length;
  const highCriticalRootCauseRecall = ratioMetric(
    cases,
    "highCriticalConfirmed",
    "highCriticalGroundTruth",
    totalCount,
    "MISSING_HIGH_CRITICAL_ROOT_CAUSE_EVIDENCE"
  );
  const criticalMissRate = ratioMetric(
    cases,
    "criticalMisses",
    "criticalGroundTruth",
    totalCount,
    "MISSING_CRITICAL_ROOT_CAUSE_EVIDENCE"
  );
  const actionablePrecision = ratioMetric(
    cases,
    "acceptedFindings",
    "adjudicatedFindings",
    totalCount,
    "MISSING_ACTIONABLE_PRECISION_EVIDENCE"
  );
  const hallucinationRate = ratioMetric(
    cases,
    "hallucinations",
    "eligibleFindings",
    totalCount,
    "MISSING_HALLUCINATION_EVIDENCE"
  );
  const fullyLoadedCostPerConfirmedHighCriticalRootCause = ratioMetric(
    cases,
    "fullCostMicros",
    "highCriticalConfirmed",
    totalCount,
    "MISSING_FULLY_LOADED_COST_OR_HIGH_CRITICAL_ROOT_CAUSE"
  );
  const fullyLoadedCostPerConfirmedRootCause = ratioMetric(
    cases,
    "fullCostMicros",
    "confirmedRoots",
    totalCount,
    "MISSING_FULLY_LOADED_COST_OR_ROOT_CAUSE"
  );
  const humanReviewMinutesPerConfirmedRootCause = ratioMetric(
    cases,
    "humanReviewMinutes",
    "confirmedRoots",
    totalCount,
    "MISSING_HUMAN_REVIEW_OR_ROOT_CAUSE"
  );
  const rootCauseQuality = ratioMetric(
    cases,
    "rootCauseQualityNumerator",
    "rootCauseQualityDenominator",
    totalCount,
    "MISSING_ROOT_CAUSE_QUALITY"
  );
  const costPerReviewedCase = meanMetric(
    cases,
    "fullCostMicros",
    totalCount,
    "MISSING_FULLY_LOADED_COST"
  );
  const metrics = {
    highCriticalRootCauseRecall,
    criticalMissRate,
    actionablePrecision,
    crossSystemTruePositives: sumMetric(
      cases,
      "crossSystemConfirmed",
      totalCount,
      "MISSING_CROSS_SYSTEM_ROOT_CAUSE_EVIDENCE"
    ),
    symptomsPerRootCause: ratioMetric(
      cases,
      "acceptedSymptoms",
      "confirmedRoots",
      totalCount,
      "MISSING_ROOT_CAUSE_EVIDENCE"
    ),
    hallucinationRate,
    humanReviewMinutesPerCase: meanMetric(
      cases,
      "humanReviewMinutes",
      totalCount,
      "MISSING_HUMAN_REVIEW_EVIDENCE"
    ),
    humanReviewMinutesPerConfirmedRootCause,
    fullyLoadedCostPerConfirmedHighCriticalRootCause,
    fullyLoadedCostPerConfirmedRootCause,
    rootCauseQuality,
    findingStability: calculateFindingStability(pairedCases, variantId),
    latencyP50: quantileMetric(cases, "latencyMs", 0.5, totalCount, "MISSING_LATENCY"),
    latencyP95: quantileMetric(cases, "latencyMs", 0.95, totalCount, "MISSING_LATENCY"),
    latencyP99: quantileMetric(cases, "latencyMs", 0.99, totalCount, "MISSING_LATENCY"),
    costP50: quantileMetric(
      cases,
      "fullCostMicros",
      0.5,
      totalCount,
      "MISSING_FULLY_LOADED_COST"
    ),
    costP95: quantileMetric(
      cases,
      "fullCostMicros",
      0.95,
      totalCount,
      "MISSING_FULLY_LOADED_COST"
    ),
    costP99: quantileMetric(
      cases,
      "fullCostMicros",
      0.99,
      totalCount,
      "MISSING_FULLY_LOADED_COST"
    ),
    costPerReviewedCase,
    modelOnlyCostPerReviewedCase: meanMetric(
      cases,
      "modelCostMicros",
      totalCount,
      "MISSING_MODEL_COST"
    ),
    tokenUsagePerCase: meanMetric(
      cases,
      "tokenCount",
      totalCount,
      "MISSING_TOKEN_USAGE"
    ),
    rawFindingCount: meanMetric(
      cases,
      "findingCount",
      totalCount,
      "MISSING_FINDING_COUNT"
    )
  };
  metrics.highCriticalPreservation = highCriticalRootCauseRecall;
  metrics.precision = actionablePrecision;
  return {
    variantId,
    sampleSize: totalCount,
    metrics,
    _casePrimitives: cases
  };
}
function ratioValue(cases, side, numeratorField, denominatorField) {
  const eligible = cases.filter(
    (item) => isFiniteNumber(item[side]?.[numeratorField]) && isFiniteNumber(item[side]?.[denominatorField])
  );
  if (eligible.length === 0) {
    return null;
  }
  const numerator = sum(eligible.map((item) => item[side][numeratorField]));
  const denominator = sum(eligible.map((item) => item[side][denominatorField]));
  return denominator === 0 ? null : numerator / denominator;
}
function quantileValue(cases, side, field, probability) {
  const values = cases.map((item) => item[side]?.[field]).filter(isFiniteNumber);
  return values.length === cases.length ? quantile(values, probability) : null;
}
function meanValue(cases, side, field) {
  const values = cases.map((item) => item[side]?.[field]).filter(isFiniteNumber);
  return values.length === cases.length ? mean(values) : null;
}
var COMPARISON_DESCRIPTORS = Object.freeze({
  highCriticalRootCauseRecall: {
    kind: "ratio",
    numerator: "highCriticalConfirmed",
    denominator: "highCriticalGroundTruth"
  },
  criticalMissRate: {
    kind: "ratio",
    numerator: "criticalMisses",
    denominator: "criticalGroundTruth"
  },
  actionablePrecision: {
    kind: "ratio",
    numerator: "acceptedFindings",
    denominator: "adjudicatedFindings"
  },
  hallucinationRate: {
    kind: "ratio",
    numerator: "hallucinations",
    denominator: "eligibleFindings"
  },
  fullyLoadedCostPerConfirmedHighCriticalRootCause: {
    kind: "ratio",
    numerator: "fullCostMicros",
    denominator: "highCriticalConfirmed"
  },
  rootCauseQuality: {
    kind: "ratio",
    numerator: "rootCauseQualityNumerator",
    denominator: "rootCauseQualityDenominator"
  },
  humanReviewMinutesPerCase: { kind: "mean", field: "humanReviewMinutes" },
  costP95: { kind: "quantile", field: "fullCostMicros", probability: 0.95 },
  costP99: { kind: "quantile", field: "fullCostMicros", probability: 0.99 },
  latencyP95: { kind: "quantile", field: "latencyMs", probability: 0.95 },
  latencyP99: { kind: "quantile", field: "latencyMs", probability: 0.99 }
});
function descriptorValue(cases, side, descriptor) {
  if (descriptor.kind === "ratio") {
    return ratioValue(cases, side, descriptor.numerator, descriptor.denominator);
  }
  if (descriptor.kind === "quantile") {
    return quantileValue(cases, side, descriptor.field, descriptor.probability);
  }
  return meanValue(cases, side, descriptor.field);
}
function eligibleComparisonCases(baseCases, candidateCases, descriptor) {
  const pairs = [];
  const totalCount = Math.max(baseCases.length, candidateCases.length);
  for (let index = 0; index < totalCount; index += 1) {
    const pair = {
      caseId: baseCases[index]?.caseId ?? candidateCases[index]?.caseId,
      baseline: baseCases[index],
      candidate: candidateCases[index]
    };
    const eligible = descriptor.kind === "ratio" ? ["baseline", "candidate"].every(
      (side) => isFiniteNumber(pair[side]?.[descriptor.numerator]) && isFiniteNumber(pair[side]?.[descriptor.denominator])
    ) : isFiniteNumber(descriptorValue([pair], "baseline", descriptor)) && isFiniteNumber(descriptorValue([pair], "candidate", descriptor));
    if (eligible) {
      pairs.push(pair);
    }
  }
  return pairs;
}
function laneComparisonMetric(baseCases, candidateCases, descriptor, options) {
  const pairs = eligibleComparisonCases(baseCases, candidateCases, descriptor);
  const allCases = Array.from(
    { length: Math.max(baseCases.length, candidateCases.length) },
    (_, index) => ({
      caseId: baseCases[index]?.caseId ?? candidateCases[index]?.caseId
    })
  );
  const totalCount = allCases.length;
  const evidence = metricEvidence(allCases, pairs, "MISSING_PAIRED_METRIC_VALUES");
  if (pairs.length === 0) {
    return {
      status: "UNAVAILABLE",
      delta: null,
      coverage: 0,
      pairedCaseCount: 0,
      interval: pairedBootstrapStatisticInterval([], () => null, options),
      reasonCodes: ["NO_PAIRED_METRIC_VALUES"],
      eligibleCount: 0,
      totalCount,
      ...evidence
    };
  }
  const statistic = (sample) => {
    const baseline = descriptorValue(sample, "baseline", descriptor);
    const candidate = descriptorValue(sample, "candidate", descriptor);
    return isFiniteNumber(baseline) && isFiniteNumber(candidate) ? roundNumber(candidate - baseline) : null;
  };
  const delta = statistic(pairs);
  return {
    status: pairs.length === totalCount ? "AVAILABLE" : "PARTIAL",
    delta,
    coverage: roundNumber(pairs.length / totalCount),
    pairedCaseCount: pairs.length,
    interval: pairedBootstrapStatisticInterval(pairs, statistic, options),
    reasonCodes: pairs.length === totalCount ? [] : ["MISSING_PAIRED_METRIC_VALUES"],
    eligibleCount: pairs.length,
    totalCount,
    ...evidence
  };
}
function calculateLaneMetrics(normalized, pairing, options = {}) {
  if (!normalized || normalized.status === "BLOCKED" || !pairing || pairing.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      errors: [
        issue("BENCHMARK_INPUT_BLOCKED", "Lane metrics require safe paired input.")
      ],
      warnings: [],
      pairedCaseCount: 0,
      variants: [],
      comparisons: []
    };
  }
  const totalCount = pairing.pairedCases.length;
  const primitivesByVariant = /* @__PURE__ */ new Map();
  const variants2 = pairing.variantIds.map((variantId) => {
    const cases = pairing.pairedCases.map(
      (pairedCase) => laneCasePrimitives(
        pairedCase,
        variantId,
        normalized.caseLabelsById.get(pairedCase.caseId)
      )
    );
    primitivesByVariant.set(variantId, cases);
    return laneVariantMetrics(variantId, cases, pairing.pairedCases);
  });
  const bootstrapOptions = {
    confidenceLevel: options.confidenceLevel ?? options.decisionPolicy?.confidenceLevel ?? 0.95,
    iterations: options.bootstrapIterations ?? options.decisionPolicy?.bootstrapIterations ?? 1e4,
    seed: options.bootstrapSeed ?? options.decisionPolicy?.bootstrapSeed ?? "reviewops-v1"
  };
  const comparisons = pairing.comparisons.map((comparison) => {
    const baselineCases = primitivesByVariant.get(comparison.baselineVariantId) ?? [];
    const candidateCases = primitivesByVariant.get(comparison.candidateVariantId) ?? [];
    const metrics = {};
    for (const [metricName, descriptor] of Object.entries(COMPARISON_DESCRIPTORS)) {
      metrics[metricName] = laneComparisonMetric(
        baselineCases,
        candidateCases,
        descriptor,
        bootstrapOptions
      );
    }
    metrics.highCriticalPreservation = metrics.highCriticalRootCauseRecall;
    metrics.precision = metrics.actionablePrecision;
    return { ...comparison, metrics };
  });
  const cleanVariants = variants2.map(({ _casePrimitives, ...variant }) => variant);
  const complete = cleanVariants.every(
    (variant) => LANE_REQUIRED_METRICS.every(
      (metricName) => variant.metrics[metricName]?.status === METRIC_STATUS.AVAILABLE
    )
  );
  return {
    status: totalCount === 0 ? "INSUFFICIENT_EVIDENCE" : complete && pairing.status === "COMPLETE" ? "COMPLETE" : "PARTIAL",
    errors: [],
    warnings: pairing.warnings ?? [],
    pairedCaseCount: totalCount,
    variants: cleanVariants,
    comparisons,
    methodology: {
      quantile: "LINEAR_INTERPOLATION",
      confidence: "PAIRED_BOOTSTRAP_PERCENTILE",
      replicateAggregation: "CASE_PRIMITIVES",
      inferentialUnit: "CASE",
      confidenceLevel: bootstrapOptions.confidenceLevel,
      bootstrapIterations: bootstrapOptions.iterations,
      bootstrapSeed: bootstrapOptions.seed
    }
  };
}

// src/normalize/index.mjs
var OPAQUE_DIGEST_ID = /^sha256:[0-9a-f]{64}$/u;
var PUBLIC_ALIAS = /^[a-z][a-z0-9._-]{0,63}$/u;
var TOOL_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
var SEVERITIES = /* @__PURE__ */ new Set(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
var CATEGORIES = /* @__PURE__ */ new Set([
  "SECURITY",
  "RELIABILITY",
  "COST",
  "LATENCY",
  "QUALITY",
  "NOISE",
  "TELEMETRY"
]);
var OUTCOMES = /* @__PURE__ */ new Set(["ACCEPTED", "REJECTED", "UNKNOWN"]);
var VERIFICATIONS = /* @__PURE__ */ new Set(["VERIFIED", "UNVERIFIED", "UNKNOWN"]);
var ADJUDICATION_STATUSES = /* @__PURE__ */ new Set(["ADJUDICATED", "PARTIAL", "UNADJUDICATED"]);
var COST_BASES = /* @__PURE__ */ new Set(["FULLY_LOADED", "MODEL_ONLY"]);
var COST_SOURCES = /* @__PURE__ */ new Set(["SUPPLIED_TOTAL", "RECONSTRUCTED_COMPONENTS"]);
var LANE_TYPES = /* @__PURE__ */ new Set([
  "PORTABLE_CORE_MODEL",
  "HARNESS_ABLATION",
  "BEST_SYSTEM",
  "SHADOW_PILOT"
]);
var EXECUTION_MODES = /* @__PURE__ */ new Set(["OFFLINE_REPLAY", "SHADOW_NO_POSTING"]);
var FORBIDDEN_KEYS2 = /* @__PURE__ */ new Set([
  "apikey",
  "api_key",
  "authorization",
  "body",
  "command",
  "comment",
  "commentbody",
  "comment_body",
  "credential",
  "credentials",
  "diff",
  "email",
  "headers",
  "log",
  "logs",
  "patch",
  "password",
  "prompt",
  "prompttext",
  "prompt_text",
  "rawdiff",
  "raw_diff",
  "rawprompt",
  "raw_prompt",
  "secret",
  "token",
  "url"
]);
var RUN_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "caseId",
  "variantId",
  "architectureId",
  "architectureStructuralDigest",
  "runId",
  "replicateId",
  "contextDigest",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "reasoningClass",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId",
  "startedAt",
  "latencyMs",
  "usage",
  "cost",
  "humanReviewMinutes",
  "findings",
  "outputCounts",
  "adjudication"
]);
var FINDING_KEYS = /* @__PURE__ */ new Set([
  "findingId",
  "severity",
  "category",
  "verification",
  "tags"
]);
var ADJUDICATION_KEYS = /* @__PURE__ */ new Set([
  "status",
  "rubricId",
  "labelVersion",
  "findingLabels",
  "rootCauseAssessments"
]);
var FINDING_LABEL_KEYS = /* @__PURE__ */ new Set(["findingId", "outcome", "matchedRootCauseIds"]);
var ROOT_CAUSE_ASSESSMENT_KEYS = /* @__PURE__ */ new Set([
  "rootCauseId",
  "qualityScore",
  "qualityRubricId"
]);
var CASE_LABEL_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "caseId",
  "rubricId",
  "labelVersion",
  "riskSliceIds",
  "groundTruth",
  "provenance"
]);
var GROUND_TRUTH_KEYS = /* @__PURE__ */ new Set(["rootCauseId", "severity", "tags"]);
var CANDIDATE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "variantId",
  "architectureId",
  "architectureStructuralDigest",
  "modelAlias",
  "reasoningClass",
  "promptStructuralDigest",
  "configStructuralDigest",
  "contextClass",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId"
]);
var COST_KEYS = /* @__PURE__ */ new Set([
  "currency",
  "amountMicros",
  "costBasis",
  "costSource",
  "pricingSnapshotId",
  "components"
]);
var COST_COMPONENT_KEYS = /* @__PURE__ */ new Set([
  "modelMicros",
  "toolingMicros",
  "humanReviewMicros"
]);
var USAGE_KEYS = /* @__PURE__ */ new Set(["inputTokens", "outputTokens", "cachedInputTokens"]);
var OUTPUT_COUNT_KEYS = /* @__PURE__ */ new Set(["proposedFindings", "publishedComments"]);
var EXPORT_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "exportId",
  "exporterVersion",
  "runRecord",
  "provenance"
]);
var PRICING_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "snapshotId",
  "currency",
  "effectiveAt",
  "costBasis",
  "provenance",
  "rates"
]);
var PRICING_RATE_KEYS = /* @__PURE__ */ new Set([
  "variantId",
  "inputMicrosPerMillion",
  "cachedInputMicrosPerMillion",
  "outputMicrosPerMillion",
  "toolingMicrosPerRun",
  "humanReviewMicrosPerMinute"
]);
var MANIFEST_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "corpusId",
  "exporterVersion",
  "exportedAt",
  "caseIds",
  "variantIds",
  "rubricId",
  "labelVersion",
  "pricingSnapshotId",
  "redactionPolicyVersion",
  "lane",
  "sliceTaxonomy",
  "productionBaselineContracts",
  "structuralReceipts"
]);
var LANE_KEYS = /* @__PURE__ */ new Set([
  "laneId",
  "laneType",
  "baselineVariantId",
  "cohortSelectionDigest",
  "cohortWindowId",
  "allowedDifferenceAxes",
  "executionMode"
]);
var SLICE_TAXONOMY_KEYS = /* @__PURE__ */ new Set(["taxonomyId", "version", "sliceIds"]);
var BASELINE_CONTRACT_KEYS = /* @__PURE__ */ new Set([
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId"
]);
var PROVENANCE_KEYS = /* @__PURE__ */ new Set(["kind", "sourceLabel", "exporterVersion"]);
var EVAL_PROTOCOL_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "protocolId",
  "protocolVersion",
  "laneId",
  "intendedClaim",
  "samplingFrame",
  "cohortSelectionDigest",
  "cohortWindowId",
  "inclusionPolicyId",
  "exclusionPolicyId",
  "assignmentMethod",
  "pairingMethod",
  "replicateAggregation",
  "missingReplicatePolicy",
  "leakageControls",
  "knownContamination",
  "heldConstantFields",
  "preservationContracts",
  "expectedExecutionMode",
  "provenance",
  "predeclaredExclusions"
]);
var LEAKAGE_CONTROL_KEYS = /* @__PURE__ */ new Set(["controlId", "status", "evidenceStatus"]);
var PRESERVATION_CONTRACT_KEYS = /* @__PURE__ */ new Set([
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "toolContractId",
  "contextClass",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId"
]);
var ADJUDICATION_PROTOCOL_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "protocolId",
  "protocolVersion",
  "laneId",
  "rubricId",
  "labelVersion",
  "variantIdentity",
  "presentationOrder",
  "highCriticalReview",
  "adjudicatorIndependence",
  "disagreement",
  "provenance"
]);
var ADJUDICATOR_INDEPENDENCE_KEYS = /* @__PURE__ */ new Set([
  "status",
  "evidenceStatus",
  "provenanceId"
]);
var DISAGREEMENT_KEYS = /* @__PURE__ */ new Set(["policyId", "status", "count"]);
var PREDECLARED_EXCLUSION_KEYS = /* @__PURE__ */ new Set(["caseId", "symmetric", "provenanceDigest"]);
var DIFFERENCE_AXES = /* @__PURE__ */ new Set([
  "modelAlias",
  "reasoningClass",
  "promptStructuralDigest",
  "configStructuralDigest",
  "contextClass",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId"
]);
var REQUIRED_RECEIPT_KINDS = /* @__PURE__ */ new Set([
  "MANIFEST",
  "EVAL_PROTOCOL",
  "ADJUDICATION_PROTOCOL",
  "CANDIDATES",
  "RUBRIC",
  "PRICING",
  "CASE_LABELS"
]);
var SOURCE_RECEIPT_KINDS = /* @__PURE__ */ new Set(["EXPORT", "CANONICAL_RUNS"]);
var RECEIPT_KINDS = /* @__PURE__ */ new Set([...REQUIRED_RECEIPT_KINDS, ...SOURCE_RECEIPT_KINDS]);
var MAX_REPLICATES_PER_CASE_VARIANT = 32;
function isOpaqueDigestId(value) {
  return typeof value === "string" && OPAQUE_DIGEST_ID.test(value);
}
function isPublicAlias(value) {
  return typeof value === "string" && PUBLIC_ALIAS.test(value);
}
function normalizedEnum(value) {
  return typeof value === "string" ? value.toUpperCase() : null;
}
function normalizedTimestamp(value) {
  const epoch = parseUtcTimestamp(value);
  return epoch === void 0 ? null : new Date(epoch).toISOString();
}
function rejectUnknownKeys(value, allowed, code, errors) {
  if (!isPlainObject2(value)) {
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length === 0) {
    return true;
  }
  errors.push(
    issue(code, "Input includes fields outside the source-neutral contract.", {
      fields: unknown.sort(compareText)
    })
  );
  return false;
}
function forbiddenPaths(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap(
      (item, index) => forbiddenPaths(item, [...path, String(index)])
    );
  }
  if (!isPlainObject2(value)) {
    return [];
  }
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll("-", "").toLowerCase();
    if (FORBIDDEN_KEYS2.has(normalized)) {
      paths.push([...path, key].join("."));
    } else {
      paths.push(...forbiddenPaths(child, [...path, key]));
    }
  }
  return paths;
}
function requiredOpaqueId(value, code, errors) {
  if (!isOpaqueDigestId(value)) {
    errors.push(issue(code, "Expected a sha256 opaque digest identifier."));
    return null;
  }
  return value;
}
function requiredAlias(value, code, errors) {
  if (!isPublicAlias(value)) {
    errors.push(issue(code, "Expected a lower-case public alias."));
    return null;
  }
  return value;
}
function requiredToolVersion(value, code, errors) {
  if (typeof value !== "string" || !TOOL_VERSION.test(value)) {
    errors.push(issue(code, "Expected a semantic exporter version."));
    return null;
  }
  return value;
}
function normalizeStringArray(value, code, errors) {
  if (!Array.isArray(value) || value.some((item) => !isPublicAlias(item))) {
    errors.push(issue(code, "Expected unique lower-case public aliases."));
    return null;
  }
  const result2 = uniqueSortedStrings(value);
  if (result2.length !== value.length) {
    errors.push(issue(code, "Expected unique lower-case public aliases."));
    return null;
  }
  return result2;
}
function normalizeDifferenceAxes(value, errors) {
  if (!Array.isArray(value) || value.some((item) => !DIFFERENCE_AXES.has(item)) || new Set(value).size !== value.length) {
    errors.push(
      issue("INVALID_DIFFERENCE_AXES", "Difference axes must be known unique fields.")
    );
    return null;
  }
  return [...value].sort(compareText);
}
function normalizeStructuralReceipts(value, errors) {
  if (!Array.isArray(value)) {
    errors.push(
      issue("INVALID_STRUCTURAL_RECEIPTS", "Manifest receipts must be an array.")
    );
    return [];
  }
  const receipts = [];
  for (const receipt of value) {
    if (!isPlainObject2(receipt) || !isNonEmptyString(receipt.kind) || !RECEIPT_KINDS.has(receipt.kind) || !isOpaqueDigestId(receipt.digest)) {
      errors.push(
        issue("INVALID_STRUCTURAL_RECEIPT", "A structural receipt is malformed.")
      );
      continue;
    }
    receipts.push({ kind: receipt.kind, digest: receipt.digest });
  }
  const kinds = receipts.map((receipt) => receipt.kind);
  const missing = [...REQUIRED_RECEIPT_KINDS].filter((kind) => !kinds.includes(kind));
  const sourceCount = kinds.filter((kind) => SOURCE_RECEIPT_KINDS.has(kind)).length;
  if (missing.length > 0 || sourceCount !== 1 || new Set(kinds).size !== kinds.length) {
    errors.push(
      issue(
        "INVALID_STRUCTURAL_RECEIPTS",
        "Manifest receipts must include each required artifact exactly once.",
        { missingKinds: missing.sort(compareText) }
      )
    );
  }
  return stableSort2(receipts, (receipt) => receipt.kind);
}
function computeStructuralReceipts(input) {
  if (!isPlainObject2(input)) {
    return [];
  }
  try {
    if (forbiddenPaths(input).length > 0) {
      return [];
    }
    const manifestValue = input.manifest ?? input.benchmarkManifest;
    const manifest = isPlainObject2(manifestValue) ? Object.fromEntries(
      Object.entries(manifestValue).filter(([key]) => key !== "structuralReceipts")
    ) : void 0;
    const sourceField = [
      "exports",
      "exportRecords",
      "canonicalRunRecords",
      "runs",
      "records"
    ].find((field) => Array.isArray(input[field]));
    const sourceKind = sourceField === "exports" || sourceField === "exportRecords" ? "EXPORT" : "CANONICAL_RUNS";
    const projections = [
      { kind: sourceKind, artifact: sourceField ? input[sourceField] : void 0 },
      { kind: "MANIFEST", artifact: manifest },
      { kind: "EVAL_PROTOCOL", artifact: input.evalProtocol },
      {
        kind: "ADJUDICATION_PROTOCOL",
        artifact: input.adjudicationProtocol
      },
      {
        kind: "CANDIDATES",
        artifact: input.candidateConfigs ?? input.candidates
      },
      { kind: "RUBRIC", artifact: input.rubric },
      { kind: "PRICING", artifact: input.pricingSnapshot },
      { kind: "CASE_LABELS", artifact: input.caseLabels }
    ].filter(({ artifact }) => artifact !== void 0 && artifact !== null);
    return stableSort2(
      projections.map(({ kind, artifact: value }) => ({
        kind,
        digest: structuralDigest({
          receiptVersion: 1,
          kind,
          artifact: value
        })
      })),
      (receipt) => receipt.kind
    );
  } catch {
    return [];
  }
}
function verifyStructuralReceipts(input, manifest, errors) {
  if (!manifest || !Array.isArray(manifest.structuralReceipts)) {
    return;
  }
  const declared = new Map(
    manifest.structuralReceipts.map((receipt) => [receipt.kind, receipt.digest])
  );
  const expectedReceipts = computeStructuralReceipts(input);
  const expectedKinds = new Set(expectedReceipts.map((receipt) => receipt.kind));
  for (const expected of expectedReceipts) {
    if (declared.get(expected.kind) !== expected.digest) {
      errors.push(
        issue(
          "RO_RECEIPT_MISMATCH",
          "Structural receipt does not match the loaded artifact.",
          { kind: expected.kind }
        )
      );
    }
  }
  for (const kind of declared.keys()) {
    if (!expectedKinds.has(kind)) {
      errors.push(
        issue(
          "RO_RECEIPT_MISMATCH",
          "Structural receipt does not match the loaded artifact.",
          { kind }
        )
      );
    }
  }
}
function normalizeTags(value, code, errors) {
  if (value === void 0) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => !isPublicAlias(item))) {
    errors.push(issue(code, "Tags must be lower-case public aliases."));
    return [];
  }
  const result2 = uniqueSortedStrings(value);
  if (result2.length !== value.length) {
    errors.push(issue(code, "Tags must be unique."));
  }
  return result2;
}
function normalizeProvenance(value) {
  if (!isPlainObject2(value) || Object.keys(value).some((key) => !PROVENANCE_KEYS.has(key))) {
    return null;
  }
  const kind = typeof value.kind === "string" && ["USER_SUPPLIED", "PRIVATE_EXPORT", "SYNTHETIC_FIXTURE"].includes(value.kind) ? value.kind : null;
  const sourceLabel = isPublicAlias(value.sourceLabel) ? value.sourceLabel : null;
  const exporterVersion = typeof value.exporterVersion === "string" && TOOL_VERSION.test(value.exporterVersion) ? value.exporterVersion : null;
  if (!kind || !sourceLabel || value.exporterVersion !== void 0 && !exporterVersion) {
    return null;
  }
  return {
    kind,
    sourceLabel,
    ...exporterVersion ? { exporterVersion } : {}
  };
}
function normalizeProtocolProvenance(value, code, errors) {
  const provenance = normalizeProvenance(value);
  if (!provenance) {
    errors.push(issue(code, "Protocol provenance is missing or malformed."));
  }
  return provenance;
}
function normalizeAliasObject(value, keys, unknownCode, invalidCode, errors) {
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, keys, unknownCode, errors)) {
    errors.push(issue(invalidCode, "Protocol contract fields are malformed."));
    return null;
  }
  const result2 = {};
  for (const field of keys) {
    const normalized = requiredAlias(value[field], invalidCode, errors);
    if (!normalized) {
      return null;
    }
    result2[field] = normalized;
  }
  return result2;
}
function normalizeLeakageControls(value, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    errors.push(
      issue(
        "INVALID_LEAKAGE_CONTROLS",
        "Leakage controls must contain one to 32 declarations."
      )
    );
    return null;
  }
  const controls = [];
  for (const control of value) {
    if (!isPlainObject2(control) || !rejectUnknownKeys(
      control,
      LEAKAGE_CONTROL_KEYS,
      "UNKNOWN_LEAKAGE_CONTROL_FIELD",
      errors
    ) || !isPublicAlias(control.controlId) || typeof control.status !== "string" || !["DECLARED", "FAILED", "UNKNOWN"].includes(control.status) || typeof control.evidenceStatus !== "string" || !["DECLARED", "UNKNOWN"].includes(control.evidenceStatus)) {
      errors.push(
        issue("INVALID_LEAKAGE_CONTROL", "A leakage-control declaration is malformed.")
      );
      continue;
    }
    controls.push({
      controlId: control.controlId,
      status: control.status,
      evidenceStatus: control.evidenceStatus
    });
  }
  return controls.length === value.length ? controls : null;
}
function normalizePredeclaredExclusions(value, errors) {
  if (value === void 0) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 1e4) {
    errors.push(
      issue(
        "INVALID_PREDECLARED_EXCLUSIONS",
        "Predeclared exclusions must be a bounded array."
      )
    );
    return null;
  }
  const exclusions = [];
  const caseIds = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isPlainObject2(entry) || !rejectUnknownKeys(
      entry,
      PREDECLARED_EXCLUSION_KEYS,
      "UNKNOWN_PREDECLARED_EXCLUSION_FIELD",
      errors
    ) || !isOpaqueDigestId(entry.caseId) || entry.symmetric !== true || !isOpaqueDigestId(entry.provenanceDigest)) {
      errors.push(
        issue(
          "INVALID_PREDECLARED_EXCLUSION",
          "A predeclared symmetric exclusion is malformed."
        )
      );
      continue;
    }
    if (caseIds.has(entry.caseId)) {
      errors.push(
        issue(
          "DUPLICATE_PREDECLARED_EXCLUSION",
          "A case may be predeclared for exclusion only once."
        )
      );
      continue;
    }
    caseIds.add(entry.caseId);
    exclusions.push({
      caseId: entry.caseId,
      symmetric: true,
      provenanceDigest: entry.provenanceDigest
    });
  }
  return exclusions.length === value.length ? stableSort2(exclusions, (entry) => entry.caseId) : null;
}
function normalizeEvalProtocol(value, errors) {
  const localErrors = [];
  if (value === void 0 || value === null) {
    errors.push(
      issue("MISSING_EVAL_PROTOCOL", "Lane bundle requires an eval protocol.")
    );
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(
    value,
    EVAL_PROTOCOL_KEYS,
    "UNKNOWN_EVAL_PROTOCOL_FIELD",
    localErrors
  )) {
    localErrors.push(issue("INVALID_EVAL_PROTOCOL", "Eval protocol is malformed."));
    errors.push(...localErrors);
    return null;
  }
  if (value.schemaVersion !== 1) {
    localErrors.push(
      issue(
        "UNSUPPORTED_EVAL_PROTOCOL_SCHEMA",
        "Eval protocol schemaVersion must be 1."
      )
    );
  }
  const protocolId = requiredAlias(
    value.protocolId,
    "INVALID_EVAL_PROTOCOL_ID",
    localErrors
  );
  const protocolVersion = requiredAlias(
    value.protocolVersion,
    "INVALID_EVAL_PROTOCOL_VERSION",
    localErrors
  );
  const laneId2 = requiredAlias(value.laneId, "INVALID_EVAL_PROTOCOL_LANE", localErrors);
  const samplingFrame = requiredAlias(
    value.samplingFrame,
    "INVALID_SAMPLING_FRAME",
    localErrors
  );
  const cohortSelectionDigest = requiredOpaqueId(
    value.cohortSelectionDigest,
    "INVALID_EVAL_COHORT_SELECTION_DIGEST",
    localErrors
  );
  const cohortWindowId = requiredOpaqueId(
    value.cohortWindowId,
    "INVALID_EVAL_COHORT_WINDOW_ID",
    localErrors
  );
  const inclusionPolicyId = requiredAlias(
    value.inclusionPolicyId,
    "INVALID_INCLUSION_POLICY_ID",
    localErrors
  );
  const exclusionPolicyId = requiredAlias(
    value.exclusionPolicyId,
    "INVALID_EXCLUSION_POLICY_ID",
    localErrors
  );
  const intendedClaim = typeof value.intendedClaim === "string" && ["MODEL_ONLY", "ONE_FACTOR", "HOLISTIC_SYSTEM", "SHADOW_NO_POSTING"].includes(
    value.intendedClaim
  ) ? value.intendedClaim : null;
  const assignmentMethod = typeof value.assignmentMethod === "string" && ["PAIRED_SAME_CASE", "RANDOMIZED_BLOCKED", "UNKNOWN"].includes(
    value.assignmentMethod
  ) ? value.assignmentMethod : null;
  const pairingMethod = typeof value.pairingMethod === "string" && ["CASE_VARIANT", "CASE_VARIANT_REPLICATE", "UNKNOWN"].includes(value.pairingMethod) ? value.pairingMethod : null;
  const missingReplicatePolicy = typeof value.missingReplicatePolicy === "string" && ["BLOCK", "SYMMETRIC_EXCLUDE_CASE"].includes(value.missingReplicatePolicy) ? value.missingReplicatePolicy : null;
  const knownContamination = typeof value.knownContamination === "string" && ["NONE_DECLARED", "PRESENT", "UNKNOWN"].includes(value.knownContamination) ? value.knownContamination : null;
  const expectedExecutionMode = typeof value.expectedExecutionMode === "string" && EXECUTION_MODES.has(value.expectedExecutionMode) ? value.expectedExecutionMode : null;
  if (!intendedClaim) {
    localErrors.push(
      issue("INVALID_INTENDED_CLAIM", "Eval intended claim is invalid.")
    );
  }
  if (!assignmentMethod) {
    localErrors.push(
      issue("INVALID_ASSIGNMENT_METHOD", "Assignment method is invalid.")
    );
  }
  if (!pairingMethod) {
    localErrors.push(issue("INVALID_PAIRING_METHOD", "Pairing method is invalid."));
  }
  if (value.replicateAggregation !== "CASE_PRIMITIVES") {
    localErrors.push(
      issue("INVALID_REPLICATE_AGGREGATION", "Replicates must use case primitives.")
    );
  }
  if (!missingReplicatePolicy) {
    localErrors.push(
      issue("INVALID_MISSING_REPLICATE_POLICY", "Missing-replicate policy is invalid.")
    );
  }
  if (!knownContamination) {
    localErrors.push(
      issue("INVALID_KNOWN_CONTAMINATION", "Known-contamination status is invalid.")
    );
  }
  if (!expectedExecutionMode) {
    localErrors.push(
      issue("INVALID_EXPECTED_EXECUTION_MODE", "Expected execution mode is invalid.")
    );
  }
  const leakageControls = normalizeLeakageControls(value.leakageControls, localErrors);
  const heldConstantFields = normalizeDifferenceAxes(
    value.heldConstantFields,
    localErrors
  );
  if (Array.isArray(value.heldConstantFields) && value.heldConstantFields.length > 32) {
    localErrors.push(
      issue(
        "INVALID_HELD_CONSTANT_FIELDS",
        "Held constants exceed the 32-field ceiling."
      )
    );
  }
  const preservationContracts = normalizeAliasObject(
    value.preservationContracts,
    PRESERVATION_CONTRACT_KEYS,
    "UNKNOWN_PRESERVATION_CONTRACT_FIELD",
    "INVALID_PRESERVATION_CONTRACTS",
    localErrors
  );
  const provenance = normalizeProtocolProvenance(
    value.provenance,
    "INVALID_EVAL_PROTOCOL_PROVENANCE",
    localErrors
  );
  const predeclaredExclusions = normalizePredeclaredExclusions(
    value.predeclaredExclusions,
    localErrors
  );
  if (Array.isArray(predeclaredExclusions) && predeclaredExclusions.length > 0 && missingReplicatePolicy !== "SYMMETRIC_EXCLUDE_CASE") {
    localErrors.push(
      issue(
        "PREDECLARED_EXCLUSION_POLICY_MISMATCH",
        "Predeclared exclusions require the symmetric missing-replicate policy."
      )
    );
  }
  errors.push(...localErrors);
  if (localErrors.length > 0 || !protocolId || !protocolVersion || !laneId2 || !samplingFrame || !cohortSelectionDigest || !cohortWindowId || !inclusionPolicyId || !exclusionPolicyId || !intendedClaim || !assignmentMethod || !pairingMethod || !missingReplicatePolicy || !knownContamination || !expectedExecutionMode || !leakageControls || !heldConstantFields || !preservationContracts || !provenance || !predeclaredExclusions) {
    return null;
  }
  return {
    schemaVersion: 1,
    protocolId,
    protocolVersion,
    laneId: laneId2,
    intendedClaim,
    samplingFrame,
    cohortSelectionDigest,
    cohortWindowId,
    inclusionPolicyId,
    exclusionPolicyId,
    assignmentMethod,
    pairingMethod,
    replicateAggregation: "CASE_PRIMITIVES",
    missingReplicatePolicy,
    leakageControls,
    knownContamination,
    heldConstantFields,
    preservationContracts,
    expectedExecutionMode,
    provenance,
    ...predeclaredExclusions.length > 0 ? { predeclaredExclusions } : {}
  };
}
function normalizeAdjudicationProtocol(value, errors) {
  const localErrors = [];
  if (value === void 0 || value === null) {
    errors.push(
      issue(
        "MISSING_ADJUDICATION_PROTOCOL",
        "Lane bundle requires an adjudication protocol."
      )
    );
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(
    value,
    ADJUDICATION_PROTOCOL_KEYS,
    "UNKNOWN_ADJUDICATION_PROTOCOL_FIELD",
    localErrors
  )) {
    localErrors.push(
      issue("INVALID_ADJUDICATION_PROTOCOL", "Adjudication protocol is malformed.")
    );
    errors.push(...localErrors);
    return null;
  }
  if (value.schemaVersion !== 1) {
    localErrors.push(
      issue(
        "UNSUPPORTED_ADJUDICATION_PROTOCOL_SCHEMA",
        "Adjudication protocol schemaVersion must be 1."
      )
    );
  }
  const protocolId = requiredAlias(
    value.protocolId,
    "INVALID_ADJUDICATION_PROTOCOL_ID",
    localErrors
  );
  const protocolVersion = requiredAlias(
    value.protocolVersion,
    "INVALID_ADJUDICATION_PROTOCOL_VERSION",
    localErrors
  );
  const laneId2 = requiredAlias(
    value.laneId,
    "INVALID_ADJUDICATION_PROTOCOL_LANE",
    localErrors
  );
  const rubricId = requiredAlias(
    value.rubricId,
    "INVALID_ADJUDICATION_PROTOCOL_RUBRIC",
    localErrors
  );
  const labelVersion = requiredAlias(
    value.labelVersion,
    "INVALID_ADJUDICATION_PROTOCOL_LABEL_VERSION",
    localErrors
  );
  const variantIdentity = typeof value.variantIdentity === "string" && ["HIDDEN", "VISIBLE", "UNKNOWN"].includes(value.variantIdentity) ? value.variantIdentity : null;
  const presentationOrder = typeof value.presentationOrder === "string" && ["RANDOMIZED", "FIXED", "UNKNOWN"].includes(value.presentationOrder) ? value.presentationOrder : null;
  const highCriticalReview = typeof value.highCriticalReview === "string" && ["HUMAN", "OTHER", "UNKNOWN"].includes(value.highCriticalReview) ? value.highCriticalReview : null;
  if (!variantIdentity || !presentationOrder || !highCriticalReview) {
    localErrors.push(
      issue(
        "INVALID_ADJUDICATION_PROTOCOL",
        "Adjudication protocol enums are invalid."
      )
    );
  }
  let adjudicatorIndependence = null;
  if (isPlainObject2(value.adjudicatorIndependence) && rejectUnknownKeys(
    value.adjudicatorIndependence,
    ADJUDICATOR_INDEPENDENCE_KEYS,
    "UNKNOWN_ADJUDICATOR_INDEPENDENCE_FIELD",
    localErrors
  ) && typeof value.adjudicatorIndependence.status === "string" && ["DECLARED", "UNKNOWN"].includes(value.adjudicatorIndependence.status) && typeof value.adjudicatorIndependence.evidenceStatus === "string" && ["DECLARED", "UNKNOWN"].includes(value.adjudicatorIndependence.evidenceStatus) && isPublicAlias(value.adjudicatorIndependence.provenanceId)) {
    adjudicatorIndependence = {
      status: value.adjudicatorIndependence.status,
      evidenceStatus: value.adjudicatorIndependence.evidenceStatus,
      provenanceId: value.adjudicatorIndependence.provenanceId
    };
  } else {
    localErrors.push(
      issue(
        "INVALID_ADJUDICATOR_INDEPENDENCE",
        "Adjudicator-independence declaration is malformed."
      )
    );
  }
  let disagreement = null;
  if (isPlainObject2(value.disagreement) && rejectUnknownKeys(
    value.disagreement,
    DISAGREEMENT_KEYS,
    "UNKNOWN_DISAGREEMENT_FIELD",
    localErrors
  ) && isPublicAlias(value.disagreement.policyId) && typeof value.disagreement.status === "string" && ["COMPLETE", "PARTIAL", "UNKNOWN"].includes(value.disagreement.status) && isNonNegativeInteger(value.disagreement.count) && value.disagreement.count <= 1e4) {
    disagreement = {
      policyId: value.disagreement.policyId,
      status: value.disagreement.status,
      count: value.disagreement.count
    };
  } else {
    localErrors.push(
      issue("INVALID_DISAGREEMENT", "Disagreement declaration is malformed.")
    );
  }
  const provenance = normalizeProtocolProvenance(
    value.provenance,
    "INVALID_ADJUDICATION_PROTOCOL_PROVENANCE",
    localErrors
  );
  errors.push(...localErrors);
  if (localErrors.length > 0 || !protocolId || !protocolVersion || !laneId2 || !rubricId || !labelVersion || !variantIdentity || !presentationOrder || !highCriticalReview || !adjudicatorIndependence || !disagreement || !provenance) {
    return null;
  }
  return {
    schemaVersion: 1,
    protocolId,
    protocolVersion,
    laneId: laneId2,
    rubricId,
    labelVersion,
    variantIdentity,
    presentationOrder,
    highCriticalReview,
    adjudicatorIndependence,
    disagreement,
    provenance
  };
}
function isClosedEvalProtocolContract(value) {
  const errors = [];
  return Boolean(normalizeEvalProtocol(value, errors)) && errors.length === 0;
}
function isClosedAdjudicationProtocolContract(value) {
  const errors = [];
  return Boolean(normalizeAdjudicationProtocol(value, errors)) && errors.length === 0;
}
function normalizeUsage(value, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, USAGE_KEYS, "UNKNOWN_USAGE_FIELD", errors)) {
    errors.push(issue("INVALID_USAGE", "Usage must be a typed token-count object."));
    return null;
  }
  const result2 = {};
  for (const field of USAGE_KEYS) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(issue("INVALID_USAGE", "Token counts must be safe integers."));
      return null;
    }
    result2[field] = value[field];
  }
  if (result2.cachedInputTokens > result2.inputTokens) {
    errors.push(
      issue("INVALID_USAGE", "Cached input tokens cannot exceed input tokens.")
    );
    return null;
  }
  return result2;
}
function normalizeOutputCounts(value, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, OUTPUT_COUNT_KEYS, "UNKNOWN_OUTPUT_COUNT_FIELD", errors)) {
    errors.push(issue("INVALID_OUTPUT_COUNTS", "Output counts are malformed."));
    return null;
  }
  const result2 = {};
  for (const field of OUTPUT_COUNT_KEYS) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(
        issue("INVALID_OUTPUT_COUNTS", "Output counts must be safe integers.")
      );
      return null;
    }
    result2[field] = value[field];
  }
  return result2;
}
function normalizeComponents(value, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(
    value,
    COST_COMPONENT_KEYS,
    "UNKNOWN_COST_COMPONENT_FIELD",
    errors
  )) {
    errors.push(issue("INVALID_COST_COMPONENTS", "Cost components are malformed."));
    return null;
  }
  const result2 = {};
  for (const field of COST_COMPONENT_KEYS) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(
        issue("INVALID_COST_COMPONENTS", "Cost components must be integer micros.")
      );
      return null;
    }
    result2[field] = value[field];
  }
  return result2;
}
function reconstructComponents(usage, humanReviewMinutes, rate) {
  if (!usage || !rate || !isFiniteNumber(humanReviewMinutes)) {
    return null;
  }
  const fields = [
    "inputMicrosPerMillion",
    "cachedInputMicrosPerMillion",
    "outputMicrosPerMillion",
    "toolingMicrosPerRun",
    "humanReviewMicrosPerMinute"
  ];
  if (fields.some((field) => !isNonNegativeInteger(rate[field]))) {
    return null;
  }
  const uncachedInput = usage.inputTokens - usage.cachedInputTokens;
  const modelTerms = [
    uncachedInput * rate.inputMicrosPerMillion,
    usage.cachedInputTokens * rate.cachedInputMicrosPerMillion,
    usage.outputTokens * rate.outputMicrosPerMillion
  ];
  const humanProduct = humanReviewMinutes * rate.humanReviewMicrosPerMinute;
  if (modelTerms.some((term) => !Number.isSafeInteger(term)) || !isFiniteNumber(humanProduct) || Math.abs(humanProduct) > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  const modelMicros = Math.round(sum(modelTerms) / 1e6);
  const humanReviewMicros = Math.round(humanProduct);
  if (!isNonNegativeInteger(modelMicros) || !isNonNegativeInteger(humanReviewMicros)) {
    return null;
  }
  return {
    modelMicros,
    toolingMicros: rate.toolingMicrosPerRun,
    humanReviewMicros
  };
}
function safeMicrosSum(values) {
  const total = values.reduce((current, value) => current + value, 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
function normalizeCost(value, variantId, usage, humanReviewMinutes, pricingSnapshot, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, COST_KEYS, "UNKNOWN_COST_FIELD", errors)) {
    errors.push(issue("INVALID_COST", "Cost must be a typed micros object."));
    return null;
  }
  const costBasis = normalizedEnum(value.costBasis);
  const costSource = normalizedEnum(value.costSource);
  if (!(typeof value.currency === "string" && /^[A-Z]{3}$/u.test(value.currency)) || !isPublicAlias(value.pricingSnapshotId) || !COST_BASES.has(costBasis) || !COST_SOURCES.has(costSource)) {
    errors.push(issue("INVALID_COST", "Cost provenance or basis is invalid."));
    return null;
  }
  if (pricingSnapshot && (value.pricingSnapshotId !== pricingSnapshot.snapshotId || value.currency !== pricingSnapshot.currency)) {
    errors.push(
      issue("PRICING_MISMATCH", "Run cost does not match its pricing snapshot.")
    );
    return null;
  }
  const suppliedComponents = normalizeComponents(value.components, errors);
  let components = suppliedComponents;
  let amountMicros = value.amountMicros;
  if (costSource === "RECONSTRUCTED_COMPONENTS") {
    const rate = pricingSnapshot?.ratesByVariant?.get(variantId);
    components = reconstructComponents(usage, humanReviewMinutes, rate);
    if (!components) {
      errors.push(
        issue(
          "UNRECONSTRUCTABLE_COST",
          "Reconstructed cost requires usage, human effort, and exact rates."
        )
      );
      return null;
    }
    amountMicros = safeMicrosSum([
      components.modelMicros,
      components.toolingMicros,
      components.humanReviewMicros
    ]);
  }
  if (!isNonNegativeInteger(amountMicros)) {
    errors.push(issue("INVALID_COST", "Cost amount must be integer micros."));
    return null;
  }
  if (components) {
    const componentTotal = safeMicrosSum([
      components.modelMicros,
      components.toolingMicros,
      components.humanReviewMicros
    ]);
    if (componentTotal !== amountMicros) {
      errors.push(
        issue("COST_COMPONENT_MISMATCH", "Cost components do not equal total.")
      );
      return null;
    }
  }
  if (costBasis === "FULLY_LOADED" && !components) {
    errors.push(
      issue(
        "INCOMPLETE_FULLY_LOADED_COST",
        "Fully loaded cost requires model, tooling, and human components."
      )
    );
    return null;
  }
  return {
    currency: value.currency,
    amountMicros,
    costBasis,
    costSource,
    pricingSnapshotId: value.pricingSnapshotId,
    components
  };
}
function normalizeFinding(value, errors) {
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, FINDING_KEYS, "UNKNOWN_FINDING_FIELD", errors)) {
    errors.push(issue("INVALID_FINDING", "Finding must be a typed object."));
    return null;
  }
  const findingId = requiredOpaqueId(value.findingId, "INVALID_FINDING_ID", errors);
  const severity = normalizedEnum(value.severity);
  const verification = value.verification === void 0 || value.verification === null ? null : normalizedEnum(value.verification);
  const category = value.category === void 0 || value.category === null ? null : normalizedEnum(value.category);
  if (!SEVERITIES.has(severity)) {
    errors.push(issue("INVALID_FINDING_SEVERITY", "Unsupported severity."));
  }
  if (verification !== null && !VERIFICATIONS.has(verification)) {
    errors.push(
      issue("INVALID_FINDING_VERIFICATION", "Unsupported verification state.")
    );
  }
  if (category !== null && !CATEGORIES.has(category)) {
    errors.push(issue("INVALID_FINDING_CATEGORY", "Unsupported finding category."));
  }
  if (!findingId || !SEVERITIES.has(severity) || verification && !VERIFICATIONS.has(verification) || category && !CATEGORIES.has(category)) {
    return null;
  }
  return {
    findingId,
    severity,
    category,
    verification,
    tags: normalizeTags(value.tags, "INVALID_FINDING_TAGS", errors)
  };
}
function normalizeFindingLabel(value, errors) {
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, FINDING_LABEL_KEYS, "UNKNOWN_FINDING_LABEL_FIELD", errors)) {
    errors.push(issue("INVALID_FINDING_LABEL", "Finding label is malformed."));
    return null;
  }
  const findingId = requiredOpaqueId(
    value.findingId,
    "INVALID_FINDING_LABEL_ID",
    errors
  );
  const outcome = normalizedEnum(value.outcome);
  const matches2 = value.matchedRootCauseIds ?? [];
  if (!Array.isArray(matches2) || matches2.some((rootCauseId) => !isOpaqueDigestId(rootCauseId)) || new Set(matches2).size !== matches2.length) {
    errors.push(
      issue("INVALID_ROOT_CAUSE_MATCHES", "Root-cause matches must be unique IDs.")
    );
  }
  if (!OUTCOMES.has(outcome)) {
    errors.push(issue("INVALID_FINDING_OUTCOME", "Unsupported finding outcome."));
  }
  if (outcome === "REJECTED" && Array.isArray(matches2) && matches2.length > 0) {
    errors.push(
      issue(
        "CONTRADICTORY_ADJUDICATION",
        "Rejected findings cannot confirm root causes."
      )
    );
  }
  if (!findingId || !OUTCOMES.has(outcome) || !Array.isArray(matches2) || matches2.some((rootCauseId) => !isOpaqueDigestId(rootCauseId))) {
    return null;
  }
  return {
    findingId,
    outcome,
    matchedRootCauseIds: [...new Set(matches2)].sort(compareText)
  };
}
function normalizeRootCauseAssessment(value, errors) {
  if (!isPlainObject2(value) || !rejectUnknownKeys(
    value,
    ROOT_CAUSE_ASSESSMENT_KEYS,
    "UNKNOWN_ROOT_CAUSE_ASSESSMENT_FIELD",
    errors
  )) {
    errors.push(issue("INVALID_ROOT_CAUSE_ASSESSMENT", "Assessment is malformed."));
    return null;
  }
  const rootCauseId = requiredOpaqueId(
    value.rootCauseId,
    "INVALID_ROOT_CAUSE_ID",
    errors
  );
  const qualityRubricId = requiredAlias(
    value.qualityRubricId,
    "INVALID_QUALITY_RUBRIC_ID",
    errors
  );
  if (!isFiniteNumber(value.qualityScore) || value.qualityScore < 0 || value.qualityScore > 1) {
    errors.push(
      issue("INVALID_ROOT_CAUSE_QUALITY", "Quality score must be between 0 and 1.")
    );
  }
  if (!rootCauseId || !qualityRubricId || !isFiniteNumber(value.qualityScore)) {
    return null;
  }
  return {
    rootCauseId,
    qualityScore: roundNumber(value.qualityScore),
    qualityRubricId
  };
}
function normalizeAdjudication(value, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, ADJUDICATION_KEYS, "UNKNOWN_ADJUDICATION_FIELD", errors)) {
    errors.push(issue("INVALID_ADJUDICATION", "Adjudication is malformed."));
    return null;
  }
  const status = normalizedEnum(value.status);
  const rubricId = requiredAlias(value.rubricId, "INVALID_ADJUDICATION_RUBRIC", errors);
  const labelVersion = isNonEmptyString(value.labelVersion) ? value.labelVersion : null;
  if (!labelVersion) {
    errors.push(
      issue("INVALID_ADJUDICATION_LABEL_VERSION", "Label version is missing.")
    );
  }
  if (!ADJUDICATION_STATUSES.has(status)) {
    errors.push(
      issue("INVALID_ADJUDICATION_STATUS", "Unsupported adjudication status.")
    );
  }
  if (!Array.isArray(value.findingLabels)) {
    errors.push(issue("INVALID_FINDING_LABELS", "Finding labels must be an array."));
    return null;
  }
  const findingLabels = value.findingLabels.map((item) => normalizeFindingLabel(item, errors)).filter(Boolean);
  const rootCauseAssessments = Array.isArray(value.rootCauseAssessments) ? value.rootCauseAssessments.map((item) => normalizeRootCauseAssessment(item, errors)).filter(Boolean) : [];
  if (value.rootCauseAssessments !== void 0 && !Array.isArray(value.rootCauseAssessments)) {
    errors.push(
      issue(
        "INVALID_ROOT_CAUSE_ASSESSMENTS",
        "Root-cause assessments must be an array."
      )
    );
  }
  const findingIds = findingLabels.map((item) => item.findingId);
  const assessmentIds = rootCauseAssessments.map((item) => item.rootCauseId);
  if (new Set(findingIds).size !== findingIds.length) {
    errors.push(issue("DUPLICATE_FINDING_LABEL", "A finding has duplicate labels."));
  }
  if (new Set(assessmentIds).size !== assessmentIds.length) {
    errors.push(
      issue("DUPLICATE_ROOT_CAUSE_ASSESSMENT", "A root cause has duplicate scores.")
    );
  }
  if (!ADJUDICATION_STATUSES.has(status) || !rubricId || !labelVersion) {
    return null;
  }
  return {
    status,
    rubricId,
    labelVersion,
    findingLabels: stableSort2(findingLabels, (item) => item.findingId),
    rootCauseAssessments: stableSort2(rootCauseAssessments, (item) => item.rootCauseId)
  };
}
function normalizeRun(value, pricingSnapshot, errors) {
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, RUN_KEYS, "UNKNOWN_RUN_FIELD", errors)) {
    errors.push(issue("INVALID_RUN", "Run record is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(issue("UNSUPPORTED_RUN_SCHEMA", "Run schemaVersion must be 1."));
  }
  const caseId = requiredOpaqueId(value.caseId, "INVALID_CASE_ID", errors);
  const variantId = requiredAlias(value.variantId, "INVALID_VARIANT_ID", errors);
  const architectureId = requiredAlias(
    value.architectureId,
    "INVALID_ARCHITECTURE_ID",
    errors
  );
  const architectureStructuralDigest = requiredOpaqueId(
    value.architectureStructuralDigest,
    "INVALID_ARCHITECTURE_DIGEST",
    errors
  );
  const runId = requiredOpaqueId(value.runId, "INVALID_RUN_ID", errors);
  const replicateId = requiredAlias(value.replicateId, "INVALID_REPLICATE_ID", errors);
  const contextDigest = requiredOpaqueId(
    value.contextDigest,
    "INVALID_CONTEXT_DIGEST",
    errors
  );
  const startedAt = normalizedTimestamp(value.startedAt);
  if (!startedAt) {
    errors.push(issue("INVALID_STARTED_AT", "Run timestamp must be UTC."));
  }
  if (!isNonNegativeInteger(value.latencyMs)) {
    errors.push(issue("INVALID_LATENCY", "Latency must be integer milliseconds."));
  }
  const contractFields = [
    "toolContractId",
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
    "reasoningClass",
    "retryPolicyId",
    "timeoutPolicyId",
    "routingPolicyId"
  ];
  const contracts2 = {};
  for (const field of contractFields) {
    contracts2[field] = requiredAlias(
      value[field],
      "INVALID_" + field.toUpperCase(),
      errors
    );
  }
  const usage = normalizeUsage(value.usage, errors);
  const outputCounts = normalizeOutputCounts(value.outputCounts, errors);
  const humanReviewMinutes = value.humanReviewMinutes === void 0 || value.humanReviewMinutes === null ? null : isNonNegativeNumber(value.humanReviewMinutes) ? roundNumber(value.humanReviewMinutes) : null;
  if (value.humanReviewMinutes !== void 0 && value.humanReviewMinutes !== null && humanReviewMinutes === null) {
    errors.push(
      issue("INVALID_HUMAN_REVIEW_MINUTES", "Human review must be non-negative.")
    );
  }
  const findingsSource = value.findings;
  if (!Array.isArray(findingsSource)) {
    errors.push(issue("INVALID_FINDINGS", "Findings must be an array."));
  }
  const findings = Array.isArray(findingsSource) ? findingsSource.map((item) => normalizeFinding(item, errors)).filter(Boolean) : [];
  const findingIds = findings.map((item) => item.findingId);
  if (new Set(findingIds).size !== findingIds.length) {
    errors.push(issue("DUPLICATE_FINDING_ID", "A run repeats a finding ID."));
  }
  const adjudication = normalizeAdjudication(value.adjudication, errors);
  if (adjudication) {
    const knownFindings = new Set(findingIds);
    for (const label of adjudication.findingLabels) {
      if (!knownFindings.has(label.findingId)) {
        errors.push(
          issue(
            "UNKNOWN_ADJUDICATED_FINDING",
            "Adjudication references an unknown finding."
          )
        );
      }
    }
  }
  const cost = variantId ? normalizeCost(
    value.cost,
    variantId,
    usage,
    humanReviewMinutes,
    pricingSnapshot,
    errors
  ) : null;
  if (value.schemaVersion !== 1 || !caseId || !variantId || !architectureId || !architectureStructuralDigest || !runId || !replicateId || !contextDigest || !startedAt || !isNonNegativeInteger(value.latencyMs) || contractFields.some((field) => !contracts2[field]) || !Array.isArray(findingsSource)) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    variantId,
    architectureId,
    architectureStructuralDigest,
    runId,
    replicateId,
    contextDigest,
    ...contracts2,
    startedAt,
    latencyMs: value.latencyMs,
    usage,
    outputCounts,
    cost,
    humanReviewMinutes,
    findings: stableSort2(findings, (item) => item.findingId),
    adjudication
  };
}
function normalizeCaseLabel(value, errors) {
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, CASE_LABEL_KEYS, "UNKNOWN_CASE_LABEL_FIELD", errors)) {
    errors.push(issue("INVALID_CASE_LABEL", "Case label is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_CASE_LABEL_SCHEMA", "Case-label schemaVersion must be 1.")
    );
  }
  const caseId = requiredOpaqueId(value.caseId, "INVALID_CASE_LABEL_ID", errors);
  const rubricId = requiredAlias(value.rubricId, "INVALID_CASE_LABEL_RUBRIC", errors);
  const labelVersion = isNonEmptyString(value.labelVersion) ? value.labelVersion : null;
  if (!labelVersion) {
    errors.push(issue("INVALID_CASE_LABEL_VERSION", "Label version is missing."));
  }
  const riskSliceIds = value.riskSliceIds === void 0 ? [] : normalizeStringArray(value.riskSliceIds, "INVALID_RISK_SLICES", errors);
  if (!Array.isArray(value.groundTruth)) {
    errors.push(issue("INVALID_GROUND_TRUTH", "Ground truth must be an array."));
    return null;
  }
  const groundTruth = [];
  for (const item of value.groundTruth) {
    if (!isPlainObject2(item) || !rejectUnknownKeys(item, GROUND_TRUTH_KEYS, "UNKNOWN_GROUND_TRUTH_FIELD", errors)) {
      errors.push(issue("INVALID_GROUND_TRUTH", "Ground truth is malformed."));
      continue;
    }
    const rootCauseId = requiredOpaqueId(
      item.rootCauseId,
      "INVALID_ROOT_CAUSE_ID",
      errors
    );
    const severity = normalizedEnum(item.severity);
    if (!SEVERITIES.has(severity)) {
      errors.push(issue("INVALID_ROOT_CAUSE_SEVERITY", "Unsupported severity."));
    }
    if (rootCauseId && SEVERITIES.has(severity)) {
      groundTruth.push({
        rootCauseId,
        severity,
        tags: normalizeTags(item.tags, "INVALID_ROOT_CAUSE_TAGS", errors)
      });
    }
  }
  const rootCauseIds = groundTruth.map((item) => item.rootCauseId);
  if (new Set(rootCauseIds).size !== rootCauseIds.length) {
    errors.push(issue("DUPLICATE_ROOT_CAUSE_ID", "A case repeats a root-cause ID."));
  }
  if (value.schemaVersion !== 1 || !caseId || !rubricId || !labelVersion || !riskSliceIds) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    rubricId,
    labelVersion,
    riskSliceIds,
    groundTruth: stableSort2(groundTruth, (item) => item.rootCauseId),
    provenance: normalizeProvenance(value.provenance)
  };
}
function normalizeCandidate(value, errors) {
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, CANDIDATE_KEYS, "UNKNOWN_CANDIDATE_FIELD", errors)) {
    errors.push(issue("INVALID_CANDIDATE_CONFIG", "Candidate config is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_CANDIDATE_SCHEMA", "Candidate schemaVersion must be 1.")
    );
  }
  const variantId = requiredAlias(value.variantId, "INVALID_VARIANT_ID", errors);
  const architectureId = requiredAlias(
    value.architectureId,
    "INVALID_ARCHITECTURE_ID",
    errors
  );
  const architectureStructuralDigest = requiredOpaqueId(
    value.architectureStructuralDigest,
    "INVALID_ARCHITECTURE_DIGEST",
    errors
  );
  const aliasFields = [
    "modelAlias",
    "reasoningClass",
    "contextClass",
    "toolContractId",
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
    "retryPolicyId",
    "timeoutPolicyId",
    "routingPolicyId"
  ];
  const digestFields = ["promptStructuralDigest", "configStructuralDigest"];
  const result2 = {
    schemaVersion: 1,
    variantId,
    architectureId,
    architectureStructuralDigest
  };
  for (const field of aliasFields) {
    result2[field] = requiredAlias(
      value[field],
      "INVALID_" + field.toUpperCase(),
      errors
    );
  }
  for (const field of digestFields) {
    result2[field] = requiredOpaqueId(
      value[field],
      "INVALID_" + field.toUpperCase(),
      errors
    );
  }
  if (value.schemaVersion !== 1 || !variantId || !architectureId || !architectureStructuralDigest || [...aliasFields, ...digestFields].some((field) => !result2[field])) {
    return null;
  }
  return result2;
}
function normalizePricingSnapshot(value, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, PRICING_KEYS, "UNKNOWN_PRICING_FIELD", errors)) {
    errors.push(issue("INVALID_PRICING_SNAPSHOT", "Pricing snapshot is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_PRICING_SCHEMA", "Pricing schemaVersion must be 1.")
    );
  }
  const snapshotId = requiredAlias(value.snapshotId, "INVALID_PRICING_ID", errors);
  const currency = typeof value.currency === "string" && /^[A-Z]{3}$/u.test(value.currency) ? value.currency : null;
  if (!currency) {
    errors.push(
      issue("INVALID_PRICING_CURRENCY", "Currency must be an uppercase ISO code.")
    );
  }
  const effectiveAt = normalizedTimestamp(value.effectiveAt);
  if (!effectiveAt) {
    errors.push(
      issue("INVALID_PRICING_EFFECTIVE_AT", "Pricing timestamp must be UTC.")
    );
  }
  const costBasis = normalizedEnum(value.costBasis);
  if (!COST_BASES.has(costBasis)) {
    errors.push(issue("INVALID_PRICING_COST_BASIS", "Unsupported cost basis."));
  }
  if (!Array.isArray(value.rates)) {
    errors.push(issue("INVALID_PRICING_RATES", "Pricing rates must be an array."));
    return null;
  }
  const rates = [];
  for (const rate of value.rates) {
    if (!isPlainObject2(rate) || !rejectUnknownKeys(rate, PRICING_RATE_KEYS, "UNKNOWN_PRICING_RATE_FIELD", errors)) {
      errors.push(issue("INVALID_PRICING_RATE", "Pricing rate is malformed."));
      continue;
    }
    const variantId = requiredAlias(rate.variantId, "INVALID_PRICING_VARIANT", errors);
    const numericFields = [...PRICING_RATE_KEYS].filter(
      (field) => field !== "variantId"
    );
    if (numericFields.some((field) => !isNonNegativeInteger(rate[field]))) {
      errors.push(
        issue("INVALID_PRICING_RATE", "Pricing rates must be integer micros.")
      );
      continue;
    }
    if (variantId) {
      rates.push({
        variantId,
        ...Object.fromEntries(numericFields.map((field) => [field, rate[field]]))
      });
    }
  }
  const rateIds = rates.map((rate) => rate.variantId);
  if (new Set(rateIds).size !== rateIds.length) {
    errors.push(issue("DUPLICATE_PRICING_RATE", "Pricing repeats a variant."));
  }
  if (value.schemaVersion !== 1 || !snapshotId || !currency || !effectiveAt || !COST_BASES.has(costBasis)) {
    return null;
  }
  const orderedRates = stableSort2(rates, (rate) => rate.variantId);
  return {
    schemaVersion: 1,
    snapshotId,
    currency,
    effectiveAt,
    costBasis,
    provenance: normalizeProvenance(value.provenance),
    rates: orderedRates,
    ratesByVariant: new Map(orderedRates.map((rate) => [rate.variantId, rate]))
  };
}
function normalizeManifest(value, errors) {
  if (value === void 0 || value === null) {
    errors.push(issue("MISSING_MANIFEST", "Lane bundle requires a manifest."));
    return null;
  }
  if (!isPlainObject2(value) || !rejectUnknownKeys(value, MANIFEST_KEYS, "UNKNOWN_MANIFEST_FIELD", errors)) {
    errors.push(issue("INVALID_MANIFEST", "Benchmark manifest is malformed."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_MANIFEST_SCHEMA", "Manifest schemaVersion must be 1.")
    );
  }
  const corpusId = requiredOpaqueId(value.corpusId, "INVALID_CORPUS_ID", errors);
  const exporterVersion = requiredToolVersion(
    value.exporterVersion,
    "INVALID_EXPORTER_VERSION",
    errors
  );
  const exportedAt = normalizedTimestamp(value.exportedAt);
  if (!exportedAt) {
    errors.push(issue("INVALID_EXPORTED_AT", "Manifest timestamp must be UTC."));
  }
  const rubricId = requiredAlias(value.rubricId, "INVALID_MANIFEST_RUBRIC", errors);
  const pricingSnapshotId = requiredAlias(
    value.pricingSnapshotId,
    "INVALID_MANIFEST_PRICING",
    errors
  );
  const structuralReceipts = normalizeStructuralReceipts(
    value.structuralReceipts,
    errors
  );
  const labelVersion = isNonEmptyString(value.labelVersion) ? value.labelVersion : null;
  if (!labelVersion) {
    errors.push(issue("INVALID_MANIFEST_LABEL_VERSION", "Label version is missing."));
  }
  const caseIds = Array.isArray(value.caseIds) && value.caseIds.every((item) => isOpaqueDigestId(item)) && new Set(value.caseIds).size === value.caseIds.length ? [...value.caseIds].sort(compareText) : null;
  if (!caseIds) {
    errors.push(issue("INVALID_MANIFEST_CASES", "Manifest case IDs are invalid."));
  }
  const variantIds = normalizeStringArray(
    value.variantIds,
    "INVALID_MANIFEST_VARIANTS",
    errors
  );
  let lane = null;
  if (isPlainObject2(value.lane) && rejectUnknownKeys(value.lane, LANE_KEYS, "UNKNOWN_LANE_FIELD", errors)) {
    const laneId2 = requiredAlias(value.lane.laneId, "INVALID_LANE_ID", errors);
    const laneType3 = normalizedEnum(value.lane.laneType);
    const baselineVariantId = requiredAlias(
      value.lane.baselineVariantId,
      "INVALID_BASELINE_VARIANT",
      errors
    );
    const cohortSelectionDigest = requiredOpaqueId(
      value.lane.cohortSelectionDigest,
      "INVALID_COHORT_SELECTION_DIGEST",
      errors
    );
    const cohortWindowId = requiredOpaqueId(
      value.lane.cohortWindowId,
      "INVALID_COHORT_WINDOW_ID",
      errors
    );
    const allowedDifferenceAxes = normalizeDifferenceAxes(
      value.lane.allowedDifferenceAxes,
      errors
    );
    const executionMode = normalizedEnum(value.lane.executionMode);
    if (!LANE_TYPES.has(laneType3)) {
      errors.push(issue("INVALID_LANE_TYPE", "Unsupported lane type."));
    }
    if (!EXECUTION_MODES.has(executionMode)) {
      errors.push(issue("INVALID_EXECUTION_MODE", "Unsupported execution mode."));
    }
    if (laneId2 && LANE_TYPES.has(laneType3) && baselineVariantId && cohortSelectionDigest && cohortWindowId && allowedDifferenceAxes && EXECUTION_MODES.has(executionMode)) {
      lane = {
        laneId: laneId2,
        laneType: laneType3,
        baselineVariantId,
        cohortSelectionDigest,
        cohortWindowId,
        allowedDifferenceAxes,
        executionMode
      };
    }
  } else {
    errors.push(issue("INVALID_LANE", "Manifest lane contract is missing."));
  }
  let sliceTaxonomy = null;
  if (isPlainObject2(value.sliceTaxonomy) && rejectUnknownKeys(
    value.sliceTaxonomy,
    SLICE_TAXONOMY_KEYS,
    "UNKNOWN_SLICE_TAXONOMY_FIELD",
    errors
  )) {
    const taxonomyId = requiredAlias(
      value.sliceTaxonomy.taxonomyId,
      "INVALID_SLICE_TAXONOMY_ID",
      errors
    );
    const version = isNonEmptyString(value.sliceTaxonomy.version) ? value.sliceTaxonomy.version : null;
    const sliceIds = normalizeStringArray(
      value.sliceTaxonomy.sliceIds,
      "INVALID_SLICE_IDS",
      errors
    );
    if (taxonomyId && version && sliceIds) {
      sliceTaxonomy = { taxonomyId, version, sliceIds };
    }
  } else {
    errors.push(issue("INVALID_SLICE_TAXONOMY", "Manifest slice taxonomy is missing."));
  }
  let productionBaselineContracts = null;
  if (isPlainObject2(value.productionBaselineContracts) && rejectUnknownKeys(
    value.productionBaselineContracts,
    BASELINE_CONTRACT_KEYS,
    "UNKNOWN_BASELINE_CONTRACT_FIELD",
    errors
  )) {
    const result2 = {};
    for (const field of BASELINE_CONTRACT_KEYS) {
      result2[field] = requiredAlias(
        value.productionBaselineContracts[field],
        "INVALID_" + field.toUpperCase(),
        errors
      );
    }
    if ([...BASELINE_CONTRACT_KEYS].every((field) => result2[field])) {
      productionBaselineContracts = result2;
    }
  } else {
    errors.push(
      issue(
        "INVALID_PRODUCTION_BASELINE_CONTRACTS",
        "Production baseline contracts are missing."
      )
    );
  }
  if (value.schemaVersion !== 1 || !corpusId || !exporterVersion || !exportedAt || !caseIds || !variantIds || !rubricId || !labelVersion || !pricingSnapshotId || !lane || !sliceTaxonomy || !productionBaselineContracts) {
    return null;
  }
  return {
    schemaVersion: 1,
    corpusId,
    exporterVersion,
    exportedAt,
    caseIds,
    variantIds,
    rubricId,
    labelVersion,
    pricingSnapshotId,
    redactionPolicyVersion: isNonEmptyString(value.redactionPolicyVersion) ? value.redactionPolicyVersion : null,
    lane,
    sliceTaxonomy,
    productionBaselineContracts,
    structuralReceipts
  };
}
function recordArray(value) {
  if (!isPlainObject2(value)) {
    return [];
  }
  const source = value.runs ?? value.exports ?? value.exportRecords ?? value.canonicalRunRecords ?? value.records;
  if (!Array.isArray(source)) {
    return [];
  }
  return source.map(
    (record) => isPlainObject2(record) && isPlainObject2(record.runRecord) ? record.runRecord : isPlainObject2(record) && isPlainObject2(record.run) ? record.run : record
  );
}
function caseLabelArray(value) {
  if (!isPlainObject2(value)) {
    return [];
  }
  return Array.isArray(value.caseLabels) ? value.caseLabels : [];
}
function candidateArray(value) {
  if (!isPlainObject2(value)) {
    return [];
  }
  const candidates = value.candidateConfigs ?? value.candidates;
  return Array.isArray(candidates) ? candidates : [];
}
function exportSummary(value, errors) {
  if (!isPlainObject2(value) || !Array.isArray(value.exports)) {
    return {
      sourceMode: Array.isArray(value?.canonicalRunRecords) ? "CANONICAL_RECORDS" : Array.isArray(value?.runs) || Array.isArray(value?.records) ? "CANONICAL_RECORDS" : "SANITIZED_EXPORT",
      exportIds: [],
      exporterVersions: []
    };
  }
  const exportIds = [];
  const exporterVersions = [];
  for (const record of value.exports) {
    if (!isPlainObject2(record) || !rejectUnknownKeys(record, EXPORT_KEYS, "UNKNOWN_EXPORT_FIELD", errors) || record.schemaVersion !== 1 || !isOpaqueDigestId(record.exportId) || typeof record.exporterVersion !== "string" || !TOOL_VERSION.test(record.exporterVersion) || !isPlainObject2(record.runRecord) || !normalizeProvenance(record.provenance)) {
      errors.push(
        issue("INVALID_EXPORT_RECORD", "Sanitized export wrapper is malformed.")
      );
      continue;
    }
    exportIds.push(record.exportId);
    exporterVersions.push(record.exporterVersion);
  }
  if (new Set(exportIds).size !== exportIds.length) {
    errors.push(issue("DUPLICATE_EXPORT_ID", "Export IDs must be unique."));
  }
  return {
    sourceMode: "SANITIZED_EXPORT",
    exportIds: uniqueSortedStrings(exportIds),
    exporterVersions: uniqueSortedStrings(exporterVersions)
  };
}
function validateRootCauseReferences(run, caseLabel, rubric, errors) {
  if (!run.adjudication || !caseLabel) {
    return;
  }
  const groundTruthIds = new Set(caseLabel.groundTruth.map((item) => item.rootCauseId));
  const matching = rubric?.matching ?? rubric?.matchingRules ?? {};
  const matchesByRootCause = /* @__PURE__ */ new Map();
  for (const label of run.adjudication.findingLabels) {
    for (const rootCauseId of label.matchedRootCauseIds) {
      if (!groundTruthIds.has(rootCauseId)) {
        errors.push(
          issue(
            "UNKNOWN_ROOT_CAUSE_MATCH",
            "Adjudication references a root cause outside case labels."
          )
        );
      }
      const count = matchesByRootCause.get(rootCauseId) ?? 0;
      matchesByRootCause.set(rootCauseId, count + 1);
    }
    if (label.matchedRootCauseIds.length > 1 && matching.oneFindingMayMatchManyRootCauses !== true && matching.allowOneFindingMultipleRootCauses !== true) {
      errors.push(
        issue(
          "CONTRADICTORY_ROOT_CAUSE_MATCH",
          "One finding matches multiple root causes without rubric permission."
        )
      );
    }
  }
  if (matching.manyFindingsMayMatchOneRootCause !== true && matching.allowMultipleFindingsPerRootCause !== true && [...matchesByRootCause.values()].some((count) => count > 1)) {
    errors.push(
      issue(
        "CONTRADICTORY_ROOT_CAUSE_MATCH",
        "Multiple findings match one root cause without rubric permission."
      )
    );
  }
  for (const assessment of run.adjudication.rootCauseAssessments) {
    if (!groundTruthIds.has(assessment.rootCauseId)) {
      errors.push(
        issue(
          "UNKNOWN_ROOT_CAUSE_ASSESSMENT",
          "Quality assessment references an unknown root cause."
        )
      );
    }
    if (assessment.qualityRubricId !== run.adjudication.rubricId) {
      errors.push(
        issue(
          "ROOT_CAUSE_QUALITY_RUBRIC_MISMATCH",
          "Quality assessment uses a different rubric."
        )
      );
    }
  }
}
function isSafeDeclaredExclusion(protocol, caseId) {
  if (!caseId || !isPlainObject2(protocol)) {
    return false;
  }
  if (protocol.missingReplicatePolicy !== "SYMMETRIC_EXCLUDE_CASE") {
    return false;
  }
  const exclusions = protocol.predeclaredExclusions;
  if (!Array.isArray(exclusions)) {
    return false;
  }
  return exclusions.some(
    (entry) => isPlainObject2(entry) && entry.caseId === caseId && entry.symmetric === true && isOpaqueDigestId(entry.provenanceDigest)
  );
}
function normalizeLaneBundle(input) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject2(input)) {
    const invalid = issue(
      "INVALID_LANE_BUNDLE",
      "Lane bundle must be an already-loaded object."
    );
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      bundleId: null,
      laneId: null,
      laneType: null,
      errors: [invalid],
      warnings: [],
      reasonCodes: ["INVALID_LANE_BUNDLE"],
      report: {
        schemaVersion: 1,
        status: "BLOCKED",
        errors: [invalid],
        warnings: [],
        reasonCodes: ["INVALID_LANE_BUNDLE"]
      },
      runs: [],
      caseLabels: [],
      caseLabelsById: /* @__PURE__ */ new Map(),
      candidateConfigs: [],
      candidatesById: /* @__PURE__ */ new Map(),
      manifest: null,
      lane: null,
      pricingSnapshot: null,
      rubric: null,
      evalProtocol: null,
      adjudicationProtocol: null,
      rankingEligible: false
    };
  }
  const forbidden = forbiddenPaths(input);
  if (forbidden.length > 0) {
    errors.push(
      issue("UNSAFE_RAW_FIELD", "Bundle includes forbidden raw-data fields.", {
        paths: forbidden.slice(0, 16).sort(compareText)
      })
    );
  }
  const bundleId = isPublicAlias(input.bundleId) ? input.bundleId : null;
  if (!bundleId) {
    errors.push(issue("INVALID_BUNDLE_ID", "Bundle ID must be a public alias."));
  }
  const manifest = normalizeManifest(input.manifest ?? input.benchmarkManifest, errors);
  const pricingSnapshot = normalizePricingSnapshot(input.pricingSnapshot, errors);
  const rubric = isPlainObject2(input.rubric) ? input.rubric : null;
  if (!rubric) {
    warnings.push(issue("MISSING_RUBRIC", "Rubric evidence is missing."));
  }
  const evalProtocol = normalizeEvalProtocol(input.evalProtocol, errors);
  const adjudicationProtocol = normalizeAdjudicationProtocol(
    input.adjudicationProtocol,
    errors
  );
  if (manifest && Array.isArray(evalProtocol?.predeclaredExclusions)) {
    for (const exclusion of evalProtocol.predeclaredExclusions) {
      if (!manifest.caseIds.includes(exclusion.caseId)) {
        errors.push(
          issue(
            "UNKNOWN_PREDECLARED_EXCLUSION_CASE",
            "A predeclared exclusion references a case outside the manifest."
          )
        );
      }
    }
  }
  const suppliedSources = [
    "runs",
    "exports",
    "exportRecords",
    "canonicalRunRecords",
    "records"
  ].filter((field) => Array.isArray(input[field]));
  if (suppliedSources.length > 1) {
    errors.push(
      issue(
        "AMBIGUOUS_SOURCE_MODE",
        "Lane bundle must supply exactly one in-memory run source."
      )
    );
  }
  const rawRuns = recordArray(input);
  const sourceSummary = exportSummary(input, errors);
  const rawLabels = caseLabelArray(input);
  const rawCandidates = candidateArray(input);
  const rejectedRecords = [];
  const runs = [];
  for (let index = 0; index < rawRuns.length; index += 1) {
    const recordErrors = [];
    const run = normalizeRun(rawRuns[index], pricingSnapshot, recordErrors);
    if (!run || recordErrors.length > 0) {
      const rawRun = (
        /** @type {any} */
        rawRuns[index]
      );
      const caseId = isPlainObject2(rawRun) ? rawRun.caseId : null;
      rejectedRecords.push({
        kind: "RUN",
        index,
        caseId: isOpaqueDigestId(caseId) ? caseId : null,
        reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        symmetricDeclaredExclusion: isSafeDeclaredExclusion(
          evalProtocol,
          isOpaqueDigestId(caseId) ? caseId : null
        )
      });
      warnings.push(
        issue("REJECTED_RUN_RECORD", "A whole run record was rejected.", {
          index,
          reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code))
        })
      );
      continue;
    }
    runs.push(run);
  }
  const caseLabels = [];
  for (let index = 0; index < rawLabels.length; index += 1) {
    const recordErrors = [];
    const label = normalizeCaseLabel(rawLabels[index], recordErrors);
    if (!label || recordErrors.length > 0) {
      const rawLabel = (
        /** @type {any} */
        rawLabels[index]
      );
      rejectedRecords.push({
        kind: "CASE_LABEL",
        index,
        caseId: isPlainObject2(rawLabel) && isOpaqueDigestId(rawLabel.caseId) ? rawLabel.caseId : null,
        reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        symmetricDeclaredExclusion: false
      });
      warnings.push(
        issue("REJECTED_CASE_LABEL", "A whole case-label record was rejected.", {
          index,
          reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code))
        })
      );
      continue;
    }
    caseLabels.push(label);
  }
  const candidateConfigs = [];
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const recordErrors = [];
    const candidate = normalizeCandidate(rawCandidates[index], recordErrors);
    if (!candidate || recordErrors.length > 0) {
      rejectedRecords.push({
        kind: "CANDIDATE",
        index,
        caseId: null,
        reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code)),
        symmetricDeclaredExclusion: false
      });
      warnings.push(
        issue("REJECTED_CANDIDATE_CONFIG", "A candidate config was rejected.", {
          index,
          reasonCodes: uniqueSortedStrings(recordErrors.map((entry) => entry.code))
        })
      );
      continue;
    }
    candidateConfigs.push(candidate);
  }
  const caseLabelsById = /* @__PURE__ */ new Map();
  for (const label of caseLabels) {
    if (caseLabelsById.has(label.caseId)) {
      errors.push(issue("DUPLICATE_CASE_LABEL", "A case has duplicate labels."));
    }
    caseLabelsById.set(label.caseId, label);
  }
  const candidatesById = /* @__PURE__ */ new Map();
  for (const candidate of candidateConfigs) {
    if (candidatesById.has(candidate.variantId)) {
      errors.push(
        issue("DUPLICATE_CANDIDATE_CONFIG", "A variant has duplicate configs.")
      );
    }
    candidatesById.set(candidate.variantId, candidate);
  }
  const runIds = /* @__PURE__ */ new Set();
  const runKeys = /* @__PURE__ */ new Set();
  const replicateCounts = /* @__PURE__ */ new Map();
  for (const run of runs) {
    const runKey = [run.caseId, run.variantId, run.replicateId].join("\0");
    const caseVariantKey = [run.caseId, run.variantId].join("\0");
    const replicateCount = (replicateCounts.get(caseVariantKey) ?? 0) + 1;
    replicateCounts.set(caseVariantKey, replicateCount);
    if (replicateCount === MAX_REPLICATES_PER_CASE_VARIANT + 1) {
      errors.push(
        issue(
          "REPLICATE_LIMIT_EXCEEDED",
          "A case and variant exceed the 32-replicate safety ceiling.",
          {
            caseId: run.caseId,
            variantId: run.variantId,
            limit: MAX_REPLICATES_PER_CASE_VARIANT
          }
        )
      );
    }
    if (runIds.has(run.runId)) {
      errors.push(issue("DUPLICATE_RUN_ID", "Run ID is duplicated."));
    }
    if (runKeys.has(runKey)) {
      errors.push(
        issue(
          "DUPLICATE_CASE_VARIANT_REPLICATE",
          "Case, variant, and replicate must be unique."
        )
      );
    }
    runIds.add(run.runId);
    runKeys.add(runKey);
    const candidate = candidatesById.get(run.variantId);
    if (candidate && (run.architectureId !== candidate.architectureId || run.architectureStructuralDigest !== candidate.architectureStructuralDigest)) {
      errors.push(
        issue(
          "RUN_CANDIDATE_ARCHITECTURE_MISMATCH",
          "Run architecture provenance disagrees with its candidate config."
        )
      );
    }
    const label = caseLabelsById.get(run.caseId);
    validateRootCauseReferences(run, label, rubric, errors);
    if (manifest) {
      if (!manifest.caseIds.includes(run.caseId)) {
        errors.push(issue("RUN_OUTSIDE_MANIFEST", "Run case is undeclared."));
      }
      if (!manifest.variantIds.includes(run.variantId)) {
        errors.push(issue("RUN_OUTSIDE_MANIFEST", "Run variant is undeclared."));
      }
      if (run.adjudication && (run.adjudication.rubricId !== manifest.rubricId || run.adjudication.labelVersion !== manifest.labelVersion)) {
        errors.push(
          issue(
            "ADJUDICATION_VERSION_MISMATCH",
            "Run adjudication disagrees with manifest versions."
          )
        );
      }
    }
  }
  if (manifest) {
    if (sourceSummary.exporterVersions.length > 0 && sourceSummary.exporterVersions.some(
      (version) => version !== manifest.exporterVersion
    )) {
      errors.push(
        issue(
          "EXPORTER_VERSION_MISMATCH",
          "Export wrappers disagree with the manifest exporter version."
        )
      );
    }
    if (pricingSnapshot && manifest.pricingSnapshotId !== pricingSnapshot.snapshotId) {
      errors.push(issue("MANIFEST_PRICING_MISMATCH", "Manifest and pricing disagree."));
    }
    if (manifest.lane && !manifest.variantIds.includes(manifest.lane.baselineVariantId)) {
      errors.push(
        issue("UNKNOWN_BASELINE_VARIANT", "Lane baseline is not a manifest variant.")
      );
    }
    for (const variantId of manifest.variantIds) {
      if (!candidatesById.has(variantId)) {
        warnings.push(
          issue(
            "MISSING_CANDIDATE_CONFIG",
            "Manifest variant lacks candidate config.",
            {
              variantId
            }
          )
        );
      }
    }
    for (const caseId of manifest.caseIds) {
      const label = caseLabelsById.get(caseId);
      if (!label) {
        warnings.push(
          issue("MISSING_CASE_LABEL", "Manifest case lacks independent labels.", {
            caseId
          })
        );
      } else if (label.rubricId !== manifest.rubricId || label.labelVersion !== manifest.labelVersion) {
        errors.push(
          issue(
            "CASE_LABEL_VERSION_MISMATCH",
            "Case label disagrees with manifest versions."
          )
        );
      }
    }
  }
  if (rawRuns.length === 0) {
    warnings.push(issue("MISSING_RUN_RECORDS", "No run records were supplied."));
  }
  if (rawLabels.length === 0) {
    warnings.push(issue("MISSING_CASE_LABELS", "No case labels were supplied."));
  }
  if (rawCandidates.length === 0) {
    warnings.push(
      issue("MISSING_CANDIDATE_CONFIGS", "No candidate configs were supplied.")
    );
  }
  const rejectedAffectCohort = rejectedRecords.some(
    (record) => !record.symmetricDeclaredExclusion
  );
  if (rejectedAffectCohort) {
    warnings.push(
      issue(
        "REJECTED_RECORDS_AFFECT_COHORT",
        "Rejected records are not symmetric provenance-backed exclusions."
      )
    );
  }
  const orderedRuns = stableSort2(
    runs,
    (run) => [run.caseId, run.variantId, run.replicateId].join("\0")
  );
  const orderedLabels = stableSort2(caseLabels, (label) => label.caseId);
  const orderedCandidates = stableSort2(
    candidateConfigs,
    (candidate) => candidate.variantId
  );
  if (errors.length === 0 && rejectedRecords.length === 0 && forbidden.length === 0) {
    verifyStructuralReceipts(input, manifest, errors);
  }
  const blocked = errors.length > 0;
  const status = blocked ? "BLOCKED" : rejectedRecords.length > 0 || warnings.length > 0 ? "PARTIAL" : "COMPLETE";
  const reasonCodes = uniqueSortedStrings([
    ...errors.map((entry) => entry.code),
    ...warnings.map((entry) => entry.code)
  ]);
  const counts = {
    sourceRecords: rawRuns.length,
    acceptedRuns: orderedRuns.length,
    rejectedRecords: rejectedRecords.length,
    cases: orderedLabels.length,
    variants: orderedCandidates.length,
    findings: orderedRuns.reduce((total, run) => total + run.findings.length, 0)
  };
  const report = {
    schemaVersion: 1,
    status,
    bundleId,
    laneId: manifest?.lane?.laneId ?? null,
    laneType: manifest?.lane?.laneType ?? null,
    counts,
    ...sourceSummary,
    reasonCodes,
    errors,
    warnings,
    rejectedRecords,
    structuralReceipts: manifest?.structuralReceipts ?? [],
    redactionCounts: isPlainObject2(input.redactionCounts) ? input.redactionCounts : { total: 0 }
  };
  return {
    schemaVersion: 1,
    status,
    bundleId,
    laneId: manifest?.lane?.laneId ?? null,
    laneType: manifest?.lane?.laneType ?? null,
    errors,
    warnings,
    reasonCodes,
    report,
    runs: orderedRuns,
    caseLabels: orderedLabels,
    caseLabelsById: new Map(orderedLabels.map((label) => [label.caseId, label])),
    candidateConfigs: orderedCandidates,
    candidatesById: new Map(
      orderedCandidates.map((candidate) => [candidate.variantId, candidate])
    ),
    manifest,
    lane: manifest?.lane ?? null,
    pricingSnapshot,
    rubric,
    evalProtocol,
    adjudicationProtocol,
    rejectedRecords,
    rankingEligible: !blocked && !rejectedAffectCohort
  };
}
function normalizeLaneBundles(input) {
  const source = Array.isArray(input) ? input : isPlainObject2(input) && Array.isArray(input.laneBundles) ? input.laneBundles : isPlainObject2(input) ? [input] : [];
  if (source.length === 0 || source.length > 8) {
    const error = issue(
      "INVALID_LANE_BUNDLE_COUNT",
      "Expected one to eight already-loaded lane bundles."
    );
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      lanes: [],
      reports: [],
      errors: [error],
      warnings: [],
      reasonCodes: ["INVALID_LANE_BUNDLE_COUNT"]
    };
  }
  const lanes = source.map((bundle) => normalizeLaneBundle(bundle));
  const duplicateErrors = [];
  const bundleIds = lanes.map((lane) => lane.bundleId).filter(Boolean);
  const laneIds = lanes.map((lane) => lane.laneId).filter(Boolean);
  if (new Set(bundleIds).size !== bundleIds.length) {
    duplicateErrors.push(
      issue("DUPLICATE_BUNDLE_ID", "Lane bundle IDs must be unique.")
    );
  }
  if (new Set(laneIds).size !== laneIds.length) {
    duplicateErrors.push(issue("DUPLICATE_LANE_ID", "Lane IDs must be unique."));
  }
  const errors = [...lanes.flatMap((lane) => lane.errors), ...duplicateErrors];
  const warnings = lanes.flatMap((lane) => lane.warnings);
  const status = errors.length > 0 || lanes.some((lane) => lane.status === "BLOCKED") ? "BLOCKED" : lanes.every((lane) => lane.status === "COMPLETE") ? "COMPLETE" : "PARTIAL";
  return {
    schemaVersion: 1,
    status,
    lanes,
    reports: lanes.map((lane) => lane.report),
    errors,
    warnings,
    reasonCodes: uniqueSortedStrings([
      ...errors.map((entry) => entry.code),
      ...warnings.map((entry) => entry.code)
    ])
  };
}

// src/benchmark/normalize.mjs
var SEVERITIES2 = /* @__PURE__ */ new Set(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
var OUTCOMES2 = /* @__PURE__ */ new Set(["ACCEPTED", "REJECTED", "UNKNOWN"]);
var VERIFICATIONS2 = /* @__PURE__ */ new Set(["VERIFIED", "UNVERIFIED", "UNKNOWN"]);
var ADJUDICATION_STATUSES2 = /* @__PURE__ */ new Set(["ADJUDICATED", "PARTIAL", "UNADJUDICATED"]);
function requiredString(value, code, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(issue(code, "A required opaque identifier is missing or invalid."));
    return null;
  }
  return value;
}
function normalizeTags2(value, code, errors) {
  if (value === void 0) {
    return [];
  }
  if (!Array.isArray(value) || value.some((tag) => !isNonEmptyString(tag))) {
    errors.push(issue(code, "Tags must be an array of non-empty strings."));
    return [];
  }
  return uniqueSortedStrings(value);
}
function normalizeUsage2(value, errors) {
  if (value === void 0) {
    return null;
  }
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_USAGE", "Run usage must be an object."));
    return null;
  }
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens"];
  const result2 = {};
  for (const field of fields) {
    if (!isNonNegativeInteger(value[field])) {
      errors.push(
        issue("INVALID_USAGE", "Run token counts must be non-negative safe integers.")
      );
      return null;
    }
    result2[field] = value[field];
  }
  if (result2.cachedInputTokens > result2.inputTokens) {
    errors.push(
      issue("INVALID_USAGE", "Cached input tokens cannot exceed input tokens.")
    );
    return null;
  }
  return result2;
}
function normalizeCost2(value, errors) {
  if (value === void 0) {
    return null;
  }
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_COST", "Run cost must be an object."));
    return null;
  }
  if (!isNonEmptyString(value.currency) || !isNonNegativeNumber(value.amount) || !isNonEmptyString(value.pricingSnapshotId)) {
    errors.push(
      issue(
        "INVALID_COST",
        "Run cost is missing currency, amount, or snapshot identity."
      )
    );
    return null;
  }
  return {
    currency: value.currency,
    amount: roundNumber(value.amount),
    pricingSnapshotId: value.pricingSnapshotId,
    source: "SUPPLIED"
  };
}
function normalizeFinding2(value, errors) {
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_FINDING", "A finding must be an object."));
    return null;
  }
  const findingId = requiredString(value.findingId, "INVALID_FINDING_ID", errors);
  if (!SEVERITIES2.has(value.severity)) {
    errors.push(
      issue("INVALID_FINDING_SEVERITY", "A finding has an unsupported severity.")
    );
  }
  if (value.verification !== void 0 && !VERIFICATIONS2.has(value.verification)) {
    errors.push(
      issue(
        "INVALID_FINDING_VERIFICATION",
        "A finding has an unsupported verification state."
      )
    );
  }
  if (findingId === null || !SEVERITIES2.has(value.severity)) {
    return null;
  }
  return {
    findingId,
    severity: value.severity,
    category: isNonEmptyString(value.category) ? value.category : null,
    verification: value.verification ?? null,
    tags: normalizeTags2(value.tags, "INVALID_FINDING_TAGS", errors)
  };
}
function normalizeFindingLabel2(value, errors) {
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_FINDING_LABEL", "A finding label must be an object."));
    return null;
  }
  const findingId = requiredString(value.findingId, "INVALID_FINDING_LABEL_ID", errors);
  if (!OUTCOMES2.has(value.outcome)) {
    errors.push(
      issue("INVALID_FINDING_OUTCOME", "A finding label has an unsupported outcome.")
    );
  }
  const matched = value.matchedGroundTruthIds ?? [];
  if (!Array.isArray(matched) || matched.some((id) => !isNonEmptyString(id))) {
    errors.push(
      issue("INVALID_MATCH_IDS", "Matched ground-truth IDs must be opaque strings.")
    );
    return null;
  }
  if (new Set(matched).size !== matched.length) {
    errors.push(
      issue("DUPLICATE_MATCH_ID", "A finding label repeats a ground-truth match.")
    );
  }
  if (value.outcome === "REJECTED" && matched.length > 0) {
    errors.push(
      issue(
        "CONTRADICTORY_ADJUDICATION",
        "A rejected finding cannot claim ground-truth matches."
      )
    );
  }
  if (findingId === null || !OUTCOMES2.has(value.outcome)) {
    return null;
  }
  return {
    findingId,
    outcome: value.outcome,
    matchedGroundTruthIds: uniqueSortedStrings(matched)
  };
}
function normalizeAdjudication2(value, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_ADJUDICATION", "Adjudication must be an object."));
    return null;
  }
  if (!ADJUDICATION_STATUSES2.has(value.status)) {
    errors.push(
      issue("INVALID_ADJUDICATION_STATUS", "Adjudication has an unsupported status.")
    );
  }
  const labels = value.findingLabels ?? [];
  if (!Array.isArray(labels)) {
    errors.push(issue("INVALID_FINDING_LABELS", "Finding labels must be an array."));
    return null;
  }
  const normalizedLabels = labels.map((label) => normalizeFindingLabel2(label, errors)).filter(Boolean);
  const ids = /* @__PURE__ */ new Set();
  for (const label of normalizedLabels) {
    if (ids.has(label.findingId)) {
      errors.push(
        issue(
          "DUPLICATE_FINDING_LABEL",
          "A finding has more than one adjudication label."
        )
      );
    }
    ids.add(label.findingId);
  }
  if (!ADJUDICATION_STATUSES2.has(value.status)) {
    return null;
  }
  return {
    status: value.status,
    rubricId: isNonEmptyString(value.rubricId) ? value.rubricId : null,
    labelVersion: isNonEmptyString(value.labelVersion) ? value.labelVersion : null,
    findingLabels: stableSort2(normalizedLabels, (label) => label.findingId),
    rootCauseScore: isFiniteNumber(value.rootCauseScore) ? roundNumber(value.rootCauseScore) : null
  };
}
function normalizeRun2(value, errors) {
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_RUN_RECORD", "A run record must be an object."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_RUN_SCHEMA", "Run records must use schemaVersion 1.")
    );
  }
  const caseId = requiredString(value.caseId, "INVALID_CASE_ID", errors);
  const variantId = requiredString(value.variantId, "INVALID_VARIANT_ID", errors);
  const runId = requiredString(value.runId, "INVALID_RUN_ID", errors);
  const contextDigest = requiredString(
    value.contextDigest,
    "INVALID_CONTEXT_DIGEST",
    errors
  );
  const toolContractId = requiredString(
    value.toolContractId,
    "INVALID_TOOL_CONTRACT_ID",
    errors
  );
  if (parseUtcTimestamp(value.startedAt) === void 0) {
    errors.push(
      issue("INVALID_STARTED_AT", "Run timestamps must be RFC 3339 UTC values.")
    );
  }
  if (!isNonNegativeNumber(value.latencyMs)) {
    errors.push(
      issue("INVALID_LATENCY", "Run latency must be a non-negative finite number.")
    );
  }
  if (!Array.isArray(value.findings)) {
    errors.push(issue("INVALID_FINDINGS", "Run findings must be an array."));
  }
  const findings = Array.isArray(value.findings) ? value.findings.map((finding) => normalizeFinding2(finding, errors)).filter(Boolean) : [];
  const findingIds = /* @__PURE__ */ new Set();
  for (const finding of findings) {
    if (findingIds.has(finding.findingId)) {
      errors.push(issue("DUPLICATE_FINDING_ID", "A run repeats a finding ID."));
    }
    findingIds.add(finding.findingId);
  }
  const adjudication = normalizeAdjudication2(value.adjudication, errors);
  if (adjudication) {
    for (const label of adjudication.findingLabels) {
      if (!findingIds.has(label.findingId)) {
        errors.push(
          issue(
            "UNKNOWN_FINDING_LABEL",
            "An adjudication references an unknown finding."
          )
        );
      }
    }
  }
  if (caseId === null || variantId === null || runId === null || contextDigest === null || toolContractId === null || parseUtcTimestamp(value.startedAt) === void 0 || !isNonNegativeNumber(value.latencyMs)) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    variantId,
    runId,
    contextDigest,
    toolContractId,
    startedAt: value.startedAt,
    latencyMs: roundNumber(value.latencyMs),
    usage: normalizeUsage2(value.usage, errors),
    cost: normalizeCost2(value.cost, errors),
    findings: stableSort2(findings, (finding) => finding.findingId),
    adjudication
  };
}
function normalizeCaseLabel2(value, errors) {
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_CASE_LABEL", "A case label must be an object."));
    return null;
  }
  if (value.schemaVersion !== 1) {
    errors.push(
      issue("UNSUPPORTED_CASE_LABEL_SCHEMA", "Case labels must use schemaVersion 1.")
    );
  }
  const caseId = requiredString(value.caseId, "INVALID_CASE_LABEL_ID", errors);
  const rubricId = requiredString(value.rubricId, "INVALID_CASE_RUBRIC_ID", errors);
  const labelVersion = requiredString(
    value.labelVersion,
    "INVALID_CASE_LABEL_VERSION",
    errors
  );
  if (!Array.isArray(value.groundTruth)) {
    errors.push(issue("INVALID_GROUND_TRUTH", "Case ground truth must be an array."));
  }
  const groundTruth = [];
  const ids = /* @__PURE__ */ new Set();
  for (const item of Array.isArray(value.groundTruth) ? value.groundTruth : []) {
    if (!isPlainObject2(item) || !isNonEmptyString(item.groundTruthId) || !SEVERITIES2.has(item.severity)) {
      errors.push(issue("INVALID_GROUND_TRUTH", "A ground-truth item is malformed."));
      continue;
    }
    if (ids.has(item.groundTruthId)) {
      errors.push(
        issue("DUPLICATE_GROUND_TRUTH_ID", "A case repeats a ground-truth ID.")
      );
    }
    ids.add(item.groundTruthId);
    groundTruth.push({
      groundTruthId: item.groundTruthId,
      severity: item.severity,
      tags: normalizeTags2(item.tags, "INVALID_GROUND_TRUTH_TAGS", errors)
    });
  }
  if (caseId === null || rubricId === null || labelVersion === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    caseId,
    rubricId,
    labelVersion,
    groundTruth: stableSort2(groundTruth, (item) => item.groundTruthId)
  };
}
function normalizeRubric(value, warnings, errors) {
  if (value === void 0 || value === null) {
    warnings.push(
      issue("MISSING_RUBRIC", "Quality metrics require a versioned rubric.")
    );
    return null;
  }
  if (!isPlainObject2(value)) {
    errors.push(issue("INVALID_RUBRIC", "Rubric must be an object."));
    return null;
  }
  const rubricId = requiredString(value.rubricId, "INVALID_RUBRIC_ID", errors);
  const version = requiredString(
    value.version ?? value.labelVersion,
    "INVALID_RUBRIC_VERSION",
    errors
  );
  const weights = value.severityWeights;
  if (!isPlainObject2(weights)) {
    warnings.push(
      issue("MISSING_SEVERITY_WEIGHTS", "Recall requires explicit severity weights.")
    );
  }
  const severityWeights = {};
  for (const severity of SEVERITIES2) {
    if (!isNonEmptyString(severity)) {
      continue;
    }
    if (isPlainObject2(weights) && isNonNegativeNumber(weights[severity])) {
      severityWeights[severity] = roundNumber(weights[severity]);
    }
  }
  if (Object.keys(severityWeights).length !== SEVERITIES2.size) {
    warnings.push(
      issue(
        "INCOMPLETE_SEVERITY_WEIGHTS",
        "Recall requires a weight for every severity."
      )
    );
  }
  const matchingRules = isPlainObject2(value.matchingRules) ? {
    allowOneFindingMultipleGroundTruth: value.matchingRules.allowOneFindingMultipleGroundTruth === true,
    allowMultipleFindingsPerGroundTruth: value.matchingRules.allowMultipleFindingsPerGroundTruth === true
  } : null;
  if (matchingRules === null) {
    warnings.push(
      issue("MISSING_MATCHING_RULES", "Recall requires explicit matching rules.")
    );
  }
  if (rubricId === null || version === null) {
    return null;
  }
  return { rubricId, version, severityWeights, matchingRules };
}
function normalizePricing(value, warnings, errors) {
  if (value === void 0 || value === null) {
    warnings.push(
      issue(
        "MISSING_PRICING_SNAPSHOT",
        "Cost reconstruction requires a pricing snapshot."
      )
    );
    return null;
  }
  if (!isPlainObject2(value)) {
    errors.push(
      issue("INVALID_PRICING_SNAPSHOT", "Pricing snapshot must be an object.")
    );
    return null;
  }
  const snapshotId = requiredString(value.snapshotId, "INVALID_PRICING_ID", errors);
  const currency = requiredString(value.currency, "INVALID_PRICING_CURRENCY", errors);
  if (parseUtcTimestamp(value.effectiveAt) === void 0) {
    errors.push(
      issue(
        "INVALID_PRICING_EFFECTIVE_AT",
        "Pricing effectiveAt must be RFC 3339 UTC."
      )
    );
  }
  if (!Array.isArray(value.rates)) {
    errors.push(issue("INVALID_PRICING_RATES", "Pricing rates must be an array."));
  }
  const rates = {};
  for (const rate of Array.isArray(value.rates) ? value.rates : []) {
    if (!isPlainObject2(rate) || !isNonEmptyString(rate.variantId) || !isNonNegativeNumber(rate.inputPerMillion) || !isNonNegativeNumber(rate.cachedInputPerMillion) || !isNonNegativeNumber(rate.outputPerMillion)) {
      errors.push(issue("INVALID_PRICING_RATE", "A pricing rate is malformed."));
      continue;
    }
    if (rates[rate.variantId]) {
      errors.push(issue("DUPLICATE_PRICING_RATE", "Pricing repeats a variant rate."));
      continue;
    }
    rates[rate.variantId] = {
      inputPerMillion: roundNumber(rate.inputPerMillion),
      cachedInputPerMillion: roundNumber(rate.cachedInputPerMillion),
      outputPerMillion: roundNumber(rate.outputPerMillion)
    };
  }
  if (snapshotId === null || currency === null || parseUtcTimestamp(value.effectiveAt) === void 0) {
    return null;
  }
  return {
    snapshotId,
    currency,
    effectiveAt: value.effectiveAt,
    provenance: isPlainObject2(value.provenance) && isNonEmptyString(value.provenance.kind) ? { kind: value.provenance.kind } : null,
    rates
  };
}
function normalizeManifest2(value, errors) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!isPlainObject2(value)) {
    errors.push(
      issue("INVALID_BENCHMARK_MANIFEST", "Benchmark manifest must be an object.")
    );
    return null;
  }
  const corpusId = requiredString(value.corpusId, "INVALID_CORPUS_ID", errors);
  const exporterVersion = requiredString(
    value.exporterVersion,
    "INVALID_EXPORTER_VERSION",
    errors
  );
  const toolContractId = requiredString(
    value.toolContractId,
    "INVALID_MANIFEST_TOOL_CONTRACT",
    errors
  );
  const rubricId = requiredString(value.rubricId, "INVALID_MANIFEST_RUBRIC", errors);
  const labelVersion = requiredString(
    value.labelVersion,
    "INVALID_MANIFEST_LABEL_VERSION",
    errors
  );
  const pricingSnapshotId = requiredString(
    value.pricingSnapshotId,
    "INVALID_MANIFEST_PRICING",
    errors
  );
  const caseIds = Array.isArray(value.caseIds) ? uniqueSortedStrings(value.caseIds) : [];
  const variantIds = Array.isArray(value.variantIds) ? uniqueSortedStrings(value.variantIds) : [];
  if (!Array.isArray(value.caseIds) || caseIds.length === 0 || caseIds.length !== value.caseIds.length) {
    errors.push(
      issue(
        "INVALID_MANIFEST_CASES",
        "Manifest case IDs must be unique opaque strings."
      )
    );
  }
  if (!Array.isArray(value.variantIds) || variantIds.length === 0 || variantIds.length !== value.variantIds.length) {
    errors.push(
      issue(
        "INVALID_MANIFEST_VARIANTS",
        "Manifest variant IDs must be unique aliases."
      )
    );
  }
  if (corpusId === null || exporterVersion === null || toolContractId === null || rubricId === null || labelVersion === null || pricingSnapshotId === null) {
    return null;
  }
  return {
    corpusId,
    exporterVersion,
    caseIds,
    variantIds,
    toolContractId,
    rubricId,
    labelVersion,
    pricingSnapshotId
  };
}
function crossValidateManifest(manifest, runs, caseLabels, rubric, pricingSnapshot, candidateConfigs, errors) {
  if (!manifest) {
    return;
  }
  const caseIds = new Set(manifest.caseIds);
  const variantIds = new Set(manifest.variantIds);
  for (const run of runs) {
    if (!caseIds.has(run.caseId)) {
      errors.push(
        issue("RUN_OUTSIDE_MANIFEST", "A run case is not declared by the manifest.")
      );
    }
    if (!variantIds.has(run.variantId)) {
      errors.push(
        issue(
          "RUN_VARIANT_OUTSIDE_MANIFEST",
          "A run variant is not declared by the manifest."
        )
      );
    }
    if (run.toolContractId !== manifest.toolContractId) {
      errors.push(
        issue(
          "TOOL_CONTRACT_MISMATCH",
          "A run tool contract differs from the manifest."
        )
      );
    }
  }
  for (const label of caseLabels) {
    if (!caseIds.has(label.caseId)) {
      errors.push(
        issue(
          "LABEL_OUTSIDE_MANIFEST",
          "A case label is not declared by the manifest."
        )
      );
    }
    if (label.rubricId !== manifest.rubricId || label.labelVersion !== manifest.labelVersion) {
      errors.push(
        issue(
          "MANIFEST_LABEL_MISMATCH",
          "A case label differs from manifest provenance."
        )
      );
    }
  }
  if (rubric && (rubric.rubricId !== manifest.rubricId || rubric.version !== manifest.labelVersion)) {
    errors.push(issue("MANIFEST_RUBRIC_MISMATCH", "Rubric differs from the manifest."));
  }
  if (pricingSnapshot && pricingSnapshot.snapshotId !== manifest.pricingSnapshotId) {
    errors.push(
      issue("MANIFEST_PRICING_MISMATCH", "Pricing snapshot differs from the manifest.")
    );
  }
  const candidateIds2 = new Set(
    candidateConfigs.map((candidate) => candidate.variantId)
  );
  for (const candidate of candidateConfigs) {
    if (!variantIds.has(candidate.variantId)) {
      errors.push(
        issue(
          "CANDIDATE_OUTSIDE_MANIFEST",
          "A candidate config is not declared by the manifest."
        )
      );
    }
  }
  for (const variantId of manifest.variantIds) {
    if (!candidateIds2.has(variantId)) {
      errors.push(
        issue(
          "MISSING_CANDIDATE_CONFIG",
          "Every manifest variant requires a candidate config."
        )
      );
    }
  }
}
function reconstructCost(run, pricing, warnings) {
  if (run.cost) {
    if (pricing && (run.cost.currency !== pricing.currency || run.cost.pricingSnapshotId !== pricing.snapshotId)) {
      warnings.push(
        issue(
          "COST_PRICING_MISMATCH",
          "Supplied run cost does not match the supplied snapshot."
        )
      );
    }
    return run;
  }
  const rate = pricing?.rates[run.variantId];
  if (!pricing || !rate || !run.usage) {
    return run;
  }
  const uncached = run.usage.inputTokens - run.usage.cachedInputTokens;
  const amount = (uncached * rate.inputPerMillion + run.usage.cachedInputTokens * rate.cachedInputPerMillion + run.usage.outputTokens * rate.outputPerMillion) / 1e6;
  return {
    ...run,
    cost: {
      currency: pricing.currency,
      amount: roundNumber(amount),
      pricingSnapshotId: pricing.snapshotId,
      source: "RECONSTRUCTED"
    }
  };
}
function crossValidate(runs, labelsByCase, rubric, errors, warnings) {
  for (const run of runs) {
    const label = labelsByCase.get(run.caseId);
    const adjudication = run.adjudication;
    if (!adjudication) {
      continue;
    }
    if (adjudication.rubricId && label && adjudication.rubricId !== label.rubricId) {
      errors.push(
        issue(
          "RUBRIC_VERSION_MISMATCH",
          "Run adjudication and case label use different rubrics."
        )
      );
    }
    if (adjudication.labelVersion && label && adjudication.labelVersion !== label.labelVersion) {
      errors.push(
        issue(
          "LABEL_VERSION_MISMATCH",
          "Run adjudication and case label use different label versions."
        )
      );
    }
    if (rubric && label && (label.rubricId !== rubric.rubricId || label.labelVersion !== rubric.version)) {
      errors.push(
        issue(
          "RUBRIC_VERSION_MISMATCH",
          "Case label and rubric versions do not match."
        )
      );
    }
    const groundTruthIds = new Set(
      label?.groundTruth.map((item) => item.groundTruthId) ?? []
    );
    const seenGroundTruth = /* @__PURE__ */ new Map();
    for (const findingLabel of adjudication.findingLabels) {
      for (const groundTruthId of findingLabel.matchedGroundTruthIds) {
        if (!groundTruthIds.has(groundTruthId)) {
          errors.push(
            issue(
              "UNKNOWN_GROUND_TRUTH_MATCH",
              "A finding references an unknown ground-truth ID."
            )
          );
        }
        const count = (seenGroundTruth.get(groundTruthId) ?? 0) + 1;
        seenGroundTruth.set(groundTruthId, count);
        if (rubric?.matchingRules?.allowMultipleFindingsPerGroundTruth === false && count > 1) {
          errors.push(
            issue(
              "CONTRADICTORY_MATCH",
              "Multiple findings match one ground-truth ID against the rubric."
            )
          );
        }
      }
      if (rubric?.matchingRules?.allowOneFindingMultipleGroundTruth === false && findingLabel.matchedGroundTruthIds.length > 1) {
        errors.push(
          issue(
            "CONTRADICTORY_MATCH",
            "One finding matches multiple ground-truth IDs against the rubric."
          )
        );
      }
    }
    if (adjudication.status === "ADJUDICATED" && adjudication.findingLabels.length !== run.findings.length) {
      errors.push(
        issue(
          "INCOMPLETE_ADJUDICATION",
          "An adjudicated run does not label every finding."
        )
      );
    }
    if (!label && adjudication.findingLabels.some((item) => item.matchedGroundTruthIds.length > 0)) {
      errors.push(
        issue(
          "MISSING_CASE_LABEL",
          "Matched findings require a case ground-truth label."
        )
      );
    } else if (!label) {
      warnings.push(
        issue(
          "MISSING_CASE_LABEL",
          "Quality metrics are unavailable for a run without case labels."
        )
      );
    }
  }
}
function normalizeBenchmarkInput(input = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject2(input)) {
    return {
      status: "BLOCKED",
      errors: [issue("INVALID_BENCHMARK_INPUT", "Benchmark input must be an object.")],
      warnings: [],
      runs: [],
      caseLabels: [],
      variantIds: []
    };
  }
  const rawRuns = input.runRecords ?? input.runs ?? [];
  const rawLabels = input.caseLabels ?? input.labels ?? [];
  if (!Array.isArray(rawRuns)) {
    errors.push(issue("INVALID_RUN_RECORDS", "Run records must be an array."));
  }
  if (!Array.isArray(rawLabels)) {
    errors.push(issue("INVALID_CASE_LABELS", "Case labels must be an array."));
  }
  const rubric = normalizeRubric(input.rubric, warnings, errors);
  const pricingSnapshot = normalizePricing(
    input.pricingSnapshot ?? input.pricing,
    warnings,
    errors
  );
  const manifest = normalizeManifest2(input.benchmarkManifest ?? input.manifest, errors);
  const caseLabels = (Array.isArray(rawLabels) ? rawLabels : []).map((label) => normalizeCaseLabel2(label, errors)).filter(Boolean);
  const labelsByCase = /* @__PURE__ */ new Map();
  for (const label of caseLabels) {
    if (labelsByCase.has(label.caseId)) {
      errors.push(
        issue("DUPLICATE_CASE_LABEL", "A case has more than one ground-truth label.")
      );
    }
    labelsByCase.set(label.caseId, label);
  }
  let runs = (Array.isArray(rawRuns) ? rawRuns : []).map((run) => normalizeRun2(run, errors)).filter(Boolean);
  const pairKeys = /* @__PURE__ */ new Set();
  const runIds = /* @__PURE__ */ new Set();
  for (const run of runs) {
    const pairKey = `${run.caseId}\0${run.variantId}`;
    if (pairKeys.has(pairKey)) {
      errors.push(
        issue(
          "DUPLICATE_CASE_VARIANT_RUN",
          "A case and variant pair has more than one run."
        )
      );
    }
    pairKeys.add(pairKey);
    if (runIds.has(run.runId)) {
      errors.push(issue("DUPLICATE_RUN_ID", "A run ID is repeated."));
    }
    runIds.add(run.runId);
  }
  runs = runs.map((run) => reconstructCost(run, pricingSnapshot, warnings));
  crossValidate(runs, labelsByCase, rubric, errors, warnings);
  const rawCandidates = input.candidateConfigs ?? input.candidates;
  const candidateConfigs = Array.isArray(rawCandidates) ? [...rawCandidates].filter(
    (candidate) => isPlainObject2(candidate) && isNonEmptyString(candidate.variantId)
  ).map((candidate) => ({
    variantId: candidate.variantId,
    modelAlias: isNonEmptyString(candidate.modelAlias) ? candidate.modelAlias : null,
    reasoningProfile: isNonEmptyString(candidate.reasoningProfile) ? candidate.reasoningProfile : null,
    promptConfigDigest: isNonEmptyString(candidate.promptConfigDigest) ? candidate.promptConfigDigest : null,
    routingPolicyId: isNonEmptyString(candidate.routingPolicyId) ? candidate.routingPolicyId : null,
    declaredContextClass: isNonEmptyString(candidate.declaredContextClass) ? candidate.declaredContextClass : null
  })).sort((left, right) => compareText(left.variantId, right.variantId)) : [];
  const candidateIds2 = /* @__PURE__ */ new Set();
  for (const candidate of candidateConfigs) {
    if (candidateIds2.has(candidate.variantId)) {
      errors.push(
        issue("DUPLICATE_CANDIDATE_CONFIG", "A candidate variant is repeated.")
      );
    }
    candidateIds2.add(candidate.variantId);
  }
  crossValidateManifest(
    manifest,
    runs,
    caseLabels,
    rubric,
    pricingSnapshot,
    candidateConfigs,
    errors
  );
  const sortedRuns = [...runs].sort(
    (left, right) => compareText(left.caseId, right.caseId) || compareText(left.variantId, right.variantId) || compareText(left.runId, right.runId)
  );
  const variantIds = uniqueSortedStrings([
    ...sortedRuns.map((run) => run.variantId),
    ...candidateConfigs.map((candidate) => candidate.variantId)
  ]);
  const sortedLabels = stableSort2(caseLabels, (label) => label.caseId);
  return {
    status: errors.length > 0 ? "BLOCKED" : warnings.length > 0 ? "PARTIAL" : "COMPLETE",
    errors,
    warnings,
    runs: sortedRuns,
    caseLabels: sortedLabels,
    caseLabelsById: new Map(sortedLabels.map((label) => [label.caseId, label])),
    rubric,
    pricingSnapshot,
    candidateConfigs,
    variantIds,
    manifest
  };
}

// src/benchmark/paired.mjs
var MAX_REPLICATES_PER_CASE_VARIANT2 = 32;
function valueSet(runs, selector) {
  return new Set(
    runs.map(selector).filter((value) => value !== null && value !== void 0)
  );
}
function addMismatchReason(reasons, runs, selector, code) {
  if (valueSet(runs, selector).size > 1) {
    reasons.push(code);
  }
}
function runPricingKey(run) {
  if (!run.cost) {
    return null;
  }
  return `${run.cost.currency}\0${run.cost.pricingSnapshotId}`;
}
function adjudicationKey(run) {
  if (!run.adjudication?.rubricId || !run.adjudication?.labelVersion) {
    return null;
  }
  return `${run.adjudication.rubricId}\0${run.adjudication.labelVersion}`;
}
function buildPairedComparison(normalized, options = {}) {
  if (!normalized || normalized.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      errors: [
        issue("NORMALIZATION_BLOCKED", "Pairing requires valid normalized runs.")
      ],
      warnings: [],
      variantIds: [],
      baselineVariantId: null,
      pairedCaseIds: [],
      pairedCases: [],
      excludedCases: [],
      comparisons: []
    };
  }
  const requestedVariantIds = Array.isArray(options.variantIds) ? uniqueSortedStrings(options.variantIds) : normalized.variantIds ?? [];
  const variantIds = requestedVariantIds.length > 0 ? requestedVariantIds : uniqueSortedStrings(normalized.runs.map((run) => run.variantId));
  const warnings = [];
  const errors = [];
  if (variantIds.length < 2) {
    warnings.push(
      issue(
        "INSUFFICIENT_VARIANTS",
        "Paired comparison requires at least two variants."
      )
    );
  }
  const baselineVariantId = isNonEmptyString(options.baselineVariantId) ? options.baselineVariantId : variantIds[0] ?? null;
  if (baselineVariantId && !variantIds.includes(baselineVariantId)) {
    errors.push(
      issue(
        "UNKNOWN_BASELINE_VARIANT",
        "The requested baseline is not in the comparison set."
      )
    );
  }
  const explicitExclusions = new Set(
    Array.isArray(options.excludedCaseIds) ? options.excludedCaseIds.filter((caseId) => isNonEmptyString(caseId)) : []
  );
  const byCase = /* @__PURE__ */ new Map();
  for (const run of normalized.runs) {
    if (!variantIds.includes(run.variantId)) {
      continue;
    }
    if (!byCase.has(run.caseId)) {
      byCase.set(run.caseId, /* @__PURE__ */ new Map());
    }
    byCase.get(run.caseId).set(run.variantId, run);
  }
  const pairedCases = [];
  const excludedCases = [];
  const declaredCaseIds = Array.isArray(normalized.manifest?.caseIds) ? normalized.manifest.caseIds : [];
  const caseIds = uniqueSortedStrings([...byCase.keys(), ...declaredCaseIds]);
  for (const caseId of caseIds) {
    const runsByVariant = byCase.get(caseId) ?? /* @__PURE__ */ new Map();
    const reasons = [];
    if (explicitExclusions.has(caseId)) {
      reasons.push("EXPLICIT_EXCLUSION");
    }
    const missingVariants = variantIds.filter(
      (variantId) => !runsByVariant.has(variantId)
    );
    if (missingVariants.length > 0) {
      reasons.push("MISSING_VARIANT_RUN");
    }
    const runs = variantIds.map((variantId) => runsByVariant.get(variantId)).filter(Boolean);
    addMismatchReason(
      reasons,
      runs,
      (run) => run.contextDigest,
      "CONTEXT_DIGEST_MISMATCH"
    );
    addMismatchReason(
      reasons,
      runs,
      (run) => run.toolContractId,
      "TOOL_CONTRACT_MISMATCH"
    );
    addMismatchReason(
      reasons,
      runs,
      adjudicationKey,
      "RUBRIC_OR_LABEL_VERSION_MISMATCH"
    );
    addMismatchReason(reasons, runs, runPricingKey, "PRICING_SEMANTICS_MISMATCH");
    if (reasons.length > 0) {
      excludedCases.push({
        caseId,
        reasonCodes: uniqueSortedStrings(reasons),
        missingVariantIds: missingVariants
      });
      continue;
    }
    const orderedRuns = {};
    for (const variantId of variantIds) {
      orderedRuns[variantId] = runsByVariant.get(variantId);
    }
    pairedCases.push({ caseId, runsByVariant: orderedRuns });
  }
  for (const caseId of [...explicitExclusions].sort(compareText)) {
    if (!byCase.has(caseId)) {
      excludedCases.push({
        caseId,
        reasonCodes: ["EXPLICIT_EXCLUSION", "UNKNOWN_CASE_ID"],
        missingVariantIds: []
      });
    }
  }
  const pairedCaseIds = pairedCases.map((item) => item.caseId);
  const comparisons = baselineVariantId ? variantIds.filter((variantId) => variantId !== baselineVariantId).map((candidateVariantId) => ({
    baselineVariantId,
    candidateVariantId,
    pairedCaseIds: [...pairedCaseIds],
    pairedCaseCount: pairedCaseIds.length
  })) : [];
  if (pairedCaseIds.length === 0) {
    warnings.push(
      issue("NO_PAIRED_CASES", "No comparable paired cases remain after exclusions.")
    );
  }
  return {
    status: errors.length > 0 ? "BLOCKED" : pairedCaseIds.length === 0 || variantIds.length < 2 ? "INSUFFICIENT_EVIDENCE" : excludedCases.length > 0 || warnings.length > 0 ? "PARTIAL" : "COMPLETE",
    errors,
    warnings,
    variantIds,
    baselineVariantId,
    pairedCaseIds,
    pairedCases,
    excludedCases: stableSort2(excludedCases, (item) => item.caseId),
    comparisons
  };
}
function declaredExclusionByCase(protocol) {
  const result2 = /* @__PURE__ */ new Map();
  if (!isClosedEvalProtocolContract(protocol) || protocol?.missingReplicatePolicy !== "SYMMETRIC_EXCLUDE_CASE" || !Array.isArray(protocol?.predeclaredExclusions)) {
    return result2;
  }
  const exclusions = protocol.predeclaredExclusions;
  for (const entry of exclusions) {
    if (entry && isNonEmptyString(entry.caseId) && entry.symmetric === true && isOpaqueDigestId(entry.provenanceDigest)) {
      result2.set(entry.caseId, entry);
    }
  }
  return result2;
}
function laneRunPricingKey(run) {
  if (!run?.cost) {
    return null;
  }
  return [run.cost.currency, run.cost.pricingSnapshotId, run.cost.costBasis].join(
    "\0"
  );
}
function sameValue(runs, selector) {
  const values = valueSet(runs, selector);
  return values.size <= 1;
}
function replicateLimitErrors(runs) {
  const counts = /* @__PURE__ */ new Map();
  const errors = [];
  for (const run of runs) {
    if (!isNonEmptyString(run?.caseId) || !isNonEmptyString(run?.variantId)) {
      continue;
    }
    const key = [run.caseId, run.variantId].join("\0");
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count === MAX_REPLICATES_PER_CASE_VARIANT2 + 1) {
      errors.push(
        issue(
          "REPLICATE_LIMIT_EXCEEDED",
          "A case and variant exceed the 32-replicate safety ceiling.",
          {
            caseId: run.caseId,
            variantId: run.variantId,
            limit: MAX_REPLICATES_PER_CASE_VARIANT2
          }
        )
      );
    }
  }
  return errors;
}
function buildLanePairedComparison(normalized, options = {}) {
  if (!normalized || normalized.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      errors: [
        issue("NORMALIZATION_BLOCKED", "Lane pairing requires normalized input.")
      ],
      warnings: [],
      variantIds: [],
      baselineVariantId: null,
      pairedCaseIds: [],
      pairedCases: [],
      excludedCases: [],
      comparisons: [],
      unsafeExclusions: []
    };
  }
  const variantIds = Array.isArray(options.variantIds) && options.variantIds.length > 0 ? uniqueSortedStrings(options.variantIds) : Array.isArray(normalized.manifest?.variantIds) ? normalized.manifest.variantIds : uniqueSortedStrings((normalized.runs ?? []).map((run) => run.variantId));
  const baselineVariantId = options.baselineVariantId ?? normalized.lane?.baselineVariantId ?? normalized.manifest?.lane?.baselineVariantId ?? variantIds[0] ?? null;
  const errors = [];
  const warnings = [];
  if (variantIds.length < 2) {
    warnings.push(
      issue("INSUFFICIENT_VARIANTS", "Lane pairing requires at least two variants.")
    );
  }
  if (baselineVariantId && !variantIds.includes(baselineVariantId)) {
    errors.push(
      issue("UNKNOWN_BASELINE_VARIANT", "Lane baseline is not a declared variant.")
    );
  }
  errors.push(...replicateLimitErrors(normalized.runs ?? []));
  if (errors.length > 0) {
    return {
      status: "BLOCKED",
      errors,
      warnings,
      variantIds,
      baselineVariantId,
      pairedCaseIds: [],
      pairedCases: [],
      excludedCases: [],
      unsafeExclusions: [],
      comparisons: []
    };
  }
  const declaredExclusions = declaredExclusionByCase(
    options.evalProtocol ?? normalized.evalProtocol
  );
  const explicitExclusions = new Set(
    Array.isArray(options.excludedCaseIds) ? options.excludedCaseIds.filter(isNonEmptyString) : []
  );
  const byCase = /* @__PURE__ */ new Map();
  for (const run of normalized.runs ?? []) {
    if (!variantIds.includes(run.variantId)) {
      continue;
    }
    if (!byCase.has(run.caseId)) {
      byCase.set(run.caseId, /* @__PURE__ */ new Map());
    }
    const byVariant = byCase.get(run.caseId);
    if (!byVariant.has(run.variantId)) {
      byVariant.set(run.variantId, /* @__PURE__ */ new Map());
    }
    byVariant.get(run.variantId).set(run.replicateId ?? "replicate_001", run);
  }
  const declaredCaseIds = Array.isArray(normalized.manifest?.caseIds) ? normalized.manifest.caseIds : [];
  const caseIds = uniqueSortedStrings([...declaredCaseIds, ...byCase.keys()]);
  const pairedCases = [];
  const excludedCases = [];
  const unsafeExclusions = [];
  for (const caseId of caseIds) {
    const byVariant = byCase.get(caseId) ?? /* @__PURE__ */ new Map();
    const reasons = [];
    const missingVariantIds = variantIds.filter(
      (variantId) => !byVariant.has(variantId)
    );
    if (missingVariantIds.length > 0) {
      reasons.push("MISSING_VARIANT_RUN");
    }
    const replicateIds = uniqueSortedStrings(
      variantIds.flatMap((variantId) => [...byVariant.get(variantId)?.keys() ?? []])
    );
    const missingReplicates = [];
    for (const replicateId of replicateIds) {
      const missing = variantIds.filter(
        (variantId) => !byVariant.get(variantId)?.has(replicateId)
      );
      if (missing.length > 0) {
        missingReplicates.push({ replicateId, missingVariantIds: missing });
      }
    }
    if (replicateIds.length === 0 || missingReplicates.length > 0) {
      reasons.push("UNBALANCED_REPLICATES");
    }
    for (const replicateId of replicateIds) {
      const runs = variantIds.map((variantId) => byVariant.get(variantId)?.get(replicateId)).filter(Boolean);
      if (!sameValue(runs, (run) => run.contextDigest)) {
        reasons.push("CONTEXT_DIGEST_MISMATCH");
      }
      if (!sameValue(runs, laneRunPricingKey)) {
        reasons.push("PRICING_SEMANTICS_MISMATCH");
      }
      if (!sameValue(
        runs,
        (run) => run.adjudication ? [run.adjudication.rubricId, run.adjudication.labelVersion].join("\0") : null
      )) {
        reasons.push("RUBRIC_OR_LABEL_VERSION_MISMATCH");
      }
    }
    const declared = declaredExclusions.get(caseId);
    if (explicitExclusions.has(caseId)) {
      reasons.push("EXPLICIT_EXCLUSION");
    }
    if (declared) {
      reasons.push("PREDECLARED_SYMMETRIC_EXCLUSION");
    }
    if (reasons.length > 0) {
      const safe = Boolean(declared) && reasons.every(
        (reason) => [
          "PREDECLARED_SYMMETRIC_EXCLUSION",
          "MISSING_VARIANT_RUN",
          "UNBALANCED_REPLICATES"
        ].includes(reason)
      );
      const exclusion = {
        caseId,
        reasonCodes: uniqueSortedStrings(reasons),
        missingVariantIds,
        missingReplicates,
        symmetricDeclared: safe
      };
      excludedCases.push(exclusion);
      if (!safe) {
        unsafeExclusions.push(exclusion);
      }
      continue;
    }
    const runsByVariant = {};
    for (const variantId of variantIds) {
      runsByVariant[variantId] = replicateIds.map(
        (replicateId) => byVariant.get(variantId).get(replicateId)
      );
    }
    pairedCases.push({ caseId, replicateIds, runsByVariant });
  }
  const pairedCaseIds = pairedCases.map((item) => item.caseId);
  const comparisons = baselineVariantId ? variantIds.filter((variantId) => variantId !== baselineVariantId).map((candidateVariantId) => ({
    baselineVariantId,
    candidateVariantId,
    pairedCaseIds: [...pairedCaseIds],
    pairedCaseCount: pairedCaseIds.length
  })) : [];
  if (pairedCaseIds.length === 0) {
    warnings.push(issue("NO_PAIRED_CASES", "No lane cases remain paired."));
  }
  if (unsafeExclusions.length > 0) {
    warnings.push(
      issue(
        "UNSAFE_COHORT_EXCLUSION",
        "Unpaired or mismatched cases lack symmetric exclusion provenance."
      )
    );
  }
  return {
    status: errors.length > 0 ? "BLOCKED" : pairedCaseIds.length === 0 || variantIds.length < 2 ? "INSUFFICIENT_EVIDENCE" : excludedCases.length > 0 || warnings.length > 0 ? "PARTIAL" : "COMPLETE",
    errors,
    warnings,
    variantIds,
    baselineVariantId,
    pairedCaseIds,
    pairedCases,
    excludedCases: stableSort2(excludedCases, (item) => item.caseId),
    unsafeExclusions: stableSort2(unsafeExclusions, (item) => item.caseId),
    comparisons
  };
}

// src/benchmark/pareto.mjs
var DEFAULT_FRONTIER_DIMENSIONS = Object.freeze([
  { metric: "highCriticalRootCauseRecall", direction: "MAXIMIZE" },
  { metric: "criticalMissRate", direction: "MINIMIZE" },
  { metric: "actionablePrecision", direction: "MAXIMIZE" },
  { metric: "hallucinationRate", direction: "MINIMIZE" },
  { metric: "rootCauseQuality", direction: "MAXIMIZE" },
  {
    metric: "fullyLoadedCostPerConfirmedHighCriticalRootCause",
    direction: "MINIMIZE"
  },
  { metric: "humanReviewMinutesPerCase", direction: "MINIMIZE" },
  { metric: "latencyP95", direction: "MINIMIZE" }
]);
var LEGACY_FRONTIER_DIMENSIONS = Object.freeze([
  { metric: "severityWeightedAcceptedRecall", direction: "MAXIMIZE" },
  { metric: "costPerReviewedCase", direction: "MINIMIZE" },
  { metric: "falsePositiveRate", direction: "MINIMIZE" },
  { metric: "latencyP95", direction: "MINIMIZE" }
]);
function normalizeDimensions(dimensions) {
  const source = Array.isArray(dimensions) && dimensions.length > 0 ? dimensions : DEFAULT_FRONTIER_DIMENSIONS;
  return source.filter(
    (item) => item && typeof item.metric === "string" && (item.direction === "MAXIMIZE" || item.direction === "MINIMIZE")
  ).map((item) => ({ metric: item.metric, direction: item.direction }));
}
function defaultDimensionsFor(variants2, dimensions) {
  if (dimensions !== DEFAULT_FRONTIER_DIMENSIONS) {
    return dimensions;
  }
  const hasLaneMetric = (Array.isArray(variants2) ? variants2 : []).some(
    (variant) => variant?.metrics?.highCriticalRootCauseRecall
  );
  return hasLaneMetric ? dimensions : LEGACY_FRONTIER_DIMENSIONS;
}
function valuesFor(variant, dimensions) {
  const values = {};
  const missing = [];
  for (const dimension of dimensions) {
    const value = metricNumber(variant.metrics?.[dimension.metric]);
    if (!isFiniteNumber(value)) {
      missing.push(dimension.metric);
    } else {
      values[dimension.metric] = value;
    }
  }
  return { values, missing };
}
function dominates(left, right, dimensions) {
  let strictlyBetter = false;
  for (const dimension of dimensions) {
    const leftValue = left.values[dimension.metric];
    const rightValue = right.values[dimension.metric];
    if (dimension.direction === "MAXIMIZE") {
      if (leftValue < rightValue) {
        return false;
      }
      if (leftValue > rightValue) {
        strictlyBetter = true;
      }
    } else {
      if (leftValue > rightValue) {
        return false;
      }
      if (leftValue < rightValue) {
        strictlyBetter = true;
      }
    }
  }
  return strictlyBetter;
}
function computeParetoFrontier(variants2, dimensions = DEFAULT_FRONTIER_DIMENSIONS) {
  const selectedDimensions = normalizeDimensions(
    defaultDimensionsFor(variants2, dimensions)
  );
  const ordered = stableSort2(
    Array.isArray(variants2) ? variants2 : [],
    (item) => item.variantId
  );
  const eligible = [];
  const unknown = [];
  for (const variant of ordered) {
    if (!variant || typeof variant.variantId !== "string") {
      continue;
    }
    const resolved = valuesFor(variant, selectedDimensions);
    if (resolved.missing.length > 0) {
      unknown.push({
        variantId: variant.variantId,
        reasonCodes: ["MISSING_FRONTIER_DIMENSION"],
        missingDimensions: resolved.missing.sort(compareText)
      });
    } else {
      eligible.push({ variantId: variant.variantId, values: resolved.values });
    }
  }
  const frontier = [];
  const dominated = [];
  for (const candidate of eligible) {
    const dominators = eligible.filter((other) => other.variantId !== candidate.variantId).filter((other) => dominates(other, candidate, selectedDimensions)).map((other) => other.variantId).sort(compareText);
    if (dominators.length > 0) {
      dominated.push({
        variantId: candidate.variantId,
        dominatedBy: dominators,
        values: candidate.values
      });
    } else {
      frontier.push({ variantId: candidate.variantId, values: candidate.values });
    }
  }
  return {
    status: frontier.length > 0 ? unknown.length > 0 ? "PARTIAL" : "COMPLETE" : "INSUFFICIENT_EVIDENCE",
    dimensions: selectedDimensions,
    frontier: stableSort2(frontier, (item) => item.variantId),
    dominated: stableSort2(dominated, (item) => item.variantId),
    unknown: stableSort2(unknown, (item) => item.variantId)
  };
}

// src/eval/adjudication.mjs
function result(id, pass, reasonCode, details = void 0) {
  const check2 = {
    id,
    status: pass ? "PASS" : "UNKNOWN",
    reasonCode,
    evidenceStatus: pass ? "DECLARED" : "UNKNOWN"
  };
  if (details !== void 0) {
    check2.details = details;
  }
  return check2;
}
function inspectAdjudicationProtocol(protocol, manifest) {
  if (!isPlainObject2(protocol)) {
    const checks2 = [
      result("RO-EV-008", false, "MISSING_ADJUDICATION_PROTOCOL"),
      result("RO-EV-009", false, "MISSING_ADJUDICATION_PROTOCOL")
    ];
    return {
      status: "INSUFFICIENT_EVIDENCE",
      checks: checks2,
      reasonCodes: checks2.map((check2) => check2.reasonCode),
      blinding: "UNKNOWN",
      randomization: "UNKNOWN",
      highCriticalReview: "UNKNOWN",
      disagreement: "UNKNOWN",
      adjudicatorIndependence: "UNKNOWN"
    };
  }
  const declared = (
    /** @type {any} */
    protocol
  );
  const closedContract = isClosedAdjudicationProtocolContract(declared);
  const laneMatches = declared.laneId === manifest?.lane?.laneId;
  const versionsMatch = declared.rubricId === manifest?.rubricId && declared.labelVersion === manifest?.labelVersion;
  const blinded = declared.variantIdentity === "HIDDEN";
  const randomized = declared.presentationOrder === "RANDOMIZED";
  const human = declared.highCriticalReview === "HUMAN";
  const ruleEightPasses = closedContract && laneMatches && versionsMatch && blinded && randomized && human;
  const independence = closedContract && isPlainObject2(declared.adjudicatorIndependence) && declared.adjudicatorIndependence.status === "DECLARED" && declared.adjudicatorIndependence.evidenceStatus === "DECLARED" && isNonEmptyString(declared.adjudicatorIndependence.provenanceId);
  const nestedDisagreement = declared.disagreement;
  const disagreement = closedContract && (isPlainObject2(nestedDisagreement) && isNonEmptyString(nestedDisagreement.policyId) && isNonNegativeInteger(nestedDisagreement.count) && nestedDisagreement.status === "COMPLETE" || isNonEmptyString(declared.disagreementPolicyId) && isNonNegativeInteger(declared.disagreementCount) && ["RESOLVED", "NONE"].includes(declared.disagreementStatus));
  const checks = [
    result(
      "RO-EV-008",
      ruleEightPasses,
      ruleEightPasses ? "BLINDED_RANDOMIZED_HUMAN_ADJUDICATION_DECLARED" : "INCOMPLETE_BLINDING_OR_HIGH_CRITICAL_REVIEW",
      {
        laneMatches,
        closedContract,
        versionsMatch,
        blinded,
        randomized,
        human
      }
    ),
    result(
      "RO-EV-009",
      independence && disagreement,
      independence && disagreement ? "INDEPENDENCE_AND_DISAGREEMENT_DECLARED" : "INCOMPLETE_INDEPENDENCE_OR_DISAGREEMENT_EVIDENCE",
      { independence, disagreement }
    )
  ];
  return {
    status: checks.every((check2) => check2.status === "PASS") ? "COMPLETE" : "INSUFFICIENT_EVIDENCE",
    checks,
    reasonCodes: checks.filter((check2) => check2.status !== "PASS").map((check2) => check2.reasonCode),
    blinding: blinded ? "DECLARED" : "UNKNOWN",
    randomization: randomized ? "DECLARED" : "UNKNOWN",
    highCriticalReview: human ? "DECLARED" : "UNKNOWN",
    disagreement: disagreement ? "DECLARED" : "UNKNOWN",
    adjudicatorIndependence: independence ? "DECLARED" : "UNKNOWN"
  };
}

// src/eval/lanes.mjs
var LANE_TYPES2 = Object.freeze([
  "PORTABLE_CORE_MODEL",
  "HARNESS_ABLATION",
  "BEST_SYSTEM",
  "SHADOW_PILOT"
]);
var CANDIDATE_DIMENSIONS = Object.freeze([
  "modelAlias",
  "reasoningClass",
  "promptStructuralDigest",
  "configStructuralDigest",
  "contextClass",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId"
]);
var HARNESS_AXES = /* @__PURE__ */ new Set([
  "promptStructuralDigest",
  "configStructuralDigest",
  "contextClass",
  "toolContractId",
  "controllerContractId",
  "validatorContractId",
  "dedupePolicyId",
  "postingPolicyId",
  "retryPolicyId",
  "timeoutPolicyId",
  "routingPolicyId"
]);
function isSupportedLaneType(laneType3) {
  return LANE_TYPES2.includes(laneType3);
}
function deriveClaimBoundary(laneType3, attributionStatus2) {
  if (attributionStatus2 === "CONFOUNDED" || attributionStatus2 === "UNKNOWN") {
    return "Descriptive only; causal or architecture ranking is not supported.";
  }
  switch (laneType3) {
    case "PORTABLE_CORE_MODEL":
      return "Model comparison under equal declared conditions.";
    case "HARNESS_ABLATION":
      return "Single declared workflow-component effect under equal declared conditions.";
    case "BEST_SYSTEM":
      return "Holistic system comparison; no component or model causality.";
    case "SHADOW_PILOT":
      return "Prospective shadow comparison only; no posting or writeback.";
    default:
      return "Descriptive only; unsupported lane evidence.";
  }
}
function inspectLaneDifferences(normalized) {
  const lane = normalized?.lane ?? normalized?.manifest?.lane ?? null;
  const candidates = Array.isArray(normalized?.candidateConfigs) ? normalized.candidateConfigs : [];
  const baseline = candidates.find(
    (candidate) => candidate.variantId === lane?.baselineVariantId
  );
  const missingDimensions = [];
  if (!lane || !baseline) {
    return {
      status: "UNKNOWN",
      baselineVariantId: lane?.baselineVariantId ?? null,
      heldConstantDimensions: [],
      intentionallyChangedDimensions: [],
      unexpectedDimensions: [],
      missingDimensions: ["baselineCandidateConfig"],
      candidateDifferences: [],
      attributionStatus: "UNKNOWN"
    };
  }
  const allowed = new Set(
    Array.isArray(lane.allowedDifferenceAxes) ? lane.allowedDifferenceAxes : []
  );
  const candidateDifferences = [];
  const allChanged = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    if (candidate.variantId === baseline.variantId) {
      continue;
    }
    const changed = [];
    const missing2 = [];
    for (const field of CANDIDATE_DIMENSIONS) {
      if (!isNonEmptyString(candidate[field]) || !isNonEmptyString(baseline[field])) {
        missing2.push(field);
      } else if (candidate[field] !== baseline[field]) {
        changed.push(field);
        allChanged.add(field);
      }
    }
    candidateDifferences.push({
      variantId: candidate.variantId,
      changedDimensions: changed.sort(compareText),
      missingDimensions: missing2.sort(compareText)
    });
    missingDimensions.push(...missing2);
  }
  const changedDimensions = [...allChanged].sort(compareText);
  const unexpectedDimensions = changedDimensions.filter((field) => !allowed.has(field)).sort(compareText);
  const heldConstantDimensions = CANDIDATE_DIMENSIONS.filter(
    (field) => !allChanged.has(field)
  ).sort(compareText);
  const intentionallyChangedDimensions = changedDimensions.filter(
    (field) => allowed.has(field)
  );
  const missing = uniqueSortedStrings(missingDimensions);
  let status = "COMPLETE";
  let attributionStatus2 = "UNKNOWN";
  if (!isSupportedLaneType(lane.laneType)) {
    status = "UNKNOWN";
  } else if (missing.length > 0) {
    status = "UNKNOWN";
  } else if (unexpectedDimensions.length > 0) {
    status = "CONFOUNDED";
    attributionStatus2 = "CONFOUNDED";
  } else if (lane.laneType === "PORTABLE_CORE_MODEL") {
    const onlyModelAxis = allowed.size === 1 && allowed.has("modelAlias") && changedDimensions.length === 1 && changedDimensions[0] === "modelAlias";
    status = onlyModelAxis ? "COMPLETE" : "CONFOUNDED";
    attributionStatus2 = onlyModelAxis ? "SINGLE_FACTOR" : "CONFOUNDED";
  } else if (lane.laneType === "HARNESS_ABLATION") {
    const axis = [...allowed][0];
    const oneHarnessAxis = allowed.size === 1 && HARNESS_AXES.has(axis) && changedDimensions.length === 1 && changedDimensions[0] === axis;
    status = oneHarnessAxis ? "COMPLETE" : "CONFOUNDED";
    attributionStatus2 = oneHarnessAxis ? "SINGLE_FACTOR" : "CONFOUNDED";
  } else {
    const declared = changedDimensions.every((field) => allowed.has(field));
    status = declared ? "COMPLETE" : "CONFOUNDED";
    attributionStatus2 = declared ? "HOLISTIC_VARIANT" : "CONFOUNDED";
  }
  return {
    status,
    baselineVariantId: baseline.variantId,
    heldConstantDimensions,
    intentionallyChangedDimensions,
    unexpectedDimensions,
    missingDimensions: missing,
    candidateDifferences,
    attributionStatus: attributionStatus2
  };
}
function productionContractDifferences(normalized) {
  const production = normalized?.manifest?.productionBaselineContracts;
  if (!isPlainObject2(production)) {
    return [];
  }
  const fields = [
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId"
  ];
  return (normalized?.candidateConfigs ?? []).map((candidate) => ({
    variantId: candidate.variantId,
    differences: fields.filter(
      (field) => isNonEmptyString(candidate[field]) && isNonEmptyString(production[field]) && candidate[field] !== production[field]
    ).sort(compareText)
  })).sort((left, right) => compareText(left.variantId, right.variantId));
}

// src/eval/index.mjs
function check(id, status, reasonCode, details = void 0) {
  const result2 = { id, status, reasonCode };
  if (details !== void 0) {
    result2.details = details;
  }
  return result2;
}
function normalizedLane(value) {
  if (isPlainObject2(value) && Array.isArray(value.runs) && value.caseLabelsById instanceof Map && "rankingEligible" in value) {
    return value;
  }
  return normalizeLaneBundle(value);
}
function protocolPairingEvidence(protocol, lane) {
  if (!isPlainObject2(protocol)) {
    return {
      status: "UNKNOWN",
      reasonCode: "MISSING_EVAL_PROTOCOL",
      details: {}
    };
  }
  const closedContract = isClosedEvalProtocolContract(protocol);
  const laneMatches = protocol.laneId === lane?.laneId;
  const intendedClaimByLane = {
    PORTABLE_CORE_MODEL: "MODEL_ONLY",
    HARNESS_ABLATION: "ONE_FACTOR",
    BEST_SYSTEM: "HOLISTIC_SYSTEM",
    SHADOW_PILOT: "SHADOW_NO_POSTING"
  };
  const protocolDeclared = closedContract && protocol.schemaVersion === 1 && isNonEmptyString(protocol.protocolId) && isNonEmptyString(protocol.protocolVersion) && isNonEmptyString(protocol.intendedClaim) && isNonEmptyString(protocol.samplingFrame) && isNonEmptyString(protocol.inclusionPolicyId) && protocol.intendedClaim === intendedClaimByLane[lane?.laneType];
  const cohortMatches = protocol.cohortSelectionDigest === lane?.cohortSelectionDigest && protocol.cohortWindowId === lane?.cohortWindowId;
  const assignmentDeclared = typeof protocol.assignmentMethod === "string" && ["PAIRED_SAME_CASE", "RANDOMIZED_BLOCKED"].includes(protocol.assignmentMethod);
  const pairingDeclared = typeof protocol.pairingMethod === "string" && ["CASE_VARIANT", "CASE_VARIANT_REPLICATE"].includes(protocol.pairingMethod);
  const aggregationMatches = protocol.replicateAggregation === "CASE_PRIMITIVES";
  const missingPolicyDeclared = typeof protocol.missingReplicatePolicy === "string" && ["BLOCK", "SYMMETRIC_EXCLUDE_CASE"].includes(protocol.missingReplicatePolicy);
  const pass = protocolDeclared && laneMatches && cohortMatches && assignmentDeclared && pairingDeclared && aggregationMatches && missingPolicyDeclared;
  return {
    status: pass ? "PASS" : "UNKNOWN",
    reasonCode: pass ? "COHORT_ASSIGNMENT_AND_PAIRING_DECLARED" : "INCOMPLETE_COHORT_OR_PAIRING_EVIDENCE",
    details: {
      laneMatches,
      closedContract,
      protocolDeclared,
      cohortMatches,
      assignmentDeclared,
      pairingDeclared,
      aggregationMatches,
      missingPolicyDeclared
    }
  };
}
function preservationEvidence(protocol, manifest, baseline) {
  const expected = manifest?.productionBaselineContracts;
  const actual = protocol?.preservationContracts;
  const productionFields = [
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId"
  ];
  const candidateFields = [
    "toolContractId",
    "contextClass",
    "retryPolicyId",
    "timeoutPolicyId",
    "routingPolicyId"
  ];
  if (!isClosedEvalProtocolContract(protocol) || !isPlainObject2(expected) || !isPlainObject2(actual)) {
    return {
      status: "UNKNOWN",
      reasonCode: "MISSING_PRESERVATION_CONTRACTS",
      fields: [...productionFields, ...candidateFields]
    };
  }
  const mismatched = productionFields.filter(
    (field) => actual[field] !== expected[field]
  );
  for (const field of candidateFields) {
    if (!isNonEmptyString(actual[field])) {
      mismatched.push(field);
    } else if (baseline && actual[field] !== baseline[field]) {
      mismatched.push(field);
    }
  }
  return {
    status: mismatched.length === 0 ? "PASS" : "UNKNOWN",
    reasonCode: mismatched.length === 0 ? "PRODUCTION_CONTRACTS_DECLARED" : "PRESERVATION_CONTRACT_MISMATCH",
    fields: mismatched
  };
}
function leakageEvidence(protocol) {
  if (!isPlainObject2(protocol)) {
    return {
      status: "UNKNOWN",
      reasonCode: "MISSING_LEAKAGE_OR_EXCLUSION_EVIDENCE",
      details: {}
    };
  }
  const closedContract = isClosedEvalProtocolContract(protocol);
  const controls = closedContract && Array.isArray(protocol.leakageControls) && protocol.leakageControls.length > 0 && protocol.leakageControls.every(
    (control) => isPlainObject2(control) && control.status === "DECLARED" && control.evidenceStatus === "DECLARED"
  );
  const evidence = controls;
  const uncontaminated = protocol.knownContamination === "NONE_DECLARED";
  const exclusionPolicy = isNonEmptyString(protocol.exclusionPolicyId);
  const pass = controls && evidence && uncontaminated && exclusionPolicy;
  return {
    status: pass ? "PASS" : "UNKNOWN",
    reasonCode: pass ? "LEAKAGE_AND_EXCLUSION_EVIDENCE_DECLARED" : "MISSING_LEAKAGE_OR_EXCLUSION_EVIDENCE",
    details: {
      closedContract,
      controls,
      evidence,
      uncontaminated,
      exclusionPolicy
    }
  };
}
function runCandidateProvenance(normalized) {
  const runToCandidate = [
    "architectureId",
    "architectureStructuralDigest",
    "toolContractId",
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId",
    "reasoningClass",
    "retryPolicyId",
    "timeoutPolicyId",
    "routingPolicyId"
  ];
  const mismatches = [];
  const missing = [];
  for (const run of normalized.runs ?? []) {
    const candidate = normalized.candidatesById?.get(run.variantId);
    if (!candidate) {
      missing.push(run.variantId);
      continue;
    }
    for (const field of runToCandidate) {
      if (!isNonEmptyString(run[field]) || !isNonEmptyString(candidate[field])) {
        missing.push(field);
      } else if (run[field] !== candidate[field]) {
        mismatches.push({ variantId: run.variantId, field });
      }
    }
  }
  return {
    status: mismatches.length > 0 ? "CONFOUNDED" : missing.length > 0 ? "UNKNOWN" : "PASS",
    mismatches,
    missing: uniqueSortedStrings(missing)
  };
}
function evaluateLaneValidity(input, options = {}) {
  const normalized = normalizedLane(input);
  if (normalized.status === "BLOCKED") {
    const errors = [
      ...normalized.errors ?? [],
      issue("RO-EV-001", "Normalization or lane provenance is blocked.")
    ];
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      laneId: normalized.laneId ?? null,
      laneType: normalized.laneType ?? null,
      attributionStatus: "UNKNOWN",
      claimBoundary: deriveClaimBoundary(normalized.laneType, "UNKNOWN"),
      eligibleForMetrics: false,
      eligibleForRecommendation: false,
      checks: [check("RO-EV-001", "BLOCKED", "NORMALIZATION_BLOCKED")],
      reasonCodes: uniqueSortedStrings(errors.map((entry) => entry.code)),
      errors,
      warnings: normalized.warnings ?? [],
      pairing: buildLanePairedComparison(normalized, options),
      heldConstantDimensions: [],
      intentionallyChangedDimensions: [],
      unexpectedDimensions: [],
      missingDimensions: [],
      candidateContractDifferences: [],
      productionBaselineContracts: normalized.manifest?.productionBaselineContracts ?? null,
      limitations: ["Normalization or provenance must be repaired first."],
      evidenceRequired: ["valid normalized lane bundle"]
    };
  }
  const lane = normalized.lane;
  const protocol = normalized.evalProtocol;
  const pairing = buildLanePairedComparison(normalized, {
    ...options,
    evalProtocol: protocol
  });
  const differences = inspectLaneDifferences(normalized);
  const adjudication = inspectAdjudicationProtocol(
    normalized.adjudicationProtocol,
    normalized.manifest
  );
  const checks = [];
  const lanePass = Boolean(lane) && isSupportedLaneType(lane?.laneType) && normalized.manifest?.lane?.laneId === normalized.laneId;
  checks.push(
    check(
      "RO-EV-001",
      lanePass ? "PASS" : "BLOCKED",
      lanePass ? "LANE_CONTRACT_VALID" : "INVALID_LANE_CONTRACT"
    )
  );
  const pairingEvidence = protocolPairingEvidence(protocol, lane);
  const pairedPass = pairingEvidence.status === "PASS" && pairing.status !== "BLOCKED" && pairing.pairedCaseIds.length > 0 && pairing.unsafeExclusions.length === 0;
  checks.push(
    check(
      "RO-EV-002",
      pairedPass ? "PASS" : "UNKNOWN",
      pairedPass ? "PAIRING_EVIDENCE_COMPATIBLE" : pairingEvidence.reasonCode,
      { ...pairingEvidence.details, pairedCaseCount: pairing.pairedCaseIds.length }
    )
  );
  const differencePass = differences.status === "COMPLETE";
  const heldConstantContradictions = differences.intentionallyChangedDimensions.filter(
    (field) => protocol?.heldConstantFields?.includes(field)
  );
  const heldConstantDeclared = Array.isArray(protocol?.heldConstantFields) && heldConstantContradictions.length === 0 && differences.heldConstantDimensions.every(
    (field) => protocol.heldConstantFields.includes(field)
  );
  checks.push(
    check(
      "RO-EV-003",
      differencePass && heldConstantDeclared ? "PASS" : "UNKNOWN",
      differencePass && heldConstantDeclared ? "HELD_CONSTANT_DIMENSIONS_MATCH" : differences.status === "CONFOUNDED" ? "UNCONTROLLED_DIMENSION_DIFFERENCE" : "MISSING_HELD_CONSTANT_EVIDENCE",
      {
        heldConstantDimensions: differences.heldConstantDimensions,
        unexpectedDimensions: differences.unexpectedDimensions,
        missingDimensions: differences.missingDimensions,
        heldConstantContradictions
      }
    )
  );
  checks.push(
    check(
      "RO-EV-004",
      differencePass ? "PASS" : "UNKNOWN",
      differencePass ? "DIFFERENCE_AXES_DECLARED" : "INVALID_OR_UNDECLARED_DIFFERENCE_AXES",
      {
        intentionallyChangedDimensions: differences.intentionallyChangedDimensions
      }
    )
  );
  const ablationPass = lane?.laneType !== "HARNESS_ABLATION" || differences.status === "COMPLETE";
  checks.push(
    check(
      "RO-EV-005",
      ablationPass ? "PASS" : "UNKNOWN",
      ablationPass ? "ABLATION_AXIS_VALID_OR_NOT_APPLICABLE" : "HARNESS_ABLATION_NOT_SINGLE_FACTOR"
    )
  );
  const preservation = preservationEvidence(
    protocol,
    normalized.manifest,
    normalized.candidatesById?.get(lane?.baselineVariantId)
  );
  checks.push(
    check("RO-EV-006", preservation.status, preservation.reasonCode, {
      mismatchedFields: preservation.fields
    })
  );
  const provenance = runCandidateProvenance(normalized);
  checks.push(
    check(
      "RO-EV-007",
      provenance.status === "PASS" ? "PASS" : "UNKNOWN",
      provenance.status === "PASS" ? "RUN_AND_CANDIDATE_CONTRACTS_MATCH" : provenance.status === "CONFOUNDED" ? "RUN_CANDIDATE_PROVENANCE_MISMATCH" : "MISSING_RUN_CANDIDATE_PROVENANCE",
      { mismatches: provenance.mismatches, missing: provenance.missing }
    )
  );
  checks.push(...adjudication.checks);
  const leakage = leakageEvidence(protocol);
  checks.push(check("RO-EV-010", leakage.status, leakage.reasonCode, leakage.details));
  const shadowPass = lane?.laneType !== "SHADOW_PILOT" || isClosedEvalProtocolContract(protocol) && lane.executionMode === "SHADOW_NO_POSTING" && protocol?.expectedExecutionMode === "SHADOW_NO_POSTING";
  checks.push(
    check(
      "RO-EV-011",
      shadowPass ? "PASS" : "UNKNOWN",
      shadowPass ? "SHADOW_NO_POSTING_DECLARED_OR_NOT_APPLICABLE" : "SHADOW_NO_POSTING_NOT_DECLARED"
    )
  );
  const blocked = checks.some((entry) => entry.status === "BLOCKED");
  const incomplete = checks.some((entry) => entry.status !== "PASS");
  let attributionStatus2 = differences.attributionStatus;
  if (differences.status === "CONFOUNDED" || provenance.status === "CONFOUNDED") {
    attributionStatus2 = "CONFOUNDED";
  } else if (incomplete) {
    attributionStatus2 = "UNKNOWN";
  }
  const status = blocked ? "BLOCKED" : incomplete ? "INSUFFICIENT_EVIDENCE" : "COMPLETE";
  const reasonCodes = uniqueSortedStrings(
    checks.filter((entry) => entry.status !== "PASS").map((entry) => entry.reasonCode)
  );
  const evidenceRequired = [];
  if (pairingEvidence.status !== "PASS") {
    evidenceRequired.push("compatible cohort, assignment, and pairing protocol");
  }
  if (differences.status !== "COMPLETE") {
    evidenceRequired.push("complete held-constant and declared difference axes");
  }
  if (adjudication.status !== "COMPLETE") {
    evidenceRequired.push("blinded randomized human high-critical adjudication");
  }
  if (leakage.status !== "PASS") {
    evidenceRequired.push("declared leakage controls and exclusion provenance");
  }
  return {
    schemaVersion: 1,
    status,
    laneId: lane?.laneId ?? null,
    laneType: lane?.laneType ?? null,
    attributionStatus: attributionStatus2,
    claimBoundary: deriveClaimBoundary(lane?.laneType, attributionStatus2),
    eligibleForMetrics: status === "COMPLETE",
    eligibleForRecommendation: status === "COMPLETE",
    checks,
    reasonCodes,
    errors: blocked ? normalized.errors ?? [] : [],
    warnings: [...normalized.warnings ?? [], ...pairing.warnings ?? []],
    pairing,
    heldConstantDimensions: differences.heldConstantDimensions,
    intentionallyChangedDimensions: differences.intentionallyChangedDimensions,
    unexpectedDimensions: differences.unexpectedDimensions,
    missingDimensions: differences.missingDimensions,
    candidateDifferences: differences.candidateDifferences,
    candidateContractDifferences: productionContractDifferences(normalized),
    productionBaselineContracts: normalized.manifest?.productionBaselineContracts ?? null,
    blinding: adjudication.blinding,
    randomization: adjudication.randomization,
    highCriticalReview: adjudication.highCriticalReview,
    disagreement: adjudication.disagreement,
    adjudicatorIndependence: adjudication.adjudicatorIndependence,
    limitations: status === "COMPLETE" ? ["Declared evidence is not proof of private runtime behavior."] : ["Quality ranking is disabled until eval validity is complete."],
    evidenceRequired
  };
}
function evaluateEvalValidity(input, options = {}) {
  const normalized = Array.isArray(input) || input?.laneBundles ? normalizeLaneBundles(input) : { lanes: [normalizedLane(input)] };
  const lanes = normalized.lanes.map((lane) => evaluateLaneValidity(lane, options));
  const status = lanes.some((lane) => lane.status === "BLOCKED") ? "BLOCKED" : lanes.every((lane) => lane.status === "COMPLETE") ? "COMPLETE" : "INSUFFICIENT_EVIDENCE";
  return {
    schemaVersion: 1,
    status,
    lanes,
    reasonCodes: uniqueSortedStrings(lanes.flatMap((lane) => lane.reasonCodes ?? [])),
    errors: lanes.flatMap((lane) => lane.errors ?? []),
    warnings: lanes.flatMap((lane) => lane.warnings ?? [])
  };
}

// src/benchmark/slices.mjs
function pairingForSlice(normalized, pairing, sliceId) {
  const declared = normalized?.manifest?.sliceTaxonomy?.sliceIds ?? [];
  if (!declared.includes(sliceId)) {
    return {
      ...pairing,
      status: "INSUFFICIENT_EVIDENCE",
      pairedCaseIds: [],
      pairedCases: [],
      comparisons: [],
      errors: [],
      warnings: [
        issue("UNSUPPORTED_RISK_SLICE", "Risk slice is not declared.", {
          sliceId
        })
      ],
      sliceId
    };
  }
  const pairedCases = (pairing?.pairedCases ?? []).filter(
    (pairedCase) => normalized.caseLabelsById?.get(pairedCase.caseId)?.riskSliceIds?.includes(sliceId)
  );
  const pairedCaseIds = pairedCases.map((item) => item.caseId);
  const comparisons = (pairing?.comparisons ?? []).map((comparison) => ({
    ...comparison,
    pairedCaseIds: [...pairedCaseIds],
    pairedCaseCount: pairedCaseIds.length
  }));
  const excludedCases = (pairing?.excludedCases ?? []).filter(
    (entry) => normalized.caseLabelsById?.get(entry.caseId)?.riskSliceIds?.includes(sliceId)
  );
  return {
    ...pairing,
    status: pairedCaseIds.length === 0 ? "INSUFFICIENT_EVIDENCE" : pairedCaseIds.length < (pairing?.pairedCaseIds?.length ?? 0) ? "PARTIAL" : pairing.status,
    pairedCaseIds,
    pairedCases,
    comparisons,
    excludedCases: stableSort2(excludedCases, (item) => item.caseId),
    sliceId
  };
}
function declaredSliceIds(normalized) {
  return [...normalized?.manifest?.sliceTaxonomy?.sliceIds ?? []].sort(compareText);
}

// src/benchmark/index.mjs
function methodology(options) {
  return {
    quantile: "LINEAR_INTERPOLATION",
    confidence: "PAIRED_BOOTSTRAP_PERCENTILE",
    confidenceLevel: options.confidenceLevel ?? options.decisionPolicy?.confidenceLevel ?? 0.95,
    bootstrapIterations: options.bootstrapIterations ?? options.decisionPolicy?.bootstrapIterations ?? 1e4,
    bootstrapSeed: options.bootstrapSeed ?? options.decisionPolicy?.bootstrapSeed ?? "reviewops-v1"
  };
}
function buildBenchmarkScorecard(input, options = {}) {
  if (Array.isArray(input?.laneBundles) || input?.manifest?.lane || input?.benchmarkManifest?.lane || input?.bundleId) {
    return buildMultiLaneScorecards(input, options);
  }
  const normalized = normalizeBenchmarkInput(input);
  if (normalized.status === "BLOCKED") {
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      errors: normalized.errors,
      warnings: normalized.warnings,
      pairing: null,
      variants: [],
      comparisons: [],
      frontier: computeParetoFrontier([]),
      pricingSnapshot: normalized.pricingSnapshot,
      methodology: methodology(options)
    };
  }
  const pairing = buildPairedComparison(normalized, options);
  const metrics = calculateMetrics(normalized, pairing, options);
  const frontier = computeParetoFrontier(metrics.variants, options.frontierDimensions);
  return {
    schemaVersion: 1,
    ...metrics,
    status: metrics.status === "BLOCKED" || pairing.status === "BLOCKED" ? "BLOCKED" : metrics.status === "INSUFFICIENT_EVIDENCE" || pairing.status === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT_EVIDENCE" : metrics.status === "PARTIAL" || pairing.status === "PARTIAL" || frontier.status === "PARTIAL" ? "PARTIAL" : "COMPLETE",
    pairing,
    frontier,
    pricingSnapshot: normalized.pricingSnapshot,
    rubric: normalized.rubric,
    methodology: metrics.methodology ?? methodology(options)
  };
}
function normalizedLane2(value) {
  if (value && Array.isArray(value.runs) && value.caseLabelsById instanceof Map && "rankingEligible" in value) {
    return value;
  }
  return normalizeLaneBundle(value);
}
function emptyFrontier(reasonCode) {
  return {
    status: "INSUFFICIENT_EVIDENCE",
    dimensions: [],
    frontier: [],
    dominated: [],
    unknown: [],
    reasonCodes: [reasonCode]
  };
}
function laneStatus(normalized, validity, metrics) {
  if (normalized.status === "BLOCKED" || validity.status === "BLOCKED") {
    return "BLOCKED";
  }
  if (validity.status !== "COMPLETE" || metrics.status === "INSUFFICIENT_EVIDENCE") {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (normalized.status === "PARTIAL" || metrics.status === "PARTIAL" || validity.pairing?.status === "PARTIAL") {
    return "PARTIAL";
  }
  return "COMPLETE";
}
function decisionSliceMultiplicity(options, sliceId) {
  const policy = options.decisionPolicy;
  const decisionSliceIds = Array.isArray(policy?.decisionSliceIds) ? uniqueSortedStrings(policy.decisionSliceIds) : [];
  if (!decisionSliceIds.includes(sliceId) || policy?.sliceMultiplicityMethod !== "HOLM_BONFERRONI" || decisionSliceIds.length === 0) {
    return null;
  }
  const confidenceLevel = options.confidenceLevel ?? policy?.confidenceLevel ?? 0.95;
  if (!isFiniteNumber(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    return null;
  }
  return {
    method: "HOLM_BONFERRONI",
    familySize: decisionSliceIds.length,
    adjustedConfidenceLevel: roundNumber(
      1 - (1 - confidenceLevel) / decisionSliceIds.length
    )
  };
}
function buildLaneBenchmarkScorecard(input, options = {}) {
  const normalized = normalizedLane2(input);
  const validity = evaluateLaneValidity(normalized, options);
  const pairing = validity.pairing ?? buildLanePairedComparison(normalized, options);
  const metrics = calculateLaneMetrics(normalized, pairing, options);
  const canRank = validity.status === "COMPLETE" && metrics.pairedCaseCount > 0;
  const frontier = canRank ? computeParetoFrontier(metrics.variants, options.frontierDimensions) : emptyFrontier("EVAL_VALIDITY_INCOMPLETE");
  const slices = declaredSliceIds(normalized).map((sliceId) => {
    const slicePairing = pairingForSlice(normalized, pairing, sliceId);
    const multiplicity = decisionSliceMultiplicity(options, sliceId);
    const sliceMetrics = calculateLaneMetrics(
      normalized,
      slicePairing,
      multiplicity ? { ...options, confidenceLevel: multiplicity.adjustedConfidenceLevel } : options
    );
    const minimum = options.decisionPolicy?.minimumPairedCasesPerSlice ?? options.minimumPairedCasesPerSlice ?? 0;
    const decisionDeclared = Array.isArray(options.decisionPolicy?.decisionSliceIds) ? options.decisionPolicy.decisionSliceIds.includes(sliceId) : false;
    const eligibleForRanking = canRank && slicePairing.pairedCaseIds.length > 0 && slicePairing.pairedCaseIds.length >= minimum;
    return {
      sliceId,
      status: slicePairing.pairedCaseIds.length === 0 ? "INSUFFICIENT_EVIDENCE" : eligibleForRanking ? sliceMetrics.status : "INSUFFICIENT_EVIDENCE",
      decisionEligible: decisionDeclared && eligibleForRanking,
      descriptiveOnly: !decisionDeclared,
      multiplicity,
      pairing: slicePairing,
      pairedCaseCount: slicePairing.pairedCaseIds.length,
      variants: sliceMetrics.variants,
      comparisons: sliceMetrics.comparisons,
      frontier: eligibleForRanking ? computeParetoFrontier(sliceMetrics.variants, options.frontierDimensions) : emptyFrontier(
        decisionDeclared ? "INSUFFICIENT_SLICE_EVIDENCE" : "DESCRIPTIVE_ONLY_SLICE"
      ),
      limitations: eligibleForRanking ? [] : [
        decisionDeclared ? "Slice evidence is below its paired-case threshold." : "Slice is descriptive only; policy did not predeclare it."
      ]
    };
  });
  const status = laneStatus(normalized, validity, metrics);
  const errors = [
    ...normalized.errors ?? [],
    ...validity.errors ?? [],
    ...metrics.errors ?? []
  ];
  const warnings = [
    ...normalized.warnings ?? [],
    ...validity.warnings ?? [],
    ...metrics.warnings ?? []
  ];
  return {
    schemaVersion: 1,
    status,
    bundleId: normalized.bundleId ?? null,
    laneId: normalized.lane?.laneId ?? null,
    laneType: normalized.lane?.laneType ?? null,
    baselineVariantId: normalized.lane?.baselineVariantId ?? null,
    replicateAggregation: normalized.evalProtocol?.replicateAggregation ?? null,
    missingReplicatePolicy: normalized.evalProtocol?.missingReplicatePolicy ?? null,
    claimBoundary: validity.claimBoundary,
    attributionStatus: validity.attributionStatus,
    eligibleForRanking: canRank,
    productionBaselineContracts: normalized.manifest?.productionBaselineContracts ?? null,
    architectures: (normalized.candidateConfigs ?? []).map((candidate) => ({
      variantId: candidate.variantId,
      architectureId: candidate.architectureId,
      architectureStructuralDigest: candidate.architectureStructuralDigest
    })),
    candidateContractDifferences: validity.candidateContractDifferences ?? [],
    normalization: normalized.report,
    validity,
    pairing,
    pairedCaseCount: metrics.pairedCaseCount,
    global: {
      status: metrics.status,
      pairedCaseCount: metrics.pairedCaseCount,
      variants: metrics.variants,
      comparisons: metrics.comparisons,
      frontier
    },
    slices,
    variants: metrics.variants,
    comparisons: metrics.comparisons,
    frontier,
    pricingSnapshot: normalized.pricingSnapshot ? {
      schemaVersion: normalized.pricingSnapshot.schemaVersion,
      snapshotId: normalized.pricingSnapshot.snapshotId,
      currency: normalized.pricingSnapshot.currency,
      effectiveAt: normalized.pricingSnapshot.effectiveAt,
      costBasis: normalized.pricingSnapshot.costBasis,
      provenance: normalized.pricingSnapshot.provenance,
      rates: normalized.pricingSnapshot.rates
    } : null,
    methodology: metrics.methodology ?? methodology(options),
    errors,
    warnings,
    reasonCodes: uniqueSortedStrings([
      ...errors.map((entry) => entry.code),
      ...warnings.map((entry) => entry.code),
      ...validity.reasonCodes ?? []
    ]),
    limitations: [
      ...validity.limitations ?? [],
      ...canRank ? [] : ["Point frontier is withheld until eval validity is complete."]
    ]
  };
}
function buildMultiLaneScorecards(input, options = {}) {
  const normalized = input && Array.isArray(input.lanes) && input.lanes.every(
    (lane) => lane && Array.isArray(lane.runs) && lane.caseLabelsById instanceof Map
  ) ? input : normalizeLaneBundles(input);
  if (normalized.status === "BLOCKED") {
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      lanes: [],
      errors: normalized.errors ?? [],
      warnings: normalized.warnings ?? [],
      reasonCodes: normalized.reasonCodes ?? ["NORMALIZATION_BLOCKED"],
      limitations: ["No lane is scored while normalization is blocked."]
    };
  }
  if (!Array.isArray(normalized.lanes) || normalized.lanes.length === 0) {
    const error = issue("NO_LANE_BUNDLES", "No normalized lane bundles are available.");
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      lanes: [],
      errors: [error],
      warnings: [],
      reasonCodes: ["NO_LANE_BUNDLES"],
      limitations: ["No lane can be scored."]
    };
  }
  const lanes = normalized.lanes.map(
    (lane) => buildLaneBenchmarkScorecard(lane, options)
  );
  const status = lanes.some((lane) => lane.status === "BLOCKED") ? "BLOCKED" : lanes.every((lane) => lane.status === "COMPLETE") ? "COMPLETE" : lanes.some((lane) => lane.status === "COMPLETE" || lane.status === "PARTIAL") ? "PARTIAL" : "INSUFFICIENT_EVIDENCE";
  const errors = lanes.flatMap((lane) => lane.errors ?? []);
  const warnings = lanes.flatMap((lane) => lane.warnings ?? []);
  return {
    schemaVersion: 1,
    status,
    lanes,
    errors,
    warnings,
    reasonCodes: uniqueSortedStrings([
      ...errors.map((entry) => entry.code),
      ...warnings.map((entry) => entry.code),
      ...lanes.flatMap((lane) => lane.reasonCodes ?? [])
    ]),
    methodology: {
      laneAggregation: "NONE",
      inferentialUnit: "CASE",
      replicateAggregation: "CASE_PRIMITIVES"
    },
    limitations: [
      "Lanes are reported independently; incompatible lanes are never averaged."
    ]
  };
}

// src/recommend/gates.mjs
var RECOMMENDATION_STATUSES = Object.freeze([
  "RECOMMENDED_FOR_SHADOW",
  "NO_CHANGE_RECOMMENDED",
  "INSUFFICIENT_EVIDENCE",
  "BLOCKED_BY_SAFETY_GATE"
]);
var TIE_POLICIES = /* @__PURE__ */ new Set([
  "NO_AUTOMATIC_WINNER",
  "LOWEST_ROOT_CAUSE_COST",
  "LOWEST_COST",
  "LOWEST_LATENCY"
]);
function gate(id, status, reasonCode, details = void 0) {
  const result2 = { id, status, reasonCode };
  return details === void 0 ? result2 : { ...result2, details };
}
function objectRecords2(value) {
  return Array.isArray(value) ? value.filter((entry) => isPlainObject2(entry)) : [];
}
function strings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function lanesFromScorecard(scorecard) {
  if (!isPlainObject2(scorecard)) {
    return [];
  }
  return Array.isArray(scorecard.lanes) ? objectRecords2(scorecard.lanes) : [];
}
function allLanes(scorecards, scorecard) {
  const sources = Array.isArray(scorecards) ? scorecards : [scorecard];
  return sources.flatMap((item) => lanesFromScorecard(item));
}
function validPolicy(policy) {
  if (!isPlainObject2(policy)) {
    return false;
  }
  return isNonEmptyString(policy.policyId) && isFiniteNumber(policy.confidenceLevel) && policy.confidenceLevel > 0 && policy.confidenceLevel < 1 && isNonNegativeInteger(policy.bootstrapIterations) && policy.bootstrapIterations > 0 && isNonEmptyString(policy.bootstrapSeed) && isNonNegativeInteger(policy.minimumPairedCases) && policy.minimumPairedCases >= 1 && isFiniteNumber(policy.minimumMetricCoverage) && policy.minimumMetricCoverage >= 0 && policy.minimumMetricCoverage <= 1 && isNonEmptyString(policy.tiePolicy) && TIE_POLICIES.has(policy.tiePolicy) && isNonNegativeInteger(policy.shadowObservationDays) && policy.shadowObservationDays >= 1 && Array.isArray(policy.exceptions);
}
function validLanePolicy(policy) {
  return validPolicy(policy) && Array.isArray(policy.decisionSliceIds) && policy.decisionSliceIds.length > 0 && policy.sliceMultiplicityMethod === "HOLM_BONFERRONI" && isFiniteNumber(policy.minimumRootCauseCoverage) && policy.minimumRootCauseCoverage >= 0 && policy.minimumRootCauseCoverage <= 1 && policy.requiredCostBasis === "FULLY_LOADED" && isFiniteNumber(policy.highCriticalRootCauseNonInferiorityMargin) && isFiniteNumber(policy.criticalMissNonInferiorityMargin) && isFiniteNumber(policy.hallucinationNonInferiorityMargin) && isFiniteNumber(policy.actionablePrecisionNonInferiorityMargin) && isFiniteNumber(policy.rootCauseQualityNonInferiorityMargin) && isFiniteNumber(
    policy.minimumCostPerConfirmedHighCriticalRootCauseImprovementFraction
  ) && isFiniteNumber(policy.maximumHumanReviewRegressionFraction) && isFiniteNumber(policy.maximumP95CostRegressionFraction) && isFiniteNumber(policy.maximumP99CostRegressionFraction) && isFiniteNumber(policy.maximumP95LatencyRegressionFraction) && isFiniteNumber(policy.maximumP99LatencyRegressionFraction) && isFiniteNumber(policy.minimumFindingStability) && Array.isArray(policy.allowedExceptionTypes);
}
function activeScopedException(policy, type, analysisAsOf, scopes) {
  if (!strings(policy.allowedExceptionTypes).includes(type)) {
    return false;
  }
  const asOf = parseUtcTimestamp(analysisAsOf);
  if (asOf === void 0 || !Array.isArray(policy.exceptions)) {
    return false;
  }
  return policy.exceptions.some((exception) => {
    if (!isPlainObject2(exception) || exception.type !== type || !isNonEmptyString(exception.approvedBy) || !isNonEmptyString(exception.scope) || !scopes.includes(exception.scope)) {
      return false;
    }
    const expiresAt = parseUtcTimestamp(exception.expiresAt);
    return expiresAt !== void 0 && expiresAt >= asOf;
  });
}
function staticFindings(report) {
  return isPlainObject2(report) ? objectRecords2(report.findings) : [];
}
function staticDiagnosticGate(report, policy, candidateLaneId, candidateVariantId) {
  if (!isPlainObject2(report)) {
    return gate(
      "RO-GATE-STATIC-DIAGNOSTICS",
      "PASS",
      "STATIC_DIAGNOSTICS_NOT_SUPPLIED"
    );
  }
  if (report.status === "BLOCKED" || report.status === "ERROR") {
    return gate("RO-GATE-STATIC-DIAGNOSTICS", "BLOCKED", "STATIC_DIAGNOSTICS_BLOCKED");
  }
  const allowed = new Set(strings(policy.blockingStaticRuleIds));
  const blocking = staticFindings(report).some((finding) => {
    const confidence = finding.confidence === "HIGH" || typeof finding.confidence === "number" && finding.confidence >= 0.9;
    return allowed.has(finding.ruleId) && finding.evidenceStatus === "OBSERVED" && finding.severity === "CRITICAL" && confidence && finding.blocksShadowPath === true && isPlainObject2(finding.binding) && isNonEmptyString(finding.binding.laneId) && isNonEmptyString(finding.binding.variantId) && isNonEmptyString(finding.binding.architectureStructuralDigest) && (!isNonEmptyString(candidateLaneId) || finding.binding.laneId === candidateLaneId) && (!isNonEmptyString(candidateVariantId) || finding.binding.variantId === candidateVariantId) && (finding.applicableToShadowPath === true || finding.shadowPathApplicable === true || finding.applicable === true);
  });
  return blocking ? gate(
    "RO-GATE-STATIC-DIAGNOSTICS",
    "BLOCKED",
    "STATIC_SAFETY_FINDING_BLOCKS_SHADOW"
  ) : gate("RO-GATE-STATIC-DIAGNOSTICS", "PASS", "STATIC_DIAGNOSTICS_NON_BLOCKING");
}
function laneStatus2(lane) {
  return typeof lane.status === "string" ? lane.status : "INSUFFICIENT_EVIDENCE";
}
function laneType(lane) {
  return lane.laneType ?? lane.evalValidity?.laneType ?? lane.manifest?.lane?.laneType;
}
function attributionStatus(lane) {
  return lane.attributionStatus ?? lane.evalValidity?.attributionStatus ?? lane.validity?.attributionStatus ?? "UNKNOWN";
}
function pairedCount(lane) {
  const value = [
    lane.pairedCaseCount,
    lane.pairingCoverage?.pairedCaseCount,
    lane.pairing?.pairedCaseCount,
    lane.evalValidity?.pairingCoverage?.pairedCaseCount
  ].find((entry) => typeof entry === "number");
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
function laneExecutionMode(lane) {
  return lane.executionMode ?? lane.manifest?.lane?.executionMode ?? null;
}
function laneIsEligible(lane) {
  const attribution = attributionStatus(lane);
  return laneStatus2(lane) === "COMPLETE" && attribution !== "CONFOUNDED" && attribution !== "UNKNOWN" && lane.recommendationEligible !== false;
}
function hasBlockedLane(lanes) {
  return lanes.some(
    (lane) => laneStatus2(lane) === "BLOCKED" || laneStatus2(lane) === "ERROR"
  );
}
function laneVariant(lane, variantId) {
  const global = isPlainObject2(lane.global) ? lane.global : lane;
  return objectRecords2(global.variants ?? lane.variants).find(
    (variant) => variant.variantId === variantId
  );
}
function laneComparison(lane, variantId) {
  const global = isPlainObject2(lane.global) ? lane.global : lane;
  return objectRecords2(global.comparisons ?? lane.comparisons).find(
    (comparison) => comparison.candidateVariantId === variantId
  );
}
function laneMetric(variant, name) {
  if (!variant || !isPlainObject2(variant.metrics)) {
    return void 0;
  }
  return variant.metrics[name];
}
function laneInterval(comparison, name) {
  const interval = comparison?.metrics?.[name]?.interval;
  return isPlainObject2(interval) && interval.status === "AVAILABLE" && isFiniteNumber(interval.lower) && isFiniteNumber(interval.upper) ? (
    /** @type {Record<string, any>} */
    interval
  ) : null;
}
function coverage(metric) {
  return isPlainObject2(metric) && isFiniteNumber(metric.coverage) ? metric.coverage : void 0;
}
function metricCoverageGate(lane, candidateVariantId, policy) {
  const baselineId2 = lane.baselineVariantId ?? lane.pairing?.baselineVariantId ?? lane.comparisons?.[0]?.baselineVariantId;
  const baseline = laneVariant(lane, baselineId2);
  const candidate = laneVariant(lane, candidateVariantId);
  const required = [
    "highCriticalRootCauseRecall",
    "criticalMissRate",
    "actionablePrecision",
    "hallucinationRate",
    "rootCauseQuality",
    "fullyLoadedCostPerConfirmedHighCriticalRootCause",
    "humanReviewMinutesPerCase",
    "costP95",
    "costP99",
    "latencyP95",
    "latencyP99",
    "findingStability"
  ];
  const missing = required.filter((name) => {
    const minimum = name === "highCriticalRootCauseRecall" || name === "criticalMissRate" || name === "fullyLoadedCostPerConfirmedHighCriticalRootCause" ? Math.max(policy.minimumMetricCoverage, policy.minimumRootCauseCoverage) : policy.minimumMetricCoverage;
    const left = coverage(laneMetric(baseline, name));
    const right = coverage(laneMetric(candidate, name));
    return left === void 0 || right === void 0 || left < minimum || right < minimum;
  });
  return missing.length === 0 ? gate("RO-GATE-METRIC-COVERAGE", "PASS", "METRIC_COVERAGE_SATISFIED") : gate("RO-GATE-METRIC-COVERAGE", "UNKNOWN", "INSUFFICIENT_METRIC_COVERAGE", {
    missingMetrics: missing
  });
}
function laneIntervalGate(id, comparison, metricName, direction, margin) {
  const interval = laneInterval(comparison, metricName);
  if (!interval) {
    return gate(id, "UNKNOWN", "MISSING_CONFIDENCE_INTERVAL");
  }
  const passes = direction === "MAXIMIZE" ? interval.lower >= -margin : interval.upper <= margin;
  return passes ? gate(id, "PASS", "NON_INFERIORITY_SATISFIED") : gate(id, "FAIL", "NON_INFERIORITY_NOT_SATISFIED");
}
function relativeGuardrailGate(id, baseline, candidate, comparison, metricName, maximumRegressionFraction, exceptionActive = false) {
  const baselineValue = metricNumber(laneMetric(baseline, metricName));
  const candidateValue = metricNumber(laneMetric(candidate, metricName));
  const interval = laneInterval(comparison, metricName);
  if (!isFiniteNumber(baselineValue) || baselineValue < 0 || !isFiniteNumber(candidateValue) || !interval) {
    return gate(id, "UNKNOWN", "MISSING_GUARDRAIL_EVIDENCE");
  }
  const allowedDelta = baselineValue * maximumRegressionFraction;
  if (candidateValue <= baselineValue + allowedDelta && interval.upper <= allowedDelta) {
    return gate(id, "PASS", "GUARDRAIL_SATISFIED");
  }
  return exceptionActive ? gate(id, "PASS", "APPROVED_EXCEPTION_APPLIED") : gate(id, "FAIL", "GUARDRAIL_NOT_SATISFIED");
}
function candidateEvidenceGates(lane, candidateVariantId, policy, analysisAsOf) {
  const gates = [];
  const baselineId2 = lane.baselineVariantId ?? lane.pairing?.baselineVariantId ?? lane.comparisons?.[0]?.baselineVariantId;
  const baseline = laneVariant(lane, baselineId2);
  const candidate = laneVariant(lane, candidateVariantId);
  const comparison = laneComparison(lane, candidateVariantId);
  if (!baseline || !candidate || !comparison || baselineId2 === candidateVariantId) {
    return [gate("RO-GATE-CANDIDATE", "UNKNOWN", "MISSING_COMPARISON_VARIANT")];
  }
  gates.push(gate("RO-GATE-CANDIDATE", "PASS", "COMPARISON_VARIANTS_PRESENT"));
  const frontierSource = (isPlainObject2(lane.global) ? lane.global : lane).frontier;
  const frontier = Array.isArray(frontierSource) ? objectRecords2(frontierSource) : objectRecords2(frontierSource?.frontier);
  gates.push(
    frontier.length === 0 ? gate("RO-GATE-FRONTIER", "UNKNOWN", "MISSING_PARETO_FRONTIER") : frontier.some((point) => point.variantId === candidateVariantId) ? gate("RO-GATE-FRONTIER", "PASS", "CANDIDATE_IS_NON_DOMINATED") : gate("RO-GATE-FRONTIER", "FAIL", "CANDIDATE_IS_DOMINATED")
  );
  gates.push(metricCoverageGate(lane, candidateVariantId, policy));
  gates.push(
    laneIntervalGate(
      "RO-GATE-HIGH-CRITICAL",
      comparison,
      "highCriticalRootCauseRecall",
      "MAXIMIZE",
      policy.highCriticalRootCauseNonInferiorityMargin
    ),
    laneIntervalGate(
      "RO-GATE-CRITICAL-MISS",
      comparison,
      "criticalMissRate",
      "MINIMIZE",
      policy.criticalMissNonInferiorityMargin
    ),
    laneIntervalGate(
      "RO-GATE-HALLUCINATION",
      comparison,
      "hallucinationRate",
      "MINIMIZE",
      policy.hallucinationNonInferiorityMargin
    ),
    laneIntervalGate(
      "RO-GATE-ACTIONABLE-PRECISION",
      comparison,
      "actionablePrecision",
      "MAXIMIZE",
      policy.actionablePrecisionNonInferiorityMargin
    ),
    laneIntervalGate(
      "RO-GATE-ROOT-CAUSE-QUALITY",
      comparison,
      "rootCauseQuality",
      "MAXIMIZE",
      policy.rootCauseQualityNonInferiorityMargin
    )
  );
  const baselineCost = metricNumber(
    laneMetric(baseline, "fullyLoadedCostPerConfirmedHighCriticalRootCause")
  );
  const candidateCost = metricNumber(
    laneMetric(candidate, "fullyLoadedCostPerConfirmedHighCriticalRootCause")
  );
  const costInterval = laneInterval(
    comparison,
    "fullyLoadedCostPerConfirmedHighCriticalRootCause"
  );
  if (!isFiniteNumber(baselineCost) || baselineCost <= 0 || !isFiniteNumber(candidateCost) || !costInterval) {
    gates.push(gate("RO-GATE-ROOT-CAUSE-COST", "UNKNOWN", "MISSING_COST_EVIDENCE"));
  } else {
    const required = policy.minimumCostPerConfirmedHighCriticalRootCauseImprovementFraction;
    if (!isFiniteNumber(required)) {
      gates.push(gate("RO-GATE-ROOT-CAUSE-COST", "UNKNOWN", "MISSING_COST_EVIDENCE"));
      return gates;
    }
    const improvement = roundNumber((baselineCost - candidateCost) / baselineCost);
    const requiredDelta = -baselineCost * required;
    gates.push(
      improvement >= required && costInterval.upper <= requiredDelta ? gate("RO-GATE-ROOT-CAUSE-COST", "PASS", "COST_IMPROVEMENT_SATISFIED") : gate("RO-GATE-ROOT-CAUSE-COST", "FAIL", "COST_IMPROVEMENT_NOT_SATISFIED")
    );
  }
  gates.push(
    relativeGuardrailGate(
      "RO-GATE-HUMAN-REVIEW",
      baseline,
      candidate,
      comparison,
      "humanReviewMinutesPerCase",
      policy.maximumHumanReviewRegressionFraction,
      activeScopedException(
        policy,
        "HUMAN_REVIEW",
        analysisAsOf,
        [lane.laneId, candidateVariantId].filter(isNonEmptyString)
      )
    ),
    relativeGuardrailGate(
      "RO-GATE-P95-COST",
      baseline,
      candidate,
      comparison,
      "costP95",
      policy.maximumP95CostRegressionFraction
    ),
    relativeGuardrailGate(
      "RO-GATE-P99-COST",
      baseline,
      candidate,
      comparison,
      "costP99",
      policy.maximumP99CostRegressionFraction,
      activeScopedException(
        policy,
        "P99_COST",
        analysisAsOf,
        [lane.laneId, candidateVariantId].filter(isNonEmptyString)
      )
    ),
    relativeGuardrailGate(
      "RO-GATE-P95-LATENCY",
      baseline,
      candidate,
      comparison,
      "latencyP95",
      policy.maximumP95LatencyRegressionFraction,
      activeScopedException(
        policy,
        "P95_LATENCY",
        analysisAsOf,
        [lane.laneId, candidateVariantId].filter(isNonEmptyString)
      )
    ),
    relativeGuardrailGate(
      "RO-GATE-P99-LATENCY",
      baseline,
      candidate,
      comparison,
      "latencyP99",
      policy.maximumP99LatencyRegressionFraction
    )
  );
  const stability = metricNumber(laneMetric(candidate, "findingStability"));
  gates.push(
    !isFiniteNumber(stability) ? gate("RO-GATE-STABILITY", "UNKNOWN", "MISSING_STABILITY_EVIDENCE") : stability < policy.minimumFindingStability ? gate("RO-GATE-STABILITY", "FAIL", "FINDING_STABILITY_NOT_SATISFIED") : gate("RO-GATE-STABILITY", "PASS", "FINDING_STABILITY_SATISFIED")
  );
  const contractDifferences = objectRecords2(lane.candidateContractDifferences);
  const protectedFields = /* @__PURE__ */ new Set([
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId"
  ]);
  const changedProtected = contractDifferences.some(
    (difference) => difference.variantId === candidateVariantId && protectedFields.has(difference.field)
  );
  gates.push(
    changedProtected ? gate("RO-GATE-PRESERVATION", "BLOCKED", "PRODUCTION_CONTRACT_NOT_PRESERVED") : gate("RO-GATE-PRESERVATION", "PASS", "PRODUCTION_CONTRACTS_PRESERVED")
  );
  return gates;
}
function evaluateLaneAwareGates({
  scorecards,
  scorecard,
  staticDiagnostics,
  auditReport,
  decisionPolicy,
  analysisAsOf,
  candidateLaneId,
  candidateVariantId
} = {}) {
  const gates = [];
  if (!validLanePolicy(decisionPolicy)) {
    gates.push(gate("RO-GATE-POLICY", "UNKNOWN", "MISSING_OR_INVALID_DECISION_POLICY"));
    return {
      status: "INSUFFICIENT_EVIDENCE",
      gates,
      reasonCodes: ["MISSING_OR_INVALID_DECISION_POLICY"],
      eligibleLanes: []
    };
  }
  const policy = (
    /** @type {Record<string, any>} */
    decisionPolicy
  );
  gates.push(gate("RO-GATE-POLICY", "PASS", "DECISION_POLICY_VALID"));
  const lanes = allLanes(scorecards, scorecard);
  if (lanes.length === 0) {
    gates.push(gate("RO-GATE-EVAL-VALIDITY", "UNKNOWN", "MISSING_LANE_EVIDENCE"));
    return {
      status: "INSUFFICIENT_EVIDENCE",
      gates,
      reasonCodes: ["MISSING_LANE_EVIDENCE"],
      eligibleLanes: []
    };
  }
  const eligibleLanes = lanes.filter((lane) => laneIsEligible(lane));
  const targetLanes = typeof candidateLaneId === "string" ? eligibleLanes.filter(
    (lane) => lane.laneId === candidateLaneId || lane.manifest?.lane?.laneId === candidateLaneId
  ) : eligibleLanes.filter(
    (lane) => ["BEST_SYSTEM", "SHADOW_PILOT"].includes(laneType(lane))
  );
  if (targetLanes.length === 0 && hasBlockedLane(lanes)) {
    gates.push(
      gate("RO-GATE-INTEGRITY", "BLOCKED", "UNRESOLVED_INPUT_INTEGRITY_WARNING")
    );
    return {
      status: "BLOCKED_BY_SAFETY_GATE",
      gates,
      reasonCodes: ["UNRESOLVED_INPUT_INTEGRITY_WARNING"],
      eligibleLanes: []
    };
  }
  gates.push(gate("RO-GATE-INTEGRITY", "PASS", "INPUT_INTEGRITY_SATISFIED"));
  gates.push(
    eligibleLanes.length === 0 ? gate("RO-GATE-EVAL-VALIDITY", "UNKNOWN", "NO_ELIGIBLE_EVAL_LANE") : gate("RO-GATE-EVAL-VALIDITY", "PASS", "EVAL_VALIDITY_SATISFIED")
  );
  const scopedLanes = targetLanes.length > 0 ? targetLanes : eligibleLanes;
  const tooSmall = scopedLanes.filter(
    (lane) => pairedCount(lane) < policy.minimumPairedCases
  );
  gates.push(
    scopedLanes.length === 0 || tooSmall.length > 0 ? gate("RO-GATE-PAIRS", "UNKNOWN", "INSUFFICIENT_PAIRED_CASES", {
      required: policy.minimumPairedCases,
      observed: scopedLanes.map((lane) => pairedCount(lane))
    }) : gate("RO-GATE-PAIRS", "PASS", "MINIMUM_PAIRED_CASES_SATISFIED")
  );
  const missingFullyLoaded = scopedLanes.some((lane) => {
    const basis = lane.costBasis ?? lane.pricingSnapshot?.costBasis ?? lane.metrics?.costBasis ?? lane.methodology?.costBasis;
    return basis !== (policy.requiredCostBasis ?? "FULLY_LOADED");
  });
  gates.push(
    missingFullyLoaded ? gate("RO-GATE-PRICING", "UNKNOWN", "MISSING_FULLY_LOADED_COST_EVIDENCE") : gate("RO-GATE-PRICING", "PASS", "FULLY_LOADED_COST_EVIDENCE_SATISFIED")
  );
  const stalePricing = scopedLanes.some((lane) => {
    const effectiveAt = lane.pricingSnapshot?.effectiveAt ?? lane.pricingEffectiveAt ?? void 0;
    const ageDays = daysBetween(analysisAsOf, effectiveAt);
    return ageDays === void 0 || !isFiniteNumber(policy.maxPricingAgeDays) || ageDays < 0 || ageDays > policy.maxPricingAgeDays;
  });
  if (stalePricing) {
    gates.push(gate("RO-GATE-PRICING-AGE", "UNKNOWN", "STALE_OR_FUTURE_PRICING"));
  }
  const badShadow = scopedLanes.some(
    (lane) => laneType(lane) === "SHADOW_PILOT" && laneExecutionMode(lane) !== "SHADOW_NO_POSTING"
  );
  gates.push(
    badShadow ? gate("RO-GATE-NO-POSTING", "BLOCKED", "SHADOW_POSTING_NOT_DISABLED") : gate("RO-GATE-NO-POSTING", "PASS", "SHADOW_NO_POSTING_SATISFIED")
  );
  if (typeof candidateVariantId === "string") {
    const candidateLane = eligibleLanes.find(
      (lane) => (typeof candidateLaneId !== "string" || lane.laneId === candidateLaneId || lane.manifest?.lane?.laneId === candidateLaneId) && laneVariant(lane, candidateVariantId) !== void 0
    );
    gates.push(
      ...candidateLane ? candidateEvidenceGates(
        candidateLane,
        candidateVariantId,
        policy,
        analysisAsOf
      ) : [gate("RO-GATE-CANDIDATE", "UNKNOWN", "MISSING_COMPARISON_VARIANT")]
    );
  }
  gates.push(
    staticDiagnosticGate(
      staticDiagnostics ?? auditReport,
      policy,
      candidateLaneId,
      candidateVariantId
    )
  );
  const blocked = gates.some((item) => item.status === "BLOCKED");
  const unknown = gates.some((item) => item.status === "UNKNOWN");
  const failed = gates.some((item) => item.status === "FAIL");
  return {
    status: blocked ? "BLOCKED_BY_SAFETY_GATE" : unknown ? "INSUFFICIENT_EVIDENCE" : failed ? "NO_CHANGE_RECOMMENDED" : "RECOMMENDED_FOR_SHADOW",
    gates,
    reasonCodes: uniqueSortedStrings(
      gates.filter((item) => item.status !== "PASS").map((item) => item.reasonCode)
    ),
    eligibleLanes
  };
}
function evaluateRecommendationGates(options = {}) {
  return evaluateLaneAwareGates(options);
}

// src/recommend/index.mjs
var RECOMMENDABLE_LANE_TYPES = /* @__PURE__ */ new Set(["BEST_SYSTEM", "SHADOW_PILOT"]);
var SAFE_NO_CHANGE_REASON = "NO_ELIGIBLE_NON_BASELINE_ARCHITECTURE";
function records2(value) {
  return Array.isArray(value) ? value.filter((item) => isPlainObject2(item)) : [];
}
function strings2(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function laneId(lane) {
  return lane.laneId ?? lane.manifest?.lane?.laneId ?? lane.bundleId ?? "unknown-lane";
}
function laneType2(lane) {
  return lane.laneType ?? lane.manifest?.lane?.laneType ?? "PORTABLE_CORE_MODEL";
}
function laneStatus3(lane) {
  return typeof lane.status === "string" ? lane.status : "INSUFFICIENT_EVIDENCE";
}
function laneAttribution(lane) {
  return typeof lane.attributionStatus === "string" ? lane.attributionStatus : "UNKNOWN";
}
function laneBundleId(lane) {
  return typeof lane.bundleId === "string" ? lane.bundleId : null;
}
function normalizedLaneId(lane) {
  return typeof lane.laneId === "string" ? lane.laneId : typeof lane.lane?.laneId === "string" ? lane.lane.laneId : null;
}
function normalizedForScorecardLane(normalizedLanes, scorecardLane) {
  const bundleId = laneBundleId(scorecardLane);
  const scorecardLaneId = laneId(scorecardLane);
  const matches2 = normalizedLanes.filter((lane) => {
    const sameBundle = bundleId === null || laneBundleId(lane) === bundleId;
    const sameLane = normalizedLaneId(lane) === scorecardLaneId;
    return sameBundle && sameLane;
  });
  if (matches2.length === 1) {
    return matches2[0];
  }
  if (normalizedLanes.length === 1 && laneBundleId(normalizedLanes[0]) === null && normalizedLaneId(normalizedLanes[0]) === null) {
    return normalizedLanes[0];
  }
  return null;
}
function baselineId(lane) {
  return lane.baselineVariantId ?? lane.manifest?.lane?.baselineVariantId ?? lane.pairing?.baselineVariantId ?? lane.comparisons?.[0]?.baselineVariantId ?? null;
}
function frontierPoints(lane) {
  const global = isPlainObject2(lane.global) ? lane.global : {};
  const frontier = global.frontier ?? lane.frontier ?? lane.pareto;
  return Array.isArray(frontier) ? records2(frontier) : records2(frontier?.frontier);
}
function variants(lane) {
  const global = isPlainObject2(lane.global) ? lane.global : {};
  return records2(global.variants ?? lane.variants);
}
function variantMetric(variant, metricId) {
  const metrics = variant.metrics;
  if (Array.isArray(metrics)) {
    const metric = metrics.find((item) => item?.metricId === metricId);
    return metric && typeof metric.value === "number" ? metric.value : void 0;
  }
  const internalId = metricId === "latency_p95" ? "latencyP95" : metricId === "fully_loaded_cost_per_confirmed_high_critical_root_cause" ? "fullyLoadedCostPerConfirmedHighCriticalRootCause" : metricId;
  return metricNumber(metrics?.[internalId]);
}
function candidateIds(lane) {
  const baseline = baselineId(lane);
  const frontier = frontierPoints(lane).filter((point) => point.status === "NON_DOMINATED" || point.status === void 0).map((point) => point.variantId).filter((value) => typeof value === "string" && value !== baseline);
  return uniqueSortedStrings(frontier);
}
function chooseCandidate(lane, policy) {
  const ids = candidateIds(lane);
  if (ids.length === 0) {
    return null;
  }
  if (ids.length > 1 && policy?.tiePolicy === "NO_AUTOMATIC_WINNER") {
    return null;
  }
  const metricId = policy?.tiePolicy === "LOWEST_LATENCY" ? "latency_p95" : "fully_loaded_cost_per_confirmed_high_critical_root_cause";
  const byId = new Map(variants(lane).map((variant) => [variant.variantId, variant]));
  return [...ids].sort((left, right) => {
    const leftValue = variantMetric(byId.get(left) ?? {}, metricId);
    const rightValue = variantMetric(byId.get(right) ?? {}, metricId);
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue - rightValue || compareText(left, right);
    }
    if (typeof leftValue === "number") {
      return -1;
    }
    if (typeof rightValue === "number") {
      return 1;
    }
    return compareText(left, right);
  })[0];
}
function publicLane(lane) {
  return {
    laneId: laneId(lane),
    laneType: laneType2(lane),
    status: laneStatus3(lane),
    attributionStatus: laneAttribution(lane),
    claimBoundary: typeof lane.claimBoundary === "string" ? lane.claimBoundary : "Lane evidence supports only the declared comparison scope."
  };
}
function contracts(value) {
  if (!isPlainObject2(value)) {
    return null;
  }
  const required = [
    "controllerContractId",
    "validatorContractId",
    "dedupePolicyId",
    "postingPolicyId"
  ];
  return required.every((key) => typeof value[key] === "string") ? Object.fromEntries(required.map((key) => [key, value[key]])) : null;
}
function preservedContracts(normalizedLanes, scorecardLane, supplied) {
  if (!scorecardLane) {
    return null;
  }
  const normalizedLane3 = normalizedForScorecardLane(normalizedLanes, scorecardLane);
  const declared = contracts(
    normalizedLane3?.manifest?.productionBaselineContracts ?? scorecardLane.productionBaselineContracts ?? scorecardLane.preservedContracts
  );
  const explicit = contracts(supplied);
  if (explicit && declared) {
    return stableEquivalent(explicit, declared) ? declared : null;
  }
  return declared;
}
function architectureReceiptForVariant(normalizedLanes, scorecardLane, variantId) {
  if (variantId === null) {
    return null;
  }
  const normalizedLane3 = normalizedForScorecardLane(normalizedLanes, scorecardLane);
  if (normalizedLane3) {
    const candidates = records2(
      normalizedLane3.candidateConfigs ?? normalizedLane3.candidates ?? normalizedLane3.normalization?.candidateConfigs
    );
    const candidate = candidates.find((item) => item.variantId === variantId);
    const runs = records2(normalizedLane3.runs).filter(
      (run) => run.variantId === variantId
    );
    if (typeof candidate?.architectureId === "string" && typeof candidate.architectureStructuralDigest === "string" && runs.length > 0 && runs.every(
      (run) => run.architectureId === candidate.architectureId && run.architectureStructuralDigest === candidate.architectureStructuralDigest
    )) {
      return {
        architectureId: candidate.architectureId,
        architectureStructuralDigest: candidate.architectureStructuralDigest
      };
    }
    return null;
  }
  const architecture = records2(scorecardLane.architectures).find(
    (item) => item.variantId === variantId
  );
  if (typeof architecture?.architectureId === "string" && typeof architecture.architectureStructuralDigest === "string") {
    return {
      architectureId: architecture.architectureId,
      architectureStructuralDigest: architecture.architectureStructuralDigest
    };
  }
  const variant = variants(scorecardLane).find((item) => item.variantId === variantId);
  if (typeof variant?.architectureId === "string" && typeof variant.architectureStructuralDigest === "string") {
    return {
      architectureId: variant.architectureId,
      architectureStructuralDigest: variant.architectureStructuralDigest
    };
  }
  return null;
}
function architectureForVariant(normalizedLanes, scorecardLane, variantId) {
  return architectureReceiptForVariant(normalizedLanes, scorecardLane, variantId)?.architectureId ?? null;
}
function stableEquivalent(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function compatibilityProjection(lane) {
  const manifest = isPlainObject2(lane.manifest) ? lane.manifest : {};
  const laneContract = isPlainObject2(manifest.lane) ? manifest.lane : {};
  const taxonomy = isPlainObject2(manifest.sliceTaxonomy) ? manifest.sliceTaxonomy : {};
  const pricing = isPlainObject2(lane.pricingSnapshot) ? lane.pricingSnapshot : {};
  return {
    rubricId: manifest.rubricId ?? null,
    labelVersion: manifest.labelVersion ?? null,
    corpusId: manifest.corpusId ?? null,
    cohortSelectionDigest: laneContract.cohortSelectionDigest ?? null,
    cohortWindowId: laneContract.cohortWindowId ?? null,
    caseIds: Array.isArray(manifest.caseIds) ? [...manifest.caseIds].sort() : null,
    sliceTaxonomy: {
      taxonomyId: taxonomy.taxonomyId ?? null,
      version: taxonomy.version ?? null,
      sliceIds: Array.isArray(taxonomy.sliceIds) ? [...taxonomy.sliceIds].sort() : null
    },
    pricing: {
      snapshotId: pricing.snapshotId ?? manifest.pricingSnapshotId ?? null,
      currency: pricing.currency ?? null,
      costBasis: pricing.costBasis ?? null,
      effectiveAt: pricing.effectiveAt ?? null
    },
    contracts: contracts(manifest.productionBaselineContracts)
  };
}
function recommendationLaneCompatibility(lanes, normalizedLanes, variantId) {
  if (lanes.length <= 1) {
    if (lanes.length === 1 && normalizedLanes.length > 0 && normalizedForScorecardLane(normalizedLanes, lanes[0]) === null) {
      return { status: "UNKNOWN", reasonCode: "MISSING_LANE_PROVENANCE" };
    }
    return { status: "PASS", reasonCode: "LANE_SCOPED_EVIDENCE" };
  }
  const normalized = lanes.map(
    (lane) => normalizedForScorecardLane(normalizedLanes, lane)
  );
  if (normalized.some((lane) => lane === null)) {
    return { status: "UNKNOWN", reasonCode: "MISSING_LANE_PROVENANCE" };
  }
  const first = (
    /** @type {Record<string, any>} */
    normalized[0]
  );
  const projection = compatibilityProjection(first);
  for (const lane of normalized.slice(1)) {
    if (!stableEquivalent(projection, compatibilityProjection(lane))) {
      return {
        status: "UNKNOWN",
        reasonCode: "INCOMPATIBLE_RECOMMENDATION_LANES"
      };
    }
  }
  if (variantId !== null) {
    const receipts = lanes.map(
      (lane) => architectureReceiptForVariant(normalizedLanes, lane, variantId)
    );
    if (receipts.some((receipt) => receipt === null) || new Set(receipts.map((receipt) => JSON.stringify(receipt))).size !== 1) {
      return {
        status: "UNKNOWN",
        reasonCode: "INCOMPATIBLE_ARCHITECTURE_PROVENANCE"
      };
    }
  }
  return { status: "PASS", reasonCode: "RECOMMENDATION_LANES_COMPATIBLE" };
}
function publicGate(gate2) {
  return {
    gateId: typeof gate2.id === "string" ? gate2.id : "RO-GATE-UNKNOWN",
    status: gate2.status === "PASS" || gate2.status === "FAIL" || gate2.status === "UNKNOWN" || gate2.status === "BLOCKED" ? gate2.status : "UNKNOWN",
    reason: typeof gate2.reasonCode === "string" ? gate2.reasonCode : "MISSING_GATE_REASON"
  };
}
function sliceRecommendations(lane, policy, normalizedLanes, allowArchitecture, analysisAsOf) {
  if (!lane || !policy || !Array.isArray(policy.decisionSliceIds)) {
    return [];
  }
  const byId = new Map(
    records2(lane.slices).filter((slice) => typeof slice.sliceId === "string").map((slice) => [slice.sliceId, slice])
  );
  const familySize = Math.max(1, policy.decisionSliceIds.length);
  const adjustedConfidence = 1 - (1 - Number(policy.confidenceLevel)) / familySize;
  const requiredIntervals = [
    "highCriticalRootCauseRecall",
    "criticalMissRate",
    "hallucinationRate",
    "actionablePrecision",
    "rootCauseQuality",
    "fullyLoadedCostPerConfirmedHighCriticalRootCause",
    "humanReviewMinutesPerCase",
    "costP95",
    "costP99",
    "latencyP95",
    "latencyP99"
  ];
  return uniqueSortedStrings(policy.decisionSliceIds).map((sliceId) => {
    const slice = byId.get(sliceId);
    if (!slice) {
      return {
        sliceId,
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["MISSING_DECISION_SLICE_EVIDENCE"]
      };
    }
    const candidate = chooseCandidate(
      {
        baselineVariantId: baselineId(lane),
        global: {
          frontier: slice.frontier,
          variants: slice.variants
        }
      },
      policy
    );
    const comparison = records2(slice.comparisons).find(
      (item) => item.candidateVariantId === candidate
    );
    const multiplicity = isPlainObject2(slice.multiplicity) ? slice.multiplicity : null;
    const intervalsAdjusted = multiplicity?.method === "HOLM_BONFERRONI" && multiplicity.familySize === familySize && typeof multiplicity.adjustedConfidenceLevel === "number" && multiplicity.adjustedConfidenceLevel >= adjustedConfidence && requiredIntervals.every((name) => {
      const interval = comparison?.metrics?.[name]?.interval;
      return isPlainObject2(interval) && interval.status === "AVAILABLE" && typeof interval.confidenceLevel === "number" && interval.confidenceLevel >= adjustedConfidence;
    });
    const sliceLane = {
      ...lane,
      pairedCaseCount: slice.pairedCaseCount,
      global: {
        variants: slice.variants,
        comparisons: slice.comparisons,
        frontier: slice.frontier
      }
    };
    const evaluation = allowArchitecture && laneStatus3(lane) === "COMPLETE" && slice.status === "COMPLETE" && slice.decisionEligible === true && typeof candidate === "string" && intervalsAdjusted ? evaluateRecommendationGates({
      scorecard: { lanes: [sliceLane] },
      decisionPolicy: policy,
      analysisAsOf,
      candidateLaneId: laneId(lane),
      candidateVariantId: candidate
    }) : null;
    const architectureId = typeof candidate === "string" ? architectureForVariant(normalizedLanes, lane, candidate) : null;
    const eligible = evaluation?.status === "RECOMMENDED_FOR_SHADOW" && architectureId !== null;
    const reasonCodes = uniqueSortedStrings([
      ...strings2(slice.limitations),
      ...allowArchitecture ? [] : ["GLOBAL_RECOMMENDATION_NOT_ELIGIBLE"],
      ...slice.decisionEligible === true ? [] : ["SLICE_NOT_DECISION_ELIGIBLE"],
      ...typeof candidate === "string" ? [] : ["NO_ELIGIBLE_NON_BASELINE_ARCHITECTURE"],
      ...intervalsAdjusted ? [] : ["MISSING_HOLM_BONFERRONI_INTERVAL_EVIDENCE"],
      ...architectureId === null ? ["MISSING_ARCHITECTURE_MAPPING"] : [],
      ...evaluation?.reasonCodes ?? []
    ]);
    return {
      sliceId,
      status: eligible ? "COMPLETE" : "INSUFFICIENT_EVIDENCE",
      ...eligible ? { architectureId } : {},
      ...reasonCodes.length > 0 ? { reasonCodes } : {}
    };
  });
}
function recommendReferenceArchitecture({
  scorecard,
  scorecards,
  normalizedLanes,
  staticDiagnostics,
  auditReport,
  decisionPolicy,
  analysisAsOf,
  preservedContracts: suppliedContracts
} = {}) {
  const scorecardLanes = Array.isArray(scorecards) ? scorecards.flatMap(
    (item) => records2(isPlainObject2(item) ? item.lanes : void 0)
  ) : records2(isPlainObject2(scorecard) ? scorecard.lanes : void 0);
  const normalized = records2(normalizedLanes);
  const policy = isPlainObject2(decisionPolicy) ? decisionPolicy : null;
  const relevant = scorecardLanes.filter(
    (lane) => RECOMMENDABLE_LANE_TYPES.has(laneType2(lane))
  );
  const preliminaryEligible = relevant.filter(
    (lane) => laneStatus3(lane) === "COMPLETE" && laneAttribution(lane) !== "CONFOUNDED" && laneAttribution(lane) !== "UNKNOWN"
  );
  const candidateLane = [...preliminaryEligible].sort((left, right) => {
    const typeOrder = (lane) => laneType2(lane) === "SHADOW_PILOT" ? 1 : 0;
    return typeOrder(left) - typeOrder(right) || compareText(laneId(left), laneId(right));
  })[0];
  const candidate = candidateLane ? chooseCandidate(candidateLane, policy) : null;
  const evaluation = evaluateRecommendationGates({
    scorecards,
    scorecard,
    staticDiagnostics,
    auditReport,
    decisionPolicy: policy,
    analysisAsOf,
    candidateLaneId: candidateLane ? laneId(candidateLane) : void 0,
    candidateVariantId: candidate ?? void 0
  });
  const compatibility = recommendationLaneCompatibility(
    preliminaryEligible,
    normalized,
    candidate
  );
  const architectureId = candidateLane === void 0 ? null : architectureForVariant(normalized, candidateLane, candidate);
  const preserved = preservedContracts(
    normalized,
    candidateLane ?? null,
    suppliedContracts
  );
  const rationale = uniqueSortedStrings([
    ...evaluation.reasonCodes,
    ...compatibility.status === "PASS" ? [] : [compatibility.reasonCode],
    ...relevant.length === 0 ? ["NO_RECOMMENDABLE_LANE"] : [],
    ...candidateLane && candidate === null ? [SAFE_NO_CHANGE_REASON] : [],
    ...candidate !== null && architectureId === null ? ["MISSING_ARCHITECTURE_MAPPING"] : [],
    ...preserved === null ? ["MISSING_PRESERVED_BASELINE_CONTRACTS"] : []
  ]);
  let recommendationStatus = evaluation.status;
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && compatibility.status !== "PASS") {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && relevant.length === 0) {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && candidate === null) {
    recommendationStatus = "NO_CHANGE_RECOMMENDED";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && architectureId === null) {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  if (recommendationStatus === "RECOMMENDED_FOR_SHADOW" && preserved === null) {
    recommendationStatus = "INSUFFICIENT_EVIDENCE";
  }
  const recommended = recommendationStatus === "RECOMMENDED_FOR_SHADOW";
  return {
    recommendationStatus,
    decisionPolicyId: policy?.policyId ?? null,
    decisionPolicy: policy,
    gates: [
      ...evaluation.gates.map(publicGate),
      publicGate({
        id: "RO-GATE-LANE-COMPATIBILITY",
        status: compatibility.status,
        reasonCode: compatibility.reasonCode
      })
    ],
    lanes: scorecardLanes.map(publicLane),
    ...recommended && architectureId ? { defaultArchitectureId: architectureId } : {},
    perSliceArchitectures: sliceRecommendations(
      candidateLane ?? null,
      policy,
      normalized,
      recommended,
      analysisAsOf
    ),
    preservedContracts: preserved,
    ...recommended && policy ? {
      shadowPilot: {
        executionMode: "SHADOW_NO_POSTING",
        minimumCases: policy.minimumPairedCases,
        observationDays: policy.shadowObservationDays,
        humanApprovalRequired: true,
        rollbackCriticalMisses: policy.rollbackCriticalMisses
      }
    } : {},
    rationale: rationale.length > 0 ? rationale : ["Evidence supports a shadow-only reference architecture."],
    limitations: [
      "Recommendation is descriptive only; it does not authorize posting or production changes.",
      "Controller, validator, dedupe, and posting contracts remain preserved."
    ]
  };
}

// src/worker.mjs
function objectValue2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalizedFor(request) {
  return normalizeLaneBundles(request.input ?? request.laneBundles ?? {});
}
function verifiedStaticBindings(bindings, normalization) {
  if (!Array.isArray(bindings) || !Array.isArray(normalization.lanes)) {
    return [];
  }
  return bindings.filter((binding) => {
    if (!objectValue2(binding)) {
      return false;
    }
    return normalization.lanes.some((lane) => {
      if (lane.status === "BLOCKED" || lane.laneId !== binding.laneId || !["BEST_SYSTEM", "SHADOW_PILOT"].includes(lane.laneType) || !Array.isArray(lane.candidateConfigs)) {
        return false;
      }
      return lane.candidateConfigs.some(
        (candidate) => candidate.variantId === binding.variantId && candidate.architectureStructuralDigest === binding.architectureStructuralDigest
      );
    });
  });
}
function pipelineFor(request) {
  const normalization = normalizedFor(request);
  const evalValidity = evaluateEvalValidity(
    request.input ?? request.laneBundles ?? {},
    request.options ?? {}
  );
  const buildMany = buildMultiLaneScorecards;
  const scorecard = typeof buildMany === "function" ? buildMany(normalization, {
    ...request.options ?? {},
    evalValidity
  }) : buildBenchmarkScorecard(
    normalization.lanes?.[0] ?? request.input ?? {},
    request.options ?? {}
  );
  return { normalization, evalValidity, scorecard };
}
function runOperation(message) {
  if (!objectValue2(message) || typeof message.operation !== "string" || !objectValue2(message.payload)) {
    fail("RO_WORKER_MESSAGE_INVALID", "Analysis worker received an invalid request.");
  }
  const request = message.payload;
  if (message.operation === "normalize") {
    return normalizedFor(request);
  }
  if (message.operation === "audit-eval") {
    const normalization = normalizedFor(request);
    const evalValidity = evaluateEvalValidity(
      request.input ?? request.laneBundles ?? {},
      request.options ?? {}
    );
    const staticDiagnostics = request.staticInputs ? buildStaticDiagnostics(request.staticInputs, {
      ...request.options ?? {},
      bindings: verifiedStaticBindings(request.staticBindings, normalization),
      blockingStaticRuleIds: request.decisionPolicy?.blockingStaticRuleIds
    }) : null;
    return { normalization, evalValidity, staticDiagnostics };
  }
  if (message.operation === "benchmark") {
    return pipelineFor(request);
  }
  if (message.operation === "recommend-architecture") {
    const pipeline = pipelineFor(request);
    const staticDiagnostics = request.staticInputs ? buildStaticDiagnostics(request.staticInputs, {
      ...request.options ?? {},
      bindings: verifiedStaticBindings(
        request.staticBindings,
        pipeline.normalization
      ),
      blockingStaticRuleIds: request.decisionPolicy?.blockingStaticRuleIds
    }) : null;
    return {
      ...pipeline,
      staticDiagnostics,
      recommendation: recommendReferenceArchitecture({
        scorecard: pipeline.scorecard,
        normalizedLanes: pipeline.normalization.lanes,
        staticDiagnostics,
        decisionPolicy: request.decisionPolicy,
        analysisAsOf: request.analysisAsOf
      })
    };
  }
  fail(
    "RO_WORKER_OPERATION_INVALID",
    "Analysis worker received an unsupported operation."
  );
}
if (parentPort) {
  parentPort.on("message", (message) => {
    try {
      parentPort.postMessage({ ok: true, value: runOperation(message) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: publicError(error) });
    }
  });
}
