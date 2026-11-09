/*
 * GENERATED FILE, DO NOT EDIT. The storage server character counter, bundled from the
 * web app EPUB import and counting code (apps/web/src/lib/server/epub/server-counter.ts).
 * Rebuild with `pnpm build:server-counter` in apps/web after changing that code.
 * epub-count-version: 1
 * build: 5e81d42b7a26c6e1
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../node_modules/.pnpm/path-browserify@1.0.1/node_modules/path-browserify/index.js
var require_path_browserify = __commonJS({
  "../../node_modules/.pnpm/path-browserify@1.0.1/node_modules/path-browserify/index.js"(exports2, module2) {
    "use strict";
    function assertPath(path3) {
      if (typeof path3 !== "string") {
        throw new TypeError("Path must be a string. Received " + JSON.stringify(path3));
      }
    }
    function normalizeStringPosix(path3, allowAboveRoot) {
      var res = "";
      var lastSegmentLength = 0;
      var lastSlash = -1;
      var dots = 0;
      var code;
      for (var i = 0; i <= path3.length; ++i) {
        if (i < path3.length)
          code = path3.charCodeAt(i);
        else if (code === 47)
          break;
        else
          code = 47;
        if (code === 47) {
          if (lastSlash === i - 1 || dots === 1) {
          } else if (lastSlash !== i - 1 && dots === 2) {
            if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
              if (res.length > 2) {
                var lastSlashIndex = res.lastIndexOf("/");
                if (lastSlashIndex !== res.length - 1) {
                  if (lastSlashIndex === -1) {
                    res = "";
                    lastSegmentLength = 0;
                  } else {
                    res = res.slice(0, lastSlashIndex);
                    lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
                  }
                  lastSlash = i;
                  dots = 0;
                  continue;
                }
              } else if (res.length === 2 || res.length === 1) {
                res = "";
                lastSegmentLength = 0;
                lastSlash = i;
                dots = 0;
                continue;
              }
            }
            if (allowAboveRoot) {
              if (res.length > 0)
                res += "/..";
              else
                res = "..";
              lastSegmentLength = 2;
            }
          } else {
            if (res.length > 0)
              res += "/" + path3.slice(lastSlash + 1, i);
            else
              res = path3.slice(lastSlash + 1, i);
            lastSegmentLength = i - lastSlash - 1;
          }
          lastSlash = i;
          dots = 0;
        } else if (code === 46 && dots !== -1) {
          ++dots;
        } else {
          dots = -1;
        }
      }
      return res;
    }
    function _format(sep, pathObject) {
      var dir = pathObject.dir || pathObject.root;
      var base = pathObject.base || (pathObject.name || "") + (pathObject.ext || "");
      if (!dir) {
        return base;
      }
      if (dir === pathObject.root) {
        return dir + base;
      }
      return dir + sep + base;
    }
    var posix = {
      // path.resolve([from ...], to)
      resolve: function resolve() {
        var resolvedPath = "";
        var resolvedAbsolute = false;
        var cwd;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
          var path3;
          if (i >= 0)
            path3 = arguments[i];
          else {
            if (cwd === void 0)
              cwd = process.cwd();
            path3 = cwd;
          }
          assertPath(path3);
          if (path3.length === 0) {
            continue;
          }
          resolvedPath = path3 + "/" + resolvedPath;
          resolvedAbsolute = path3.charCodeAt(0) === 47;
        }
        resolvedPath = normalizeStringPosix(resolvedPath, !resolvedAbsolute);
        if (resolvedAbsolute) {
          if (resolvedPath.length > 0)
            return "/" + resolvedPath;
          else
            return "/";
        } else if (resolvedPath.length > 0) {
          return resolvedPath;
        } else {
          return ".";
        }
      },
      normalize: function normalize(path3) {
        assertPath(path3);
        if (path3.length === 0) return ".";
        var isAbsolute = path3.charCodeAt(0) === 47;
        var trailingSeparator = path3.charCodeAt(path3.length - 1) === 47;
        path3 = normalizeStringPosix(path3, !isAbsolute);
        if (path3.length === 0 && !isAbsolute) path3 = ".";
        if (path3.length > 0 && trailingSeparator) path3 += "/";
        if (isAbsolute) return "/" + path3;
        return path3;
      },
      isAbsolute: function isAbsolute(path3) {
        assertPath(path3);
        return path3.length > 0 && path3.charCodeAt(0) === 47;
      },
      join: function join() {
        if (arguments.length === 0)
          return ".";
        var joined;
        for (var i = 0; i < arguments.length; ++i) {
          var arg = arguments[i];
          assertPath(arg);
          if (arg.length > 0) {
            if (joined === void 0)
              joined = arg;
            else
              joined += "/" + arg;
          }
        }
        if (joined === void 0)
          return ".";
        return posix.normalize(joined);
      },
      relative: function relative2(from, to) {
        assertPath(from);
        assertPath(to);
        if (from === to) return "";
        from = posix.resolve(from);
        to = posix.resolve(to);
        if (from === to) return "";
        var fromStart = 1;
        for (; fromStart < from.length; ++fromStart) {
          if (from.charCodeAt(fromStart) !== 47)
            break;
        }
        var fromEnd = from.length;
        var fromLen = fromEnd - fromStart;
        var toStart = 1;
        for (; toStart < to.length; ++toStart) {
          if (to.charCodeAt(toStart) !== 47)
            break;
        }
        var toEnd = to.length;
        var toLen = toEnd - toStart;
        var length = fromLen < toLen ? fromLen : toLen;
        var lastCommonSep = -1;
        var i = 0;
        for (; i <= length; ++i) {
          if (i === length) {
            if (toLen > length) {
              if (to.charCodeAt(toStart + i) === 47) {
                return to.slice(toStart + i + 1);
              } else if (i === 0) {
                return to.slice(toStart + i);
              }
            } else if (fromLen > length) {
              if (from.charCodeAt(fromStart + i) === 47) {
                lastCommonSep = i;
              } else if (i === 0) {
                lastCommonSep = 0;
              }
            }
            break;
          }
          var fromCode = from.charCodeAt(fromStart + i);
          var toCode = to.charCodeAt(toStart + i);
          if (fromCode !== toCode)
            break;
          else if (fromCode === 47)
            lastCommonSep = i;
        }
        var out = "";
        for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
          if (i === fromEnd || from.charCodeAt(i) === 47) {
            if (out.length === 0)
              out += "..";
            else
              out += "/..";
          }
        }
        if (out.length > 0)
          return out + to.slice(toStart + lastCommonSep);
        else {
          toStart += lastCommonSep;
          if (to.charCodeAt(toStart) === 47)
            ++toStart;
          return to.slice(toStart);
        }
      },
      _makeLong: function _makeLong(path3) {
        return path3;
      },
      dirname: function dirname(path3) {
        assertPath(path3);
        if (path3.length === 0) return ".";
        var code = path3.charCodeAt(0);
        var hasRoot = code === 47;
        var end = -1;
        var matchedSlash = true;
        for (var i = path3.length - 1; i >= 1; --i) {
          code = path3.charCodeAt(i);
          if (code === 47) {
            if (!matchedSlash) {
              end = i;
              break;
            }
          } else {
            matchedSlash = false;
          }
        }
        if (end === -1) return hasRoot ? "/" : ".";
        if (hasRoot && end === 1) return "//";
        return path3.slice(0, end);
      },
      basename: function basename(path3, ext) {
        if (ext !== void 0 && typeof ext !== "string") throw new TypeError('"ext" argument must be a string');
        assertPath(path3);
        var start = 0;
        var end = -1;
        var matchedSlash = true;
        var i;
        if (ext !== void 0 && ext.length > 0 && ext.length <= path3.length) {
          if (ext.length === path3.length && ext === path3) return "";
          var extIdx = ext.length - 1;
          var firstNonSlashEnd = -1;
          for (i = path3.length - 1; i >= 0; --i) {
            var code = path3.charCodeAt(i);
            if (code === 47) {
              if (!matchedSlash) {
                start = i + 1;
                break;
              }
            } else {
              if (firstNonSlashEnd === -1) {
                matchedSlash = false;
                firstNonSlashEnd = i + 1;
              }
              if (extIdx >= 0) {
                if (code === ext.charCodeAt(extIdx)) {
                  if (--extIdx === -1) {
                    end = i;
                  }
                } else {
                  extIdx = -1;
                  end = firstNonSlashEnd;
                }
              }
            }
          }
          if (start === end) end = firstNonSlashEnd;
          else if (end === -1) end = path3.length;
          return path3.slice(start, end);
        } else {
          for (i = path3.length - 1; i >= 0; --i) {
            if (path3.charCodeAt(i) === 47) {
              if (!matchedSlash) {
                start = i + 1;
                break;
              }
            } else if (end === -1) {
              matchedSlash = false;
              end = i + 1;
            }
          }
          if (end === -1) return "";
          return path3.slice(start, end);
        }
      },
      extname: function extname(path3) {
        assertPath(path3);
        var startDot = -1;
        var startPart = 0;
        var end = -1;
        var matchedSlash = true;
        var preDotState = 0;
        for (var i = path3.length - 1; i >= 0; --i) {
          var code = path3.charCodeAt(i);
          if (code === 47) {
            if (!matchedSlash) {
              startPart = i + 1;
              break;
            }
            continue;
          }
          if (end === -1) {
            matchedSlash = false;
            end = i + 1;
          }
          if (code === 46) {
            if (startDot === -1)
              startDot = i;
            else if (preDotState !== 1)
              preDotState = 1;
          } else if (startDot !== -1) {
            preDotState = -1;
          }
        }
        if (startDot === -1 || end === -1 || // We saw a non-dot character immediately before the dot
        preDotState === 0 || // The (right-most) trimmed path component is exactly '..'
        preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
          return "";
        }
        return path3.slice(startDot, end);
      },
      format: function format(pathObject) {
        if (pathObject === null || typeof pathObject !== "object") {
          throw new TypeError('The "pathObject" argument must be of type Object. Received type ' + typeof pathObject);
        }
        return _format("/", pathObject);
      },
      parse: function parse(path3) {
        assertPath(path3);
        var ret = { root: "", dir: "", base: "", ext: "", name: "" };
        if (path3.length === 0) return ret;
        var code = path3.charCodeAt(0);
        var isAbsolute = code === 47;
        var start;
        if (isAbsolute) {
          ret.root = "/";
          start = 1;
        } else {
          start = 0;
        }
        var startDot = -1;
        var startPart = 0;
        var end = -1;
        var matchedSlash = true;
        var i = path3.length - 1;
        var preDotState = 0;
        for (; i >= start; --i) {
          code = path3.charCodeAt(i);
          if (code === 47) {
            if (!matchedSlash) {
              startPart = i + 1;
              break;
            }
            continue;
          }
          if (end === -1) {
            matchedSlash = false;
            end = i + 1;
          }
          if (code === 46) {
            if (startDot === -1) startDot = i;
            else if (preDotState !== 1) preDotState = 1;
          } else if (startDot !== -1) {
            preDotState = -1;
          }
        }
        if (startDot === -1 || end === -1 || // We saw a non-dot character immediately before the dot
        preDotState === 0 || // The (right-most) trimmed path component is exactly '..'
        preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
          if (end !== -1) {
            if (startPart === 0 && isAbsolute) ret.base = ret.name = path3.slice(1, end);
            else ret.base = ret.name = path3.slice(startPart, end);
          }
        } else {
          if (startPart === 0 && isAbsolute) {
            ret.name = path3.slice(1, startDot);
            ret.base = path3.slice(1, end);
          } else {
            ret.name = path3.slice(startPart, startDot);
            ret.base = path3.slice(startPart, end);
          }
          ret.ext = path3.slice(startDot, end);
        }
        if (startPart > 0) ret.dir = path3.slice(0, startPart - 1);
        else if (isAbsolute) ret.dir = "/";
        return ret;
      },
      sep: "/",
      delimiter: ":",
      win32: null,
      posix: null
    };
    posix.posix = posix;
    module2.exports = posix;
  }
});

// src/lib/server/epub/server-counter.ts
var server_counter_exports = {};
__export(server_counter_exports, {
  EPUB_COUNT_VERSION: () => EPUB_COUNT_VERSION,
  ImportHTMLFixMode: () => ImportHTMLFixMode,
  countEpubForServer: () => countEpubForServer,
  defaultEpubImportOptions: () => defaultEpubImportOptions
});
module.exports = __toCommonJS(server_counter_exports);

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/deflate.js
var MAX_BITS = 15;
var D_CODES = 30;
var BL_CODES = 19;
var LENGTH_CODES = 29;
var LITERALS = 256;
var L_CODES = LITERALS + 1 + LENGTH_CODES;
var HEAP_SIZE = 2 * L_CODES + 1;
var END_BLOCK = 256;
var MAX_BL_BITS = 7;
var REP_3_6 = 16;
var REPZ_3_10 = 17;
var REPZ_11_138 = 18;
var Buf_size = 8 * 2;
var Z_DEFAULT_COMPRESSION = -1;
var Z_FILTERED = 1;
var Z_HUFFMAN_ONLY = 2;
var Z_DEFAULT_STRATEGY = 0;
var Z_NO_FLUSH = 0;
var Z_PARTIAL_FLUSH = 1;
var Z_FULL_FLUSH = 3;
var Z_FINISH = 4;
var Z_OK = 0;
var Z_STREAM_END = 1;
var Z_NEED_DICT = 2;
var Z_STREAM_ERROR = -2;
var Z_DATA_ERROR = -3;
var Z_BUF_ERROR = -5;
function extractArray(array) {
  return flatArray(array.map(([length, value]) => new Array(length).fill(value, 0, length)));
}
function flatArray(array) {
  return array.reduce((a, b) => a.concat(Array.isArray(b) ? flatArray(b) : b), []);
}
var _dist_code = [0, 1, 2, 3].concat(...extractArray([
  [2, 4],
  [2, 5],
  [4, 6],
  [4, 7],
  [8, 8],
  [8, 9],
  [16, 10],
  [16, 11],
  [32, 12],
  [32, 13],
  [64, 14],
  [64, 15],
  [2, 0],
  [1, 16],
  [1, 17],
  [2, 18],
  [2, 19],
  [4, 20],
  [4, 21],
  [8, 22],
  [8, 23],
  [16, 24],
  [16, 25],
  [32, 26],
  [32, 27],
  [64, 28],
  [64, 29]
]));
function Tree() {
  const that = this;
  function gen_bitlen(s) {
    const tree = that.dyn_tree;
    const stree = that.stat_desc.static_tree;
    const extra = that.stat_desc.extra_bits;
    const base = that.stat_desc.extra_base;
    const max_length = that.stat_desc.max_length;
    let h;
    let n, m;
    let bits;
    let xbits;
    let f;
    let overflow = 0;
    for (bits = 0; bits <= MAX_BITS; bits++)
      s.bl_count[bits] = 0;
    tree[s.heap[s.heap_max] * 2 + 1] = 0;
    for (h = s.heap_max + 1; h < HEAP_SIZE; h++) {
      n = s.heap[h];
      bits = tree[tree[n * 2 + 1] * 2 + 1] + 1;
      if (bits > max_length) {
        bits = max_length;
        overflow++;
      }
      tree[n * 2 + 1] = bits;
      if (n > that.max_code)
        continue;
      s.bl_count[bits]++;
      xbits = 0;
      if (n >= base)
        xbits = extra[n - base];
      f = tree[n * 2];
      s.opt_len += f * (bits + xbits);
      if (stree)
        s.static_len += f * (stree[n * 2 + 1] + xbits);
    }
    if (overflow === 0)
      return;
    do {
      bits = max_length - 1;
      while (s.bl_count[bits] === 0)
        bits--;
      s.bl_count[bits]--;
      s.bl_count[bits + 1] += 2;
      s.bl_count[max_length]--;
      overflow -= 2;
    } while (overflow > 0);
    for (bits = max_length; bits !== 0; bits--) {
      n = s.bl_count[bits];
      while (n !== 0) {
        m = s.heap[--h];
        if (m > that.max_code)
          continue;
        if (tree[m * 2 + 1] != bits) {
          s.opt_len += (bits - tree[m * 2 + 1]) * tree[m * 2];
          tree[m * 2 + 1] = bits;
        }
        n--;
      }
    }
  }
  function bi_reverse(code, len) {
    let res = 0;
    do {
      res |= code & 1;
      code >>>= 1;
      res <<= 1;
    } while (--len > 0);
    return res >>> 1;
  }
  function gen_codes(tree, max_code, bl_count) {
    const next_code = [];
    let code = 0;
    let bits;
    let n;
    let len;
    for (bits = 1; bits <= MAX_BITS; bits++) {
      next_code[bits] = code = code + bl_count[bits - 1] << 1;
    }
    for (n = 0; n <= max_code; n++) {
      len = tree[n * 2 + 1];
      if (len === 0)
        continue;
      tree[n * 2] = bi_reverse(next_code[len]++, len);
    }
  }
  that.build_tree = function(s) {
    const tree = that.dyn_tree;
    const stree = that.stat_desc.static_tree;
    const elems = that.stat_desc.elems;
    let n, m;
    let max_code = -1;
    let node;
    s.heap_len = 0;
    s.heap_max = HEAP_SIZE;
    for (n = 0; n < elems; n++) {
      if (tree[n * 2] !== 0) {
        s.heap[++s.heap_len] = max_code = n;
        s.depth[n] = 0;
      } else {
        tree[n * 2 + 1] = 0;
      }
    }
    while (s.heap_len < 2) {
      node = s.heap[++s.heap_len] = max_code < 2 ? ++max_code : 0;
      tree[node * 2] = 1;
      s.depth[node] = 0;
      s.opt_len--;
      if (stree)
        s.static_len -= stree[node * 2 + 1];
    }
    that.max_code = max_code;
    for (n = Math.floor(s.heap_len / 2); n >= 1; n--)
      s.pqdownheap(tree, n);
    node = elems;
    do {
      n = s.heap[1];
      s.heap[1] = s.heap[s.heap_len--];
      s.pqdownheap(tree, 1);
      m = s.heap[1];
      s.heap[--s.heap_max] = n;
      s.heap[--s.heap_max] = m;
      tree[node * 2] = tree[n * 2] + tree[m * 2];
      s.depth[node] = Math.max(s.depth[n], s.depth[m]) + 1;
      tree[n * 2 + 1] = tree[m * 2 + 1] = node;
      s.heap[1] = node++;
      s.pqdownheap(tree, 1);
    } while (s.heap_len >= 2);
    s.heap[--s.heap_max] = s.heap[1];
    gen_bitlen(s);
    gen_codes(tree, that.max_code, s.bl_count);
  };
}
Tree._length_code = [0, 1, 2, 3, 4, 5, 6, 7].concat(...extractArray([
  [2, 8],
  [2, 9],
  [2, 10],
  [2, 11],
  [4, 12],
  [4, 13],
  [4, 14],
  [4, 15],
  [8, 16],
  [8, 17],
  [8, 18],
  [8, 19],
  [16, 20],
  [16, 21],
  [16, 22],
  [16, 23],
  [32, 24],
  [32, 25],
  [32, 26],
  [31, 27],
  [1, 28]
]));
Tree.base_length = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 0];
Tree.base_dist = [
  0,
  1,
  2,
  3,
  4,
  6,
  8,
  12,
  16,
  24,
  32,
  48,
  64,
  96,
  128,
  192,
  256,
  384,
  512,
  768,
  1024,
  1536,
  2048,
  3072,
  4096,
  6144,
  8192,
  12288,
  16384,
  24576
];
Tree.d_code = function(dist) {
  return dist < 256 ? _dist_code[dist] : _dist_code[256 + (dist >>> 7)];
};
Tree.extra_lbits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
Tree.extra_dbits = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
Tree.extra_blbits = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
Tree.bl_order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function StaticTree(static_tree, extra_bits, extra_base, elems, max_length) {
  const that = this;
  that.static_tree = static_tree;
  that.extra_bits = extra_bits;
  that.extra_base = extra_base;
  that.elems = elems;
  that.max_length = max_length;
}
var static_ltree2_first_part = [
  12,
  140,
  76,
  204,
  44,
  172,
  108,
  236,
  28,
  156,
  92,
  220,
  60,
  188,
  124,
  252,
  2,
  130,
  66,
  194,
  34,
  162,
  98,
  226,
  18,
  146,
  82,
  210,
  50,
  178,
  114,
  242,
  10,
  138,
  74,
  202,
  42,
  170,
  106,
  234,
  26,
  154,
  90,
  218,
  58,
  186,
  122,
  250,
  6,
  134,
  70,
  198,
  38,
  166,
  102,
  230,
  22,
  150,
  86,
  214,
  54,
  182,
  118,
  246,
  14,
  142,
  78,
  206,
  46,
  174,
  110,
  238,
  30,
  158,
  94,
  222,
  62,
  190,
  126,
  254,
  1,
  129,
  65,
  193,
  33,
  161,
  97,
  225,
  17,
  145,
  81,
  209,
  49,
  177,
  113,
  241,
  9,
  137,
  73,
  201,
  41,
  169,
  105,
  233,
  25,
  153,
  89,
  217,
  57,
  185,
  121,
  249,
  5,
  133,
  69,
  197,
  37,
  165,
  101,
  229,
  21,
  149,
  85,
  213,
  53,
  181,
  117,
  245,
  13,
  141,
  77,
  205,
  45,
  173,
  109,
  237,
  29,
  157,
  93,
  221,
  61,
  189,
  125,
  253,
  19,
  275,
  147,
  403,
  83,
  339,
  211,
  467,
  51,
  307,
  179,
  435,
  115,
  371,
  243,
  499,
  11,
  267,
  139,
  395,
  75,
  331,
  203,
  459,
  43,
  299,
  171,
  427,
  107,
  363,
  235,
  491,
  27,
  283,
  155,
  411,
  91,
  347,
  219,
  475,
  59,
  315,
  187,
  443,
  123,
  379,
  251,
  507,
  7,
  263,
  135,
  391,
  71,
  327,
  199,
  455,
  39,
  295,
  167,
  423,
  103,
  359,
  231,
  487,
  23,
  279,
  151,
  407,
  87,
  343,
  215,
  471,
  55,
  311,
  183,
  439,
  119,
  375,
  247,
  503,
  15,
  271,
  143,
  399,
  79,
  335,
  207,
  463,
  47,
  303,
  175,
  431,
  111,
  367,
  239,
  495,
  31,
  287,
  159,
  415,
  95,
  351,
  223,
  479,
  63,
  319,
  191,
  447,
  127,
  383,
  255,
  511,
  0,
  64,
  32,
  96,
  16,
  80,
  48,
  112,
  8,
  72,
  40,
  104,
  24,
  88,
  56,
  120,
  4,
  68,
  36,
  100,
  20,
  84,
  52,
  116,
  3,
  131,
  67,
  195,
  35,
  163,
  99,
  227
];
var static_ltree2_second_part = extractArray([[144, 8], [112, 9], [24, 7], [8, 8]]);
StaticTree.static_ltree = flatArray(static_ltree2_first_part.map((value, index) => [value, static_ltree2_second_part[index]]));
var static_dtree_first_part = [0, 16, 8, 24, 4, 20, 12, 28, 2, 18, 10, 26, 6, 22, 14, 30, 1, 17, 9, 25, 5, 21, 13, 29, 3, 19, 11, 27, 7, 23];
var static_dtree_second_part = extractArray([[30, 5]]);
StaticTree.static_dtree = flatArray(static_dtree_first_part.map((value, index) => [value, static_dtree_second_part[index]]));
StaticTree.static_l_desc = new StaticTree(StaticTree.static_ltree, Tree.extra_lbits, LITERALS + 1, L_CODES, MAX_BITS);
StaticTree.static_d_desc = new StaticTree(StaticTree.static_dtree, Tree.extra_dbits, 0, D_CODES, MAX_BITS);
StaticTree.static_bl_desc = new StaticTree(null, Tree.extra_blbits, 0, BL_CODES, MAX_BL_BITS);
var MAX_MEM_LEVEL = 9;
var DEF_MEM_LEVEL = 8;
function Config(good_length, max_lazy, nice_length, max_chain, func) {
  const that = this;
  that.good_length = good_length;
  that.max_lazy = max_lazy;
  that.nice_length = nice_length;
  that.max_chain = max_chain;
  that.func = func;
}
var STORED = 0;
var FAST = 1;
var SLOW = 2;
var config_table = [
  new Config(0, 0, 0, 0, STORED),
  new Config(4, 4, 8, 4, FAST),
  new Config(4, 5, 16, 8, FAST),
  new Config(4, 6, 32, 32, FAST),
  new Config(4, 4, 16, 16, SLOW),
  new Config(8, 16, 32, 32, SLOW),
  new Config(8, 16, 128, 128, SLOW),
  new Config(8, 32, 128, 256, SLOW),
  new Config(32, 128, 258, 1024, SLOW),
  new Config(32, 258, 258, 4096, SLOW)
];
var z_errmsg = [
  "need dictionary",
  // Z_NEED_DICT
  // 2
  "stream end",
  // Z_STREAM_END 1
  "",
  // Z_OK 0
  "",
  // Z_ERRNO (-1)
  "stream error",
  // Z_STREAM_ERROR (-2)
  "data error",
  // Z_DATA_ERROR (-3)
  "",
  // Z_MEM_ERROR (-4)
  "buffer error",
  // Z_BUF_ERROR (-5)
  "",
  // Z_VERSION_ERROR (-6)
  ""
];
var NeedMore = 0;
var BlockDone = 1;
var FinishStarted = 2;
var FinishDone = 3;
var PRESET_DICT = 32;
var INIT_STATE = 42;
var BUSY_STATE = 113;
var FINISH_STATE = 666;
var Z_DEFLATED = 8;
var STORED_BLOCK = 0;
var STATIC_TREES = 1;
var DYN_TREES = 2;
var MIN_MATCH = 3;
var MAX_MATCH = 258;
var MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
function smaller(tree, n, m, depth) {
  const tn2 = tree[n * 2];
  const tm2 = tree[m * 2];
  return tn2 < tm2 || tn2 == tm2 && depth[n] <= depth[m];
}
function Deflate() {
  const that = this;
  let strm;
  let status;
  let pending_buf_size;
  let last_flush;
  let w_size;
  let w_bits;
  let w_mask;
  let win;
  let window_size;
  let prev;
  let head;
  let ins_h;
  let hash_size;
  let hash_bits;
  let hash_mask;
  let hash_shift;
  let block_start;
  let match_length;
  let prev_match;
  let match_available;
  let strstart;
  let match_start;
  let lookahead;
  let prev_length;
  let max_chain_length;
  let max_lazy_match;
  let level;
  let strategy;
  let good_match;
  let nice_match;
  let dyn_ltree;
  let dyn_dtree;
  let bl_tree;
  const l_desc = new Tree();
  const d_desc = new Tree();
  const bl_desc = new Tree();
  that.depth = [];
  let lit_bufsize;
  let last_lit;
  let matches;
  let last_eob_len;
  let bi_buf;
  let bi_valid;
  that.bl_count = [];
  that.heap = [];
  dyn_ltree = [];
  dyn_dtree = [];
  bl_tree = [];
  function lm_init() {
    window_size = 2 * w_size;
    head[hash_size - 1] = 0;
    for (let i = 0; i < hash_size - 1; i++) {
      head[i] = 0;
    }
    max_lazy_match = config_table[level].max_lazy;
    good_match = config_table[level].good_length;
    nice_match = config_table[level].nice_length;
    max_chain_length = config_table[level].max_chain;
    strstart = 0;
    block_start = 0;
    lookahead = 0;
    match_length = prev_length = MIN_MATCH - 1;
    match_available = 0;
    ins_h = 0;
  }
  function init_block() {
    let i;
    for (i = 0; i < L_CODES; i++)
      dyn_ltree[i * 2] = 0;
    for (i = 0; i < D_CODES; i++)
      dyn_dtree[i * 2] = 0;
    for (i = 0; i < BL_CODES; i++)
      bl_tree[i * 2] = 0;
    dyn_ltree[END_BLOCK * 2] = 1;
    that.opt_len = that.static_len = 0;
    last_lit = matches = 0;
  }
  function tr_init() {
    l_desc.dyn_tree = dyn_ltree;
    l_desc.stat_desc = StaticTree.static_l_desc;
    d_desc.dyn_tree = dyn_dtree;
    d_desc.stat_desc = StaticTree.static_d_desc;
    bl_desc.dyn_tree = bl_tree;
    bl_desc.stat_desc = StaticTree.static_bl_desc;
    bi_buf = 0;
    bi_valid = 0;
    last_eob_len = 8;
    init_block();
  }
  that.pqdownheap = function(tree, k) {
    const heap = that.heap;
    const v = heap[k];
    let j = k << 1;
    while (j <= that.heap_len) {
      if (j < that.heap_len && smaller(tree, heap[j + 1], heap[j], that.depth)) {
        j++;
      }
      if (smaller(tree, v, heap[j], that.depth))
        break;
      heap[k] = heap[j];
      k = j;
      j <<= 1;
    }
    heap[k] = v;
  };
  function scan_tree(tree, max_code) {
    let prevlen = -1;
    let curlen;
    let nextlen = tree[0 * 2 + 1];
    let count = 0;
    let max_count = 7;
    let min_count = 4;
    if (nextlen === 0) {
      max_count = 138;
      min_count = 3;
    }
    tree[(max_code + 1) * 2 + 1] = 65535;
    for (let n = 0; n <= max_code; n++) {
      curlen = nextlen;
      nextlen = tree[(n + 1) * 2 + 1];
      if (++count < max_count && curlen == nextlen) {
        continue;
      } else if (count < min_count) {
        bl_tree[curlen * 2] += count;
      } else if (curlen !== 0) {
        if (curlen != prevlen)
          bl_tree[curlen * 2]++;
        bl_tree[REP_3_6 * 2]++;
      } else if (count <= 10) {
        bl_tree[REPZ_3_10 * 2]++;
      } else {
        bl_tree[REPZ_11_138 * 2]++;
      }
      count = 0;
      prevlen = curlen;
      if (nextlen === 0) {
        max_count = 138;
        min_count = 3;
      } else if (curlen == nextlen) {
        max_count = 6;
        min_count = 3;
      } else {
        max_count = 7;
        min_count = 4;
      }
    }
  }
  function build_bl_tree() {
    let max_blindex;
    scan_tree(dyn_ltree, l_desc.max_code);
    scan_tree(dyn_dtree, d_desc.max_code);
    bl_desc.build_tree(that);
    for (max_blindex = BL_CODES - 1; max_blindex >= 3; max_blindex--) {
      if (bl_tree[Tree.bl_order[max_blindex] * 2 + 1] !== 0)
        break;
    }
    that.opt_len += 3 * (max_blindex + 1) + 5 + 5 + 4;
    return max_blindex;
  }
  function put_byte(p) {
    that.pending_buf[that.pending++] = p;
  }
  function put_short(w) {
    put_byte(w & 255);
    put_byte(w >>> 8 & 255);
  }
  function putShortMSB(b) {
    put_byte(b >> 8 & 255);
    put_byte(b & 255 & 255);
  }
  function send_bits(value, length) {
    let val;
    const len = length;
    if (bi_valid > Buf_size - len) {
      val = value;
      bi_buf |= val << bi_valid & 65535;
      put_short(bi_buf);
      bi_buf = val >>> Buf_size - bi_valid;
      bi_valid += len - Buf_size;
    } else {
      bi_buf |= value << bi_valid & 65535;
      bi_valid += len;
    }
  }
  function send_code(c, tree) {
    const c2 = c * 2;
    send_bits(tree[c2] & 65535, tree[c2 + 1] & 65535);
  }
  function send_tree(tree, max_code) {
    let n;
    let prevlen = -1;
    let curlen;
    let nextlen = tree[0 * 2 + 1];
    let count = 0;
    let max_count = 7;
    let min_count = 4;
    if (nextlen === 0) {
      max_count = 138;
      min_count = 3;
    }
    for (n = 0; n <= max_code; n++) {
      curlen = nextlen;
      nextlen = tree[(n + 1) * 2 + 1];
      if (++count < max_count && curlen == nextlen) {
        continue;
      } else if (count < min_count) {
        do {
          send_code(curlen, bl_tree);
        } while (--count !== 0);
      } else if (curlen !== 0) {
        if (curlen != prevlen) {
          send_code(curlen, bl_tree);
          count--;
        }
        send_code(REP_3_6, bl_tree);
        send_bits(count - 3, 2);
      } else if (count <= 10) {
        send_code(REPZ_3_10, bl_tree);
        send_bits(count - 3, 3);
      } else {
        send_code(REPZ_11_138, bl_tree);
        send_bits(count - 11, 7);
      }
      count = 0;
      prevlen = curlen;
      if (nextlen === 0) {
        max_count = 138;
        min_count = 3;
      } else if (curlen == nextlen) {
        max_count = 6;
        min_count = 3;
      } else {
        max_count = 7;
        min_count = 4;
      }
    }
  }
  function send_all_trees(lcodes, dcodes, blcodes) {
    let rank;
    send_bits(lcodes - 257, 5);
    send_bits(dcodes - 1, 5);
    send_bits(blcodes - 4, 4);
    for (rank = 0; rank < blcodes; rank++) {
      send_bits(bl_tree[Tree.bl_order[rank] * 2 + 1], 3);
    }
    send_tree(dyn_ltree, lcodes - 1);
    send_tree(dyn_dtree, dcodes - 1);
  }
  function bi_flush() {
    if (bi_valid == 16) {
      put_short(bi_buf);
      bi_buf = 0;
      bi_valid = 0;
    } else if (bi_valid >= 8) {
      put_byte(bi_buf & 255);
      bi_buf >>>= 8;
      bi_valid -= 8;
    }
  }
  function _tr_align() {
    send_bits(STATIC_TREES << 1, 3);
    send_code(END_BLOCK, StaticTree.static_ltree);
    bi_flush();
    if (1 + last_eob_len + 10 - bi_valid < 9) {
      send_bits(STATIC_TREES << 1, 3);
      send_code(END_BLOCK, StaticTree.static_ltree);
      bi_flush();
    }
    last_eob_len = 7;
  }
  function _tr_tally(dist, lc) {
    let out_length, in_length, dcode;
    that.dist_buf[last_lit] = dist;
    that.lc_buf[last_lit] = lc & 255;
    last_lit++;
    if (dist === 0) {
      dyn_ltree[lc * 2]++;
    } else {
      matches++;
      dist--;
      dyn_ltree[(Tree._length_code[lc] + LITERALS + 1) * 2]++;
      dyn_dtree[Tree.d_code(dist) * 2]++;
    }
    if ((last_lit & 8191) === 0 && level > 2) {
      out_length = last_lit * 8;
      in_length = strstart - block_start;
      for (dcode = 0; dcode < D_CODES; dcode++) {
        out_length += dyn_dtree[dcode * 2] * (5 + Tree.extra_dbits[dcode]);
      }
      out_length >>>= 3;
      if (matches < Math.floor(last_lit / 2) && out_length < Math.floor(in_length / 2))
        return true;
    }
    return last_lit == lit_bufsize - 1;
  }
  function compress_block(ltree, dtree) {
    let dist;
    let lc;
    let lx = 0;
    let code;
    let extra;
    if (last_lit !== 0) {
      do {
        dist = that.dist_buf[lx];
        lc = that.lc_buf[lx];
        lx++;
        if (dist === 0) {
          send_code(lc, ltree);
        } else {
          code = Tree._length_code[lc];
          send_code(code + LITERALS + 1, ltree);
          extra = Tree.extra_lbits[code];
          if (extra !== 0) {
            lc -= Tree.base_length[code];
            send_bits(lc, extra);
          }
          dist--;
          code = Tree.d_code(dist);
          send_code(code, dtree);
          extra = Tree.extra_dbits[code];
          if (extra !== 0) {
            dist -= Tree.base_dist[code];
            send_bits(dist, extra);
          }
        }
      } while (lx < last_lit);
    }
    send_code(END_BLOCK, ltree);
    last_eob_len = ltree[END_BLOCK * 2 + 1];
  }
  function bi_windup() {
    if (bi_valid > 8) {
      put_short(bi_buf);
    } else if (bi_valid > 0) {
      put_byte(bi_buf & 255);
    }
    bi_buf = 0;
    bi_valid = 0;
  }
  function copy_block(buf, len, header) {
    bi_windup();
    last_eob_len = 8;
    if (header) {
      put_short(len);
      put_short(~len);
    }
    that.pending_buf.set(win.subarray(buf, buf + len), that.pending);
    that.pending += len;
  }
  function _tr_stored_block(buf, stored_len, eof) {
    send_bits((STORED_BLOCK << 1) + (eof ? 1 : 0), 3);
    copy_block(buf, stored_len, true);
  }
  function _tr_flush_block(buf, stored_len, eof) {
    let opt_lenb, static_lenb;
    let max_blindex = 0;
    if (level > 0) {
      l_desc.build_tree(that);
      d_desc.build_tree(that);
      max_blindex = build_bl_tree();
      opt_lenb = that.opt_len + 3 + 7 >>> 3;
      static_lenb = that.static_len + 3 + 7 >>> 3;
      if (static_lenb <= opt_lenb)
        opt_lenb = static_lenb;
    } else {
      opt_lenb = static_lenb = stored_len + 5;
    }
    if (stored_len + 4 <= opt_lenb && buf != -1) {
      _tr_stored_block(buf, stored_len, eof);
    } else if (static_lenb == opt_lenb) {
      send_bits((STATIC_TREES << 1) + (eof ? 1 : 0), 3);
      compress_block(StaticTree.static_ltree, StaticTree.static_dtree);
    } else {
      send_bits((DYN_TREES << 1) + (eof ? 1 : 0), 3);
      send_all_trees(l_desc.max_code + 1, d_desc.max_code + 1, max_blindex + 1);
      compress_block(dyn_ltree, dyn_dtree);
    }
    init_block();
    if (eof) {
      bi_windup();
    }
  }
  function flush_block_only(eof) {
    _tr_flush_block(block_start >= 0 ? block_start : -1, strstart - block_start, eof);
    block_start = strstart;
    strm.flush_pending();
  }
  function fill_window() {
    let n, m;
    let p;
    let more;
    do {
      more = window_size - lookahead - strstart;
      if (more === 0 && strstart === 0 && lookahead === 0) {
        more = w_size;
      } else if (more == -1) {
        more--;
      } else if (strstart >= w_size + w_size - MIN_LOOKAHEAD) {
        win.set(win.subarray(w_size, w_size + w_size), 0);
        match_start -= w_size;
        strstart -= w_size;
        block_start -= w_size;
        n = hash_size;
        p = n;
        do {
          m = head[--p] & 65535;
          head[p] = m >= w_size ? m - w_size : 0;
        } while (--n !== 0);
        n = w_size;
        p = n;
        do {
          m = prev[--p] & 65535;
          prev[p] = m >= w_size ? m - w_size : 0;
        } while (--n !== 0);
        more += w_size;
      }
      if (strm.avail_in === 0)
        return;
      n = strm.read_buf(win, strstart + lookahead, more);
      lookahead += n;
      if (lookahead >= MIN_MATCH) {
        ins_h = win[strstart] & 255;
        ins_h = (ins_h << hash_shift ^ win[strstart + 1] & 255) & hash_mask;
      }
    } while (lookahead < MIN_LOOKAHEAD && strm.avail_in !== 0);
  }
  function deflate_stored(flush) {
    let max_block_size = 65535;
    let max_start;
    if (max_block_size > pending_buf_size - 5) {
      max_block_size = pending_buf_size - 5;
    }
    while (true) {
      if (lookahead <= 1) {
        fill_window();
        if (lookahead === 0 && flush == Z_NO_FLUSH)
          return NeedMore;
        if (lookahead === 0)
          break;
      }
      strstart += lookahead;
      lookahead = 0;
      max_start = block_start + max_block_size;
      if (strstart === 0 || strstart >= max_start) {
        lookahead = strstart - max_start;
        strstart = max_start;
        flush_block_only(false);
        if (strm.avail_out === 0)
          return NeedMore;
      }
      if (strstart - block_start >= w_size - MIN_LOOKAHEAD) {
        flush_block_only(false);
        if (strm.avail_out === 0)
          return NeedMore;
      }
    }
    flush_block_only(flush == Z_FINISH);
    if (strm.avail_out === 0)
      return flush == Z_FINISH ? FinishStarted : NeedMore;
    return flush == Z_FINISH ? FinishDone : BlockDone;
  }
  function longest_match(cur_match) {
    let chain_length = max_chain_length;
    let scan = strstart;
    let match;
    let len;
    let best_len = prev_length;
    const limit = strstart > w_size - MIN_LOOKAHEAD ? strstart - (w_size - MIN_LOOKAHEAD) : 0;
    let _nice_match = nice_match;
    const wmask = w_mask;
    const strend = strstart + MAX_MATCH;
    let scan_end1 = win[scan + best_len - 1];
    let scan_end = win[scan + best_len];
    if (prev_length >= good_match) {
      chain_length >>= 2;
    }
    if (_nice_match > lookahead)
      _nice_match = lookahead;
    do {
      match = cur_match;
      if (win[match + best_len] != scan_end || win[match + best_len - 1] != scan_end1 || win[match] != win[scan] || win[++match] != win[scan + 1])
        continue;
      scan += 2;
      match++;
      do {
      } while (win[++scan] == win[++match] && win[++scan] == win[++match] && win[++scan] == win[++match] && win[++scan] == win[++match] && win[++scan] == win[++match] && win[++scan] == win[++match] && win[++scan] == win[++match] && win[++scan] == win[++match] && scan < strend);
      len = MAX_MATCH - (strend - scan);
      scan = strend - MAX_MATCH;
      if (len > best_len) {
        match_start = cur_match;
        best_len = len;
        if (len >= _nice_match)
          break;
        scan_end1 = win[scan + best_len - 1];
        scan_end = win[scan + best_len];
      }
    } while ((cur_match = prev[cur_match & wmask] & 65535) > limit && --chain_length !== 0);
    if (best_len <= lookahead)
      return best_len;
    return lookahead;
  }
  function deflate_fast(flush) {
    let hash_head = 0;
    let bflush;
    while (true) {
      if (lookahead < MIN_LOOKAHEAD) {
        fill_window();
        if (lookahead < MIN_LOOKAHEAD && flush == Z_NO_FLUSH) {
          return NeedMore;
        }
        if (lookahead === 0)
          break;
      }
      if (lookahead >= MIN_MATCH) {
        ins_h = (ins_h << hash_shift ^ win[strstart + (MIN_MATCH - 1)] & 255) & hash_mask;
        hash_head = head[ins_h] & 65535;
        prev[strstart & w_mask] = head[ins_h];
        head[ins_h] = strstart;
      }
      if (hash_head !== 0 && (strstart - hash_head & 65535) <= w_size - MIN_LOOKAHEAD) {
        if (strategy != Z_HUFFMAN_ONLY) {
          match_length = longest_match(hash_head);
        }
      }
      if (match_length >= MIN_MATCH) {
        bflush = _tr_tally(strstart - match_start, match_length - MIN_MATCH);
        lookahead -= match_length;
        if (match_length <= max_lazy_match && lookahead >= MIN_MATCH) {
          match_length--;
          do {
            strstart++;
            ins_h = (ins_h << hash_shift ^ win[strstart + (MIN_MATCH - 1)] & 255) & hash_mask;
            hash_head = head[ins_h] & 65535;
            prev[strstart & w_mask] = head[ins_h];
            head[ins_h] = strstart;
          } while (--match_length !== 0);
          strstart++;
        } else {
          strstart += match_length;
          match_length = 0;
          ins_h = win[strstart] & 255;
          ins_h = (ins_h << hash_shift ^ win[strstart + 1] & 255) & hash_mask;
        }
      } else {
        bflush = _tr_tally(0, win[strstart] & 255);
        lookahead--;
        strstart++;
      }
      if (bflush) {
        flush_block_only(false);
        if (strm.avail_out === 0)
          return NeedMore;
      }
    }
    flush_block_only(flush == Z_FINISH);
    if (strm.avail_out === 0) {
      if (flush == Z_FINISH)
        return FinishStarted;
      else
        return NeedMore;
    }
    return flush == Z_FINISH ? FinishDone : BlockDone;
  }
  function deflate_slow(flush) {
    let hash_head = 0;
    let bflush;
    let max_insert;
    while (true) {
      if (lookahead < MIN_LOOKAHEAD) {
        fill_window();
        if (lookahead < MIN_LOOKAHEAD && flush == Z_NO_FLUSH) {
          return NeedMore;
        }
        if (lookahead === 0)
          break;
      }
      if (lookahead >= MIN_MATCH) {
        ins_h = (ins_h << hash_shift ^ win[strstart + (MIN_MATCH - 1)] & 255) & hash_mask;
        hash_head = head[ins_h] & 65535;
        prev[strstart & w_mask] = head[ins_h];
        head[ins_h] = strstart;
      }
      prev_length = match_length;
      prev_match = match_start;
      match_length = MIN_MATCH - 1;
      if (hash_head !== 0 && prev_length < max_lazy_match && (strstart - hash_head & 65535) <= w_size - MIN_LOOKAHEAD) {
        if (strategy != Z_HUFFMAN_ONLY) {
          match_length = longest_match(hash_head);
        }
        if (match_length <= 5 && (strategy == Z_FILTERED || match_length == MIN_MATCH && strstart - match_start > 4096)) {
          match_length = MIN_MATCH - 1;
        }
      }
      if (prev_length >= MIN_MATCH && match_length <= prev_length) {
        max_insert = strstart + lookahead - MIN_MATCH;
        bflush = _tr_tally(strstart - 1 - prev_match, prev_length - MIN_MATCH);
        lookahead -= prev_length - 1;
        prev_length -= 2;
        do {
          if (++strstart <= max_insert) {
            ins_h = (ins_h << hash_shift ^ win[strstart + (MIN_MATCH - 1)] & 255) & hash_mask;
            hash_head = head[ins_h] & 65535;
            prev[strstart & w_mask] = head[ins_h];
            head[ins_h] = strstart;
          }
        } while (--prev_length !== 0);
        match_available = 0;
        match_length = MIN_MATCH - 1;
        strstart++;
        if (bflush) {
          flush_block_only(false);
          if (strm.avail_out === 0)
            return NeedMore;
        }
      } else if (match_available !== 0) {
        bflush = _tr_tally(0, win[strstart - 1] & 255);
        if (bflush) {
          flush_block_only(false);
        }
        strstart++;
        lookahead--;
        if (strm.avail_out === 0)
          return NeedMore;
      } else {
        match_available = 1;
        strstart++;
        lookahead--;
      }
    }
    if (match_available !== 0) {
      bflush = _tr_tally(0, win[strstart - 1] & 255);
      match_available = 0;
    }
    flush_block_only(flush == Z_FINISH);
    if (strm.avail_out === 0) {
      if (flush == Z_FINISH)
        return FinishStarted;
      else
        return NeedMore;
    }
    return flush == Z_FINISH ? FinishDone : BlockDone;
  }
  function deflateReset(strm2) {
    strm2.total_in = strm2.total_out = 0;
    strm2.msg = null;
    that.pending = 0;
    that.pending_out = 0;
    status = BUSY_STATE;
    last_flush = Z_NO_FLUSH;
    tr_init();
    lm_init();
    return Z_OK;
  }
  that.deflateInit = function(strm2, _level, bits, _method, memLevel, _strategy) {
    if (!_method)
      _method = Z_DEFLATED;
    if (!memLevel)
      memLevel = DEF_MEM_LEVEL;
    if (!_strategy)
      _strategy = Z_DEFAULT_STRATEGY;
    strm2.msg = null;
    if (_level == Z_DEFAULT_COMPRESSION)
      _level = 6;
    if (memLevel < 1 || memLevel > MAX_MEM_LEVEL || _method != Z_DEFLATED || bits < 9 || bits > 15 || _level < 0 || _level > 9 || _strategy < 0 || _strategy > Z_HUFFMAN_ONLY) {
      return Z_STREAM_ERROR;
    }
    strm2.dstate = that;
    w_bits = bits;
    w_size = 1 << w_bits;
    w_mask = w_size - 1;
    hash_bits = memLevel + 7;
    hash_size = 1 << hash_bits;
    hash_mask = hash_size - 1;
    hash_shift = Math.floor((hash_bits + MIN_MATCH - 1) / MIN_MATCH);
    win = new Uint8Array(w_size * 2);
    prev = [];
    head = [];
    lit_bufsize = 1 << memLevel + 6;
    that.pending_buf = new Uint8Array(lit_bufsize * 4);
    pending_buf_size = lit_bufsize * 4;
    that.dist_buf = new Uint16Array(lit_bufsize);
    that.lc_buf = new Uint8Array(lit_bufsize);
    level = _level;
    strategy = _strategy;
    return deflateReset(strm2);
  };
  that.deflateEnd = function() {
    if (status != INIT_STATE && status != BUSY_STATE && status != FINISH_STATE) {
      return Z_STREAM_ERROR;
    }
    that.lc_buf = null;
    that.dist_buf = null;
    that.pending_buf = null;
    head = null;
    prev = null;
    win = null;
    that.dstate = null;
    return status == BUSY_STATE ? Z_DATA_ERROR : Z_OK;
  };
  that.deflateParams = function(strm2, _level, _strategy) {
    let err = Z_OK;
    if (_level == Z_DEFAULT_COMPRESSION) {
      _level = 6;
    }
    if (_level < 0 || _level > 9 || _strategy < 0 || _strategy > Z_HUFFMAN_ONLY) {
      return Z_STREAM_ERROR;
    }
    if (config_table[level].func != config_table[_level].func && strm2.total_in !== 0) {
      err = strm2.deflate(Z_PARTIAL_FLUSH);
    }
    if (level != _level) {
      level = _level;
      max_lazy_match = config_table[level].max_lazy;
      good_match = config_table[level].good_length;
      nice_match = config_table[level].nice_length;
      max_chain_length = config_table[level].max_chain;
    }
    strategy = _strategy;
    return err;
  };
  that.deflateSetDictionary = function(_strm, dictionary, dictLength) {
    let length = dictLength;
    let n, index = 0;
    if (!dictionary || status != INIT_STATE)
      return Z_STREAM_ERROR;
    if (length < MIN_MATCH)
      return Z_OK;
    if (length > w_size - MIN_LOOKAHEAD) {
      length = w_size - MIN_LOOKAHEAD;
      index = dictLength - length;
    }
    win.set(dictionary.subarray(index, index + length), 0);
    strstart = length;
    block_start = length;
    ins_h = win[0] & 255;
    ins_h = (ins_h << hash_shift ^ win[1] & 255) & hash_mask;
    for (n = 0; n <= length - MIN_MATCH; n++) {
      ins_h = (ins_h << hash_shift ^ win[n + (MIN_MATCH - 1)] & 255) & hash_mask;
      prev[n & w_mask] = head[ins_h];
      head[ins_h] = n;
    }
    return Z_OK;
  };
  that.deflate = function(_strm, flush) {
    let i, header, level_flags, old_flush, bstate;
    if (flush > Z_FINISH || flush < 0) {
      return Z_STREAM_ERROR;
    }
    if (!_strm.next_out || !_strm.next_in && _strm.avail_in !== 0 || status == FINISH_STATE && flush != Z_FINISH) {
      _strm.msg = z_errmsg[Z_NEED_DICT - Z_STREAM_ERROR];
      return Z_STREAM_ERROR;
    }
    if (_strm.avail_out === 0) {
      _strm.msg = z_errmsg[Z_NEED_DICT - Z_BUF_ERROR];
      return Z_BUF_ERROR;
    }
    strm = _strm;
    old_flush = last_flush;
    last_flush = flush;
    if (status == INIT_STATE) {
      header = Z_DEFLATED + (w_bits - 8 << 4) << 8;
      level_flags = (level - 1 & 255) >> 1;
      if (level_flags > 3)
        level_flags = 3;
      header |= level_flags << 6;
      if (strstart !== 0)
        header |= PRESET_DICT;
      header += 31 - header % 31;
      status = BUSY_STATE;
      putShortMSB(header);
    }
    if (that.pending !== 0) {
      strm.flush_pending();
      if (strm.avail_out === 0) {
        last_flush = -1;
        return Z_OK;
      }
    } else if (strm.avail_in === 0 && flush <= old_flush && flush != Z_FINISH) {
      strm.msg = z_errmsg[Z_NEED_DICT - Z_BUF_ERROR];
      return Z_BUF_ERROR;
    }
    if (status == FINISH_STATE && strm.avail_in !== 0) {
      _strm.msg = z_errmsg[Z_NEED_DICT - Z_BUF_ERROR];
      return Z_BUF_ERROR;
    }
    if (strm.avail_in !== 0 || lookahead !== 0 || flush != Z_NO_FLUSH && status != FINISH_STATE) {
      bstate = -1;
      switch (config_table[level].func) {
        case STORED:
          bstate = deflate_stored(flush);
          break;
        case FAST:
          bstate = deflate_fast(flush);
          break;
        case SLOW:
          bstate = deflate_slow(flush);
          break;
        default:
      }
      if (bstate == FinishStarted || bstate == FinishDone) {
        status = FINISH_STATE;
      }
      if (bstate == NeedMore || bstate == FinishStarted) {
        if (strm.avail_out === 0) {
          last_flush = -1;
        }
        return Z_OK;
      }
      if (bstate == BlockDone) {
        if (flush == Z_PARTIAL_FLUSH) {
          _tr_align();
        } else {
          _tr_stored_block(0, 0, false);
          if (flush == Z_FULL_FLUSH) {
            for (i = 0; i < hash_size; i++)
              head[i] = 0;
          }
        }
        strm.flush_pending();
        if (strm.avail_out === 0) {
          last_flush = -1;
          return Z_OK;
        }
      }
    }
    if (flush != Z_FINISH)
      return Z_OK;
    return Z_STREAM_END;
  };
}
function ZStream() {
  const that = this;
  that.next_in_index = 0;
  that.next_out_index = 0;
  that.avail_in = 0;
  that.total_in = 0;
  that.avail_out = 0;
  that.total_out = 0;
}
ZStream.prototype = {
  deflateInit: function(level, bits) {
    const that = this;
    that.dstate = new Deflate();
    if (!bits)
      bits = MAX_BITS;
    return that.dstate.deflateInit(that, level, bits);
  },
  deflate: function(flush) {
    const that = this;
    if (!that.dstate) {
      return Z_STREAM_ERROR;
    }
    return that.dstate.deflate(that, flush);
  },
  deflateEnd: function() {
    const that = this;
    if (!that.dstate)
      return Z_STREAM_ERROR;
    const ret = that.dstate.deflateEnd();
    that.dstate = null;
    return ret;
  },
  deflateParams: function(level, strategy) {
    const that = this;
    if (!that.dstate)
      return Z_STREAM_ERROR;
    return that.dstate.deflateParams(that, level, strategy);
  },
  deflateSetDictionary: function(dictionary, dictLength) {
    const that = this;
    if (!that.dstate)
      return Z_STREAM_ERROR;
    return that.dstate.deflateSetDictionary(that, dictionary, dictLength);
  },
  // Read a new buffer from the current input stream, update the
  // total number of bytes read. All deflate() input goes through
  // this function so some applications may wish to modify it to avoid
  // allocating a large strm->next_in buffer and copying from it.
  // (See also flush_pending()).
  read_buf: function(buf, start, size) {
    const that = this;
    let len = that.avail_in;
    if (len > size)
      len = size;
    if (len === 0)
      return 0;
    that.avail_in -= len;
    buf.set(that.next_in.subarray(that.next_in_index, that.next_in_index + len), start);
    that.next_in_index += len;
    that.total_in += len;
    return len;
  },
  // Flush as much pending output as possible. All deflate() output goes
  // through this function so some applications may wish to modify it
  // to avoid allocating a large strm->next_out buffer and copying into it.
  // (See also read_buf()).
  flush_pending: function() {
    const that = this;
    let len = that.dstate.pending;
    if (len > that.avail_out)
      len = that.avail_out;
    if (len === 0)
      return;
    that.next_out.set(that.dstate.pending_buf.subarray(that.dstate.pending_out, that.dstate.pending_out + len), that.next_out_index);
    that.next_out_index += len;
    that.dstate.pending_out += len;
    that.total_out += len;
    that.avail_out -= len;
    that.dstate.pending -= len;
    if (that.dstate.pending === 0) {
      that.dstate.pending_out = 0;
    }
  }
};
function ZipDeflate(options) {
  const that = this;
  const z = new ZStream();
  const bufsize = getMaximumCompressedSize(options && options.chunkSize ? options.chunkSize : 64 * 1024);
  const flush = Z_NO_FLUSH;
  const buf = new Uint8Array(bufsize);
  let level = options ? options.level : Z_DEFAULT_COMPRESSION;
  if (typeof level == "undefined")
    level = Z_DEFAULT_COMPRESSION;
  z.deflateInit(level);
  z.next_out = buf;
  that.append = function(data, onprogress) {
    let err, array, lastIndex = 0, bufferIndex = 0, bufferSize = 0;
    const buffers = [];
    if (!data.length)
      return;
    z.next_in_index = 0;
    z.next_in = data;
    z.avail_in = data.length;
    do {
      z.next_out_index = 0;
      z.avail_out = bufsize;
      err = z.deflate(flush);
      if (err != Z_OK)
        throw new Error("deflating: " + z.msg);
      if (z.next_out_index)
        if (z.next_out_index == bufsize)
          buffers.push(new Uint8Array(buf));
        else
          buffers.push(buf.slice(0, z.next_out_index));
      bufferSize += z.next_out_index;
      if (onprogress && z.next_in_index > 0 && z.next_in_index != lastIndex) {
        onprogress(z.next_in_index);
        lastIndex = z.next_in_index;
      }
    } while (z.avail_in > 0 || z.avail_out === 0);
    if (buffers.length > 1) {
      array = new Uint8Array(bufferSize);
      buffers.forEach(function(chunk) {
        array.set(chunk, bufferIndex);
        bufferIndex += chunk.length;
      });
    } else {
      array = buffers[0] || new Uint8Array(0);
    }
    return array;
  };
  that.flush = function() {
    let err, array, bufferIndex = 0, bufferSize = 0;
    const buffers = [];
    do {
      z.next_out_index = 0;
      z.avail_out = bufsize;
      err = z.deflate(Z_FINISH);
      if (err != Z_STREAM_END && err != Z_OK)
        throw new Error("deflating: " + z.msg);
      if (bufsize - z.avail_out > 0)
        buffers.push(buf.slice(0, z.next_out_index));
      bufferSize += z.next_out_index;
    } while (z.avail_in > 0 || z.avail_out === 0);
    z.deflateEnd();
    array = new Uint8Array(bufferSize);
    buffers.forEach(function(chunk) {
      array.set(chunk, bufferIndex);
      bufferIndex += chunk.length;
    });
    return array;
  };
}
function getMaximumCompressedSize(uncompressedSize) {
  return uncompressedSize + 5 * (Math.floor(uncompressedSize / 16383) + 1);
}
var deflate_default = ZipDeflate;

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/inflate.js
var MAX_BITS2 = 15;
var Z_OK2 = 0;
var Z_STREAM_END2 = 1;
var Z_NEED_DICT2 = 2;
var Z_STREAM_ERROR2 = -2;
var Z_DATA_ERROR2 = -3;
var Z_MEM_ERROR = -4;
var Z_BUF_ERROR2 = -5;
var inflate_mask = [
  0,
  1,
  3,
  7,
  15,
  31,
  63,
  127,
  255,
  511,
  1023,
  2047,
  4095,
  8191,
  16383,
  32767,
  65535
];
var MANY = 1440;
var Z_NO_FLUSH2 = 0;
var Z_FINISH2 = 4;
var fixed_bl = 9;
var fixed_bd = 5;
var fixed_tl = [
  96,
  7,
  256,
  0,
  8,
  80,
  0,
  8,
  16,
  84,
  8,
  115,
  82,
  7,
  31,
  0,
  8,
  112,
  0,
  8,
  48,
  0,
  9,
  192,
  80,
  7,
  10,
  0,
  8,
  96,
  0,
  8,
  32,
  0,
  9,
  160,
  0,
  8,
  0,
  0,
  8,
  128,
  0,
  8,
  64,
  0,
  9,
  224,
  80,
  7,
  6,
  0,
  8,
  88,
  0,
  8,
  24,
  0,
  9,
  144,
  83,
  7,
  59,
  0,
  8,
  120,
  0,
  8,
  56,
  0,
  9,
  208,
  81,
  7,
  17,
  0,
  8,
  104,
  0,
  8,
  40,
  0,
  9,
  176,
  0,
  8,
  8,
  0,
  8,
  136,
  0,
  8,
  72,
  0,
  9,
  240,
  80,
  7,
  4,
  0,
  8,
  84,
  0,
  8,
  20,
  85,
  8,
  227,
  83,
  7,
  43,
  0,
  8,
  116,
  0,
  8,
  52,
  0,
  9,
  200,
  81,
  7,
  13,
  0,
  8,
  100,
  0,
  8,
  36,
  0,
  9,
  168,
  0,
  8,
  4,
  0,
  8,
  132,
  0,
  8,
  68,
  0,
  9,
  232,
  80,
  7,
  8,
  0,
  8,
  92,
  0,
  8,
  28,
  0,
  9,
  152,
  84,
  7,
  83,
  0,
  8,
  124,
  0,
  8,
  60,
  0,
  9,
  216,
  82,
  7,
  23,
  0,
  8,
  108,
  0,
  8,
  44,
  0,
  9,
  184,
  0,
  8,
  12,
  0,
  8,
  140,
  0,
  8,
  76,
  0,
  9,
  248,
  80,
  7,
  3,
  0,
  8,
  82,
  0,
  8,
  18,
  85,
  8,
  163,
  83,
  7,
  35,
  0,
  8,
  114,
  0,
  8,
  50,
  0,
  9,
  196,
  81,
  7,
  11,
  0,
  8,
  98,
  0,
  8,
  34,
  0,
  9,
  164,
  0,
  8,
  2,
  0,
  8,
  130,
  0,
  8,
  66,
  0,
  9,
  228,
  80,
  7,
  7,
  0,
  8,
  90,
  0,
  8,
  26,
  0,
  9,
  148,
  84,
  7,
  67,
  0,
  8,
  122,
  0,
  8,
  58,
  0,
  9,
  212,
  82,
  7,
  19,
  0,
  8,
  106,
  0,
  8,
  42,
  0,
  9,
  180,
  0,
  8,
  10,
  0,
  8,
  138,
  0,
  8,
  74,
  0,
  9,
  244,
  80,
  7,
  5,
  0,
  8,
  86,
  0,
  8,
  22,
  192,
  8,
  0,
  83,
  7,
  51,
  0,
  8,
  118,
  0,
  8,
  54,
  0,
  9,
  204,
  81,
  7,
  15,
  0,
  8,
  102,
  0,
  8,
  38,
  0,
  9,
  172,
  0,
  8,
  6,
  0,
  8,
  134,
  0,
  8,
  70,
  0,
  9,
  236,
  80,
  7,
  9,
  0,
  8,
  94,
  0,
  8,
  30,
  0,
  9,
  156,
  84,
  7,
  99,
  0,
  8,
  126,
  0,
  8,
  62,
  0,
  9,
  220,
  82,
  7,
  27,
  0,
  8,
  110,
  0,
  8,
  46,
  0,
  9,
  188,
  0,
  8,
  14,
  0,
  8,
  142,
  0,
  8,
  78,
  0,
  9,
  252,
  96,
  7,
  256,
  0,
  8,
  81,
  0,
  8,
  17,
  85,
  8,
  131,
  82,
  7,
  31,
  0,
  8,
  113,
  0,
  8,
  49,
  0,
  9,
  194,
  80,
  7,
  10,
  0,
  8,
  97,
  0,
  8,
  33,
  0,
  9,
  162,
  0,
  8,
  1,
  0,
  8,
  129,
  0,
  8,
  65,
  0,
  9,
  226,
  80,
  7,
  6,
  0,
  8,
  89,
  0,
  8,
  25,
  0,
  9,
  146,
  83,
  7,
  59,
  0,
  8,
  121,
  0,
  8,
  57,
  0,
  9,
  210,
  81,
  7,
  17,
  0,
  8,
  105,
  0,
  8,
  41,
  0,
  9,
  178,
  0,
  8,
  9,
  0,
  8,
  137,
  0,
  8,
  73,
  0,
  9,
  242,
  80,
  7,
  4,
  0,
  8,
  85,
  0,
  8,
  21,
  80,
  8,
  258,
  83,
  7,
  43,
  0,
  8,
  117,
  0,
  8,
  53,
  0,
  9,
  202,
  81,
  7,
  13,
  0,
  8,
  101,
  0,
  8,
  37,
  0,
  9,
  170,
  0,
  8,
  5,
  0,
  8,
  133,
  0,
  8,
  69,
  0,
  9,
  234,
  80,
  7,
  8,
  0,
  8,
  93,
  0,
  8,
  29,
  0,
  9,
  154,
  84,
  7,
  83,
  0,
  8,
  125,
  0,
  8,
  61,
  0,
  9,
  218,
  82,
  7,
  23,
  0,
  8,
  109,
  0,
  8,
  45,
  0,
  9,
  186,
  0,
  8,
  13,
  0,
  8,
  141,
  0,
  8,
  77,
  0,
  9,
  250,
  80,
  7,
  3,
  0,
  8,
  83,
  0,
  8,
  19,
  85,
  8,
  195,
  83,
  7,
  35,
  0,
  8,
  115,
  0,
  8,
  51,
  0,
  9,
  198,
  81,
  7,
  11,
  0,
  8,
  99,
  0,
  8,
  35,
  0,
  9,
  166,
  0,
  8,
  3,
  0,
  8,
  131,
  0,
  8,
  67,
  0,
  9,
  230,
  80,
  7,
  7,
  0,
  8,
  91,
  0,
  8,
  27,
  0,
  9,
  150,
  84,
  7,
  67,
  0,
  8,
  123,
  0,
  8,
  59,
  0,
  9,
  214,
  82,
  7,
  19,
  0,
  8,
  107,
  0,
  8,
  43,
  0,
  9,
  182,
  0,
  8,
  11,
  0,
  8,
  139,
  0,
  8,
  75,
  0,
  9,
  246,
  80,
  7,
  5,
  0,
  8,
  87,
  0,
  8,
  23,
  192,
  8,
  0,
  83,
  7,
  51,
  0,
  8,
  119,
  0,
  8,
  55,
  0,
  9,
  206,
  81,
  7,
  15,
  0,
  8,
  103,
  0,
  8,
  39,
  0,
  9,
  174,
  0,
  8,
  7,
  0,
  8,
  135,
  0,
  8,
  71,
  0,
  9,
  238,
  80,
  7,
  9,
  0,
  8,
  95,
  0,
  8,
  31,
  0,
  9,
  158,
  84,
  7,
  99,
  0,
  8,
  127,
  0,
  8,
  63,
  0,
  9,
  222,
  82,
  7,
  27,
  0,
  8,
  111,
  0,
  8,
  47,
  0,
  9,
  190,
  0,
  8,
  15,
  0,
  8,
  143,
  0,
  8,
  79,
  0,
  9,
  254,
  96,
  7,
  256,
  0,
  8,
  80,
  0,
  8,
  16,
  84,
  8,
  115,
  82,
  7,
  31,
  0,
  8,
  112,
  0,
  8,
  48,
  0,
  9,
  193,
  80,
  7,
  10,
  0,
  8,
  96,
  0,
  8,
  32,
  0,
  9,
  161,
  0,
  8,
  0,
  0,
  8,
  128,
  0,
  8,
  64,
  0,
  9,
  225,
  80,
  7,
  6,
  0,
  8,
  88,
  0,
  8,
  24,
  0,
  9,
  145,
  83,
  7,
  59,
  0,
  8,
  120,
  0,
  8,
  56,
  0,
  9,
  209,
  81,
  7,
  17,
  0,
  8,
  104,
  0,
  8,
  40,
  0,
  9,
  177,
  0,
  8,
  8,
  0,
  8,
  136,
  0,
  8,
  72,
  0,
  9,
  241,
  80,
  7,
  4,
  0,
  8,
  84,
  0,
  8,
  20,
  85,
  8,
  227,
  83,
  7,
  43,
  0,
  8,
  116,
  0,
  8,
  52,
  0,
  9,
  201,
  81,
  7,
  13,
  0,
  8,
  100,
  0,
  8,
  36,
  0,
  9,
  169,
  0,
  8,
  4,
  0,
  8,
  132,
  0,
  8,
  68,
  0,
  9,
  233,
  80,
  7,
  8,
  0,
  8,
  92,
  0,
  8,
  28,
  0,
  9,
  153,
  84,
  7,
  83,
  0,
  8,
  124,
  0,
  8,
  60,
  0,
  9,
  217,
  82,
  7,
  23,
  0,
  8,
  108,
  0,
  8,
  44,
  0,
  9,
  185,
  0,
  8,
  12,
  0,
  8,
  140,
  0,
  8,
  76,
  0,
  9,
  249,
  80,
  7,
  3,
  0,
  8,
  82,
  0,
  8,
  18,
  85,
  8,
  163,
  83,
  7,
  35,
  0,
  8,
  114,
  0,
  8,
  50,
  0,
  9,
  197,
  81,
  7,
  11,
  0,
  8,
  98,
  0,
  8,
  34,
  0,
  9,
  165,
  0,
  8,
  2,
  0,
  8,
  130,
  0,
  8,
  66,
  0,
  9,
  229,
  80,
  7,
  7,
  0,
  8,
  90,
  0,
  8,
  26,
  0,
  9,
  149,
  84,
  7,
  67,
  0,
  8,
  122,
  0,
  8,
  58,
  0,
  9,
  213,
  82,
  7,
  19,
  0,
  8,
  106,
  0,
  8,
  42,
  0,
  9,
  181,
  0,
  8,
  10,
  0,
  8,
  138,
  0,
  8,
  74,
  0,
  9,
  245,
  80,
  7,
  5,
  0,
  8,
  86,
  0,
  8,
  22,
  192,
  8,
  0,
  83,
  7,
  51,
  0,
  8,
  118,
  0,
  8,
  54,
  0,
  9,
  205,
  81,
  7,
  15,
  0,
  8,
  102,
  0,
  8,
  38,
  0,
  9,
  173,
  0,
  8,
  6,
  0,
  8,
  134,
  0,
  8,
  70,
  0,
  9,
  237,
  80,
  7,
  9,
  0,
  8,
  94,
  0,
  8,
  30,
  0,
  9,
  157,
  84,
  7,
  99,
  0,
  8,
  126,
  0,
  8,
  62,
  0,
  9,
  221,
  82,
  7,
  27,
  0,
  8,
  110,
  0,
  8,
  46,
  0,
  9,
  189,
  0,
  8,
  14,
  0,
  8,
  142,
  0,
  8,
  78,
  0,
  9,
  253,
  96,
  7,
  256,
  0,
  8,
  81,
  0,
  8,
  17,
  85,
  8,
  131,
  82,
  7,
  31,
  0,
  8,
  113,
  0,
  8,
  49,
  0,
  9,
  195,
  80,
  7,
  10,
  0,
  8,
  97,
  0,
  8,
  33,
  0,
  9,
  163,
  0,
  8,
  1,
  0,
  8,
  129,
  0,
  8,
  65,
  0,
  9,
  227,
  80,
  7,
  6,
  0,
  8,
  89,
  0,
  8,
  25,
  0,
  9,
  147,
  83,
  7,
  59,
  0,
  8,
  121,
  0,
  8,
  57,
  0,
  9,
  211,
  81,
  7,
  17,
  0,
  8,
  105,
  0,
  8,
  41,
  0,
  9,
  179,
  0,
  8,
  9,
  0,
  8,
  137,
  0,
  8,
  73,
  0,
  9,
  243,
  80,
  7,
  4,
  0,
  8,
  85,
  0,
  8,
  21,
  80,
  8,
  258,
  83,
  7,
  43,
  0,
  8,
  117,
  0,
  8,
  53,
  0,
  9,
  203,
  81,
  7,
  13,
  0,
  8,
  101,
  0,
  8,
  37,
  0,
  9,
  171,
  0,
  8,
  5,
  0,
  8,
  133,
  0,
  8,
  69,
  0,
  9,
  235,
  80,
  7,
  8,
  0,
  8,
  93,
  0,
  8,
  29,
  0,
  9,
  155,
  84,
  7,
  83,
  0,
  8,
  125,
  0,
  8,
  61,
  0,
  9,
  219,
  82,
  7,
  23,
  0,
  8,
  109,
  0,
  8,
  45,
  0,
  9,
  187,
  0,
  8,
  13,
  0,
  8,
  141,
  0,
  8,
  77,
  0,
  9,
  251,
  80,
  7,
  3,
  0,
  8,
  83,
  0,
  8,
  19,
  85,
  8,
  195,
  83,
  7,
  35,
  0,
  8,
  115,
  0,
  8,
  51,
  0,
  9,
  199,
  81,
  7,
  11,
  0,
  8,
  99,
  0,
  8,
  35,
  0,
  9,
  167,
  0,
  8,
  3,
  0,
  8,
  131,
  0,
  8,
  67,
  0,
  9,
  231,
  80,
  7,
  7,
  0,
  8,
  91,
  0,
  8,
  27,
  0,
  9,
  151,
  84,
  7,
  67,
  0,
  8,
  123,
  0,
  8,
  59,
  0,
  9,
  215,
  82,
  7,
  19,
  0,
  8,
  107,
  0,
  8,
  43,
  0,
  9,
  183,
  0,
  8,
  11,
  0,
  8,
  139,
  0,
  8,
  75,
  0,
  9,
  247,
  80,
  7,
  5,
  0,
  8,
  87,
  0,
  8,
  23,
  192,
  8,
  0,
  83,
  7,
  51,
  0,
  8,
  119,
  0,
  8,
  55,
  0,
  9,
  207,
  81,
  7,
  15,
  0,
  8,
  103,
  0,
  8,
  39,
  0,
  9,
  175,
  0,
  8,
  7,
  0,
  8,
  135,
  0,
  8,
  71,
  0,
  9,
  239,
  80,
  7,
  9,
  0,
  8,
  95,
  0,
  8,
  31,
  0,
  9,
  159,
  84,
  7,
  99,
  0,
  8,
  127,
  0,
  8,
  63,
  0,
  9,
  223,
  82,
  7,
  27,
  0,
  8,
  111,
  0,
  8,
  47,
  0,
  9,
  191,
  0,
  8,
  15,
  0,
  8,
  143,
  0,
  8,
  79,
  0,
  9,
  255
];
var fixed_td = [
  80,
  5,
  1,
  87,
  5,
  257,
  83,
  5,
  17,
  91,
  5,
  4097,
  81,
  5,
  5,
  89,
  5,
  1025,
  85,
  5,
  65,
  93,
  5,
  16385,
  80,
  5,
  3,
  88,
  5,
  513,
  84,
  5,
  33,
  92,
  5,
  8193,
  82,
  5,
  9,
  90,
  5,
  2049,
  86,
  5,
  129,
  192,
  5,
  24577,
  80,
  5,
  2,
  87,
  5,
  385,
  83,
  5,
  25,
  91,
  5,
  6145,
  81,
  5,
  7,
  89,
  5,
  1537,
  85,
  5,
  97,
  93,
  5,
  24577,
  80,
  5,
  4,
  88,
  5,
  769,
  84,
  5,
  49,
  92,
  5,
  12289,
  82,
  5,
  13,
  90,
  5,
  3073,
  86,
  5,
  193,
  192,
  5,
  24577
];
var cplens = [
  // Copy lengths for literal codes 257..285
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  13,
  15,
  17,
  19,
  23,
  27,
  31,
  35,
  43,
  51,
  59,
  67,
  83,
  99,
  115,
  131,
  163,
  195,
  227,
  258,
  0,
  0
];
var cplext = [
  // Extra bits for literal codes 257..285
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  112,
  112
  // 112==invalid
];
var cpdist = [
  // Copy offsets for distance codes 0..29
  1,
  2,
  3,
  4,
  5,
  7,
  9,
  13,
  17,
  25,
  33,
  49,
  65,
  97,
  129,
  193,
  257,
  385,
  513,
  769,
  1025,
  1537,
  2049,
  3073,
  4097,
  6145,
  8193,
  12289,
  16385,
  24577
];
var cpdext = [
  // Extra bits for distance codes
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13
];
var BMAX = 15;
function InfTree() {
  const that = this;
  let hn;
  let v;
  let c;
  let r;
  let u;
  let x;
  function huft_build(b, bindex, n, s, d, e, t2, m, hp, hn2, v2) {
    let a;
    let f;
    let g;
    let h;
    let i;
    let j;
    let k;
    let l;
    let mask;
    let p;
    let q;
    let w;
    let xp;
    let y;
    let z;
    p = 0;
    i = n;
    do {
      c[b[bindex + p]]++;
      p++;
      i--;
    } while (i !== 0);
    if (c[0] == n) {
      t2[0] = -1;
      m[0] = 0;
      return Z_OK2;
    }
    l = m[0];
    for (j = 1; j <= BMAX; j++)
      if (c[j] !== 0)
        break;
    k = j;
    if (l < j) {
      l = j;
    }
    for (i = BMAX; i !== 0; i--) {
      if (c[i] !== 0)
        break;
    }
    g = i;
    if (l > i) {
      l = i;
    }
    m[0] = l;
    for (y = 1 << j; j < i; j++, y <<= 1) {
      if ((y -= c[j]) < 0) {
        return Z_DATA_ERROR2;
      }
    }
    if ((y -= c[i]) < 0) {
      return Z_DATA_ERROR2;
    }
    c[i] += y;
    x[1] = j = 0;
    p = 1;
    xp = 2;
    while (--i !== 0) {
      x[xp] = j += c[p];
      xp++;
      p++;
    }
    i = 0;
    p = 0;
    do {
      if ((j = b[bindex + p]) !== 0) {
        v2[x[j]++] = i;
      }
      p++;
    } while (++i < n);
    n = x[g];
    x[0] = i = 0;
    p = 0;
    h = -1;
    w = -l;
    u[0] = 0;
    q = 0;
    z = 0;
    for (; k <= g; k++) {
      a = c[k];
      while (a-- !== 0) {
        while (k > w + l) {
          h++;
          w += l;
          z = g - w;
          z = z > l ? l : z;
          if ((f = 1 << (j = k - w)) > a + 1) {
            f -= a + 1;
            xp = k;
            if (j < z) {
              while (++j < z) {
                if ((f <<= 1) <= c[++xp])
                  break;
                f -= c[xp];
              }
            }
          }
          z = 1 << j;
          if (hn2[0] + z > MANY) {
            return Z_DATA_ERROR2;
          }
          u[h] = q = /* hp+ */
          hn2[0];
          hn2[0] += z;
          if (h !== 0) {
            x[h] = i;
            r[0] = /* (byte) */
            j;
            r[1] = /* (byte) */
            l;
            j = i >>> w - l;
            r[2] = /* (int) */
            q - u[h - 1] - j;
            hp.set(r, (u[h - 1] + j) * 3);
          } else {
            t2[0] = q;
          }
        }
        r[1] = /* (byte) */
        k - w;
        if (p >= n) {
          r[0] = 128 + 64;
        } else if (v2[p] < s) {
          r[0] = /* (byte) */
          v2[p] < 256 ? 0 : 32 + 64;
          r[2] = v2[p++];
        } else {
          r[0] = /* (byte) */
          e[v2[p] - s] + 16 + 64;
          r[2] = d[v2[p++] - s];
        }
        f = 1 << k - w;
        for (j = i >>> w; j < z; j += f) {
          hp.set(r, (q + j) * 3);
        }
        for (j = 1 << k - 1; (i & j) !== 0; j >>>= 1) {
          i ^= j;
        }
        i ^= j;
        mask = (1 << w) - 1;
        while ((i & mask) != x[h]) {
          h--;
          w -= l;
          mask = (1 << w) - 1;
        }
      }
    }
    return y !== 0 && g != 1 ? Z_BUF_ERROR2 : Z_OK2;
  }
  function initWorkArea(vsize) {
    let i;
    if (!hn) {
      hn = [];
      v = [];
      c = new Int32Array(BMAX + 1);
      r = [];
      u = new Int32Array(BMAX);
      x = new Int32Array(BMAX + 1);
    }
    if (v.length < vsize) {
      v = [];
    }
    for (i = 0; i < vsize; i++) {
      v[i] = 0;
    }
    for (i = 0; i < BMAX + 1; i++) {
      c[i] = 0;
    }
    for (i = 0; i < 3; i++) {
      r[i] = 0;
    }
    u.set(c.subarray(0, BMAX), 0);
    x.set(c.subarray(0, BMAX + 1), 0);
  }
  that.inflate_trees_bits = function(c2, bb, tb, hp, z) {
    let result;
    initWorkArea(19);
    hn[0] = 0;
    result = huft_build(c2, 0, 19, 19, null, null, tb, bb, hp, hn, v);
    if (result == Z_DATA_ERROR2) {
      z.msg = "oversubscribed dynamic bit lengths tree";
    } else if (result == Z_BUF_ERROR2 || bb[0] === 0) {
      z.msg = "incomplete dynamic bit lengths tree";
      result = Z_DATA_ERROR2;
    }
    return result;
  };
  that.inflate_trees_dynamic = function(nl, nd, c2, bl, bd, tl, td, hp, z) {
    let result;
    initWorkArea(288);
    hn[0] = 0;
    result = huft_build(c2, 0, nl, 257, cplens, cplext, tl, bl, hp, hn, v);
    if (result != Z_OK2 || bl[0] === 0) {
      if (result == Z_DATA_ERROR2) {
        z.msg = "oversubscribed literal/length tree";
      } else if (result != Z_MEM_ERROR) {
        z.msg = "incomplete literal/length tree";
        result = Z_DATA_ERROR2;
      }
      return result;
    }
    initWorkArea(288);
    result = huft_build(c2, nl, nd, 0, cpdist, cpdext, td, bd, hp, hn, v);
    if (result != Z_OK2 || bd[0] === 0 && nl > 257) {
      if (result == Z_DATA_ERROR2) {
        z.msg = "oversubscribed distance tree";
      } else if (result == Z_BUF_ERROR2) {
        z.msg = "incomplete distance tree";
        result = Z_DATA_ERROR2;
      } else if (result != Z_MEM_ERROR) {
        z.msg = "empty distance tree with lengths";
        result = Z_DATA_ERROR2;
      }
      return result;
    }
    return Z_OK2;
  };
}
InfTree.inflate_trees_fixed = function(bl, bd, tl, td) {
  bl[0] = fixed_bl;
  bd[0] = fixed_bd;
  tl[0] = fixed_tl;
  td[0] = fixed_td;
  return Z_OK2;
};
var START = 0;
var LEN = 1;
var LENEXT = 2;
var DIST = 3;
var DISTEXT = 4;
var COPY = 5;
var LIT = 6;
var WASH = 7;
var END = 8;
var BADCODE = 9;
function InfCodes() {
  const that = this;
  let mode2;
  let len = 0;
  let tree;
  let tree_index = 0;
  let need = 0;
  let lit = 0;
  let get = 0;
  let dist = 0;
  let lbits = 0;
  let dbits = 0;
  let ltree;
  let ltree_index = 0;
  let dtree;
  let dtree_index = 0;
  function inflate_fast(bl, bd, tl, tl_index, td, td_index, s, z) {
    let t2;
    let tp;
    let tp_index;
    let e;
    let b;
    let k;
    let p;
    let n;
    let q;
    let m;
    let ml;
    let md;
    let c;
    let d;
    let r;
    let tp_index_t_3;
    p = z.next_in_index;
    n = z.avail_in;
    b = s.bitb;
    k = s.bitk;
    q = s.write;
    m = q < s.read ? s.read - q - 1 : s.end - q;
    ml = inflate_mask[bl];
    md = inflate_mask[bd];
    do {
      while (k < 20) {
        n--;
        b |= (z.read_byte(p++) & 255) << k;
        k += 8;
      }
      t2 = b & ml;
      tp = tl;
      tp_index = tl_index;
      tp_index_t_3 = (tp_index + t2) * 3;
      if ((e = tp[tp_index_t_3]) === 0) {
        b >>= tp[tp_index_t_3 + 1];
        k -= tp[tp_index_t_3 + 1];
        s.win[q++] = /* (byte) */
        tp[tp_index_t_3 + 2];
        m--;
        continue;
      }
      do {
        b >>= tp[tp_index_t_3 + 1];
        k -= tp[tp_index_t_3 + 1];
        if ((e & 16) !== 0) {
          e &= 15;
          c = tp[tp_index_t_3 + 2] + /* (int) */
          (b & inflate_mask[e]);
          b >>= e;
          k -= e;
          while (k < 15) {
            n--;
            b |= (z.read_byte(p++) & 255) << k;
            k += 8;
          }
          t2 = b & md;
          tp = td;
          tp_index = td_index;
          tp_index_t_3 = (tp_index + t2) * 3;
          e = tp[tp_index_t_3];
          do {
            b >>= tp[tp_index_t_3 + 1];
            k -= tp[tp_index_t_3 + 1];
            if ((e & 16) !== 0) {
              e &= 15;
              while (k < e) {
                n--;
                b |= (z.read_byte(p++) & 255) << k;
                k += 8;
              }
              d = tp[tp_index_t_3 + 2] + (b & inflate_mask[e]);
              b >>= e;
              k -= e;
              m -= c;
              if (q >= d) {
                r = q - d;
                if (q - r > 0 && 2 > q - r) {
                  s.win[q++] = s.win[r++];
                  s.win[q++] = s.win[r++];
                  c -= 2;
                } else {
                  s.win.set(s.win.subarray(r, r + 2), q);
                  q += 2;
                  r += 2;
                  c -= 2;
                }
              } else {
                r = q - d;
                do {
                  r += s.end;
                } while (r < 0);
                e = s.end - r;
                if (c > e) {
                  c -= e;
                  if (q - r > 0 && e > q - r) {
                    do {
                      s.win[q++] = s.win[r++];
                    } while (--e !== 0);
                  } else {
                    s.win.set(s.win.subarray(r, r + e), q);
                    q += e;
                    r += e;
                    e = 0;
                  }
                  r = 0;
                }
              }
              if (q - r > 0 && c > q - r) {
                do {
                  s.win[q++] = s.win[r++];
                } while (--c !== 0);
              } else {
                s.win.set(s.win.subarray(r, r + c), q);
                q += c;
                r += c;
                c = 0;
              }
              break;
            } else if ((e & 64) === 0) {
              t2 += tp[tp_index_t_3 + 2];
              t2 += b & inflate_mask[e];
              tp_index_t_3 = (tp_index + t2) * 3;
              e = tp[tp_index_t_3];
            } else {
              z.msg = "invalid distance code";
              c = z.avail_in - n;
              c = k >> 3 < c ? k >> 3 : c;
              n += c;
              p -= c;
              k -= c << 3;
              s.bitb = b;
              s.bitk = k;
              z.avail_in = n;
              z.total_in += p - z.next_in_index;
              z.next_in_index = p;
              s.write = q;
              return Z_DATA_ERROR2;
            }
          } while (true);
          break;
        }
        if ((e & 64) === 0) {
          t2 += tp[tp_index_t_3 + 2];
          t2 += b & inflate_mask[e];
          tp_index_t_3 = (tp_index + t2) * 3;
          if ((e = tp[tp_index_t_3]) === 0) {
            b >>= tp[tp_index_t_3 + 1];
            k -= tp[tp_index_t_3 + 1];
            s.win[q++] = /* (byte) */
            tp[tp_index_t_3 + 2];
            m--;
            break;
          }
        } else if ((e & 32) !== 0) {
          c = z.avail_in - n;
          c = k >> 3 < c ? k >> 3 : c;
          n += c;
          p -= c;
          k -= c << 3;
          s.bitb = b;
          s.bitk = k;
          z.avail_in = n;
          z.total_in += p - z.next_in_index;
          z.next_in_index = p;
          s.write = q;
          return Z_STREAM_END2;
        } else {
          z.msg = "invalid literal/length code";
          c = z.avail_in - n;
          c = k >> 3 < c ? k >> 3 : c;
          n += c;
          p -= c;
          k -= c << 3;
          s.bitb = b;
          s.bitk = k;
          z.avail_in = n;
          z.total_in += p - z.next_in_index;
          z.next_in_index = p;
          s.write = q;
          return Z_DATA_ERROR2;
        }
      } while (true);
    } while (m >= 258 && n >= 10);
    c = z.avail_in - n;
    c = k >> 3 < c ? k >> 3 : c;
    n += c;
    p -= c;
    k -= c << 3;
    s.bitb = b;
    s.bitk = k;
    z.avail_in = n;
    z.total_in += p - z.next_in_index;
    z.next_in_index = p;
    s.write = q;
    return Z_OK2;
  }
  that.init = function(bl, bd, tl, tl_index, td, td_index) {
    mode2 = START;
    lbits = /* (byte) */
    bl;
    dbits = /* (byte) */
    bd;
    ltree = tl;
    ltree_index = tl_index;
    dtree = td;
    dtree_index = td_index;
    tree = null;
  };
  that.proc = function(s, z, r) {
    let j;
    let tindex;
    let e;
    let b = 0;
    let k = 0;
    let p = 0;
    let n;
    let q;
    let m;
    let f;
    p = z.next_in_index;
    n = z.avail_in;
    b = s.bitb;
    k = s.bitk;
    q = s.write;
    m = q < s.read ? s.read - q - 1 : s.end - q;
    while (true) {
      switch (mode2) {
        case START:
          if (m >= 258 && n >= 10) {
            s.bitb = b;
            s.bitk = k;
            z.avail_in = n;
            z.total_in += p - z.next_in_index;
            z.next_in_index = p;
            s.write = q;
            r = inflate_fast(lbits, dbits, ltree, ltree_index, dtree, dtree_index, s, z);
            p = z.next_in_index;
            n = z.avail_in;
            b = s.bitb;
            k = s.bitk;
            q = s.write;
            m = q < s.read ? s.read - q - 1 : s.end - q;
            if (r != Z_OK2) {
              mode2 = r == Z_STREAM_END2 ? WASH : BADCODE;
              break;
            }
          }
          need = lbits;
          tree = ltree;
          tree_index = ltree_index;
          mode2 = LEN;
        case LEN:
          j = need;
          while (k < j) {
            if (n !== 0)
              r = Z_OK2;
            else {
              s.bitb = b;
              s.bitk = k;
              z.avail_in = n;
              z.total_in += p - z.next_in_index;
              z.next_in_index = p;
              s.write = q;
              return s.inflate_flush(z, r);
            }
            n--;
            b |= (z.read_byte(p++) & 255) << k;
            k += 8;
          }
          tindex = (tree_index + (b & inflate_mask[j])) * 3;
          b >>>= tree[tindex + 1];
          k -= tree[tindex + 1];
          e = tree[tindex];
          if (e === 0) {
            lit = tree[tindex + 2];
            mode2 = LIT;
            break;
          }
          if ((e & 16) !== 0) {
            get = e & 15;
            len = tree[tindex + 2];
            mode2 = LENEXT;
            break;
          }
          if ((e & 64) === 0) {
            need = e;
            tree_index = tindex / 3 + tree[tindex + 2];
            break;
          }
          if ((e & 32) !== 0) {
            mode2 = WASH;
            break;
          }
          mode2 = BADCODE;
          z.msg = "invalid literal/length code";
          r = Z_DATA_ERROR2;
          s.bitb = b;
          s.bitk = k;
          z.avail_in = n;
          z.total_in += p - z.next_in_index;
          z.next_in_index = p;
          s.write = q;
          return s.inflate_flush(z, r);
        case LENEXT:
          j = get;
          while (k < j) {
            if (n !== 0)
              r = Z_OK2;
            else {
              s.bitb = b;
              s.bitk = k;
              z.avail_in = n;
              z.total_in += p - z.next_in_index;
              z.next_in_index = p;
              s.write = q;
              return s.inflate_flush(z, r);
            }
            n--;
            b |= (z.read_byte(p++) & 255) << k;
            k += 8;
          }
          len += b & inflate_mask[j];
          b >>= j;
          k -= j;
          need = dbits;
          tree = dtree;
          tree_index = dtree_index;
          mode2 = DIST;
        case DIST:
          j = need;
          while (k < j) {
            if (n !== 0)
              r = Z_OK2;
            else {
              s.bitb = b;
              s.bitk = k;
              z.avail_in = n;
              z.total_in += p - z.next_in_index;
              z.next_in_index = p;
              s.write = q;
              return s.inflate_flush(z, r);
            }
            n--;
            b |= (z.read_byte(p++) & 255) << k;
            k += 8;
          }
          tindex = (tree_index + (b & inflate_mask[j])) * 3;
          b >>= tree[tindex + 1];
          k -= tree[tindex + 1];
          e = tree[tindex];
          if ((e & 16) !== 0) {
            get = e & 15;
            dist = tree[tindex + 2];
            mode2 = DISTEXT;
            break;
          }
          if ((e & 64) === 0) {
            need = e;
            tree_index = tindex / 3 + tree[tindex + 2];
            break;
          }
          mode2 = BADCODE;
          z.msg = "invalid distance code";
          r = Z_DATA_ERROR2;
          s.bitb = b;
          s.bitk = k;
          z.avail_in = n;
          z.total_in += p - z.next_in_index;
          z.next_in_index = p;
          s.write = q;
          return s.inflate_flush(z, r);
        case DISTEXT:
          j = get;
          while (k < j) {
            if (n !== 0)
              r = Z_OK2;
            else {
              s.bitb = b;
              s.bitk = k;
              z.avail_in = n;
              z.total_in += p - z.next_in_index;
              z.next_in_index = p;
              s.write = q;
              return s.inflate_flush(z, r);
            }
            n--;
            b |= (z.read_byte(p++) & 255) << k;
            k += 8;
          }
          dist += b & inflate_mask[j];
          b >>= j;
          k -= j;
          mode2 = COPY;
        case COPY:
          f = q - dist;
          while (f < 0) {
            f += s.end;
          }
          while (len !== 0) {
            if (m === 0) {
              if (q == s.end && s.read !== 0) {
                q = 0;
                m = q < s.read ? s.read - q - 1 : s.end - q;
              }
              if (m === 0) {
                s.write = q;
                r = s.inflate_flush(z, r);
                q = s.write;
                m = q < s.read ? s.read - q - 1 : s.end - q;
                if (q == s.end && s.read !== 0) {
                  q = 0;
                  m = q < s.read ? s.read - q - 1 : s.end - q;
                }
                if (m === 0) {
                  s.bitb = b;
                  s.bitk = k;
                  z.avail_in = n;
                  z.total_in += p - z.next_in_index;
                  z.next_in_index = p;
                  s.write = q;
                  return s.inflate_flush(z, r);
                }
              }
            }
            s.win[q++] = s.win[f++];
            m--;
            if (f == s.end)
              f = 0;
            len--;
          }
          mode2 = START;
          break;
        case LIT:
          if (m === 0) {
            if (q == s.end && s.read !== 0) {
              q = 0;
              m = q < s.read ? s.read - q - 1 : s.end - q;
            }
            if (m === 0) {
              s.write = q;
              r = s.inflate_flush(z, r);
              q = s.write;
              m = q < s.read ? s.read - q - 1 : s.end - q;
              if (q == s.end && s.read !== 0) {
                q = 0;
                m = q < s.read ? s.read - q - 1 : s.end - q;
              }
              if (m === 0) {
                s.bitb = b;
                s.bitk = k;
                z.avail_in = n;
                z.total_in += p - z.next_in_index;
                z.next_in_index = p;
                s.write = q;
                return s.inflate_flush(z, r);
              }
            }
          }
          r = Z_OK2;
          s.win[q++] = /* (byte) */
          lit;
          m--;
          mode2 = START;
          break;
        case WASH:
          if (k > 7) {
            k -= 8;
            n++;
            p--;
          }
          s.write = q;
          r = s.inflate_flush(z, r);
          q = s.write;
          m = q < s.read ? s.read - q - 1 : s.end - q;
          if (s.read != s.write) {
            s.bitb = b;
            s.bitk = k;
            z.avail_in = n;
            z.total_in += p - z.next_in_index;
            z.next_in_index = p;
            s.write = q;
            return s.inflate_flush(z, r);
          }
          mode2 = END;
        case END:
          r = Z_STREAM_END2;
          s.bitb = b;
          s.bitk = k;
          z.avail_in = n;
          z.total_in += p - z.next_in_index;
          z.next_in_index = p;
          s.write = q;
          return s.inflate_flush(z, r);
        case BADCODE:
          r = Z_DATA_ERROR2;
          s.bitb = b;
          s.bitk = k;
          z.avail_in = n;
          z.total_in += p - z.next_in_index;
          z.next_in_index = p;
          s.write = q;
          return s.inflate_flush(z, r);
        default:
          r = Z_STREAM_ERROR2;
          s.bitb = b;
          s.bitk = k;
          z.avail_in = n;
          z.total_in += p - z.next_in_index;
          z.next_in_index = p;
          s.write = q;
          return s.inflate_flush(z, r);
      }
    }
  };
  that.free = function() {
  };
}
var border = [
  // Order of the bit length code lengths
  16,
  17,
  18,
  0,
  8,
  7,
  9,
  6,
  10,
  5,
  11,
  4,
  12,
  3,
  13,
  2,
  14,
  1,
  15
];
var TYPE = 0;
var LENS = 1;
var STORED2 = 2;
var TABLE = 3;
var BTREE = 4;
var DTREE = 5;
var CODES = 6;
var DRY = 7;
var DONELOCKS = 8;
var BADBLOCKS = 9;
function InfBlocks(z, w) {
  const that = this;
  let mode2 = TYPE;
  let left = 0;
  let table3 = 0;
  let index = 0;
  let blens;
  const bb = [0];
  const tb = [0];
  const codes = new InfCodes();
  let last = 0;
  let hufts = new Int32Array(MANY * 3);
  const check = 0;
  const inftree = new InfTree();
  that.bitk = 0;
  that.bitb = 0;
  that.win = new Uint8Array(w);
  that.end = w;
  that.read = 0;
  that.write = 0;
  that.reset = function(z2, c) {
    if (c)
      c[0] = check;
    if (mode2 == CODES) {
      codes.free(z2);
    }
    mode2 = TYPE;
    that.bitk = 0;
    that.bitb = 0;
    that.read = that.write = 0;
  };
  that.reset(z, null);
  that.inflate_flush = function(z2, r) {
    let n;
    let p;
    let q;
    p = z2.next_out_index;
    q = that.read;
    n = /* (int) */
    (q <= that.write ? that.write : that.end) - q;
    if (n > z2.avail_out)
      n = z2.avail_out;
    if (n !== 0 && r == Z_BUF_ERROR2)
      r = Z_OK2;
    z2.avail_out -= n;
    z2.total_out += n;
    z2.next_out.set(that.win.subarray(q, q + n), p);
    p += n;
    q += n;
    if (q == that.end) {
      q = 0;
      if (that.write == that.end)
        that.write = 0;
      n = that.write - q;
      if (n > z2.avail_out)
        n = z2.avail_out;
      if (n !== 0 && r == Z_BUF_ERROR2)
        r = Z_OK2;
      z2.avail_out -= n;
      z2.total_out += n;
      z2.next_out.set(that.win.subarray(q, q + n), p);
      p += n;
      q += n;
    }
    z2.next_out_index = p;
    that.read = q;
    return r;
  };
  that.proc = function(z2, r) {
    let t2;
    let b;
    let k;
    let p;
    let n;
    let q;
    let m;
    let i;
    p = z2.next_in_index;
    n = z2.avail_in;
    b = that.bitb;
    k = that.bitk;
    q = that.write;
    m = /* (int) */
    q < that.read ? that.read - q - 1 : that.end - q;
    while (true) {
      let bl, bd, tl, td, bl_, bd_, tl_, td_;
      switch (mode2) {
        case TYPE:
          while (k < 3) {
            if (n !== 0) {
              r = Z_OK2;
            } else {
              that.bitb = b;
              that.bitk = k;
              z2.avail_in = n;
              z2.total_in += p - z2.next_in_index;
              z2.next_in_index = p;
              that.write = q;
              return that.inflate_flush(z2, r);
            }
            n--;
            b |= (z2.read_byte(p++) & 255) << k;
            k += 8;
          }
          t2 = /* (int) */
          b & 7;
          last = t2 & 1;
          switch (t2 >>> 1) {
            case 0:
              b >>>= 3;
              k -= 3;
              t2 = k & 7;
              b >>>= t2;
              k -= t2;
              mode2 = LENS;
              break;
            case 1:
              bl = [];
              bd = [];
              tl = [[]];
              td = [[]];
              InfTree.inflate_trees_fixed(bl, bd, tl, td);
              codes.init(bl[0], bd[0], tl[0], 0, td[0], 0);
              b >>>= 3;
              k -= 3;
              mode2 = CODES;
              break;
            case 2:
              b >>>= 3;
              k -= 3;
              mode2 = TABLE;
              break;
            case 3:
              b >>>= 3;
              k -= 3;
              mode2 = BADBLOCKS;
              z2.msg = "invalid block type";
              r = Z_DATA_ERROR2;
              that.bitb = b;
              that.bitk = k;
              z2.avail_in = n;
              z2.total_in += p - z2.next_in_index;
              z2.next_in_index = p;
              that.write = q;
              return that.inflate_flush(z2, r);
          }
          break;
        case LENS:
          while (k < 32) {
            if (n !== 0) {
              r = Z_OK2;
            } else {
              that.bitb = b;
              that.bitk = k;
              z2.avail_in = n;
              z2.total_in += p - z2.next_in_index;
              z2.next_in_index = p;
              that.write = q;
              return that.inflate_flush(z2, r);
            }
            n--;
            b |= (z2.read_byte(p++) & 255) << k;
            k += 8;
          }
          if ((~b >>> 16 & 65535) != (b & 65535)) {
            mode2 = BADBLOCKS;
            z2.msg = "invalid stored block lengths";
            r = Z_DATA_ERROR2;
            that.bitb = b;
            that.bitk = k;
            z2.avail_in = n;
            z2.total_in += p - z2.next_in_index;
            z2.next_in_index = p;
            that.write = q;
            return that.inflate_flush(z2, r);
          }
          left = b & 65535;
          b = k = 0;
          mode2 = left !== 0 ? STORED2 : last !== 0 ? DRY : TYPE;
          break;
        case STORED2:
          if (n === 0) {
            that.bitb = b;
            that.bitk = k;
            z2.avail_in = n;
            z2.total_in += p - z2.next_in_index;
            z2.next_in_index = p;
            that.write = q;
            return that.inflate_flush(z2, r);
          }
          if (m === 0) {
            if (q == that.end && that.read !== 0) {
              q = 0;
              m = /* (int) */
              q < that.read ? that.read - q - 1 : that.end - q;
            }
            if (m === 0) {
              that.write = q;
              r = that.inflate_flush(z2, r);
              q = that.write;
              m = /* (int) */
              q < that.read ? that.read - q - 1 : that.end - q;
              if (q == that.end && that.read !== 0) {
                q = 0;
                m = /* (int) */
                q < that.read ? that.read - q - 1 : that.end - q;
              }
              if (m === 0) {
                that.bitb = b;
                that.bitk = k;
                z2.avail_in = n;
                z2.total_in += p - z2.next_in_index;
                z2.next_in_index = p;
                that.write = q;
                return that.inflate_flush(z2, r);
              }
            }
          }
          r = Z_OK2;
          t2 = left;
          if (t2 > n)
            t2 = n;
          if (t2 > m)
            t2 = m;
          that.win.set(z2.read_buf(p, t2), q);
          p += t2;
          n -= t2;
          q += t2;
          m -= t2;
          if ((left -= t2) !== 0)
            break;
          mode2 = last !== 0 ? DRY : TYPE;
          break;
        case TABLE:
          while (k < 14) {
            if (n !== 0) {
              r = Z_OK2;
            } else {
              that.bitb = b;
              that.bitk = k;
              z2.avail_in = n;
              z2.total_in += p - z2.next_in_index;
              z2.next_in_index = p;
              that.write = q;
              return that.inflate_flush(z2, r);
            }
            n--;
            b |= (z2.read_byte(p++) & 255) << k;
            k += 8;
          }
          table3 = t2 = b & 16383;
          if ((t2 & 31) > 29 || (t2 >> 5 & 31) > 29) {
            mode2 = BADBLOCKS;
            z2.msg = "too many length or distance symbols";
            r = Z_DATA_ERROR2;
            that.bitb = b;
            that.bitk = k;
            z2.avail_in = n;
            z2.total_in += p - z2.next_in_index;
            z2.next_in_index = p;
            that.write = q;
            return that.inflate_flush(z2, r);
          }
          t2 = 258 + (t2 & 31) + (t2 >> 5 & 31);
          if (!blens || blens.length < t2) {
            blens = [];
          } else {
            for (i = 0; i < t2; i++) {
              blens[i] = 0;
            }
          }
          b >>>= 14;
          k -= 14;
          index = 0;
          mode2 = BTREE;
        case BTREE:
          while (index < 4 + (table3 >>> 10)) {
            while (k < 3) {
              if (n !== 0) {
                r = Z_OK2;
              } else {
                that.bitb = b;
                that.bitk = k;
                z2.avail_in = n;
                z2.total_in += p - z2.next_in_index;
                z2.next_in_index = p;
                that.write = q;
                return that.inflate_flush(z2, r);
              }
              n--;
              b |= (z2.read_byte(p++) & 255) << k;
              k += 8;
            }
            blens[border[index++]] = b & 7;
            b >>>= 3;
            k -= 3;
          }
          while (index < 19) {
            blens[border[index++]] = 0;
          }
          bb[0] = 7;
          t2 = inftree.inflate_trees_bits(blens, bb, tb, hufts, z2);
          if (t2 != Z_OK2) {
            r = t2;
            if (r == Z_DATA_ERROR2) {
              blens = null;
              mode2 = BADBLOCKS;
            }
            that.bitb = b;
            that.bitk = k;
            z2.avail_in = n;
            z2.total_in += p - z2.next_in_index;
            z2.next_in_index = p;
            that.write = q;
            return that.inflate_flush(z2, r);
          }
          index = 0;
          mode2 = DTREE;
        case DTREE:
          while (true) {
            t2 = table3;
            if (index >= 258 + (t2 & 31) + (t2 >> 5 & 31)) {
              break;
            }
            let j, c;
            t2 = bb[0];
            while (k < t2) {
              if (n !== 0) {
                r = Z_OK2;
              } else {
                that.bitb = b;
                that.bitk = k;
                z2.avail_in = n;
                z2.total_in += p - z2.next_in_index;
                z2.next_in_index = p;
                that.write = q;
                return that.inflate_flush(z2, r);
              }
              n--;
              b |= (z2.read_byte(p++) & 255) << k;
              k += 8;
            }
            t2 = hufts[(tb[0] + (b & inflate_mask[t2])) * 3 + 1];
            c = hufts[(tb[0] + (b & inflate_mask[t2])) * 3 + 2];
            if (c < 16) {
              b >>>= t2;
              k -= t2;
              blens[index++] = c;
            } else {
              i = c == 18 ? 7 : c - 14;
              j = c == 18 ? 11 : 3;
              while (k < t2 + i) {
                if (n !== 0) {
                  r = Z_OK2;
                } else {
                  that.bitb = b;
                  that.bitk = k;
                  z2.avail_in = n;
                  z2.total_in += p - z2.next_in_index;
                  z2.next_in_index = p;
                  that.write = q;
                  return that.inflate_flush(z2, r);
                }
                n--;
                b |= (z2.read_byte(p++) & 255) << k;
                k += 8;
              }
              b >>>= t2;
              k -= t2;
              j += b & inflate_mask[i];
              b >>>= i;
              k -= i;
              i = index;
              t2 = table3;
              if (i + j > 258 + (t2 & 31) + (t2 >> 5 & 31) || c == 16 && i < 1) {
                blens = null;
                mode2 = BADBLOCKS;
                z2.msg = "invalid bit length repeat";
                r = Z_DATA_ERROR2;
                that.bitb = b;
                that.bitk = k;
                z2.avail_in = n;
                z2.total_in += p - z2.next_in_index;
                z2.next_in_index = p;
                that.write = q;
                return that.inflate_flush(z2, r);
              }
              c = c == 16 ? blens[i - 1] : 0;
              do {
                blens[i++] = c;
              } while (--j !== 0);
              index = i;
            }
          }
          tb[0] = -1;
          bl_ = [];
          bd_ = [];
          tl_ = [];
          td_ = [];
          bl_[0] = 9;
          bd_[0] = 6;
          t2 = table3;
          t2 = inftree.inflate_trees_dynamic(257 + (t2 & 31), 1 + (t2 >> 5 & 31), blens, bl_, bd_, tl_, td_, hufts, z2);
          if (t2 != Z_OK2) {
            if (t2 == Z_DATA_ERROR2) {
              blens = null;
              mode2 = BADBLOCKS;
            }
            r = t2;
            that.bitb = b;
            that.bitk = k;
            z2.avail_in = n;
            z2.total_in += p - z2.next_in_index;
            z2.next_in_index = p;
            that.write = q;
            return that.inflate_flush(z2, r);
          }
          codes.init(bl_[0], bd_[0], hufts, tl_[0], hufts, td_[0]);
          mode2 = CODES;
        case CODES:
          that.bitb = b;
          that.bitk = k;
          z2.avail_in = n;
          z2.total_in += p - z2.next_in_index;
          z2.next_in_index = p;
          that.write = q;
          if ((r = codes.proc(that, z2, r)) != Z_STREAM_END2) {
            return that.inflate_flush(z2, r);
          }
          r = Z_OK2;
          codes.free(z2);
          p = z2.next_in_index;
          n = z2.avail_in;
          b = that.bitb;
          k = that.bitk;
          q = that.write;
          m = /* (int) */
          q < that.read ? that.read - q - 1 : that.end - q;
          if (last === 0) {
            mode2 = TYPE;
            break;
          }
          mode2 = DRY;
        case DRY:
          that.write = q;
          r = that.inflate_flush(z2, r);
          q = that.write;
          m = /* (int) */
          q < that.read ? that.read - q - 1 : that.end - q;
          if (that.read != that.write) {
            that.bitb = b;
            that.bitk = k;
            z2.avail_in = n;
            z2.total_in += p - z2.next_in_index;
            z2.next_in_index = p;
            that.write = q;
            return that.inflate_flush(z2, r);
          }
          mode2 = DONELOCKS;
        case DONELOCKS:
          r = Z_STREAM_END2;
          that.bitb = b;
          that.bitk = k;
          z2.avail_in = n;
          z2.total_in += p - z2.next_in_index;
          z2.next_in_index = p;
          that.write = q;
          return that.inflate_flush(z2, r);
        case BADBLOCKS:
          r = Z_DATA_ERROR2;
          that.bitb = b;
          that.bitk = k;
          z2.avail_in = n;
          z2.total_in += p - z2.next_in_index;
          z2.next_in_index = p;
          that.write = q;
          return that.inflate_flush(z2, r);
        default:
          r = Z_STREAM_ERROR2;
          that.bitb = b;
          that.bitk = k;
          z2.avail_in = n;
          z2.total_in += p - z2.next_in_index;
          z2.next_in_index = p;
          that.write = q;
          return that.inflate_flush(z2, r);
      }
    }
  };
  that.free = function(z2) {
    that.reset(z2, null);
    that.win = null;
    hufts = null;
  };
  that.set_dictionary = function(d, start, n) {
    that.win.set(d.subarray(start, start + n), 0);
    that.read = that.write = n;
  };
  that.sync_point = function() {
    return mode2 == LENS ? 1 : 0;
  };
}
var PRESET_DICT2 = 32;
var Z_DEFLATED2 = 8;
var METHOD = 0;
var FLAG = 1;
var DICT4 = 2;
var DICT3 = 3;
var DICT2 = 4;
var DICT1 = 5;
var DICT0 = 6;
var BLOCKS = 7;
var DONE = 12;
var BAD = 13;
var mark = [0, 0, 255, 255];
function Inflate() {
  const that = this;
  that.mode = 0;
  that.method = 0;
  that.was = [0];
  that.need = 0;
  that.marker = 0;
  that.wbits = 0;
  function inflateReset(z) {
    if (!z || !z.istate)
      return Z_STREAM_ERROR2;
    z.total_in = z.total_out = 0;
    z.msg = null;
    z.istate.mode = BLOCKS;
    z.istate.blocks.reset(z, null);
    return Z_OK2;
  }
  that.inflateEnd = function(z) {
    if (that.blocks)
      that.blocks.free(z);
    that.blocks = null;
    return Z_OK2;
  };
  that.inflateInit = function(z, w) {
    z.msg = null;
    that.blocks = null;
    if (w < 8 || w > 15) {
      that.inflateEnd(z);
      return Z_STREAM_ERROR2;
    }
    that.wbits = w;
    z.istate.blocks = new InfBlocks(z, 1 << w);
    inflateReset(z);
    return Z_OK2;
  };
  that.inflate = function(z, f) {
    let r;
    let b;
    if (!z || !z.istate || !z.next_in)
      return Z_STREAM_ERROR2;
    const istate = z.istate;
    f = f == Z_FINISH2 ? Z_BUF_ERROR2 : Z_OK2;
    r = Z_BUF_ERROR2;
    while (true) {
      switch (istate.mode) {
        case METHOD:
          if (z.avail_in === 0)
            return r;
          r = f;
          z.avail_in--;
          z.total_in++;
          if (((istate.method = z.read_byte(z.next_in_index++)) & 15) != Z_DEFLATED2) {
            istate.mode = BAD;
            z.msg = "unknown compression method";
            istate.marker = 5;
            break;
          }
          if ((istate.method >> 4) + 8 > istate.wbits) {
            istate.mode = BAD;
            z.msg = "invalid win size";
            istate.marker = 5;
            break;
          }
          istate.mode = FLAG;
        case FLAG:
          if (z.avail_in === 0)
            return r;
          r = f;
          z.avail_in--;
          z.total_in++;
          b = z.read_byte(z.next_in_index++) & 255;
          if (((istate.method << 8) + b) % 31 !== 0) {
            istate.mode = BAD;
            z.msg = "incorrect header check";
            istate.marker = 5;
            break;
          }
          if ((b & PRESET_DICT2) === 0) {
            istate.mode = BLOCKS;
            break;
          }
          istate.mode = DICT4;
        case DICT4:
          if (z.avail_in === 0)
            return r;
          r = f;
          z.avail_in--;
          z.total_in++;
          istate.need = (z.read_byte(z.next_in_index++) & 255) << 24 & 4278190080;
          istate.mode = DICT3;
        case DICT3:
          if (z.avail_in === 0)
            return r;
          r = f;
          z.avail_in--;
          z.total_in++;
          istate.need += (z.read_byte(z.next_in_index++) & 255) << 16 & 16711680;
          istate.mode = DICT2;
        case DICT2:
          if (z.avail_in === 0)
            return r;
          r = f;
          z.avail_in--;
          z.total_in++;
          istate.need += (z.read_byte(z.next_in_index++) & 255) << 8 & 65280;
          istate.mode = DICT1;
        case DICT1:
          if (z.avail_in === 0)
            return r;
          r = f;
          z.avail_in--;
          z.total_in++;
          istate.need += z.read_byte(z.next_in_index++) & 255;
          istate.mode = DICT0;
          return Z_NEED_DICT2;
        case DICT0:
          istate.mode = BAD;
          z.msg = "need dictionary";
          istate.marker = 0;
          return Z_STREAM_ERROR2;
        case BLOCKS:
          r = istate.blocks.proc(z, r);
          if (r == Z_DATA_ERROR2) {
            istate.mode = BAD;
            istate.marker = 0;
            break;
          }
          if (r == Z_OK2) {
            r = f;
          }
          if (r != Z_STREAM_END2) {
            return r;
          }
          r = f;
          istate.blocks.reset(z, istate.was);
          istate.mode = DONE;
        case DONE:
          z.avail_in = 0;
          return Z_STREAM_END2;
        case BAD:
          return Z_DATA_ERROR2;
        default:
          return Z_STREAM_ERROR2;
      }
    }
  };
  that.inflateSetDictionary = function(z, dictionary, dictLength) {
    let index = 0, length = dictLength;
    if (!z || !z.istate || z.istate.mode != DICT0)
      return Z_STREAM_ERROR2;
    const istate = z.istate;
    if (length >= 1 << istate.wbits) {
      length = (1 << istate.wbits) - 1;
      index = dictLength - length;
    }
    istate.blocks.set_dictionary(dictionary, index, length);
    istate.mode = BLOCKS;
    return Z_OK2;
  };
  that.inflateSync = function(z) {
    let n;
    let p;
    let m;
    let r, w;
    if (!z || !z.istate)
      return Z_STREAM_ERROR2;
    const istate = z.istate;
    if (istate.mode != BAD) {
      istate.mode = BAD;
      istate.marker = 0;
    }
    if ((n = z.avail_in) === 0)
      return Z_BUF_ERROR2;
    p = z.next_in_index;
    m = istate.marker;
    while (n !== 0 && m < 4) {
      if (z.read_byte(p) == mark[m]) {
        m++;
      } else if (z.read_byte(p) !== 0) {
        m = 0;
      } else {
        m = 4 - m;
      }
      p++;
      n--;
    }
    z.total_in += p - z.next_in_index;
    z.next_in_index = p;
    z.avail_in = n;
    istate.marker = m;
    if (m != 4) {
      return Z_DATA_ERROR2;
    }
    r = z.total_in;
    w = z.total_out;
    inflateReset(z);
    z.total_in = r;
    z.total_out = w;
    istate.mode = BLOCKS;
    return Z_OK2;
  };
  that.inflateSyncPoint = function(z) {
    if (!z || !z.istate || !z.istate.blocks)
      return Z_STREAM_ERROR2;
    return z.istate.blocks.sync_point();
  };
}
function ZStream2() {
}
ZStream2.prototype = {
  inflateInit: function(bits) {
    const that = this;
    that.istate = new Inflate();
    if (!bits)
      bits = MAX_BITS2;
    return that.istate.inflateInit(that, bits);
  },
  inflate: function(f) {
    const that = this;
    if (!that.istate)
      return Z_STREAM_ERROR2;
    return that.istate.inflate(that, f);
  },
  inflateEnd: function() {
    const that = this;
    if (!that.istate)
      return Z_STREAM_ERROR2;
    const ret = that.istate.inflateEnd(that);
    that.istate = null;
    return ret;
  },
  inflateSync: function() {
    const that = this;
    if (!that.istate)
      return Z_STREAM_ERROR2;
    return that.istate.inflateSync(that);
  },
  inflateSetDictionary: function(dictionary, dictLength) {
    const that = this;
    if (!that.istate)
      return Z_STREAM_ERROR2;
    return that.istate.inflateSetDictionary(that, dictionary, dictLength);
  },
  read_byte: function(start) {
    const that = this;
    return that.next_in[start];
  },
  read_buf: function(start, size) {
    const that = this;
    return that.next_in.subarray(start, start + size);
  }
};
function ZipInflate(options) {
  const that = this;
  const z = new ZStream2();
  const bufsize = options && options.chunkSize ? Math.floor(options.chunkSize * 2) : 128 * 1024;
  const flush = Z_NO_FLUSH2;
  const buf = new Uint8Array(bufsize);
  let nomoreinput = false;
  z.inflateInit();
  z.next_out = buf;
  that.append = function(data, onprogress) {
    const buffers = [];
    let err, array, lastIndex = 0, bufferIndex = 0, bufferSize = 0;
    if (data.length === 0)
      return;
    z.next_in_index = 0;
    z.next_in = data;
    z.avail_in = data.length;
    do {
      z.next_out_index = 0;
      z.avail_out = bufsize;
      if (z.avail_in === 0 && !nomoreinput) {
        z.next_in_index = 0;
        nomoreinput = true;
      }
      err = z.inflate(flush);
      if (nomoreinput && err === Z_BUF_ERROR2) {
        if (z.avail_in !== 0)
          throw new Error("inflating: bad input");
      } else if (err !== Z_OK2 && err !== Z_STREAM_END2)
        throw new Error("inflating: " + z.msg);
      if ((nomoreinput || err === Z_STREAM_END2) && z.avail_in === data.length)
        throw new Error("inflating: bad input");
      if (z.next_out_index)
        if (z.next_out_index === bufsize)
          buffers.push(new Uint8Array(buf));
        else
          buffers.push(buf.slice(0, z.next_out_index));
      bufferSize += z.next_out_index;
      if (onprogress && z.next_in_index > 0 && z.next_in_index != lastIndex) {
        onprogress(z.next_in_index);
        lastIndex = z.next_in_index;
      }
    } while (z.avail_in > 0 || z.avail_out === 0);
    if (buffers.length > 1) {
      array = new Uint8Array(bufferSize);
      buffers.forEach(function(chunk) {
        array.set(chunk, bufferIndex);
        bufferIndex += chunk.length;
      });
    } else {
      array = buffers[0] || new Uint8Array(0);
    }
    return array;
  };
  that.flush = function() {
    z.inflateEnd();
  };
}
var inflate_default = ZipInflate;

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/configuration.js
var DEFAULT_CONFIGURATION = {
  chunkSize: 512 * 1024,
  maxWorkers: typeof navigator != "undefined" && navigator.hardwareConcurrency || 2,
  terminateWorkerTimeout: 5e3,
  useWebWorkers: true,
  workerScripts: void 0
};
var config = Object.assign({}, DEFAULT_CONFIGURATION);
function getConfiguration() {
  return config;
}
function configure(configuration) {
  if (configuration.baseURL !== void 0) {
    config.baseURL = configuration.baseURL;
  }
  if (configuration.chunkSize !== void 0) {
    config.chunkSize = configuration.chunkSize;
  }
  if (configuration.maxWorkers !== void 0) {
    config.maxWorkers = configuration.maxWorkers;
  }
  if (configuration.terminateWorkerTimeout !== void 0) {
    config.terminateWorkerTimeout = configuration.terminateWorkerTimeout;
  }
  if (configuration.useWebWorkers !== void 0) {
    config.useWebWorkers = configuration.useWebWorkers;
  }
  if (configuration.Deflate !== void 0) {
    config.Deflate = configuration.Deflate;
  }
  if (configuration.Inflate !== void 0) {
    config.Inflate = configuration.Inflate;
  }
  if (configuration.workerScripts !== void 0) {
    if (configuration.workerScripts.deflate) {
      if (!Array.isArray(configuration.workerScripts.deflate)) {
        throw new Error("workerScripts.deflate must be an array");
      }
      if (!config.workerScripts) {
        config.workerScripts = {};
      }
      config.workerScripts.deflate = configuration.workerScripts.deflate;
    }
    if (configuration.workerScripts.inflate) {
      if (!Array.isArray(configuration.workerScripts.inflate)) {
        throw new Error("workerScripts.inflate must be an array");
      }
      if (!config.workerScripts) {
        config.workerScripts = {};
      }
      config.workerScripts.inflate = configuration.workerScripts.inflate;
    }
  }
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/util/mime-type.js
var table = {
  "application": {
    "andrew-inset": "ez",
    "annodex": "anx",
    "atom+xml": "atom",
    "atomcat+xml": "atomcat",
    "atomserv+xml": "atomsrv",
    "bbolin": "lin",
    "cap": ["cap", "pcap"],
    "cu-seeme": "cu",
    "davmount+xml": "davmount",
    "dsptype": "tsp",
    "ecmascript": ["es", "ecma"],
    "futuresplash": "spl",
    "hta": "hta",
    "java-archive": "jar",
    "java-serialized-object": "ser",
    "java-vm": "class",
    "javascript": "js",
    "m3g": "m3g",
    "mac-binhex40": "hqx",
    "mathematica": ["nb", "ma", "mb"],
    "msaccess": "mdb",
    "msword": ["doc", "dot"],
    "mxf": "mxf",
    "oda": "oda",
    "ogg": "ogx",
    "pdf": "pdf",
    "pgp-keys": "key",
    "pgp-signature": ["asc", "sig"],
    "pics-rules": "prf",
    "postscript": ["ps", "ai", "eps", "epsi", "epsf", "eps2", "eps3"],
    "rar": "rar",
    "rdf+xml": "rdf",
    "rss+xml": "rss",
    "rtf": "rtf",
    "smil": ["smi", "smil"],
    "xhtml+xml": ["xhtml", "xht"],
    "xml": ["xml", "xsl", "xsd"],
    "xspf+xml": "xspf",
    "zip": "zip",
    "vnd.android.package-archive": "apk",
    "vnd.cinderella": "cdy",
    "vnd.google-earth.kml+xml": "kml",
    "vnd.google-earth.kmz": "kmz",
    "vnd.mozilla.xul+xml": "xul",
    "vnd.ms-excel": ["xls", "xlb", "xlt", "xlm", "xla", "xlc", "xlw"],
    "vnd.ms-pki.seccat": "cat",
    "vnd.ms-pki.stl": "stl",
    "vnd.ms-powerpoint": ["ppt", "pps", "pot"],
    "vnd.oasis.opendocument.chart": "odc",
    "vnd.oasis.opendocument.database": "odb",
    "vnd.oasis.opendocument.formula": "odf",
    "vnd.oasis.opendocument.graphics": "odg",
    "vnd.oasis.opendocument.graphics-template": "otg",
    "vnd.oasis.opendocument.image": "odi",
    "vnd.oasis.opendocument.presentation": "odp",
    "vnd.oasis.opendocument.presentation-template": "otp",
    "vnd.oasis.opendocument.spreadsheet": "ods",
    "vnd.oasis.opendocument.spreadsheet-template": "ots",
    "vnd.oasis.opendocument.text": "odt",
    "vnd.oasis.opendocument.text-master": "odm",
    "vnd.oasis.opendocument.text-template": "ott",
    "vnd.oasis.opendocument.text-web": "oth",
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "vnd.openxmlformats-officedocument.spreadsheetml.template": "xltx",
    "vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
    "vnd.openxmlformats-officedocument.presentationml.template": "potx",
    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "vnd.openxmlformats-officedocument.wordprocessingml.template": "dotx",
    "vnd.smaf": "mmf",
    "vnd.stardivision.calc": "sdc",
    "vnd.stardivision.chart": "sds",
    "vnd.stardivision.draw": "sda",
    "vnd.stardivision.impress": "sdd",
    "vnd.stardivision.math": ["sdf", "smf"],
    "vnd.stardivision.writer": ["sdw", "vor"],
    "vnd.stardivision.writer-global": "sgl",
    "vnd.sun.xml.calc": "sxc",
    "vnd.sun.xml.calc.template": "stc",
    "vnd.sun.xml.draw": "sxd",
    "vnd.sun.xml.draw.template": "std",
    "vnd.sun.xml.impress": "sxi",
    "vnd.sun.xml.impress.template": "sti",
    "vnd.sun.xml.math": "sxm",
    "vnd.sun.xml.writer": "sxw",
    "vnd.sun.xml.writer.global": "sxg",
    "vnd.sun.xml.writer.template": "stw",
    "vnd.symbian.install": ["sis", "sisx"],
    "vnd.visio": ["vsd", "vst", "vss", "vsw"],
    "vnd.wap.wbxml": "wbxml",
    "vnd.wap.wmlc": "wmlc",
    "vnd.wap.wmlscriptc": "wmlsc",
    "vnd.wordperfect": "wpd",
    "vnd.wordperfect5.1": "wp5",
    "x-123": "wk",
    "x-7z-compressed": "7z",
    "x-abiword": "abw",
    "x-apple-diskimage": "dmg",
    "x-bcpio": "bcpio",
    "x-bittorrent": "torrent",
    "x-cbr": ["cbr", "cba", "cbt", "cb7"],
    "x-cbz": "cbz",
    "x-cdf": ["cdf", "cda"],
    "x-cdlink": "vcd",
    "x-chess-pgn": "pgn",
    "x-cpio": "cpio",
    "x-csh": "csh",
    "x-debian-package": ["deb", "udeb"],
    "x-director": ["dcr", "dir", "dxr", "cst", "cct", "cxt", "w3d", "fgd", "swa"],
    "x-dms": "dms",
    "x-doom": "wad",
    "x-dvi": "dvi",
    "x-httpd-eruby": "rhtml",
    "x-font": "pcf.Z",
    "x-freemind": "mm",
    "x-gnumeric": "gnumeric",
    "x-go-sgf": "sgf",
    "x-graphing-calculator": "gcf",
    "x-gtar": ["gtar", "taz"],
    "x-hdf": "hdf",
    "x-httpd-php": ["phtml", "pht", "php"],
    "x-httpd-php-source": "phps",
    "x-httpd-php3": "php3",
    "x-httpd-php3-preprocessed": "php3p",
    "x-httpd-php4": "php4",
    "x-httpd-php5": "php5",
    "x-ica": "ica",
    "x-info": "info",
    "x-internet-signup": ["ins", "isp"],
    "x-iphone": "iii",
    "x-iso9660-image": "iso",
    "x-java-jnlp-file": "jnlp",
    "x-jmol": "jmz",
    "x-killustrator": "kil",
    "x-koan": ["skp", "skd", "skt", "skm"],
    "x-kpresenter": ["kpr", "kpt"],
    "x-kword": ["kwd", "kwt"],
    "x-latex": "latex",
    "x-lha": "lha",
    "x-lyx": "lyx",
    "x-lzh": "lzh",
    "x-lzx": "lzx",
    "x-maker": ["frm", "maker", "frame", "fm", "fb", "book", "fbdoc"],
    "x-ms-wmd": "wmd",
    "x-ms-wmz": "wmz",
    "x-msdos-program": ["com", "exe", "bat", "dll"],
    "x-msi": "msi",
    "x-netcdf": ["nc", "cdf"],
    "x-ns-proxy-autoconfig": ["pac", "dat"],
    "x-nwc": "nwc",
    "x-object": "o",
    "x-oz-application": "oza",
    "x-pkcs7-certreqresp": "p7r",
    "x-python-code": ["pyc", "pyo"],
    "x-qgis": ["qgs", "shp", "shx"],
    "x-quicktimeplayer": "qtl",
    "x-redhat-package-manager": "rpm",
    "x-ruby": "rb",
    "x-sh": "sh",
    "x-shar": "shar",
    "x-shockwave-flash": ["swf", "swfl"],
    "x-silverlight": "scr",
    "x-stuffit": "sit",
    "x-sv4cpio": "sv4cpio",
    "x-sv4crc": "sv4crc",
    "x-tar": "tar",
    "x-tcl": "tcl",
    "x-tex-gf": "gf",
    "x-tex-pk": "pk",
    "x-texinfo": ["texinfo", "texi"],
    "x-trash": ["~", "%", "bak", "old", "sik"],
    "x-troff": ["t", "tr", "roff"],
    "x-troff-man": "man",
    "x-troff-me": "me",
    "x-troff-ms": "ms",
    "x-ustar": "ustar",
    "x-wais-source": "src",
    "x-wingz": "wz",
    "x-x509-ca-cert": ["crt", "der", "cer"],
    "x-xcf": "xcf",
    "x-xfig": "fig",
    "x-xpinstall": "xpi",
    "applixware": "aw",
    "atomsvc+xml": "atomsvc",
    "ccxml+xml": "ccxml",
    "cdmi-capability": "cdmia",
    "cdmi-container": "cdmic",
    "cdmi-domain": "cdmid",
    "cdmi-object": "cdmio",
    "cdmi-queue": "cdmiq",
    "docbook+xml": "dbk",
    "dssc+der": "dssc",
    "dssc+xml": "xdssc",
    "emma+xml": "emma",
    "epub+zip": "epub",
    "exi": "exi",
    "font-tdpfr": "pfr",
    "gml+xml": "gml",
    "gpx+xml": "gpx",
    "gxf": "gxf",
    "hyperstudio": "stk",
    "inkml+xml": ["ink", "inkml"],
    "ipfix": "ipfix",
    "json": "json",
    "jsonml+json": "jsonml",
    "lost+xml": "lostxml",
    "mads+xml": "mads",
    "marc": "mrc",
    "marcxml+xml": "mrcx",
    "mathml+xml": "mathml",
    "mbox": "mbox",
    "mediaservercontrol+xml": "mscml",
    "metalink+xml": "metalink",
    "metalink4+xml": "meta4",
    "mets+xml": "mets",
    "mods+xml": "mods",
    "mp21": ["m21", "mp21"],
    "mp4": "mp4s",
    "oebps-package+xml": "opf",
    "omdoc+xml": "omdoc",
    "onenote": ["onetoc", "onetoc2", "onetmp", "onepkg"],
    "oxps": "oxps",
    "patch-ops-error+xml": "xer",
    "pgp-encrypted": "pgp",
    "pkcs10": "p10",
    "pkcs7-mime": ["p7m", "p7c"],
    "pkcs7-signature": "p7s",
    "pkcs8": "p8",
    "pkix-attr-cert": "ac",
    "pkix-crl": "crl",
    "pkix-pkipath": "pkipath",
    "pkixcmp": "pki",
    "pls+xml": "pls",
    "prs.cww": "cww",
    "pskc+xml": "pskcxml",
    "reginfo+xml": "rif",
    "relax-ng-compact-syntax": "rnc",
    "resource-lists+xml": "rl",
    "resource-lists-diff+xml": "rld",
    "rls-services+xml": "rs",
    "rpki-ghostbusters": "gbr",
    "rpki-manifest": "mft",
    "rpki-roa": "roa",
    "rsd+xml": "rsd",
    "sbml+xml": "sbml",
    "scvp-cv-request": "scq",
    "scvp-cv-response": "scs",
    "scvp-vp-request": "spq",
    "scvp-vp-response": "spp",
    "sdp": "sdp",
    "set-payment-initiation": "setpay",
    "set-registration-initiation": "setreg",
    "shf+xml": "shf",
    "sparql-query": "rq",
    "sparql-results+xml": "srx",
    "srgs": "gram",
    "srgs+xml": "grxml",
    "sru+xml": "sru",
    "ssdl+xml": "ssdl",
    "ssml+xml": "ssml",
    "tei+xml": ["tei", "teicorpus"],
    "thraud+xml": "tfi",
    "timestamped-data": "tsd",
    "vnd.3gpp.pic-bw-large": "plb",
    "vnd.3gpp.pic-bw-small": "psb",
    "vnd.3gpp.pic-bw-var": "pvb",
    "vnd.3gpp2.tcap": "tcap",
    "vnd.3m.post-it-notes": "pwn",
    "vnd.accpac.simply.aso": "aso",
    "vnd.accpac.simply.imp": "imp",
    "vnd.acucobol": "acu",
    "vnd.acucorp": ["atc", "acutc"],
    "vnd.adobe.air-application-installer-package+zip": "air",
    "vnd.adobe.formscentral.fcdt": "fcdt",
    "vnd.adobe.fxp": ["fxp", "fxpl"],
    "vnd.adobe.xdp+xml": "xdp",
    "vnd.adobe.xfdf": "xfdf",
    "vnd.ahead.space": "ahead",
    "vnd.airzip.filesecure.azf": "azf",
    "vnd.airzip.filesecure.azs": "azs",
    "vnd.amazon.ebook": "azw",
    "vnd.americandynamics.acc": "acc",
    "vnd.amiga.ami": "ami",
    "vnd.anser-web-certificate-issue-initiation": "cii",
    "vnd.anser-web-funds-transfer-initiation": "fti",
    "vnd.antix.game-component": "atx",
    "vnd.apple.installer+xml": "mpkg",
    "vnd.apple.mpegurl": "m3u8",
    "vnd.aristanetworks.swi": "swi",
    "vnd.astraea-software.iota": "iota",
    "vnd.audiograph": "aep",
    "vnd.blueice.multipass": "mpm",
    "vnd.bmi": "bmi",
    "vnd.businessobjects": "rep",
    "vnd.chemdraw+xml": "cdxml",
    "vnd.chipnuts.karaoke-mmd": "mmd",
    "vnd.claymore": "cla",
    "vnd.cloanto.rp9": "rp9",
    "vnd.clonk.c4group": ["c4g", "c4d", "c4f", "c4p", "c4u"],
    "vnd.cluetrust.cartomobile-config": "c11amc",
    "vnd.cluetrust.cartomobile-config-pkg": "c11amz",
    "vnd.commonspace": "csp",
    "vnd.contact.cmsg": "cdbcmsg",
    "vnd.cosmocaller": "cmc",
    "vnd.crick.clicker": "clkx",
    "vnd.crick.clicker.keyboard": "clkk",
    "vnd.crick.clicker.palette": "clkp",
    "vnd.crick.clicker.template": "clkt",
    "vnd.crick.clicker.wordbank": "clkw",
    "vnd.criticaltools.wbs+xml": "wbs",
    "vnd.ctc-posml": "pml",
    "vnd.cups-ppd": "ppd",
    "vnd.curl.car": "car",
    "vnd.curl.pcurl": "pcurl",
    "vnd.dart": "dart",
    "vnd.data-vision.rdz": "rdz",
    "vnd.dece.data": ["uvf", "uvvf", "uvd", "uvvd"],
    "vnd.dece.ttml+xml": ["uvt", "uvvt"],
    "vnd.dece.unspecified": ["uvx", "uvvx"],
    "vnd.dece.zip": ["uvz", "uvvz"],
    "vnd.denovo.fcselayout-link": "fe_launch",
    "vnd.dna": "dna",
    "vnd.dolby.mlp": "mlp",
    "vnd.dpgraph": "dpg",
    "vnd.dreamfactory": "dfac",
    "vnd.ds-keypoint": "kpxx",
    "vnd.dvb.ait": "ait",
    "vnd.dvb.service": "svc",
    "vnd.dynageo": "geo",
    "vnd.ecowin.chart": "mag",
    "vnd.enliven": "nml",
    "vnd.epson.esf": "esf",
    "vnd.epson.msf": "msf",
    "vnd.epson.quickanime": "qam",
    "vnd.epson.salt": "slt",
    "vnd.epson.ssf": "ssf",
    "vnd.eszigno3+xml": ["es3", "et3"],
    "vnd.ezpix-album": "ez2",
    "vnd.ezpix-package": "ez3",
    "vnd.fdf": "fdf",
    "vnd.fdsn.mseed": "mseed",
    "vnd.fdsn.seed": ["seed", "dataless"],
    "vnd.flographit": "gph",
    "vnd.fluxtime.clip": "ftc",
    "vnd.framemaker": ["fm", "frame", "maker", "book"],
    "vnd.frogans.fnc": "fnc",
    "vnd.frogans.ltf": "ltf",
    "vnd.fsc.weblaunch": "fsc",
    "vnd.fujitsu.oasys": "oas",
    "vnd.fujitsu.oasys2": "oa2",
    "vnd.fujitsu.oasys3": "oa3",
    "vnd.fujitsu.oasysgp": "fg5",
    "vnd.fujitsu.oasysprs": "bh2",
    "vnd.fujixerox.ddd": "ddd",
    "vnd.fujixerox.docuworks": "xdw",
    "vnd.fujixerox.docuworks.binder": "xbd",
    "vnd.fuzzysheet": "fzs",
    "vnd.genomatix.tuxedo": "txd",
    "vnd.geogebra.file": "ggb",
    "vnd.geogebra.tool": "ggt",
    "vnd.geometry-explorer": ["gex", "gre"],
    "vnd.geonext": "gxt",
    "vnd.geoplan": "g2w",
    "vnd.geospace": "g3w",
    "vnd.gmx": "gmx",
    "vnd.grafeq": ["gqf", "gqs"],
    "vnd.groove-account": "gac",
    "vnd.groove-help": "ghf",
    "vnd.groove-identity-message": "gim",
    "vnd.groove-injector": "grv",
    "vnd.groove-tool-message": "gtm",
    "vnd.groove-tool-template": "tpl",
    "vnd.groove-vcard": "vcg",
    "vnd.hal+xml": "hal",
    "vnd.handheld-entertainment+xml": "zmm",
    "vnd.hbci": "hbci",
    "vnd.hhe.lesson-player": "les",
    "vnd.hp-hpgl": "hpgl",
    "vnd.hp-hpid": "hpid",
    "vnd.hp-hps": "hps",
    "vnd.hp-jlyt": "jlt",
    "vnd.hp-pcl": "pcl",
    "vnd.hp-pclxl": "pclxl",
    "vnd.hydrostatix.sof-data": "sfd-hdstx",
    "vnd.ibm.minipay": "mpy",
    "vnd.ibm.modcap": ["afp", "listafp", "list3820"],
    "vnd.ibm.rights-management": "irm",
    "vnd.ibm.secure-container": "sc",
    "vnd.iccprofile": ["icc", "icm"],
    "vnd.igloader": "igl",
    "vnd.immervision-ivp": "ivp",
    "vnd.immervision-ivu": "ivu",
    "vnd.insors.igm": "igm",
    "vnd.intercon.formnet": ["xpw", "xpx"],
    "vnd.intergeo": "i2g",
    "vnd.intu.qbo": "qbo",
    "vnd.intu.qfx": "qfx",
    "vnd.ipunplugged.rcprofile": "rcprofile",
    "vnd.irepository.package+xml": "irp",
    "vnd.is-xpr": "xpr",
    "vnd.isac.fcs": "fcs",
    "vnd.jam": "jam",
    "vnd.jcp.javame.midlet-rms": "rms",
    "vnd.jisp": "jisp",
    "vnd.joost.joda-archive": "joda",
    "vnd.kahootz": ["ktz", "ktr"],
    "vnd.kde.karbon": "karbon",
    "vnd.kde.kchart": "chrt",
    "vnd.kde.kformula": "kfo",
    "vnd.kde.kivio": "flw",
    "vnd.kde.kontour": "kon",
    "vnd.kde.kpresenter": ["kpr", "kpt"],
    "vnd.kde.kspread": "ksp",
    "vnd.kde.kword": ["kwd", "kwt"],
    "vnd.kenameaapp": "htke",
    "vnd.kidspiration": "kia",
    "vnd.kinar": ["kne", "knp"],
    "vnd.koan": ["skp", "skd", "skt", "skm"],
    "vnd.kodak-descriptor": "sse",
    "vnd.las.las+xml": "lasxml",
    "vnd.llamagraphics.life-balance.desktop": "lbd",
    "vnd.llamagraphics.life-balance.exchange+xml": "lbe",
    "vnd.lotus-1-2-3": "123",
    "vnd.lotus-approach": "apr",
    "vnd.lotus-freelance": "pre",
    "vnd.lotus-notes": "nsf",
    "vnd.lotus-organizer": "org",
    "vnd.lotus-screencam": "scm",
    "vnd.lotus-wordpro": "lwp",
    "vnd.macports.portpkg": "portpkg",
    "vnd.mcd": "mcd",
    "vnd.medcalcdata": "mc1",
    "vnd.mediastation.cdkey": "cdkey",
    "vnd.mfer": "mwf",
    "vnd.mfmp": "mfm",
    "vnd.micrografx.flo": "flo",
    "vnd.micrografx.igx": "igx",
    "vnd.mif": "mif",
    "vnd.mobius.daf": "daf",
    "vnd.mobius.dis": "dis",
    "vnd.mobius.mbk": "mbk",
    "vnd.mobius.mqy": "mqy",
    "vnd.mobius.msl": "msl",
    "vnd.mobius.plc": "plc",
    "vnd.mobius.txf": "txf",
    "vnd.mophun.application": "mpn",
    "vnd.mophun.certificate": "mpc",
    "vnd.ms-artgalry": "cil",
    "vnd.ms-cab-compressed": "cab",
    "vnd.ms-excel.addin.macroenabled.12": "xlam",
    "vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
    "vnd.ms-excel.sheet.macroenabled.12": "xlsm",
    "vnd.ms-excel.template.macroenabled.12": "xltm",
    "vnd.ms-fontobject": "eot",
    "vnd.ms-htmlhelp": "chm",
    "vnd.ms-ims": "ims",
    "vnd.ms-lrm": "lrm",
    "vnd.ms-officetheme": "thmx",
    "vnd.ms-powerpoint.addin.macroenabled.12": "ppam",
    "vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
    "vnd.ms-powerpoint.slide.macroenabled.12": "sldm",
    "vnd.ms-powerpoint.slideshow.macroenabled.12": "ppsm",
    "vnd.ms-powerpoint.template.macroenabled.12": "potm",
    "vnd.ms-project": ["mpp", "mpt"],
    "vnd.ms-word.document.macroenabled.12": "docm",
    "vnd.ms-word.template.macroenabled.12": "dotm",
    "vnd.ms-works": ["wps", "wks", "wcm", "wdb"],
    "vnd.ms-wpl": "wpl",
    "vnd.ms-xpsdocument": "xps",
    "vnd.mseq": "mseq",
    "vnd.musician": "mus",
    "vnd.muvee.style": "msty",
    "vnd.mynfc": "taglet",
    "vnd.neurolanguage.nlu": "nlu",
    "vnd.nitf": ["ntf", "nitf"],
    "vnd.noblenet-directory": "nnd",
    "vnd.noblenet-sealer": "nns",
    "vnd.noblenet-web": "nnw",
    "vnd.nokia.n-gage.data": "ngdat",
    "vnd.nokia.n-gage.symbian.install": "n-gage",
    "vnd.nokia.radio-preset": "rpst",
    "vnd.nokia.radio-presets": "rpss",
    "vnd.novadigm.edm": "edm",
    "vnd.novadigm.edx": "edx",
    "vnd.novadigm.ext": "ext",
    "vnd.oasis.opendocument.chart-template": "otc",
    "vnd.oasis.opendocument.formula-template": "odft",
    "vnd.oasis.opendocument.image-template": "oti",
    "vnd.olpc-sugar": "xo",
    "vnd.oma.dd2+xml": "dd2",
    "vnd.openofficeorg.extension": "oxt",
    "vnd.openxmlformats-officedocument.presentationml.slide": "sldx",
    "vnd.osgeo.mapguide.package": "mgp",
    "vnd.osgi.dp": "dp",
    "vnd.osgi.subsystem": "esa",
    "vnd.palm": ["pdb", "pqa", "oprc"],
    "vnd.pawaafile": "paw",
    "vnd.pg.format": "str",
    "vnd.pg.osasli": "ei6",
    "vnd.picsel": "efif",
    "vnd.pmi.widget": "wg",
    "vnd.pocketlearn": "plf",
    "vnd.powerbuilder6": "pbd",
    "vnd.previewsystems.box": "box",
    "vnd.proteus.magazine": "mgz",
    "vnd.publishare-delta-tree": "qps",
    "vnd.pvi.ptid1": "ptid",
    "vnd.quark.quarkxpress": ["qxd", "qxt", "qwd", "qwt", "qxl", "qxb"],
    "vnd.realvnc.bed": "bed",
    "vnd.recordare.musicxml": "mxl",
    "vnd.recordare.musicxml+xml": "musicxml",
    "vnd.rig.cryptonote": "cryptonote",
    "vnd.rn-realmedia": "rm",
    "vnd.rn-realmedia-vbr": "rmvb",
    "vnd.route66.link66+xml": "link66",
    "vnd.sailingtracker.track": "st",
    "vnd.seemail": "see",
    "vnd.sema": "sema",
    "vnd.semd": "semd",
    "vnd.semf": "semf",
    "vnd.shana.informed.formdata": "ifm",
    "vnd.shana.informed.formtemplate": "itp",
    "vnd.shana.informed.interchange": "iif",
    "vnd.shana.informed.package": "ipk",
    "vnd.simtech-mindmapper": ["twd", "twds"],
    "vnd.smart.teacher": "teacher",
    "vnd.solent.sdkm+xml": ["sdkm", "sdkd"],
    "vnd.spotfire.dxp": "dxp",
    "vnd.spotfire.sfs": "sfs",
    "vnd.stepmania.package": "smzip",
    "vnd.stepmania.stepchart": "sm",
    "vnd.sus-calendar": ["sus", "susp"],
    "vnd.svd": "svd",
    "vnd.syncml+xml": "xsm",
    "vnd.syncml.dm+wbxml": "bdm",
    "vnd.syncml.dm+xml": "xdm",
    "vnd.tao.intent-module-archive": "tao",
    "vnd.tcpdump.pcap": ["pcap", "cap", "dmp"],
    "vnd.tmobile-livetv": "tmo",
    "vnd.trid.tpt": "tpt",
    "vnd.triscape.mxs": "mxs",
    "vnd.trueapp": "tra",
    "vnd.ufdl": ["ufd", "ufdl"],
    "vnd.uiq.theme": "utz",
    "vnd.umajin": "umj",
    "vnd.unity": "unityweb",
    "vnd.uoml+xml": "uoml",
    "vnd.vcx": "vcx",
    "vnd.visionary": "vis",
    "vnd.vsf": "vsf",
    "vnd.webturbo": "wtb",
    "vnd.wolfram.player": "nbp",
    "vnd.wqd": "wqd",
    "vnd.wt.stf": "stf",
    "vnd.xara": "xar",
    "vnd.xfdl": "xfdl",
    "vnd.yamaha.hv-dic": "hvd",
    "vnd.yamaha.hv-script": "hvs",
    "vnd.yamaha.hv-voice": "hvp",
    "vnd.yamaha.openscoreformat": "osf",
    "vnd.yamaha.openscoreformat.osfpvg+xml": "osfpvg",
    "vnd.yamaha.smaf-audio": "saf",
    "vnd.yamaha.smaf-phrase": "spf",
    "vnd.yellowriver-custom-menu": "cmp",
    "vnd.zul": ["zir", "zirz"],
    "vnd.zzazz.deck+xml": "zaz",
    "voicexml+xml": "vxml",
    "widget": "wgt",
    "winhlp": "hlp",
    "wsdl+xml": "wsdl",
    "wspolicy+xml": "wspolicy",
    "x-ace-compressed": "ace",
    "x-authorware-bin": ["aab", "x32", "u32", "vox"],
    "x-authorware-map": "aam",
    "x-authorware-seg": "aas",
    "x-blorb": ["blb", "blorb"],
    "x-bzip": "bz",
    "x-bzip2": ["bz2", "boz"],
    "x-cfs-compressed": "cfs",
    "x-chat": "chat",
    "x-conference": "nsc",
    "x-dgc-compressed": "dgc",
    "x-dtbncx+xml": "ncx",
    "x-dtbook+xml": "dtb",
    "x-dtbresource+xml": "res",
    "x-eva": "eva",
    "x-font-bdf": "bdf",
    "x-font-ghostscript": "gsf",
    "x-font-linux-psf": "psf",
    "x-font-otf": "otf",
    "x-font-pcf": "pcf",
    "x-font-snf": "snf",
    "x-font-ttf": ["ttf", "ttc"],
    "x-font-type1": ["pfa", "pfb", "pfm", "afm"],
    "x-font-woff": "woff",
    "x-freearc": "arc",
    "x-gca-compressed": "gca",
    "x-glulx": "ulx",
    "x-gramps-xml": "gramps",
    "x-install-instructions": "install",
    "x-lzh-compressed": ["lzh", "lha"],
    "x-mie": "mie",
    "x-mobipocket-ebook": ["prc", "mobi"],
    "x-ms-application": "application",
    "x-ms-shortcut": "lnk",
    "x-ms-xbap": "xbap",
    "x-msbinder": "obd",
    "x-mscardfile": "crd",
    "x-msclip": "clp",
    "x-msdownload": ["exe", "dll", "com", "bat", "msi"],
    "x-msmediaview": ["mvb", "m13", "m14"],
    "x-msmetafile": ["wmf", "wmz", "emf", "emz"],
    "x-msmoney": "mny",
    "x-mspublisher": "pub",
    "x-msschedule": "scd",
    "x-msterminal": "trm",
    "x-mswrite": "wri",
    "x-nzb": "nzb",
    "x-pkcs12": ["p12", "pfx"],
    "x-pkcs7-certificates": ["p7b", "spc"],
    "x-research-info-systems": "ris",
    "x-silverlight-app": "xap",
    "x-sql": "sql",
    "x-stuffitx": "sitx",
    "x-subrip": "srt",
    "x-t3vm-image": "t3",
    "x-tads": "gam",
    "x-tex": "tex",
    "x-tex-tfm": "tfm",
    "x-tgif": "obj",
    "x-xliff+xml": "xlf",
    "x-xz": "xz",
    "x-zmachine": ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8"],
    "xaml+xml": "xaml",
    "xcap-diff+xml": "xdf",
    "xenc+xml": "xenc",
    "xml-dtd": "dtd",
    "xop+xml": "xop",
    "xproc+xml": "xpl",
    "xslt+xml": "xslt",
    "xv+xml": ["mxml", "xhvml", "xvml", "xvm"],
    "yang": "yang",
    "yin+xml": "yin",
    "envoy": "evy",
    "fractals": "fif",
    "internet-property-stream": "acx",
    "olescript": "axs",
    "vnd.ms-outlook": "msg",
    "vnd.ms-pkicertstore": "sst",
    "x-compress": "z",
    "x-compressed": "tgz",
    "x-gzip": "gz",
    "x-perfmon": ["pma", "pmc", "pml", "pmr", "pmw"],
    "x-pkcs7-mime": ["p7c", "p7m"],
    "ynd.ms-pkipko": "pko"
  },
  "audio": {
    "amr": "amr",
    "amr-wb": "awb",
    "annodex": "axa",
    "basic": ["au", "snd"],
    "flac": "flac",
    "midi": ["mid", "midi", "kar", "rmi"],
    "mpeg": ["mpga", "mpega", "mp2", "mp3", "m4a", "mp2a", "m2a", "m3a"],
    "mpegurl": "m3u",
    "ogg": ["oga", "ogg", "spx"],
    "prs.sid": "sid",
    "x-aiff": ["aif", "aiff", "aifc"],
    "x-gsm": "gsm",
    "x-ms-wma": "wma",
    "x-ms-wax": "wax",
    "x-pn-realaudio": "ram",
    "x-realaudio": "ra",
    "x-sd2": "sd2",
    "x-wav": "wav",
    "adpcm": "adp",
    "mp4": "mp4a",
    "s3m": "s3m",
    "silk": "sil",
    "vnd.dece.audio": ["uva", "uvva"],
    "vnd.digital-winds": "eol",
    "vnd.dra": "dra",
    "vnd.dts": "dts",
    "vnd.dts.hd": "dtshd",
    "vnd.lucent.voice": "lvp",
    "vnd.ms-playready.media.pya": "pya",
    "vnd.nuera.ecelp4800": "ecelp4800",
    "vnd.nuera.ecelp7470": "ecelp7470",
    "vnd.nuera.ecelp9600": "ecelp9600",
    "vnd.rip": "rip",
    "webm": "weba",
    "x-aac": "aac",
    "x-caf": "caf",
    "x-matroska": "mka",
    "x-pn-realaudio-plugin": "rmp",
    "xm": "xm",
    "mid": ["mid", "rmi"]
  },
  "chemical": {
    "x-alchemy": "alc",
    "x-cache": ["cac", "cache"],
    "x-cache-csf": "csf",
    "x-cactvs-binary": ["cbin", "cascii", "ctab"],
    "x-cdx": "cdx",
    "x-chem3d": "c3d",
    "x-cif": "cif",
    "x-cmdf": "cmdf",
    "x-cml": "cml",
    "x-compass": "cpa",
    "x-crossfire": "bsd",
    "x-csml": ["csml", "csm"],
    "x-ctx": "ctx",
    "x-cxf": ["cxf", "cef"],
    "x-embl-dl-nucleotide": ["emb", "embl"],
    "x-gamess-input": ["inp", "gam", "gamin"],
    "x-gaussian-checkpoint": ["fch", "fchk"],
    "x-gaussian-cube": "cub",
    "x-gaussian-input": ["gau", "gjc", "gjf"],
    "x-gaussian-log": "gal",
    "x-gcg8-sequence": "gcg",
    "x-genbank": "gen",
    "x-hin": "hin",
    "x-isostar": ["istr", "ist"],
    "x-jcamp-dx": ["jdx", "dx"],
    "x-kinemage": "kin",
    "x-macmolecule": "mcm",
    "x-macromodel-input": ["mmd", "mmod"],
    "x-mdl-molfile": "mol",
    "x-mdl-rdfile": "rd",
    "x-mdl-rxnfile": "rxn",
    "x-mdl-sdfile": ["sd", "sdf"],
    "x-mdl-tgf": "tgf",
    "x-mmcif": "mcif",
    "x-mol2": "mol2",
    "x-molconn-Z": "b",
    "x-mopac-graph": "gpt",
    "x-mopac-input": ["mop", "mopcrt", "mpc", "zmt"],
    "x-mopac-out": "moo",
    "x-ncbi-asn1": "asn",
    "x-ncbi-asn1-ascii": ["prt", "ent"],
    "x-ncbi-asn1-binary": ["val", "aso"],
    "x-pdb": ["pdb", "ent"],
    "x-rosdal": "ros",
    "x-swissprot": "sw",
    "x-vamas-iso14976": "vms",
    "x-vmd": "vmd",
    "x-xtel": "xtel",
    "x-xyz": "xyz"
  },
  "image": {
    "gif": "gif",
    "ief": "ief",
    "jpeg": ["jpeg", "jpg", "jpe"],
    "pcx": "pcx",
    "png": "png",
    "svg+xml": ["svg", "svgz"],
    "tiff": ["tiff", "tif"],
    "vnd.djvu": ["djvu", "djv"],
    "vnd.wap.wbmp": "wbmp",
    "x-canon-cr2": "cr2",
    "x-canon-crw": "crw",
    "x-cmu-raster": "ras",
    "x-coreldraw": "cdr",
    "x-coreldrawpattern": "pat",
    "x-coreldrawtemplate": "cdt",
    "x-corelphotopaint": "cpt",
    "x-epson-erf": "erf",
    "x-icon": "ico",
    "x-jg": "art",
    "x-jng": "jng",
    "x-nikon-nef": "nef",
    "x-olympus-orf": "orf",
    "x-photoshop": "psd",
    "x-portable-anymap": "pnm",
    "x-portable-bitmap": "pbm",
    "x-portable-graymap": "pgm",
    "x-portable-pixmap": "ppm",
    "x-rgb": "rgb",
    "x-xbitmap": "xbm",
    "x-xpixmap": "xpm",
    "x-xwindowdump": "xwd",
    "bmp": "bmp",
    "cgm": "cgm",
    "g3fax": "g3",
    "ktx": "ktx",
    "prs.btif": "btif",
    "sgi": "sgi",
    "vnd.dece.graphic": ["uvi", "uvvi", "uvg", "uvvg"],
    "vnd.dwg": "dwg",
    "vnd.dxf": "dxf",
    "vnd.fastbidsheet": "fbs",
    "vnd.fpx": "fpx",
    "vnd.fst": "fst",
    "vnd.fujixerox.edmics-mmr": "mmr",
    "vnd.fujixerox.edmics-rlc": "rlc",
    "vnd.ms-modi": "mdi",
    "vnd.ms-photo": "wdp",
    "vnd.net-fpx": "npx",
    "vnd.xiff": "xif",
    "webp": "webp",
    "x-3ds": "3ds",
    "x-cmx": "cmx",
    "x-freehand": ["fh", "fhc", "fh4", "fh5", "fh7"],
    "x-pict": ["pic", "pct"],
    "x-tga": "tga",
    "cis-cod": "cod",
    "pipeg": "jfif"
  },
  "message": {
    "rfc822": ["eml", "mime", "mht", "mhtml", "nws"]
  },
  "model": {
    "iges": ["igs", "iges"],
    "mesh": ["msh", "mesh", "silo"],
    "vrml": ["wrl", "vrml"],
    "x3d+vrml": ["x3dv", "x3dvz"],
    "x3d+xml": ["x3d", "x3dz"],
    "x3d+binary": ["x3db", "x3dbz"],
    "vnd.collada+xml": "dae",
    "vnd.dwf": "dwf",
    "vnd.gdl": "gdl",
    "vnd.gtw": "gtw",
    "vnd.mts": "mts",
    "vnd.vtu": "vtu"
  },
  "text": {
    "cache-manifest": ["manifest", "appcache"],
    "calendar": ["ics", "icz", "ifb"],
    "css": "css",
    "csv": "csv",
    "h323": "323",
    "html": ["html", "htm", "shtml", "stm"],
    "iuls": "uls",
    "mathml": "mml",
    "plain": ["txt", "text", "brf", "conf", "def", "list", "log", "in", "bas"],
    "richtext": "rtx",
    "scriptlet": ["sct", "wsc"],
    "texmacs": ["tm", "ts"],
    "tab-separated-values": "tsv",
    "vnd.sun.j2me.app-descriptor": "jad",
    "vnd.wap.wml": "wml",
    "vnd.wap.wmlscript": "wmls",
    "x-bibtex": "bib",
    "x-boo": "boo",
    "x-c++hdr": ["h++", "hpp", "hxx", "hh"],
    "x-c++src": ["c++", "cpp", "cxx", "cc"],
    "x-component": "htc",
    "x-dsrc": "d",
    "x-diff": ["diff", "patch"],
    "x-haskell": "hs",
    "x-java": "java",
    "x-literate-haskell": "lhs",
    "x-moc": "moc",
    "x-pascal": ["p", "pas"],
    "x-pcs-gcd": "gcd",
    "x-perl": ["pl", "pm"],
    "x-python": "py",
    "x-scala": "scala",
    "x-setext": "etx",
    "x-tcl": ["tcl", "tk"],
    "x-tex": ["tex", "ltx", "sty", "cls"],
    "x-vcalendar": "vcs",
    "x-vcard": "vcf",
    "n3": "n3",
    "prs.lines.tag": "dsc",
    "sgml": ["sgml", "sgm"],
    "troff": ["t", "tr", "roff", "man", "me", "ms"],
    "turtle": "ttl",
    "uri-list": ["uri", "uris", "urls"],
    "vcard": "vcard",
    "vnd.curl": "curl",
    "vnd.curl.dcurl": "dcurl",
    "vnd.curl.scurl": "scurl",
    "vnd.curl.mcurl": "mcurl",
    "vnd.dvb.subtitle": "sub",
    "vnd.fly": "fly",
    "vnd.fmi.flexstor": "flx",
    "vnd.graphviz": "gv",
    "vnd.in3d.3dml": "3dml",
    "vnd.in3d.spot": "spot",
    "x-asm": ["s", "asm"],
    "x-c": ["c", "cc", "cxx", "cpp", "h", "hh", "dic"],
    "x-fortran": ["f", "for", "f77", "f90"],
    "x-opml": "opml",
    "x-nfo": "nfo",
    "x-sfv": "sfv",
    "x-uuencode": "uu",
    "webviewhtml": "htt"
  },
  "video": {
    "avif": ".avif",
    "3gpp": "3gp",
    "annodex": "axv",
    "dl": "dl",
    "dv": ["dif", "dv"],
    "fli": "fli",
    "gl": "gl",
    "mpeg": ["mpeg", "mpg", "mpe", "m1v", "m2v", "mp2", "mpa", "mpv2"],
    "mp4": ["mp4", "mp4v", "mpg4"],
    "quicktime": ["qt", "mov"],
    "ogg": "ogv",
    "vnd.mpegurl": ["mxu", "m4u"],
    "x-flv": "flv",
    "x-la-asf": ["lsf", "lsx"],
    "x-mng": "mng",
    "x-ms-asf": ["asf", "asx", "asr"],
    "x-ms-wm": "wm",
    "x-ms-wmv": "wmv",
    "x-ms-wmx": "wmx",
    "x-ms-wvx": "wvx",
    "x-msvideo": "avi",
    "x-sgi-movie": "movie",
    "x-matroska": ["mpv", "mkv", "mk3d", "mks"],
    "3gpp2": "3g2",
    "h261": "h261",
    "h263": "h263",
    "h264": "h264",
    "jpeg": "jpgv",
    "jpm": ["jpm", "jpgm"],
    "mj2": ["mj2", "mjp2"],
    "vnd.dece.hd": ["uvh", "uvvh"],
    "vnd.dece.mobile": ["uvm", "uvvm"],
    "vnd.dece.pd": ["uvp", "uvvp"],
    "vnd.dece.sd": ["uvs", "uvvs"],
    "vnd.dece.video": ["uvv", "uvvv"],
    "vnd.dvb.file": "dvb",
    "vnd.fvt": "fvt",
    "vnd.ms-playready.media.pyv": "pyv",
    "vnd.uvvu.mp4": ["uvu", "uvvu"],
    "vnd.vivo": "viv",
    "webm": "webm",
    "x-f4v": "f4v",
    "x-m4v": "m4v",
    "x-ms-vob": "vob",
    "x-smv": "smv"
  },
  "x-conference": {
    "x-cooltalk": "ice"
  },
  "x-world": {
    "x-vrml": ["vrm", "vrml", "wrl", "flr", "wrz", "xaf", "xof"]
  }
};
var mimeTypes = (() => {
  const mimeTypes2 = {};
  for (const type in table) {
    if (table.hasOwnProperty(type)) {
      for (const subtype in table[type]) {
        if (table[type].hasOwnProperty(subtype)) {
          const value = table[type][subtype];
          if (typeof value == "string") {
            mimeTypes2[value] = type + "/" + subtype;
          } else {
            for (let indexMimeType = 0; indexMimeType < value.length; indexMimeType++) {
              mimeTypes2[value[indexMimeType]] = type + "/" + subtype;
            }
          }
        }
      }
    }
  }
  return mimeTypes2;
})();

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/crc32.js
var table2 = [];
for (let i = 0; i < 256; i++) {
  let t2 = i;
  for (let j = 0; j < 8; j++) {
    if (t2 & 1) {
      t2 = t2 >>> 1 ^ 3988292384;
    } else {
      t2 = t2 >>> 1;
    }
  }
  table2[i] = t2;
}
var Crc32 = class {
  constructor(crc) {
    this.crc = crc || -1;
  }
  append(data) {
    let crc = this.crc | 0;
    for (let offset = 0, length = data.length | 0; offset < length; offset++) {
      crc = crc >>> 8 ^ table2[(crc ^ data[offset]) & 255];
    }
    this.crc = crc;
  }
  get() {
    return ~this.crc;
  }
};
var crc32_default = Crc32;

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/util/encode-text.js
var encode_text_default = encodeText;
function encodeText(value) {
  if (typeof TextEncoder == "undefined") {
    value = unescape(encodeURIComponent(value));
    const result = new Uint8Array(value.length);
    for (let i = 0; i < result.length; i++) {
      result[i] = value.charCodeAt(i);
    }
    return result;
  } else {
    return new TextEncoder().encode(value);
  }
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/sjcl.js
var bitArray = {
  /**
   * Concatenate two bit arrays.
   * @param {bitArray} a1 The first array.
   * @param {bitArray} a2 The second array.
   * @return {bitArray} The concatenation of a1 and a2.
   */
  concat(a1, a2) {
    if (a1.length === 0 || a2.length === 0) {
      return a1.concat(a2);
    }
    const last = a1[a1.length - 1], shift = bitArray.getPartial(last);
    if (shift === 32) {
      return a1.concat(a2);
    } else {
      return bitArray._shiftRight(a2, shift, last | 0, a1.slice(0, a1.length - 1));
    }
  },
  /**
   * Find the length of an array of bits.
   * @param {bitArray} a The array.
   * @return {Number} The length of a, in bits.
   */
  bitLength(a) {
    const l = a.length;
    if (l === 0) {
      return 0;
    }
    const x = a[l - 1];
    return (l - 1) * 32 + bitArray.getPartial(x);
  },
  /**
   * Truncate an array.
   * @param {bitArray} a The array.
   * @param {Number} len The length to truncate to, in bits.
   * @return {bitArray} A new array, truncated to len bits.
   */
  clamp(a, len) {
    if (a.length * 32 < len) {
      return a;
    }
    a = a.slice(0, Math.ceil(len / 32));
    const l = a.length;
    len = len & 31;
    if (l > 0 && len) {
      a[l - 1] = bitArray.partial(len, a[l - 1] & 2147483648 >> len - 1, 1);
    }
    return a;
  },
  /**
   * Make a partial word for a bit array.
   * @param {Number} len The number of bits in the word.
   * @param {Number} x The bits.
   * @param {Number} [_end=0] Pass 1 if x has already been shifted to the high side.
   * @return {Number} The partial word.
   */
  partial(len, x, _end) {
    if (len === 32) {
      return x;
    }
    return (_end ? x | 0 : x << 32 - len) + len * 1099511627776;
  },
  /**
   * Get the number of bits used by a partial word.
   * @param {Number} x The partial word.
   * @return {Number} The number of bits used by the partial word.
   */
  getPartial(x) {
    return Math.round(x / 1099511627776) || 32;
  },
  /** Shift an array right.
   * @param {bitArray} a The array to shift.
   * @param {Number} shift The number of bits to shift.
   * @param {Number} [carry=0] A byte to carry in
   * @param {bitArray} [out=[]] An array to prepend to the output.
   * @private
   */
  _shiftRight(a, shift, carry, out) {
    if (out === void 0) {
      out = [];
    }
    for (; shift >= 32; shift -= 32) {
      out.push(carry);
      carry = 0;
    }
    if (shift === 0) {
      return out.concat(a);
    }
    for (let i = 0; i < a.length; i++) {
      out.push(carry | a[i] >>> shift);
      carry = a[i] << 32 - shift;
    }
    const last2 = a.length ? a[a.length - 1] : 0;
    const shift2 = bitArray.getPartial(last2);
    out.push(bitArray.partial(shift + shift2 & 31, shift + shift2 > 32 ? carry : out.pop(), 1));
    return out;
  }
};
var codec = {
  bytes: {
    /** Convert from a bitArray to an array of bytes. */
    fromBits(arr) {
      const bl = bitArray.bitLength(arr);
      const byteLength = bl / 8;
      const out = new Uint8Array(byteLength);
      let tmp;
      for (let i = 0; i < byteLength; i++) {
        if ((i & 3) === 0) {
          tmp = arr[i / 4];
        }
        out[i] = tmp >>> 24;
        tmp <<= 8;
      }
      return out;
    },
    /** Convert from an array of bytes to a bitArray. */
    toBits(bytes) {
      const out = [];
      let i;
      let tmp = 0;
      for (i = 0; i < bytes.length; i++) {
        tmp = tmp << 8 | bytes[i];
        if ((i & 3) === 3) {
          out.push(tmp);
          tmp = 0;
        }
      }
      if (i & 3) {
        out.push(bitArray.partial(8 * (i & 3), tmp));
      }
      return out;
    }
  }
};
var hash = {};
hash.sha1 = function(hash2) {
  if (hash2) {
    this._h = hash2._h.slice(0);
    this._buffer = hash2._buffer.slice(0);
    this._length = hash2._length;
  } else {
    this.reset();
  }
};
hash.sha1.prototype = {
  /**
   * The hash's block size, in bits.
   * @constant
   */
  blockSize: 512,
  /**
   * Reset the hash state.
   * @return this
   */
  reset: function() {
    const sha1 = this;
    sha1._h = this._init.slice(0);
    sha1._buffer = [];
    sha1._length = 0;
    return sha1;
  },
  /**
   * Input several words to the hash.
   * @param {bitArray|String} data the data to hash.
   * @return this
   */
  update: function(data) {
    const sha1 = this;
    if (typeof data === "string") {
      data = codec.utf8String.toBits(data);
    }
    const b = sha1._buffer = bitArray.concat(sha1._buffer, data);
    const ol = sha1._length;
    const nl = sha1._length = ol + bitArray.bitLength(data);
    if (nl > 9007199254740991) {
      throw new Error("Cannot hash more than 2^53 - 1 bits");
    }
    const c = new Uint32Array(b);
    let j = 0;
    for (let i = sha1.blockSize + ol - (sha1.blockSize + ol & sha1.blockSize - 1); i <= nl; i += sha1.blockSize) {
      sha1._block(c.subarray(16 * j, 16 * (j + 1)));
      j += 1;
    }
    b.splice(0, 16 * j);
    return sha1;
  },
  /**
   * Complete hashing and output the hash value.
   * @return {bitArray} The hash value, an array of 5 big-endian words. TODO
   */
  finalize: function() {
    const sha1 = this;
    let b = sha1._buffer;
    const h = sha1._h;
    b = bitArray.concat(b, [bitArray.partial(1, 1)]);
    for (let i = b.length + 2; i & 15; i++) {
      b.push(0);
    }
    b.push(Math.floor(sha1._length / 4294967296));
    b.push(sha1._length | 0);
    while (b.length) {
      sha1._block(b.splice(0, 16));
    }
    sha1.reset();
    return h;
  },
  /**
   * The SHA-1 initialization vector.
   * @private
   */
  _init: [1732584193, 4023233417, 2562383102, 271733878, 3285377520],
  /**
   * The SHA-1 hash key.
   * @private
   */
  _key: [1518500249, 1859775393, 2400959708, 3395469782],
  /**
   * The SHA-1 logical functions f(0), f(1), ..., f(79).
   * @private
   */
  _f: function(t2, b, c, d) {
    if (t2 <= 19) {
      return b & c | ~b & d;
    } else if (t2 <= 39) {
      return b ^ c ^ d;
    } else if (t2 <= 59) {
      return b & c | b & d | c & d;
    } else if (t2 <= 79) {
      return b ^ c ^ d;
    }
  },
  /**
   * Circular left-shift operator.
   * @private
   */
  _S: function(n, x) {
    return x << n | x >>> 32 - n;
  },
  /**
   * Perform one cycle of SHA-1.
   * @param {Uint32Array|bitArray} words one block of words.
   * @private
   */
  _block: function(words) {
    const sha1 = this;
    const h = sha1._h;
    const w = Array(80);
    for (let j = 0; j < 16; j++) {
      w[j] = words[j];
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    for (let t2 = 0; t2 <= 79; t2++) {
      if (t2 >= 16) {
        w[t2] = sha1._S(1, w[t2 - 3] ^ w[t2 - 8] ^ w[t2 - 14] ^ w[t2 - 16]);
      }
      const tmp = sha1._S(5, a) + sha1._f(t2, b, c, d) + e + w[t2] + sha1._key[Math.floor(t2 / 20)] | 0;
      e = d;
      d = c;
      c = sha1._S(30, b);
      b = a;
      a = tmp;
    }
    h[0] = h[0] + a | 0;
    h[1] = h[1] + b | 0;
    h[2] = h[2] + c | 0;
    h[3] = h[3] + d | 0;
    h[4] = h[4] + e | 0;
  }
};
var cipher = {};
cipher.aes = class {
  constructor(key) {
    const aes = this;
    aes._tables = [[[], [], [], [], []], [[], [], [], [], []]];
    if (!aes._tables[0][0][0]) {
      aes._precompute();
    }
    const sbox = aes._tables[0][4];
    const decTable = aes._tables[1];
    const keyLen = key.length;
    let i, encKey, decKey, rcon = 1;
    if (keyLen !== 4 && keyLen !== 6 && keyLen !== 8) {
      throw new Error("invalid aes key size");
    }
    aes._key = [encKey = key.slice(0), decKey = []];
    for (i = keyLen; i < 4 * keyLen + 28; i++) {
      let tmp = encKey[i - 1];
      if (i % keyLen === 0 || keyLen === 8 && i % keyLen === 4) {
        tmp = sbox[tmp >>> 24] << 24 ^ sbox[tmp >> 16 & 255] << 16 ^ sbox[tmp >> 8 & 255] << 8 ^ sbox[tmp & 255];
        if (i % keyLen === 0) {
          tmp = tmp << 8 ^ tmp >>> 24 ^ rcon << 24;
          rcon = rcon << 1 ^ (rcon >> 7) * 283;
        }
      }
      encKey[i] = encKey[i - keyLen] ^ tmp;
    }
    for (let j = 0; i; j++, i--) {
      const tmp = encKey[j & 3 ? i : i - 4];
      if (i <= 4 || j < 4) {
        decKey[j] = tmp;
      } else {
        decKey[j] = decTable[0][sbox[tmp >>> 24]] ^ decTable[1][sbox[tmp >> 16 & 255]] ^ decTable[2][sbox[tmp >> 8 & 255]] ^ decTable[3][sbox[tmp & 255]];
      }
    }
  }
  // public
  /* Something like this might appear here eventually
  name: "AES",
  blockSize: 4,
  keySizes: [4,6,8],
  */
  /**
   * Encrypt an array of 4 big-endian words.
   * @param {Array} data The plaintext.
   * @return {Array} The ciphertext.
   */
  encrypt(data) {
    return this._crypt(data, 0);
  }
  /**
   * Decrypt an array of 4 big-endian words.
   * @param {Array} data The ciphertext.
   * @return {Array} The plaintext.
   */
  decrypt(data) {
    return this._crypt(data, 1);
  }
  /**
   * Expand the S-box tables.
   *
   * @private
   */
  _precompute() {
    const encTable = this._tables[0];
    const decTable = this._tables[1];
    const sbox = encTable[4];
    const sboxInv = decTable[4];
    const d = [];
    const th = [];
    let xInv, x2, x4, x8;
    for (let i = 0; i < 256; i++) {
      th[(d[i] = i << 1 ^ (i >> 7) * 283) ^ i] = i;
    }
    for (let x = xInv = 0; !sbox[x]; x ^= x2 || 1, xInv = th[xInv] || 1) {
      let s = xInv ^ xInv << 1 ^ xInv << 2 ^ xInv << 3 ^ xInv << 4;
      s = s >> 8 ^ s & 255 ^ 99;
      sbox[x] = s;
      sboxInv[s] = x;
      x8 = d[x4 = d[x2 = d[x]]];
      let tDec = x8 * 16843009 ^ x4 * 65537 ^ x2 * 257 ^ x * 16843008;
      let tEnc = d[s] * 257 ^ s * 16843008;
      for (let i = 0; i < 4; i++) {
        encTable[i][x] = tEnc = tEnc << 24 ^ tEnc >>> 8;
        decTable[i][s] = tDec = tDec << 24 ^ tDec >>> 8;
      }
    }
    for (let i = 0; i < 5; i++) {
      encTable[i] = encTable[i].slice(0);
      decTable[i] = decTable[i].slice(0);
    }
  }
  /**
   * Encryption and decryption core.
   * @param {Array} input Four words to be encrypted or decrypted.
   * @param dir The direction, 0 for encrypt and 1 for decrypt.
   * @return {Array} The four encrypted or decrypted words.
   * @private
   */
  _crypt(input, dir) {
    if (input.length !== 4) {
      throw new Error("invalid aes block size");
    }
    const key = this._key[dir];
    const nInnerRounds = key.length / 4 - 2;
    const out = [0, 0, 0, 0];
    const table3 = this._tables[dir];
    const t0 = table3[0];
    const t1 = table3[1];
    const t2 = table3[2];
    const t3 = table3[3];
    const sbox = table3[4];
    let a = input[0] ^ key[0];
    let b = input[dir ? 3 : 1] ^ key[1];
    let c = input[2] ^ key[2];
    let d = input[dir ? 1 : 3] ^ key[3];
    let kIndex = 4;
    let a2, b2, c2;
    for (let i = 0; i < nInnerRounds; i++) {
      a2 = t0[a >>> 24] ^ t1[b >> 16 & 255] ^ t2[c >> 8 & 255] ^ t3[d & 255] ^ key[kIndex];
      b2 = t0[b >>> 24] ^ t1[c >> 16 & 255] ^ t2[d >> 8 & 255] ^ t3[a & 255] ^ key[kIndex + 1];
      c2 = t0[c >>> 24] ^ t1[d >> 16 & 255] ^ t2[a >> 8 & 255] ^ t3[b & 255] ^ key[kIndex + 2];
      d = t0[d >>> 24] ^ t1[a >> 16 & 255] ^ t2[b >> 8 & 255] ^ t3[c & 255] ^ key[kIndex + 3];
      kIndex += 4;
      a = a2;
      b = b2;
      c = c2;
    }
    for (let i = 0; i < 4; i++) {
      out[dir ? 3 & -i : i] = sbox[a >>> 24] << 24 ^ sbox[b >> 16 & 255] << 16 ^ sbox[c >> 8 & 255] << 8 ^ sbox[d & 255] ^ key[kIndex++];
      a2 = a;
      a = b;
      b = c;
      c = d;
      d = a2;
    }
    return out;
  }
};
var random = {
  /** 
   * Generate random words with pure js, cryptographically not as strong & safe as native implementation.
   * @param {TypedArray} typedArray The array to fill.
   * @return {TypedArray} The random values.
   */
  getRandomValues(typedArray) {
    const words = new Uint32Array(typedArray.buffer);
    const r = (m_w) => {
      let m_z = 987654321;
      const mask = 4294967295;
      return function() {
        m_z = 36969 * (m_z & 65535) + (m_z >> 16) & mask;
        m_w = 18e3 * (m_w & 65535) + (m_w >> 16) & mask;
        const result = ((m_z << 16) + m_w & mask) / 4294967296 + 0.5;
        return result * (Math.random() > 0.5 ? 1 : -1);
      };
    };
    for (let i = 0, rcache; i < typedArray.length; i += 4) {
      const _r = r((rcache || Math.random()) * 4294967296);
      rcache = _r() * 987654071;
      words[i / 4] = _r() * 4294967296 | 0;
    }
    return typedArray;
  }
};
var mode = {};
mode.ctrGladman = class {
  constructor(prf, iv) {
    this._prf = prf;
    this._initIv = iv;
    this._iv = iv;
  }
  reset() {
    this._iv = this._initIv;
  }
  /** Input some data to calculate.
   * @param {bitArray} data the data to process, it must be intergral multiple of 128 bits unless it's the last.
   */
  update(data) {
    return this.calculate(this._prf, data, this._iv);
  }
  incWord(word) {
    if ((word >> 24 & 255) === 255) {
      let b1 = word >> 16 & 255;
      let b2 = word >> 8 & 255;
      let b3 = word & 255;
      if (b1 === 255) {
        b1 = 0;
        if (b2 === 255) {
          b2 = 0;
          if (b3 === 255) {
            b3 = 0;
          } else {
            ++b3;
          }
        } else {
          ++b2;
        }
      } else {
        ++b1;
      }
      word = 0;
      word += b1 << 16;
      word += b2 << 8;
      word += b3;
    } else {
      word += 1 << 24;
    }
    return word;
  }
  incCounter(counter) {
    if ((counter[0] = this.incWord(counter[0])) === 0) {
      counter[1] = this.incWord(counter[1]);
    }
  }
  calculate(prf, data, iv) {
    let l;
    if (!(l = data.length)) {
      return [];
    }
    const bl = bitArray.bitLength(data);
    for (let i = 0; i < l; i += 4) {
      this.incCounter(iv);
      const e = prf.encrypt(iv);
      data[i] ^= e[0];
      data[i + 1] ^= e[1];
      data[i + 2] ^= e[2];
      data[i + 3] ^= e[3];
    }
    return bitArray.clamp(data, bl);
  }
};
var misc = {
  importKey(password) {
    return new misc.hmacSha1(codec.bytes.toBits(password));
  },
  pbkdf2(prf, salt, count, length) {
    count = count || 1e4;
    if (length < 0 || count < 0) {
      throw new Error("invalid params to pbkdf2");
    }
    const byteLength = (length >> 5) + 1 << 2;
    let u, ui, i, j, k;
    const arrayBuffer = new ArrayBuffer(byteLength);
    const out = new DataView(arrayBuffer);
    let outLength = 0;
    const b = bitArray;
    salt = codec.bytes.toBits(salt);
    for (k = 1; outLength < (byteLength || 1); k++) {
      u = ui = prf.encrypt(b.concat(salt, [k]));
      for (i = 1; i < count; i++) {
        ui = prf.encrypt(ui);
        for (j = 0; j < ui.length; j++) {
          u[j] ^= ui[j];
        }
      }
      for (i = 0; outLength < (byteLength || 1) && i < u.length; i++) {
        out.setInt32(outLength, u[i]);
        outLength += 4;
      }
    }
    return arrayBuffer.slice(0, length / 8);
  }
};
misc.hmacSha1 = class {
  constructor(key) {
    const hmac = this;
    const Hash = hmac._hash = hash.sha1;
    const exKey = [[], []];
    const bs = Hash.prototype.blockSize / 32;
    hmac._baseHash = [new Hash(), new Hash()];
    if (key.length > bs) {
      key = Hash.hash(key);
    }
    for (let i = 0; i < bs; i++) {
      exKey[0][i] = key[i] ^ 909522486;
      exKey[1][i] = key[i] ^ 1549556828;
    }
    hmac._baseHash[0].update(exKey[0]);
    hmac._baseHash[1].update(exKey[1]);
    hmac._resultHash = new Hash(hmac._baseHash[0]);
  }
  reset() {
    const hmac = this;
    hmac._resultHash = new hmac._hash(hmac._baseHash[0]);
    hmac._updated = false;
  }
  update(data) {
    const hmac = this;
    hmac._updated = true;
    hmac._resultHash.update(data);
  }
  digest() {
    const hmac = this;
    const w = hmac._resultHash.finalize();
    const result = new hmac._hash(hmac._baseHash[1]).update(w).finalize();
    hmac.reset();
    return result;
  }
  encrypt(data) {
    if (!this._updated) {
      this.update(data);
      return this.digest(data);
    } else {
      throw new Error("encrypt on already updated hmac called!");
    }
  }
};

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/aes-crypto.js
var ERR_INVALID_PASSWORD = "Invalid pasword";
var BLOCK_LENGTH = 16;
var RAW_FORMAT = "raw";
var PBKDF2_ALGORITHM = { name: "PBKDF2" };
var HASH_ALGORITHM = { name: "HMAC" };
var HASH_FUNCTION = "SHA-1";
var BASE_KEY_ALGORITHM = Object.assign({ hash: HASH_ALGORITHM }, PBKDF2_ALGORITHM);
var DERIVED_BITS_ALGORITHM = Object.assign({ iterations: 1e3, hash: { name: HASH_FUNCTION } }, PBKDF2_ALGORITHM);
var DERIVED_BITS_USAGE = ["deriveBits"];
var SALT_LENGTH = [8, 12, 16];
var KEY_LENGTH = [16, 24, 32];
var SIGNATURE_LENGTH = 10;
var COUNTER_DEFAULT_VALUE = [0, 0, 0, 0];
var CRYPTO_API_SUPPORTED = typeof crypto != "undefined";
var SUBTLE_API_SUPPORTED = CRYPTO_API_SUPPORTED && typeof crypto.subtle != "undefined";
var codecBytes = codec.bytes;
var Aes = cipher.aes;
var CtrGladman = mode.ctrGladman;
var HmacSha1 = misc.hmacSha1;
var AESDecrypt = class {
  constructor(password, signed, strength) {
    Object.assign(this, {
      password,
      signed,
      strength: strength - 1,
      pendingInput: new Uint8Array(0)
    });
  }
  async append(input) {
    const aesCrypto = this;
    if (aesCrypto.password) {
      const preamble = subarray(input, 0, SALT_LENGTH[aesCrypto.strength] + 2);
      await createDecryptionKeys(aesCrypto, preamble, aesCrypto.password);
      aesCrypto.password = null;
      aesCrypto.aesCtrGladman = new CtrGladman(new Aes(aesCrypto.keys.key), Array.from(COUNTER_DEFAULT_VALUE));
      aesCrypto.hmac = new HmacSha1(aesCrypto.keys.authentication);
      input = subarray(input, SALT_LENGTH[aesCrypto.strength] + 2);
    }
    const output = new Uint8Array(input.length - SIGNATURE_LENGTH - (input.length - SIGNATURE_LENGTH) % BLOCK_LENGTH);
    return append(aesCrypto, input, output, 0, SIGNATURE_LENGTH, true);
  }
  flush() {
    const aesCrypto = this;
    const pendingInput = aesCrypto.pendingInput;
    const chunkToDecrypt = subarray(pendingInput, 0, pendingInput.length - SIGNATURE_LENGTH);
    const originalSignature = subarray(pendingInput, pendingInput.length - SIGNATURE_LENGTH);
    let decryptedChunkArray = new Uint8Array(0);
    if (chunkToDecrypt.length) {
      const encryptedChunk = codecBytes.toBits(chunkToDecrypt);
      aesCrypto.hmac.update(encryptedChunk);
      const decryptedChunk = aesCrypto.aesCtrGladman.update(encryptedChunk);
      decryptedChunkArray = codecBytes.fromBits(decryptedChunk);
    }
    let valid = true;
    if (aesCrypto.signed) {
      const signature = subarray(codecBytes.fromBits(aesCrypto.hmac.digest()), 0, SIGNATURE_LENGTH);
      for (let indexSignature = 0; indexSignature < SIGNATURE_LENGTH; indexSignature++) {
        if (signature[indexSignature] != originalSignature[indexSignature]) {
          valid = false;
        }
      }
    }
    return {
      valid,
      data: decryptedChunkArray
    };
  }
};
var AESEncrypt = class {
  constructor(password, strength) {
    Object.assign(this, {
      password,
      strength: strength - 1,
      pendingInput: new Uint8Array(0)
    });
  }
  async append(input) {
    const aesCrypto = this;
    let preamble = new Uint8Array(0);
    if (aesCrypto.password) {
      preamble = await createEncryptionKeys(aesCrypto, aesCrypto.password);
      aesCrypto.password = null;
      aesCrypto.aesCtrGladman = new CtrGladman(new Aes(aesCrypto.keys.key), Array.from(COUNTER_DEFAULT_VALUE));
      aesCrypto.hmac = new HmacSha1(aesCrypto.keys.authentication);
    }
    const output = new Uint8Array(preamble.length + input.length - input.length % BLOCK_LENGTH);
    output.set(preamble, 0);
    return append(aesCrypto, input, output, preamble.length, 0);
  }
  flush() {
    const aesCrypto = this;
    let encryptedChunkArray = new Uint8Array(0);
    if (aesCrypto.pendingInput.length) {
      const encryptedChunk = aesCrypto.aesCtrGladman.update(codecBytes.toBits(aesCrypto.pendingInput));
      aesCrypto.hmac.update(encryptedChunk);
      encryptedChunkArray = codecBytes.fromBits(encryptedChunk);
    }
    const signature = subarray(codecBytes.fromBits(aesCrypto.hmac.digest()), 0, SIGNATURE_LENGTH);
    return {
      data: concat(encryptedChunkArray, signature),
      signature
    };
  }
};
function append(aesCrypto, input, output, paddingStart, paddingEnd, verifySignature) {
  const inputLength = input.length - paddingEnd;
  if (aesCrypto.pendingInput.length) {
    input = concat(aesCrypto.pendingInput, input);
    output = expand(output, inputLength - inputLength % BLOCK_LENGTH);
  }
  let offset;
  for (offset = 0; offset <= inputLength - BLOCK_LENGTH; offset += BLOCK_LENGTH) {
    const inputChunk = codecBytes.toBits(subarray(input, offset, offset + BLOCK_LENGTH));
    if (verifySignature) {
      aesCrypto.hmac.update(inputChunk);
    }
    const outputChunk = aesCrypto.aesCtrGladman.update(inputChunk);
    if (!verifySignature) {
      aesCrypto.hmac.update(outputChunk);
    }
    output.set(codecBytes.fromBits(outputChunk), offset + paddingStart);
  }
  aesCrypto.pendingInput = subarray(input, offset);
  return output;
}
async function createDecryptionKeys(decrypt2, preambleArray, password) {
  await createKeys(decrypt2, password, subarray(preambleArray, 0, SALT_LENGTH[decrypt2.strength]));
  const passwordVerification = subarray(preambleArray, SALT_LENGTH[decrypt2.strength]);
  const passwordVerificationKey = decrypt2.keys.passwordVerification;
  if (passwordVerificationKey[0] != passwordVerification[0] || passwordVerificationKey[1] != passwordVerification[1]) {
    throw new Error(ERR_INVALID_PASSWORD);
  }
}
async function createEncryptionKeys(encrypt2, password) {
  const salt = getRandomValues(new Uint8Array(SALT_LENGTH[encrypt2.strength]));
  await createKeys(encrypt2, password, salt);
  return concat(salt, encrypt2.keys.passwordVerification);
}
async function createKeys(target, password, salt) {
  const encodedPassword = encode_text_default(password);
  const basekey = await importKey(RAW_FORMAT, encodedPassword, BASE_KEY_ALGORITHM, false, DERIVED_BITS_USAGE);
  const derivedBits = await deriveBits(Object.assign({ salt }, DERIVED_BITS_ALGORITHM), basekey, 8 * (KEY_LENGTH[target.strength] * 2 + 2));
  const compositeKey = new Uint8Array(derivedBits);
  target.keys = {
    key: codecBytes.toBits(subarray(compositeKey, 0, KEY_LENGTH[target.strength])),
    authentication: codecBytes.toBits(subarray(compositeKey, KEY_LENGTH[target.strength], KEY_LENGTH[target.strength] * 2)),
    passwordVerification: subarray(compositeKey, KEY_LENGTH[target.strength] * 2)
  };
}
function getRandomValues(array) {
  if (CRYPTO_API_SUPPORTED && typeof crypto.getRandomValues == "function") {
    return crypto.getRandomValues(array);
  } else {
    return random.getRandomValues(array);
  }
}
function importKey(format, password, algorithm, extractable, keyUsages) {
  if (CRYPTO_API_SUPPORTED && SUBTLE_API_SUPPORTED && typeof crypto.subtle.importKey == "function") {
    return crypto.subtle.importKey(format, password, algorithm, extractable, keyUsages);
  } else {
    return misc.importKey(password);
  }
}
async function deriveBits(algorithm, baseKey, length) {
  if (CRYPTO_API_SUPPORTED && SUBTLE_API_SUPPORTED && typeof crypto.subtle.deriveBits == "function") {
    return await crypto.subtle.deriveBits(algorithm, baseKey, length);
  } else {
    return misc.pbkdf2(baseKey, algorithm.salt, DERIVED_BITS_ALGORITHM.iterations, length);
  }
}
function concat(leftArray, rightArray) {
  let array = leftArray;
  if (leftArray.length + rightArray.length) {
    array = new Uint8Array(leftArray.length + rightArray.length);
    array.set(leftArray, 0);
    array.set(rightArray, leftArray.length);
  }
  return array;
}
function expand(inputArray, length) {
  if (length && length > inputArray.length) {
    const array = inputArray;
    inputArray = new Uint8Array(length);
    inputArray.set(array, 0);
  }
  return inputArray;
}
function subarray(array, begin, end) {
  return array.subarray(begin, end);
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/zip-crypto.js
var HEADER_LENGTH = 12;
var ZipCryptoDecrypt = class {
  constructor(password, passwordVerification) {
    const zipCrypto = this;
    Object.assign(zipCrypto, {
      password,
      passwordVerification
    });
    createKeys2(zipCrypto, password);
  }
  append(input) {
    const zipCrypto = this;
    if (zipCrypto.password) {
      const decryptedHeader = decrypt(zipCrypto, input.subarray(0, HEADER_LENGTH));
      zipCrypto.password = null;
      if (decryptedHeader[HEADER_LENGTH - 1] != zipCrypto.passwordVerification) {
        throw new Error(ERR_INVALID_PASSWORD);
      }
      input = input.subarray(HEADER_LENGTH);
    }
    return decrypt(zipCrypto, input);
  }
  flush() {
    return {
      valid: true,
      data: new Uint8Array(0)
    };
  }
};
var ZipCryptoEncrypt = class {
  constructor(password, passwordVerification) {
    const zipCrypto = this;
    Object.assign(zipCrypto, {
      password,
      passwordVerification
    });
    createKeys2(zipCrypto, password);
  }
  append(input) {
    const zipCrypto = this;
    let output;
    let offset;
    if (zipCrypto.password) {
      zipCrypto.password = null;
      const header = crypto.getRandomValues(new Uint8Array(HEADER_LENGTH));
      header[HEADER_LENGTH - 1] = zipCrypto.passwordVerification;
      output = new Uint8Array(input.length + header.length);
      output.set(encrypt(zipCrypto, header), 0);
      offset = HEADER_LENGTH;
    } else {
      output = new Uint8Array(input.length);
      offset = 0;
    }
    output.set(encrypt(zipCrypto, input), offset);
    return output;
  }
  flush() {
    return {
      data: new Uint8Array(0)
    };
  }
};
function decrypt(target, input) {
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index++) {
    output[index] = getByte(target) ^ input[index];
    updateKeys(target, output[index]);
  }
  return output;
}
function encrypt(target, input) {
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index++) {
    output[index] = getByte(target) ^ input[index];
    updateKeys(target, input[index]);
  }
  return output;
}
function createKeys2(target, password) {
  target.keys = [305419896, 591751049, 878082192];
  target.crcKey0 = new crc32_default(target.keys[0]);
  target.crcKey2 = new crc32_default(target.keys[2]);
  for (let index = 0; index < password.length; index++) {
    updateKeys(target, password.charCodeAt(index));
  }
}
function updateKeys(target, byte) {
  target.crcKey0.append([byte]);
  target.keys[0] = ~target.crcKey0.get();
  target.keys[1] = getInt32(target.keys[1] + getInt8(target.keys[0]));
  target.keys[1] = getInt32(Math.imul(target.keys[1], 134775813) + 1);
  target.crcKey2.append([target.keys[1] >>> 24]);
  target.keys[2] = ~target.crcKey2.get();
}
function getByte(target) {
  const temp = target.keys[2] | 2;
  return getInt8(Math.imul(temp, temp ^ 1) >>> 8);
}
function getInt8(number) {
  return number & 255;
}
function getInt32(number) {
  return number & 4294967295;
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/codec.js
var CODEC_DEFLATE = "deflate";
var CODEC_INFLATE = "inflate";
var ERR_INVALID_SIGNATURE = "Invalid signature";
var Inflate2 = class {
  constructor(codecConstructor, {
    signature,
    password,
    signed,
    compressed,
    zipCrypto,
    passwordVerification,
    encryptionStrength
  }, { chunkSize }) {
    const encrypted = Boolean(password);
    Object.assign(this, {
      signature,
      encrypted,
      signed,
      compressed,
      inflate: compressed && new codecConstructor({ chunkSize }),
      crc32: signed && new crc32_default(),
      zipCrypto,
      decrypt: encrypted && zipCrypto ? new ZipCryptoDecrypt(password, passwordVerification) : new AESDecrypt(password, signed, encryptionStrength)
    });
  }
  async append(data) {
    const codec2 = this;
    if (codec2.encrypted && data.length) {
      data = await codec2.decrypt.append(data);
    }
    if (codec2.compressed && data.length) {
      data = await codec2.inflate.append(data);
    }
    if ((!codec2.encrypted || codec2.zipCrypto) && codec2.signed && data.length) {
      codec2.crc32.append(data);
    }
    return data;
  }
  async flush() {
    const codec2 = this;
    let signature;
    let data = new Uint8Array(0);
    if (codec2.encrypted) {
      const result = codec2.decrypt.flush();
      if (!result.valid) {
        throw new Error(ERR_INVALID_SIGNATURE);
      }
      data = result.data;
    }
    if ((!codec2.encrypted || codec2.zipCrypto) && codec2.signed) {
      const dataViewSignature = new DataView(new Uint8Array(4).buffer);
      signature = codec2.crc32.get();
      dataViewSignature.setUint32(0, signature);
      if (codec2.signature != dataViewSignature.getUint32(0, false)) {
        throw new Error(ERR_INVALID_SIGNATURE);
      }
    }
    if (codec2.compressed) {
      data = await codec2.inflate.append(data) || new Uint8Array(0);
      await codec2.inflate.flush();
    }
    return { data, signature };
  }
};
var Deflate2 = class {
  constructor(codecConstructor, {
    encrypted,
    signed,
    compressed,
    level,
    zipCrypto,
    password,
    passwordVerification,
    encryptionStrength
  }, { chunkSize }) {
    Object.assign(this, {
      encrypted,
      signed,
      compressed,
      deflate: compressed && new codecConstructor({ level: level || 5, chunkSize }),
      crc32: signed && new crc32_default(),
      zipCrypto,
      encrypt: encrypted && zipCrypto ? new ZipCryptoEncrypt(password, passwordVerification) : new AESEncrypt(password, encryptionStrength)
    });
  }
  async append(inputData) {
    const codec2 = this;
    let data = inputData;
    if (codec2.compressed && inputData.length) {
      data = await codec2.deflate.append(inputData);
    }
    if (codec2.encrypted && data.length) {
      data = await codec2.encrypt.append(data);
    }
    if ((!codec2.encrypted || codec2.zipCrypto) && codec2.signed && inputData.length) {
      codec2.crc32.append(inputData);
    }
    return data;
  }
  async flush() {
    const codec2 = this;
    let signature;
    let data = new Uint8Array(0);
    if (codec2.compressed) {
      data = await codec2.deflate.flush() || new Uint8Array(0);
    }
    if (codec2.encrypted) {
      data = await codec2.encrypt.append(data);
      const result = codec2.encrypt.flush();
      signature = result.signature;
      const newData = new Uint8Array(data.length + result.data.length);
      newData.set(data, 0);
      newData.set(result.data, data.length);
      data = newData;
    }
    if ((!codec2.encrypted || codec2.zipCrypto) && codec2.signed) {
      signature = codec2.crc32.get();
    }
    return { data, signature };
  }
};
function createCodec(codecConstructor, options, config2) {
  if (options.codecType.startsWith(CODEC_DEFLATE)) {
    return new Deflate2(codecConstructor, options, config2);
  } else if (options.codecType.startsWith(CODEC_INFLATE)) {
    return new Inflate2(codecConstructor, options, config2);
  }
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/codec-pool-worker.js
var MESSAGE_INIT = "init";
var MESSAGE_APPEND = "append";
var MESSAGE_FLUSH = "flush";
var MESSAGE_EVENT_TYPE = "message";
var classicWorkersSupported = true;
var codec_pool_worker_default = (workerData, codecConstructor, options, config2, onTaskFinished, webWorker, scripts) => {
  Object.assign(workerData, {
    busy: true,
    codecConstructor,
    options: Object.assign({}, options),
    scripts,
    terminate() {
      if (workerData.worker && !workerData.busy) {
        workerData.worker.terminate();
        workerData.interface = null;
      }
    },
    onTaskFinished() {
      workerData.busy = false;
      onTaskFinished(workerData);
    }
  });
  return webWorker ? createWebWorkerInterface(workerData, config2) : createWorkerInterface(workerData, config2);
};
function createWorkerInterface(workerData, config2) {
  const interfaceCodec = createCodec(workerData.codecConstructor, workerData.options, config2);
  return {
    async append(data) {
      try {
        return await interfaceCodec.append(data);
      } catch (error) {
        workerData.onTaskFinished();
        throw error;
      }
    },
    async flush() {
      try {
        return await interfaceCodec.flush();
      } finally {
        workerData.onTaskFinished();
      }
    },
    abort() {
      workerData.onTaskFinished();
    }
  };
}
function createWebWorkerInterface(workerData, config2) {
  let messageTask;
  const workerOptions = { type: "module" };
  if (!workerData.interface) {
    if (!classicWorkersSupported) {
      workerData.worker = getWorker(workerOptions, config2.baseURL);
    } else {
      try {
        workerData.worker = getWorker({}, config2.baseURL);
      } catch (_error) {
        classicWorkersSupported = false;
        workerData.worker = getWorker(workerOptions, config2.baseURL);
      }
    }
    workerData.worker.addEventListener(MESSAGE_EVENT_TYPE, onMessage, false);
    workerData.interface = {
      append(data) {
        return initAndSendMessage({ type: MESSAGE_APPEND, data });
      },
      flush() {
        return initAndSendMessage({ type: MESSAGE_FLUSH });
      },
      abort() {
        workerData.onTaskFinished();
      }
    };
  }
  return workerData.interface;
  function getWorker(options, baseURL2) {
    let url, scriptUrl;
    url = workerData.scripts[0];
    if (typeof url == "function") {
      url = url();
    }
    try {
      scriptUrl = new URL(url, baseURL2);
    } catch (_error) {
      scriptUrl = url;
    }
    return new Worker(scriptUrl, options);
  }
  async function initAndSendMessage(message) {
    if (!messageTask) {
      const options = workerData.options;
      const scripts = workerData.scripts.slice(1);
      await sendMessage({ scripts, type: MESSAGE_INIT, options, config: { chunkSize: config2.chunkSize } });
    }
    return sendMessage(message);
  }
  function sendMessage(message) {
    const worker = workerData.worker;
    const result = new Promise((resolve, reject) => messageTask = { resolve, reject });
    try {
      if (message.data) {
        try {
          message.data = message.data.buffer;
          worker.postMessage(message, [message.data]);
        } catch (_error) {
          worker.postMessage(message);
        }
      } else {
        worker.postMessage(message);
      }
    } catch (error) {
      messageTask.reject(error);
      messageTask = null;
      workerData.onTaskFinished();
    }
    return result;
  }
  function onMessage(event) {
    const message = event.data;
    if (messageTask) {
      const reponseError = message.error;
      const type = message.type;
      if (reponseError) {
        const error = new Error(reponseError.message);
        error.stack = reponseError.stack;
        messageTask.reject(error);
        messageTask = null;
        workerData.onTaskFinished();
      } else if (type == MESSAGE_INIT || type == MESSAGE_FLUSH || type == MESSAGE_APPEND) {
        const data = message.data;
        if (type == MESSAGE_FLUSH) {
          messageTask.resolve({ data: new Uint8Array(data), signature: message.signature });
          messageTask = null;
          workerData.onTaskFinished();
        } else {
          messageTask.resolve(data && new Uint8Array(data));
        }
      }
    }
  }
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/codecs/codec-pool.js
var pool = [];
var pendingRequests = [];
function createCodec2(codecConstructor, options, config2) {
  const streamCopy = !options.compressed && !options.signed && !options.encrypted;
  const webWorker = !streamCopy && (options.useWebWorkers || options.useWebWorkers === void 0 && config2.useWebWorkers);
  const scripts = webWorker && config2.workerScripts ? config2.workerScripts[options.codecType] : [];
  if (pool.length < config2.maxWorkers) {
    const workerData = {};
    pool.push(workerData);
    return codec_pool_worker_default(workerData, codecConstructor, options, config2, onTaskFinished, webWorker, scripts);
  } else {
    const workerData = pool.find((workerData2) => !workerData2.busy);
    if (workerData) {
      clearTerminateTimeout(workerData);
      return codec_pool_worker_default(workerData, codecConstructor, options, config2, onTaskFinished, webWorker, scripts);
    } else {
      return new Promise((resolve) => pendingRequests.push({ resolve, codecConstructor, options, webWorker, scripts }));
    }
  }
  function onTaskFinished(workerData) {
    if (pendingRequests.length) {
      const [{ resolve, codecConstructor: codecConstructor2, options: options2, webWorker: webWorker2, scripts: scripts2 }] = pendingRequests.splice(0, 1);
      resolve(codec_pool_worker_default(workerData, codecConstructor2, options2, config2, onTaskFinished, webWorker2, scripts2));
    } else if (workerData.worker) {
      clearTerminateTimeout(workerData);
      if (Number.isFinite(config2.terminateWorkerTimeout) && config2.terminateWorkerTimeout >= 0) {
        workerData.terminateTimeout = setTimeout(() => {
          pool = pool.filter((data) => data != workerData);
          workerData.terminate();
        }, config2.terminateWorkerTimeout);
      }
    } else {
      pool = pool.filter((data) => data != workerData);
    }
  }
}
function clearTerminateTimeout(workerData) {
  if (workerData.terminateTimeout) {
    clearTimeout(workerData.terminateTimeout);
    workerData.terminateTimeout = null;
  }
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/z-worker-inline.js
var t = (t2) => {
  if ("function" == typeof URL.createObjectURL) {
    const e = () => URL.createObjectURL(new Blob(['const{Array:t,Object:e,Math:n,Error:r,Uint8Array:i,Uint16Array:o,Uint32Array:s,Int32Array:f,DataView:c,TextEncoder:l,crypto:u,postMessage:a}=globalThis,w=[];for(let t=0;256>t;t++){let e=t;for(let t=0;8>t;t++)1&e?e=e>>>1^3988292384:e>>>=1;w[t]=e}class h{constructor(t){this.t=t||-1}append(t){let e=0|this.t;for(let n=0,r=0|t.length;r>n;n++)e=e>>>8^w[255&(e^t[n])];this.t=e}get(){return~this.t}}const d={concat(t,e){if(0===t.length||0===e.length)return t.concat(e);const n=t[t.length-1],r=d.i(n);return 32===r?t.concat(e):d.o(e,r,0|n,t.slice(0,t.length-1))},l(t){const e=t.length;if(0===e)return 0;const n=t[e-1];return 32*(e-1)+d.i(n)},u(t,e){if(32*t.length<e)return t;const r=(t=t.slice(0,n.ceil(e/32))).length;return e&=31,r>0&&e&&(t[r-1]=d.h(e,t[r-1]&2147483648>>e-1,1)),t},h:(t,e,n)=>32===t?e:(n?0|e:e<<32-t)+1099511627776*t,i:t=>n.round(t/1099511627776)||32,o(t,e,n,r){for(void 0===r&&(r=[]);e>=32;e-=32)r.push(n),n=0;if(0===e)return r.concat(t);for(let i=0;i<t.length;i++)r.push(n|t[i]>>>e),n=t[i]<<32-e;const i=t.length?t[t.length-1]:0,o=d.i(i);return r.push(d.h(e+o&31,e+o>32?n:r.pop(),1)),r}},p={p:{k(t){const e=d.l(t)/8,n=new i(e);let r;for(let i=0;e>i;i++)0==(3&i)&&(r=t[i/4]),n[i]=r>>>24,r<<=8;return n},g(t){const e=[];let n,r=0;for(n=0;n<t.length;n++)r=r<<8|t[n],3==(3&n)&&(e.push(r),r=0);return 3&n&&e.push(d.h(8*(3&n),r)),e}}},y={v:function(t){t?(this.m=t.m.slice(0),this.S=t.S.slice(0),this._=t._):this.reset()}};y.v.prototype={blockSize:512,reset:function(){const t=this;return t.m=this.I.slice(0),t.S=[],t._=0,t},update:function(t){const e=this;"string"==typeof t&&(t=p.A.g(t));const n=e.S=d.concat(e.S,t),i=e._,o=e._=i+d.l(t);if(o>9007199254740991)throw new r("Cannot hash more than 2^53 - 1 bits");const f=new s(n);let c=0;for(let t=e.blockSize+i-(e.blockSize+i&e.blockSize-1);o>=t;t+=e.blockSize)e.C(f.subarray(16*c,16*(c+1))),c+=1;return n.splice(0,16*c),e},V:function(){const t=this;let e=t.S;const r=t.m;e=d.concat(e,[d.h(1,1)]);for(let t=e.length+2;15&t;t++)e.push(0);for(e.push(n.floor(t._/4294967296)),e.push(0|t._);e.length;)t.C(e.splice(0,16));return t.reset(),r},I:[1732584193,4023233417,2562383102,271733878,3285377520],B:[1518500249,1859775393,2400959708,3395469782],D:(t,e,n,r)=>t>19?t>39?t>59?t>79?void 0:e^n^r:e&n|e&r|n&r:e^n^r:e&n|~e&r,U:(t,e)=>e<<t|e>>>32-t,C:function(e){const r=this,i=r.m,o=t(80);for(let t=0;16>t;t++)o[t]=e[t];let s=i[0],f=i[1],c=i[2],l=i[3],u=i[4];for(let t=0;79>=t;t++){16>t||(o[t]=r.U(1,o[t-3]^o[t-8]^o[t-14]^o[t-16]));const e=r.U(5,s)+r.D(t,f,c,l)+u+o[t]+r.B[n.floor(t/20)]|0;u=l,l=c,c=r.U(30,f),f=s,s=e}i[0]=i[0]+s|0,i[1]=i[1]+f|0,i[2]=i[2]+c|0,i[3]=i[3]+l|0,i[4]=i[4]+u|0}};const b={getRandomValues(t){const e=new s(t.buffer),r=t=>{let e=987654321;const r=4294967295;return()=>(e=36969*(65535&e)+(e>>16)&r,(((e<<16)+(t=18e3*(65535&t)+(t>>16)&r)&r)/4294967296+.5)*(n.random()>.5?1:-1))};for(let i,o=0;o<t.length;o+=4){const t=r(4294967296*(i||n.random()));i=987654071*t(),e[o/4]=4294967296*t()|0}return t}},k={importKey:t=>new k.M(p.p.g(t)),P(t,e,n,i){if(n=n||1e4,0>i||0>n)throw new r("invalid params to pbkdf2");const o=1+(i>>5)<<2;let s,f,l,u,a;const w=new ArrayBuffer(o),h=new c(w);let y=0;const b=d;for(e=p.p.g(e),a=1;(o||1)>y;a++){for(s=f=t.encrypt(b.concat(e,[a])),l=1;n>l;l++)for(f=t.encrypt(f),u=0;u<f.length;u++)s[u]^=f[u];for(l=0;(o||1)>y&&l<s.length;l++)h.setInt32(y,s[l]),y+=4}return w.slice(0,i/8)},M:class{constructor(t){const e=this,n=e.R=y.v,r=[[],[]],i=n.prototype.blockSize/32;e.H=[new n,new n],t.length>i&&(t=n.hash(t));for(let e=0;i>e;e++)r[0][e]=909522486^t[e],r[1][e]=1549556828^t[e];e.H[0].update(r[0]),e.H[1].update(r[1]),e.K=new n(e.H[0])}reset(){const t=this;t.K=new t.R(t.H[0]),t.L=!1}update(t){this.L=!0,this.K.update(t)}digest(){const t=this,e=t.K.V(),n=new t.R(t.H[1]).update(e).V();return t.reset(),n}encrypt(t){if(this.L)throw new r("encrypt on already updated hmac called!");return this.update(t),this.digest(t)}}},g={name:"PBKDF2"},v=e.assign({hash:{name:"HMAC"}},g),m=e.assign({iterations:1e3,hash:{name:"SHA-1"}},g),S=["deriveBits"],z=[8,12,16],_=[16,24,32],I=[0,0,0,0],A=void 0!==u,C=A&&void 0!==u.subtle,V=p.p,B=class{constructor(t){const e=this;e.T=[[[],[],[],[],[]],[[],[],[],[],[]]],e.T[0][0][0]||e.j();const n=e.T[0][4],i=e.T[1],o=t.length;let s,f,c,l=1;if(4!==o&&6!==o&&8!==o)throw new r("invalid aes key size");for(e.B=[f=t.slice(0),c=[]],s=o;4*o+28>s;s++){let t=f[s-1];(s%o==0||8===o&&s%o==4)&&(t=n[t>>>24]<<24^n[t>>16&255]<<16^n[t>>8&255]<<8^n[255&t],s%o==0&&(t=t<<8^t>>>24^l<<24,l=l<<1^283*(l>>7))),f[s]=f[s-o]^t}for(let t=0;s;t++,s--){const e=f[3&t?s:s-4];c[t]=4>=s||4>t?e:i[0][n[e>>>24]]^i[1][n[e>>16&255]]^i[2][n[e>>8&255]]^i[3][n[255&e]]}}encrypt(t){return this.F(t,0)}decrypt(t){return this.F(t,1)}j(){const t=this.T[0],e=this.T[1],n=t[4],r=e[4],i=[],o=[];let s,f,c,l;for(let t=0;256>t;t++)o[(i[t]=t<<1^283*(t>>7))^t]=t;for(let u=s=0;!n[u];u^=f||1,s=o[s]||1){let o=s^s<<1^s<<2^s<<3^s<<4;o=o>>8^255&o^99,n[u]=o,r[o]=u,l=i[c=i[f=i[u]]];let a=16843009*l^65537*c^257*f^16843008*u,w=257*i[o]^16843008*o;for(let n=0;4>n;n++)t[n][u]=w=w<<24^w>>>8,e[n][o]=a=a<<24^a>>>8}for(let n=0;5>n;n++)t[n]=t[n].slice(0),e[n]=e[n].slice(0)}F(t,e){if(4!==t.length)throw new r("invalid aes block size");const n=this.B[e],i=n.length/4-2,o=[0,0,0,0],s=this.T[e],f=s[0],c=s[1],l=s[2],u=s[3],a=s[4];let w,h,d,p=t[0]^n[0],y=t[e?3:1]^n[1],b=t[2]^n[2],k=t[e?1:3]^n[3],g=4;for(let t=0;i>t;t++)w=f[p>>>24]^c[y>>16&255]^l[b>>8&255]^u[255&k]^n[g],h=f[y>>>24]^c[b>>16&255]^l[k>>8&255]^u[255&p]^n[g+1],d=f[b>>>24]^c[k>>16&255]^l[p>>8&255]^u[255&y]^n[g+2],k=f[k>>>24]^c[p>>16&255]^l[y>>8&255]^u[255&b]^n[g+3],g+=4,p=w,y=h,b=d;for(let t=0;4>t;t++)o[e?3&-t:t]=a[p>>>24]<<24^a[y>>16&255]<<16^a[b>>8&255]<<8^a[255&k]^n[g++],w=p,p=y,y=b,b=k,k=w;return o}},E=class{constructor(t,e){this.O=t,this.W=e,this.q=e}reset(){this.q=this.W}update(t){return this.G(this.O,t,this.q)}J(t){if(255==(t>>24&255)){let e=t>>16&255,n=t>>8&255,r=255&t;255===e?(e=0,255===n?(n=0,255===r?r=0:++r):++n):++e,t=0,t+=e<<16,t+=n<<8,t+=r}else t+=1<<24;return t}N(t){0===(t[0]=this.J(t[0]))&&(t[1]=this.J(t[1]))}G(t,e,n){let r;if(!(r=e.length))return[];const i=d.l(e);for(let i=0;r>i;i+=4){this.N(n);const r=t.encrypt(n);e[i]^=r[0],e[i+1]^=r[1],e[i+2]^=r[2],e[i+3]^=r[3]}return d.u(e,i)}},D=k.M;class U{constructor(t,n,r){e.assign(this,{password:t,signed:n,X:r-1,Y:new i(0)})}async append(e){const n=this;if(n.password){const i=K(e,0,z[n.X]+2);await(async(t,e,n)=>{await R(t,n,K(e,0,z[t.X]));const i=K(e,z[t.X]),o=t.keys.passwordVerification;if(o[0]!=i[0]||o[1]!=i[1])throw new r("Invalid pasword")})(n,i,n.password),n.password=null,n.Z=new E(new B(n.keys.key),t.from(I)),n.$=new D(n.keys.tt),e=K(e,z[n.X]+2)}return P(n,e,new i(e.length-10-(e.length-10)%16),0,10,!0)}flush(){const t=this,e=t.Y,n=K(e,0,e.length-10),r=K(e,e.length-10);let o=new i(0);if(n.length){const e=V.g(n);t.$.update(e);const r=t.Z.update(e);o=V.k(r)}let s=!0;if(t.signed){const e=K(V.k(t.$.digest()),0,10);for(let t=0;10>t;t++)e[t]!=r[t]&&(s=!1)}return{valid:s,data:o}}}class M{constructor(t,n){e.assign(this,{password:t,X:n-1,Y:new i(0)})}async append(e){const n=this;let r=new i(0);n.password&&(r=await(async(t,e)=>{const n=(r=new i(z[t.X]),A&&"function"==typeof u.getRandomValues?u.getRandomValues(r):b.getRandomValues(r));var r;return await R(t,e,n),H(n,t.keys.passwordVerification)})(n,n.password),n.password=null,n.Z=new E(new B(n.keys.key),t.from(I)),n.$=new D(n.keys.tt));const o=new i(r.length+e.length-e.length%16);return o.set(r,0),P(n,e,o,r.length,0)}flush(){const t=this;let e=new i(0);if(t.Y.length){const n=t.Z.update(V.g(t.Y));t.$.update(n),e=V.k(n)}const n=K(V.k(t.$.digest()),0,10);return{data:H(e,n),signature:n}}}function P(t,e,n,r,o,s){const f=e.length-o;let c;for(t.Y.length&&(e=H(t.Y,e),n=((t,e)=>{if(e&&e>t.length){const n=t;(t=new i(e)).set(n,0)}return t})(n,f-f%16)),c=0;f-16>=c;c+=16){const i=V.g(K(e,c,c+16));s&&t.$.update(i);const o=t.Z.update(i);s||t.$.update(o),n.set(V.k(o),c+r)}return t.Y=K(e,c),n}async function R(t,n,r){const o=(t=>{if(void 0===l){const e=new i((t=unescape(encodeURIComponent(t))).length);for(let n=0;n<e.length;n++)e[n]=t.charCodeAt(n);return e}return(new l).encode(t)})(n),s=await((t,e,n,r,i)=>A&&C&&"function"==typeof u.subtle.importKey?u.subtle.importKey("raw",e,n,!1,i):k.importKey(e))(0,o,v,0,S),f=await(async(t,e,n)=>A&&C&&"function"==typeof u.subtle.deriveBits?await u.subtle.deriveBits(t,e,n):k.P(e,t.salt,m.iterations,n))(e.assign({salt:r},m),s,8*(2*_[t.X]+2)),c=new i(f);t.keys={key:V.g(K(c,0,_[t.X])),tt:V.g(K(c,_[t.X],2*_[t.X])),passwordVerification:K(c,2*_[t.X])}}function H(t,e){let n=t;return t.length+e.length&&(n=new i(t.length+e.length),n.set(t,0),n.set(e,t.length)),n}function K(t,e,n){return t.subarray(e,n)}class L{constructor(t,n){e.assign(this,{password:t,passwordVerification:n}),F(this,t)}append(t){const e=this;if(e.password){const n=j(e,t.subarray(0,12));if(e.password=null,n[11]!=e.passwordVerification)throw new r("Invalid pasword");t=t.subarray(12)}return j(e,t)}flush(){return{valid:!0,data:new i(0)}}}class T{constructor(t,n){e.assign(this,{password:t,passwordVerification:n}),F(this,t)}append(t){const e=this;let n,r;if(e.password){e.password=null;const o=u.getRandomValues(new i(12));o[11]=e.passwordVerification,n=new i(t.length+o.length),n.set(x(e,o),0),r=12}else n=new i(t.length),r=0;return n.set(x(e,t),r),n}flush(){return{data:new i(0)}}}function j(t,e){const n=new i(e.length);for(let r=0;r<e.length;r++)n[r]=W(t)^e[r],O(t,n[r]);return n}function x(t,e){const n=new i(e.length);for(let r=0;r<e.length;r++)n[r]=W(t)^e[r],O(t,e[r]);return n}function F(t,e){t.keys=[305419896,591751049,878082192],t.et=new h(t.keys[0]),t.nt=new h(t.keys[2]);for(let n=0;n<e.length;n++)O(t,e.charCodeAt(n))}function O(t,e){t.et.append([e]),t.keys[0]=~t.et.get(),t.keys[1]=G(t.keys[1]+q(t.keys[0])),t.keys[1]=G(n.imul(t.keys[1],134775813)+1),t.nt.append([t.keys[1]>>>24]),t.keys[2]=~t.nt.get()}function W(t){const e=2|t.keys[2];return q(n.imul(e,1^e)>>>8)}function q(t){return 255&t}function G(t){return 4294967295&t}class J{constructor(t,{signature:n,password:r,signed:i,compressed:o,zipCrypto:s,passwordVerification:f,encryptionStrength:c},{rt:l}){const u=!!r;e.assign(this,{signature:n,encrypted:u,signed:i,compressed:o,it:o&&new t({rt:l}),ot:i&&new h,zipCrypto:s,decrypt:u&&s?new L(r,f):new U(r,i,c)})}async append(t){const e=this;return e.encrypted&&t.length&&(t=await e.decrypt.append(t)),e.compressed&&t.length&&(t=await e.it.append(t)),(!e.encrypted||e.zipCrypto)&&e.signed&&t.length&&e.ot.append(t),t}async flush(){const t=this;let e,n=new i(0);if(t.encrypted){const e=t.decrypt.flush();if(!e.valid)throw new r("Invalid signature");n=e.data}if((!t.encrypted||t.zipCrypto)&&t.signed){const n=new c(new i(4).buffer);if(e=t.ot.get(),n.setUint32(0,e),t.signature!=n.getUint32(0,!1))throw new r("Invalid signature")}return t.compressed&&(n=await t.it.append(n)||new i(0),await t.it.flush()),{data:n,signature:e}}}class N{constructor(t,{encrypted:n,signed:r,compressed:i,level:o,zipCrypto:s,password:f,passwordVerification:c,encryptionStrength:l},{rt:u}){e.assign(this,{encrypted:n,signed:r,compressed:i,st:i&&new t({level:o||5,rt:u}),ot:r&&new h,zipCrypto:s,encrypt:n&&s?new T(f,c):new M(f,l)})}async append(t){const e=this;let n=t;return e.compressed&&t.length&&(n=await e.st.append(t)),e.encrypted&&n.length&&(n=await e.encrypt.append(n)),(!e.encrypted||e.zipCrypto)&&e.signed&&t.length&&e.ot.append(t),n}async flush(){const t=this;let e,n=new i(0);if(t.compressed&&(n=await t.st.flush()||new i(0)),t.encrypted){n=await t.encrypt.append(n);const r=t.encrypt.flush();e=r.signature;const o=new i(n.length+r.data.length);o.set(n,0),o.set(r.data,n.length),n=o}return t.encrypted&&!t.zipCrypto||!t.signed||(e=t.ot.get()),{data:n,signature:e}}}const Q={init(t){t.scripts&&t.scripts.length&&importScripts.apply(void 0,t.scripts);const e=t.options;let n;self.initCodec&&self.initCodec(),e.codecType.startsWith("deflate")?n=self.Deflate:e.codecType.startsWith("inflate")&&(n=self.Inflate),X=((t,e,n)=>e.codecType.startsWith("deflate")?new N(t,e,n):e.codecType.startsWith("inflate")?new J(t,e,n):void 0)(n,e,t.config)},append:async t=>({data:await X.append(t.data)}),flush:()=>X.flush()};let X;function Y(e){return Z(e.map((([e,n])=>new t(e).fill(n,0,e))))}function Z(e){return e.reduce(((e,n)=>e.concat(t.isArray(n)?Z(n):n)),[])}addEventListener("message",(async t=>{const e=t.data,n=e.type,r=Q[n];if(r)try{e.data&&(e.data=new i(e.data));const t=await r(e)||{};if(t.type=n,t.data)try{t.data=t.data.buffer,a(t,[t.data])}catch(e){a(t)}else a(t)}catch(t){a({type:n,error:{message:t.message,stack:t.stack}})}}));const $=[0,1,2,3].concat(...Y([[2,4],[2,5],[4,6],[4,7],[8,8],[8,9],[16,10],[16,11],[32,12],[32,13],[64,14],[64,15],[2,0],[1,16],[1,17],[2,18],[2,19],[4,20],[4,21],[8,22],[8,23],[16,24],[16,25],[32,26],[32,27],[64,28],[64,29]]));function tt(){const t=this;function e(t,e){let n=0;do{n|=1&t,t>>>=1,n<<=1}while(--e>0);return n>>>1}t.ft=r=>{const i=t.ct,o=t.ut.lt,s=t.ut.wt;let f,c,l,u=-1;for(r.ht=0,r.dt=573,f=0;s>f;f++)0!==i[2*f]?(r.yt[++r.ht]=u=f,r.bt[f]=0):i[2*f+1]=0;for(;2>r.ht;)l=r.yt[++r.ht]=2>u?++u:0,i[2*l]=1,r.bt[l]=0,r.kt--,o&&(r.gt-=o[2*l+1]);for(t.vt=u,f=n.floor(r.ht/2);f>=1;f--)r.St(i,f);l=s;do{f=r.yt[1],r.yt[1]=r.yt[r.ht--],r.St(i,1),c=r.yt[1],r.yt[--r.dt]=f,r.yt[--r.dt]=c,i[2*l]=i[2*f]+i[2*c],r.bt[l]=n.max(r.bt[f],r.bt[c])+1,i[2*f+1]=i[2*c+1]=l,r.yt[1]=l++,r.St(i,1)}while(r.ht>=2);r.yt[--r.dt]=r.yt[1],(e=>{const n=t.ct,r=t.ut.lt,i=t.ut.zt,o=t.ut._t,s=t.ut.It;let f,c,l,u,a,w,h=0;for(u=0;15>=u;u++)e.At[u]=0;for(n[2*e.yt[e.dt]+1]=0,f=e.dt+1;573>f;f++)c=e.yt[f],u=n[2*n[2*c+1]+1]+1,u>s&&(u=s,h++),n[2*c+1]=u,c>t.vt||(e.At[u]++,a=0,o>c||(a=i[c-o]),w=n[2*c],e.kt+=w*(u+a),r&&(e.gt+=w*(r[2*c+1]+a)));if(0!==h){do{for(u=s-1;0===e.At[u];)u--;e.At[u]--,e.At[u+1]+=2,e.At[s]--,h-=2}while(h>0);for(u=s;0!==u;u--)for(c=e.At[u];0!==c;)l=e.yt[--f],l>t.vt||(n[2*l+1]!=u&&(e.kt+=(u-n[2*l+1])*n[2*l],n[2*l+1]=u),c--)}})(r),((t,n,r)=>{const i=[];let o,s,f,c=0;for(o=1;15>=o;o++)i[o]=c=c+r[o-1]<<1;for(s=0;n>=s;s++)f=t[2*s+1],0!==f&&(t[2*s]=e(i[f]++,f))})(i,t.vt,r.At)}}function et(t,e,n,r,i){const o=this;o.lt=t,o.zt=e,o._t=n,o.wt=r,o.It=i}tt.Ct=[0,1,2,3,4,5,6,7].concat(...Y([[2,8],[2,9],[2,10],[2,11],[4,12],[4,13],[4,14],[4,15],[8,16],[8,17],[8,18],[8,19],[16,20],[16,21],[16,22],[16,23],[32,24],[32,25],[32,26],[31,27],[1,28]])),tt.Vt=[0,1,2,3,4,5,6,7,8,10,12,14,16,20,24,28,32,40,48,56,64,80,96,112,128,160,192,224,0],tt.Bt=[0,1,2,3,4,6,8,12,16,24,32,48,64,96,128,192,256,384,512,768,1024,1536,2048,3072,4096,6144,8192,12288,16384,24576],tt.Et=t=>256>t?$[t]:$[256+(t>>>7)],tt.Dt=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0],tt.Ut=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13],tt.Mt=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7],tt.Pt=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];const nt=Y([[144,8],[112,9],[24,7],[8,8]]);et.Rt=Z([12,140,76,204,44,172,108,236,28,156,92,220,60,188,124,252,2,130,66,194,34,162,98,226,18,146,82,210,50,178,114,242,10,138,74,202,42,170,106,234,26,154,90,218,58,186,122,250,6,134,70,198,38,166,102,230,22,150,86,214,54,182,118,246,14,142,78,206,46,174,110,238,30,158,94,222,62,190,126,254,1,129,65,193,33,161,97,225,17,145,81,209,49,177,113,241,9,137,73,201,41,169,105,233,25,153,89,217,57,185,121,249,5,133,69,197,37,165,101,229,21,149,85,213,53,181,117,245,13,141,77,205,45,173,109,237,29,157,93,221,61,189,125,253,19,275,147,403,83,339,211,467,51,307,179,435,115,371,243,499,11,267,139,395,75,331,203,459,43,299,171,427,107,363,235,491,27,283,155,411,91,347,219,475,59,315,187,443,123,379,251,507,7,263,135,391,71,327,199,455,39,295,167,423,103,359,231,487,23,279,151,407,87,343,215,471,55,311,183,439,119,375,247,503,15,271,143,399,79,335,207,463,47,303,175,431,111,367,239,495,31,287,159,415,95,351,223,479,63,319,191,447,127,383,255,511,0,64,32,96,16,80,48,112,8,72,40,104,24,88,56,120,4,68,36,100,20,84,52,116,3,131,67,195,35,163,99,227].map(((t,e)=>[t,nt[e]])));const rt=Y([[30,5]]);function it(t,e,n,r,i){const o=this;o.Ht=t,o.Kt=e,o.Lt=n,o.Tt=r,o.jt=i}et.xt=Z([0,16,8,24,4,20,12,28,2,18,10,26,6,22,14,30,1,17,9,25,5,21,13,29,3,19,11,27,7,23].map(((t,e)=>[t,rt[e]]))),et.Ft=new et(et.Rt,tt.Dt,257,286,15),et.Ot=new et(et.xt,tt.Ut,0,30,15),et.Wt=new et(null,tt.Mt,0,19,7);const ot=[new it(0,0,0,0,0),new it(4,4,8,4,1),new it(4,5,16,8,1),new it(4,6,32,32,1),new it(4,4,16,16,2),new it(8,16,32,32,2),new it(8,16,128,128,2),new it(8,32,128,256,2),new it(32,128,258,1024,2),new it(32,258,258,4096,2)],st=["need dictionary","stream end","","","stream error","data error","","buffer error","",""];function ft(t,e,n,r){const i=t[2*e],o=t[2*n];return o>i||i==o&&r[e]<=r[n]}function ct(){const t=this;let e,r,s,f,c,l,u,a,w,h,d,p,y,b,k,g,v,m,S,z,_,I,A,C,V,B,E,D,U,M,P,R,H;const K=new tt,L=new tt,T=new tt;let j,x,F,O,W,q;function G(){let e;for(e=0;286>e;e++)P[2*e]=0;for(e=0;30>e;e++)R[2*e]=0;for(e=0;19>e;e++)H[2*e]=0;P[512]=1,t.kt=t.gt=0,x=F=0}function J(t,e){let n,r=-1,i=t[1],o=0,s=7,f=4;0===i&&(s=138,f=3),t[2*(e+1)+1]=65535;for(let c=0;e>=c;c++)n=i,i=t[2*(c+1)+1],++o<s&&n==i||(f>o?H[2*n]+=o:0!==n?(n!=r&&H[2*n]++,H[32]++):o>10?H[36]++:H[34]++,o=0,r=n,0===i?(s=138,f=3):n==i?(s=6,f=3):(s=7,f=4))}function N(e){t.qt[t.pending++]=e}function Q(t){N(255&t),N(t>>>8&255)}function X(t,e){let n;const r=e;q>16-r?(n=t,W|=n<<q&65535,Q(W),W=n>>>16-q,q+=r-16):(W|=t<<q&65535,q+=r)}function Y(t,e){const n=2*t;X(65535&e[n],65535&e[n+1])}function Z(t,e){let n,r,i=-1,o=t[1],s=0,f=7,c=4;for(0===o&&(f=138,c=3),n=0;e>=n;n++)if(r=o,o=t[2*(n+1)+1],++s>=f||r!=o){if(c>s)do{Y(r,H)}while(0!=--s);else 0!==r?(r!=i&&(Y(r,H),s--),Y(16,H),X(s-3,2)):s>10?(Y(18,H),X(s-11,7)):(Y(17,H),X(s-3,3));s=0,i=r,0===o?(f=138,c=3):r==o?(f=6,c=3):(f=7,c=4)}}function $(){16==q?(Q(W),W=0,q=0):8>q||(N(255&W),W>>>=8,q-=8)}function nt(e,r){let i,o,s;if(t.Gt[x]=e,t.Jt[x]=255&r,x++,0===e?P[2*r]++:(F++,e--,P[2*(tt.Ct[r]+256+1)]++,R[2*tt.Et(e)]++),0==(8191&x)&&E>2){for(i=8*x,o=_-v,s=0;30>s;s++)i+=R[2*s]*(5+tt.Ut[s]);if(i>>>=3,F<n.floor(x/2)&&i<n.floor(o/2))return!0}return x==j-1}function rt(e,n){let r,i,o,s,f=0;if(0!==x)do{r=t.Gt[f],i=t.Jt[f],f++,0===r?Y(i,e):(o=tt.Ct[i],Y(o+256+1,e),s=tt.Dt[o],0!==s&&(i-=tt.Vt[o],X(i,s)),r--,o=tt.Et(r),Y(o,n),s=tt.Ut[o],0!==s&&(r-=tt.Bt[o],X(r,s)))}while(x>f);Y(256,e),O=e[513]}function it(){q>8?Q(W):q>0&&N(255&W),W=0,q=0}function ct(e,n,r){X(0+(r?1:0),3),((e,n)=>{it(),O=8,Q(n),Q(~n),t.qt.set(a.subarray(e,e+n),t.pending),t.pending+=n})(e,n)}function lt(n){((e,n,r)=>{let i,o,s=0;E>0?(K.ft(t),L.ft(t),s=(()=>{let e;for(J(P,K.vt),J(R,L.vt),T.ft(t),e=18;e>=3&&0===H[2*tt.Pt[e]+1];e--);return t.kt+=14+3*(e+1),e})(),i=t.kt+3+7>>>3,o=t.gt+3+7>>>3,o>i||(i=o)):i=o=n+5,n+4>i||-1==e?o==i?(X(2+(r?1:0),3),rt(et.Rt,et.xt)):(X(4+(r?1:0),3),((t,e,n)=>{let r;for(X(t-257,5),X(e-1,5),X(n-4,4),r=0;n>r;r++)X(H[2*tt.Pt[r]+1],3);Z(P,t-1),Z(R,e-1)})(K.vt+1,L.vt+1,s+1),rt(P,R)):ct(e,n,r),G(),r&&it()})(0>v?-1:v,_-v,n),v=_,e.Nt()}function ut(){let t,n,r,i;do{if(i=w-A-_,0===i&&0===_&&0===A)i=c;else if(-1==i)i--;else if(_>=c+c-262){a.set(a.subarray(c,c+c),0),I-=c,_-=c,v-=c,t=y,r=t;do{n=65535&d[--r],d[r]=c>n?0:n-c}while(0!=--t);t=c,r=t;do{n=65535&h[--r],h[r]=c>n?0:n-c}while(0!=--t);i+=c}if(0===e.Qt)return;t=e.Xt(a,_+A,i),A+=t,3>A||(p=255&a[_],p=(p<<g^255&a[_+1])&k)}while(262>A&&0!==e.Qt)}function at(t){let e,n,r=V,i=_,o=C;const s=_>c-262?_-(c-262):0;let f=M;const l=u,w=_+258;let d=a[i+o-1],p=a[i+o];U>C||(r>>=2),f>A&&(f=A);do{if(e=t,a[e+o]==p&&a[e+o-1]==d&&a[e]==a[i]&&a[++e]==a[i+1]){i+=2,e++;do{}while(a[++i]==a[++e]&&a[++i]==a[++e]&&a[++i]==a[++e]&&a[++i]==a[++e]&&a[++i]==a[++e]&&a[++i]==a[++e]&&a[++i]==a[++e]&&a[++i]==a[++e]&&w>i);if(n=258-(w-i),i=w-258,n>o){if(I=t,o=n,n>=f)break;d=a[i+o-1],p=a[i+o]}}}while((t=65535&h[t&l])>s&&0!=--r);return o>A?A:o}t.bt=[],t.At=[],t.yt=[],P=[],R=[],H=[],t.St=(e,n)=>{const r=t.yt,i=r[n];let o=n<<1;for(;o<=t.ht&&(o<t.ht&&ft(e,r[o+1],r[o],t.bt)&&o++,!ft(e,i,r[o],t.bt));)r[n]=r[o],n=o,o<<=1;r[n]=i},t.Yt=(e,S,I,x,F,J)=>(x||(x=8),F||(F=8),J||(J=0),e.Zt=null,-1==S&&(S=6),1>F||F>9||8!=x||9>I||I>15||0>S||S>9||0>J||J>2?-2:(e.$t=t,l=I,c=1<<l,u=c-1,b=F+7,y=1<<b,k=y-1,g=n.floor((b+3-1)/3),a=new i(2*c),h=[],d=[],j=1<<F+6,t.qt=new i(4*j),s=4*j,t.Gt=new o(j),t.Jt=new i(j),E=S,D=J,(e=>(e.te=e.ee=0,e.Zt=null,t.pending=0,t.ne=0,r=113,f=0,K.ct=P,K.ut=et.Ft,L.ct=R,L.ut=et.Ot,T.ct=H,T.ut=et.Wt,W=0,q=0,O=8,G(),(()=>{w=2*c,d[y-1]=0;for(let t=0;y-1>t;t++)d[t]=0;B=ot[E].Kt,U=ot[E].Ht,M=ot[E].Lt,V=ot[E].Tt,_=0,v=0,A=0,m=C=2,z=0,p=0})(),0))(e))),t.re=()=>42!=r&&113!=r&&666!=r?-2:(t.Jt=null,t.Gt=null,t.qt=null,d=null,h=null,a=null,t.$t=null,113==r?-3:0),t.ie=(t,e,n)=>{let r=0;return-1==e&&(e=6),0>e||e>9||0>n||n>2?-2:(ot[E].jt!=ot[e].jt&&0!==t.te&&(r=t.st(1)),E!=e&&(E=e,B=ot[E].Kt,U=ot[E].Ht,M=ot[E].Lt,V=ot[E].Tt),D=n,r)},t.oe=(t,e,n)=>{let i,o=n,s=0;if(!e||42!=r)return-2;if(3>o)return 0;for(o>c-262&&(o=c-262,s=n-o),a.set(e.subarray(s,s+o),0),_=o,v=o,p=255&a[0],p=(p<<g^255&a[1])&k,i=0;o-3>=i;i++)p=(p<<g^255&a[i+2])&k,h[i&u]=d[p],d[p]=i;return 0},t.st=(n,i)=>{let o,w,b,V,U;if(i>4||0>i)return-2;if(!n.se||!n.fe&&0!==n.Qt||666==r&&4!=i)return n.Zt=st[4],-2;if(0===n.ce)return n.Zt=st[7],-5;var M;if(e=n,V=f,f=i,42==r&&(w=8+(l-8<<4)<<8,b=(E-1&255)>>1,b>3&&(b=3),w|=b<<6,0!==_&&(w|=32),w+=31-w%31,r=113,N((M=w)>>8&255),N(255&M)),0!==t.pending){if(e.Nt(),0===e.ce)return f=-1,0}else if(0===e.Qt&&V>=i&&4!=i)return e.Zt=st[7],-5;if(666==r&&0!==e.Qt)return n.Zt=st[7],-5;if(0!==e.Qt||0!==A||0!=i&&666!=r){switch(U=-1,ot[E].jt){case 0:U=(t=>{let n,r=65535;for(r>s-5&&(r=s-5);;){if(1>=A){if(ut(),0===A&&0==t)return 0;if(0===A)break}if(_+=A,A=0,n=v+r,(0===_||_>=n)&&(A=_-n,_=n,lt(!1),0===e.ce))return 0;if(_-v>=c-262&&(lt(!1),0===e.ce))return 0}return lt(4==t),0===e.ce?4==t?2:0:4==t?3:1})(i);break;case 1:U=(t=>{let n,r=0;for(;;){if(262>A){if(ut(),262>A&&0==t)return 0;if(0===A)break}if(3>A||(p=(p<<g^255&a[_+2])&k,r=65535&d[p],h[_&u]=d[p],d[p]=_),0===r||(_-r&65535)>c-262||2!=D&&(m=at(r)),3>m)n=nt(0,255&a[_]),A--,_++;else if(n=nt(_-I,m-3),A-=m,m>B||3>A)_+=m,m=0,p=255&a[_],p=(p<<g^255&a[_+1])&k;else{m--;do{_++,p=(p<<g^255&a[_+2])&k,r=65535&d[p],h[_&u]=d[p],d[p]=_}while(0!=--m);_++}if(n&&(lt(!1),0===e.ce))return 0}return lt(4==t),0===e.ce?4==t?2:0:4==t?3:1})(i);break;case 2:U=(t=>{let n,r,i=0;for(;;){if(262>A){if(ut(),262>A&&0==t)return 0;if(0===A)break}if(3>A||(p=(p<<g^255&a[_+2])&k,i=65535&d[p],h[_&u]=d[p],d[p]=_),C=m,S=I,m=2,0!==i&&B>C&&c-262>=(_-i&65535)&&(2!=D&&(m=at(i)),5>=m&&(1==D||3==m&&_-I>4096)&&(m=2)),3>C||m>C)if(0!==z){if(n=nt(0,255&a[_-1]),n&&lt(!1),_++,A--,0===e.ce)return 0}else z=1,_++,A--;else{r=_+A-3,n=nt(_-1-S,C-3),A-=C-1,C-=2;do{++_>r||(p=(p<<g^255&a[_+2])&k,i=65535&d[p],h[_&u]=d[p],d[p]=_)}while(0!=--C);if(z=0,m=2,_++,n&&(lt(!1),0===e.ce))return 0}}return 0!==z&&(n=nt(0,255&a[_-1]),z=0),lt(4==t),0===e.ce?4==t?2:0:4==t?3:1})(i)}if(2!=U&&3!=U||(r=666),0==U||2==U)return 0===e.ce&&(f=-1),0;if(1==U){if(1==i)X(2,3),Y(256,et.Rt),$(),9>1+O+10-q&&(X(2,3),Y(256,et.Rt),$()),O=7;else if(ct(0,0,!1),3==i)for(o=0;y>o;o++)d[o]=0;if(e.Nt(),0===e.ce)return f=-1,0}}return 4!=i?0:1}}function lt(){const t=this;t.le=0,t.ue=0,t.Qt=0,t.te=0,t.ce=0,t.ee=0}function ut(t){const e=new lt,o=(s=t&&t.rt?t.rt:65536)+5*(n.floor(s/16383)+1);var s;const f=new i(o);let c=t?t.level:-1;void 0===c&&(c=-1),e.Yt(c),e.se=f,this.append=(t,n)=>{let s,c,l=0,u=0,a=0;const w=[];if(t.length){e.le=0,e.fe=t,e.Qt=t.length;do{if(e.ue=0,e.ce=o,s=e.st(0),0!=s)throw new r("deflating: "+e.Zt);e.ue&&(e.ue==o?w.push(new i(f)):w.push(f.slice(0,e.ue))),a+=e.ue,n&&e.le>0&&e.le!=l&&(n(e.le),l=e.le)}while(e.Qt>0||0===e.ce);return w.length>1?(c=new i(a),w.forEach((t=>{c.set(t,u),u+=t.length}))):c=w[0]||new i(0),c}},this.flush=()=>{let t,n,s=0,c=0;const l=[];do{if(e.ue=0,e.ce=o,t=e.st(4),1!=t&&0!=t)throw new r("deflating: "+e.Zt);o-e.ce>0&&l.push(f.slice(0,e.ue)),c+=e.ue}while(e.Qt>0||0===e.ce);return e.re(),n=new i(c),l.forEach((t=>{n.set(t,s),s+=t.length})),n}}lt.prototype={Yt:function(t,e){const n=this;return n.$t=new ct,e||(e=15),n.$t.Yt(n,t,e)},st:function(t){const e=this;return e.$t?e.$t.st(e,t):-2},re:function(){const t=this;if(!t.$t)return-2;const e=t.$t.re();return t.$t=null,e},ie:function(t,e){const n=this;return n.$t?n.$t.ie(n,t,e):-2},oe:function(t,e){const n=this;return n.$t?n.$t.oe(n,t,e):-2},Xt:function(t,e,n){const r=this;let i=r.Qt;return i>n&&(i=n),0===i?0:(r.Qt-=i,t.set(r.fe.subarray(r.le,r.le+i),e),r.le+=i,r.te+=i,i)},Nt:function(){const t=this;let e=t.$t.pending;e>t.ce&&(e=t.ce),0!==e&&(t.se.set(t.$t.qt.subarray(t.$t.ne,t.$t.ne+e),t.ue),t.ue+=e,t.$t.ne+=e,t.ee+=e,t.ce-=e,t.$t.pending-=e,0===t.$t.pending&&(t.$t.ne=0))}};const at=[0,1,3,7,15,31,63,127,255,511,1023,2047,4095,8191,16383,32767,65535],wt=[96,7,256,0,8,80,0,8,16,84,8,115,82,7,31,0,8,112,0,8,48,0,9,192,80,7,10,0,8,96,0,8,32,0,9,160,0,8,0,0,8,128,0,8,64,0,9,224,80,7,6,0,8,88,0,8,24,0,9,144,83,7,59,0,8,120,0,8,56,0,9,208,81,7,17,0,8,104,0,8,40,0,9,176,0,8,8,0,8,136,0,8,72,0,9,240,80,7,4,0,8,84,0,8,20,85,8,227,83,7,43,0,8,116,0,8,52,0,9,200,81,7,13,0,8,100,0,8,36,0,9,168,0,8,4,0,8,132,0,8,68,0,9,232,80,7,8,0,8,92,0,8,28,0,9,152,84,7,83,0,8,124,0,8,60,0,9,216,82,7,23,0,8,108,0,8,44,0,9,184,0,8,12,0,8,140,0,8,76,0,9,248,80,7,3,0,8,82,0,8,18,85,8,163,83,7,35,0,8,114,0,8,50,0,9,196,81,7,11,0,8,98,0,8,34,0,9,164,0,8,2,0,8,130,0,8,66,0,9,228,80,7,7,0,8,90,0,8,26,0,9,148,84,7,67,0,8,122,0,8,58,0,9,212,82,7,19,0,8,106,0,8,42,0,9,180,0,8,10,0,8,138,0,8,74,0,9,244,80,7,5,0,8,86,0,8,22,192,8,0,83,7,51,0,8,118,0,8,54,0,9,204,81,7,15,0,8,102,0,8,38,0,9,172,0,8,6,0,8,134,0,8,70,0,9,236,80,7,9,0,8,94,0,8,30,0,9,156,84,7,99,0,8,126,0,8,62,0,9,220,82,7,27,0,8,110,0,8,46,0,9,188,0,8,14,0,8,142,0,8,78,0,9,252,96,7,256,0,8,81,0,8,17,85,8,131,82,7,31,0,8,113,0,8,49,0,9,194,80,7,10,0,8,97,0,8,33,0,9,162,0,8,1,0,8,129,0,8,65,0,9,226,80,7,6,0,8,89,0,8,25,0,9,146,83,7,59,0,8,121,0,8,57,0,9,210,81,7,17,0,8,105,0,8,41,0,9,178,0,8,9,0,8,137,0,8,73,0,9,242,80,7,4,0,8,85,0,8,21,80,8,258,83,7,43,0,8,117,0,8,53,0,9,202,81,7,13,0,8,101,0,8,37,0,9,170,0,8,5,0,8,133,0,8,69,0,9,234,80,7,8,0,8,93,0,8,29,0,9,154,84,7,83,0,8,125,0,8,61,0,9,218,82,7,23,0,8,109,0,8,45,0,9,186,0,8,13,0,8,141,0,8,77,0,9,250,80,7,3,0,8,83,0,8,19,85,8,195,83,7,35,0,8,115,0,8,51,0,9,198,81,7,11,0,8,99,0,8,35,0,9,166,0,8,3,0,8,131,0,8,67,0,9,230,80,7,7,0,8,91,0,8,27,0,9,150,84,7,67,0,8,123,0,8,59,0,9,214,82,7,19,0,8,107,0,8,43,0,9,182,0,8,11,0,8,139,0,8,75,0,9,246,80,7,5,0,8,87,0,8,23,192,8,0,83,7,51,0,8,119,0,8,55,0,9,206,81,7,15,0,8,103,0,8,39,0,9,174,0,8,7,0,8,135,0,8,71,0,9,238,80,7,9,0,8,95,0,8,31,0,9,158,84,7,99,0,8,127,0,8,63,0,9,222,82,7,27,0,8,111,0,8,47,0,9,190,0,8,15,0,8,143,0,8,79,0,9,254,96,7,256,0,8,80,0,8,16,84,8,115,82,7,31,0,8,112,0,8,48,0,9,193,80,7,10,0,8,96,0,8,32,0,9,161,0,8,0,0,8,128,0,8,64,0,9,225,80,7,6,0,8,88,0,8,24,0,9,145,83,7,59,0,8,120,0,8,56,0,9,209,81,7,17,0,8,104,0,8,40,0,9,177,0,8,8,0,8,136,0,8,72,0,9,241,80,7,4,0,8,84,0,8,20,85,8,227,83,7,43,0,8,116,0,8,52,0,9,201,81,7,13,0,8,100,0,8,36,0,9,169,0,8,4,0,8,132,0,8,68,0,9,233,80,7,8,0,8,92,0,8,28,0,9,153,84,7,83,0,8,124,0,8,60,0,9,217,82,7,23,0,8,108,0,8,44,0,9,185,0,8,12,0,8,140,0,8,76,0,9,249,80,7,3,0,8,82,0,8,18,85,8,163,83,7,35,0,8,114,0,8,50,0,9,197,81,7,11,0,8,98,0,8,34,0,9,165,0,8,2,0,8,130,0,8,66,0,9,229,80,7,7,0,8,90,0,8,26,0,9,149,84,7,67,0,8,122,0,8,58,0,9,213,82,7,19,0,8,106,0,8,42,0,9,181,0,8,10,0,8,138,0,8,74,0,9,245,80,7,5,0,8,86,0,8,22,192,8,0,83,7,51,0,8,118,0,8,54,0,9,205,81,7,15,0,8,102,0,8,38,0,9,173,0,8,6,0,8,134,0,8,70,0,9,237,80,7,9,0,8,94,0,8,30,0,9,157,84,7,99,0,8,126,0,8,62,0,9,221,82,7,27,0,8,110,0,8,46,0,9,189,0,8,14,0,8,142,0,8,78,0,9,253,96,7,256,0,8,81,0,8,17,85,8,131,82,7,31,0,8,113,0,8,49,0,9,195,80,7,10,0,8,97,0,8,33,0,9,163,0,8,1,0,8,129,0,8,65,0,9,227,80,7,6,0,8,89,0,8,25,0,9,147,83,7,59,0,8,121,0,8,57,0,9,211,81,7,17,0,8,105,0,8,41,0,9,179,0,8,9,0,8,137,0,8,73,0,9,243,80,7,4,0,8,85,0,8,21,80,8,258,83,7,43,0,8,117,0,8,53,0,9,203,81,7,13,0,8,101,0,8,37,0,9,171,0,8,5,0,8,133,0,8,69,0,9,235,80,7,8,0,8,93,0,8,29,0,9,155,84,7,83,0,8,125,0,8,61,0,9,219,82,7,23,0,8,109,0,8,45,0,9,187,0,8,13,0,8,141,0,8,77,0,9,251,80,7,3,0,8,83,0,8,19,85,8,195,83,7,35,0,8,115,0,8,51,0,9,199,81,7,11,0,8,99,0,8,35,0,9,167,0,8,3,0,8,131,0,8,67,0,9,231,80,7,7,0,8,91,0,8,27,0,9,151,84,7,67,0,8,123,0,8,59,0,9,215,82,7,19,0,8,107,0,8,43,0,9,183,0,8,11,0,8,139,0,8,75,0,9,247,80,7,5,0,8,87,0,8,23,192,8,0,83,7,51,0,8,119,0,8,55,0,9,207,81,7,15,0,8,103,0,8,39,0,9,175,0,8,7,0,8,135,0,8,71,0,9,239,80,7,9,0,8,95,0,8,31,0,9,159,84,7,99,0,8,127,0,8,63,0,9,223,82,7,27,0,8,111,0,8,47,0,9,191,0,8,15,0,8,143,0,8,79,0,9,255],ht=[80,5,1,87,5,257,83,5,17,91,5,4097,81,5,5,89,5,1025,85,5,65,93,5,16385,80,5,3,88,5,513,84,5,33,92,5,8193,82,5,9,90,5,2049,86,5,129,192,5,24577,80,5,2,87,5,385,83,5,25,91,5,6145,81,5,7,89,5,1537,85,5,97,93,5,24577,80,5,4,88,5,769,84,5,49,92,5,12289,82,5,13,90,5,3073,86,5,193,192,5,24577],dt=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0],pt=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,112,112],yt=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577],bt=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];function kt(){let t,e,n,r,i,o;function s(t,e,s,f,c,l,u,a,w,h,d){let p,y,b,k,g,v,m,S,z,_,I,A,C,V,B;_=0,g=s;do{n[t[e+_]]++,_++,g--}while(0!==g);if(n[0]==s)return u[0]=-1,a[0]=0,0;for(S=a[0],v=1;15>=v&&0===n[v];v++);for(m=v,v>S&&(S=v),g=15;0!==g&&0===n[g];g--);for(b=g,S>g&&(S=g),a[0]=S,V=1<<v;g>v;v++,V<<=1)if(0>(V-=n[v]))return-3;if(0>(V-=n[g]))return-3;for(n[g]+=V,o[1]=v=0,_=1,C=2;0!=--g;)o[C]=v+=n[_],C++,_++;g=0,_=0;do{0!==(v=t[e+_])&&(d[o[v]++]=g),_++}while(++g<s);for(s=o[b],o[0]=g=0,_=0,k=-1,A=-S,i[0]=0,I=0,B=0;b>=m;m++)for(p=n[m];0!=p--;){for(;m>A+S;){if(k++,A+=S,B=b-A,B=B>S?S:B,(y=1<<(v=m-A))>p+1&&(y-=p+1,C=m,B>v))for(;++v<B&&(y<<=1)>n[++C];)y-=n[C];if(B=1<<v,h[0]+B>1440)return-3;i[k]=I=h[0],h[0]+=B,0!==k?(o[k]=g,r[0]=v,r[1]=S,v=g>>>A-S,r[2]=I-i[k-1]-v,w.set(r,3*(i[k-1]+v))):u[0]=I}for(r[1]=m-A,s>_?d[_]<f?(r[0]=256>d[_]?0:96,r[2]=d[_++]):(r[0]=l[d[_]-f]+16+64,r[2]=c[d[_++]-f]):r[0]=192,y=1<<m-A,v=g>>>A;B>v;v+=y)w.set(r,3*(I+v));for(v=1<<m-1;0!=(g&v);v>>>=1)g^=v;for(g^=v,z=(1<<A)-1;(g&z)!=o[k];)k--,A-=S,z=(1<<A)-1}return 0!==V&&1!=b?-5:0}function c(s){let c;for(t||(t=[],e=[],n=new f(16),r=[],i=new f(15),o=new f(16)),e.length<s&&(e=[]),c=0;s>c;c++)e[c]=0;for(c=0;16>c;c++)n[c]=0;for(c=0;3>c;c++)r[c]=0;i.set(n.subarray(0,15),0),o.set(n.subarray(0,16),0)}this.ae=(n,r,i,o,f)=>{let l;return c(19),t[0]=0,l=s(n,0,19,19,null,null,i,r,o,t,e),-3==l?f.Zt="oversubscribed dynamic bit lengths tree":-5!=l&&0!==r[0]||(f.Zt="incomplete dynamic bit lengths tree",l=-3),l},this.we=(n,r,i,o,f,l,u,a,w)=>{let h;return c(288),t[0]=0,h=s(i,0,n,257,dt,pt,l,o,a,t,e),0!=h||0===o[0]?(-3==h?w.Zt="oversubscribed literal/length tree":-4!=h&&(w.Zt="incomplete literal/length tree",h=-3),h):(c(288),h=s(i,n,r,0,yt,bt,u,f,a,t,e),0!=h||0===f[0]&&n>257?(-3==h?w.Zt="oversubscribed distance tree":-5==h?(w.Zt="incomplete distance tree",h=-3):-4!=h&&(w.Zt="empty distance tree with lengths",h=-3),h):0)}}function gt(){const t=this;let e,n,r,i,o=0,s=0,f=0,c=0,l=0,u=0,a=0,w=0,h=0,d=0;function p(t,e,n,r,i,o,s,f){let c,l,u,a,w,h,d,p,y,b,k,g,v,m,S,z;d=f.le,p=f.Qt,w=s.he,h=s.de,y=s.write,b=y<s.read?s.read-y-1:s.end-y,k=at[t],g=at[e];do{for(;20>h;)p--,w|=(255&f.pe(d++))<<h,h+=8;if(c=w&k,l=n,u=r,z=3*(u+c),0!==(a=l[z]))for(;;){if(w>>=l[z+1],h-=l[z+1],0!=(16&a)){for(a&=15,v=l[z+2]+(w&at[a]),w>>=a,h-=a;15>h;)p--,w|=(255&f.pe(d++))<<h,h+=8;for(c=w&g,l=i,u=o,z=3*(u+c),a=l[z];;){if(w>>=l[z+1],h-=l[z+1],0!=(16&a)){for(a&=15;a>h;)p--,w|=(255&f.pe(d++))<<h,h+=8;if(m=l[z+2]+(w&at[a]),w>>=a,h-=a,b-=v,m>y){S=y-m;do{S+=s.end}while(0>S);if(a=s.end-S,v>a){if(v-=a,y-S>0&&a>y-S)do{s.ye[y++]=s.ye[S++]}while(0!=--a);else s.ye.set(s.ye.subarray(S,S+a),y),y+=a,S+=a,a=0;S=0}}else S=y-m,y-S>0&&2>y-S?(s.ye[y++]=s.ye[S++],s.ye[y++]=s.ye[S++],v-=2):(s.ye.set(s.ye.subarray(S,S+2),y),y+=2,S+=2,v-=2);if(y-S>0&&v>y-S)do{s.ye[y++]=s.ye[S++]}while(0!=--v);else s.ye.set(s.ye.subarray(S,S+v),y),y+=v,S+=v,v=0;break}if(0!=(64&a))return f.Zt="invalid distance code",v=f.Qt-p,v=v>h>>3?h>>3:v,p+=v,d-=v,h-=v<<3,s.he=w,s.de=h,f.Qt=p,f.te+=d-f.le,f.le=d,s.write=y,-3;c+=l[z+2],c+=w&at[a],z=3*(u+c),a=l[z]}break}if(0!=(64&a))return 0!=(32&a)?(v=f.Qt-p,v=v>h>>3?h>>3:v,p+=v,d-=v,h-=v<<3,s.he=w,s.de=h,f.Qt=p,f.te+=d-f.le,f.le=d,s.write=y,1):(f.Zt="invalid literal/length code",v=f.Qt-p,v=v>h>>3?h>>3:v,p+=v,d-=v,h-=v<<3,s.he=w,s.de=h,f.Qt=p,f.te+=d-f.le,f.le=d,s.write=y,-3);if(c+=l[z+2],c+=w&at[a],z=3*(u+c),0===(a=l[z])){w>>=l[z+1],h-=l[z+1],s.ye[y++]=l[z+2],b--;break}}else w>>=l[z+1],h-=l[z+1],s.ye[y++]=l[z+2],b--}while(b>=258&&p>=10);return v=f.Qt-p,v=v>h>>3?h>>3:v,p+=v,d-=v,h-=v<<3,s.he=w,s.de=h,f.Qt=p,f.te+=d-f.le,f.le=d,s.write=y,0}t.init=(t,o,s,f,c,l)=>{e=0,a=t,w=o,r=s,h=f,i=c,d=l,n=null},t.be=(t,y,b)=>{let k,g,v,m,S,z,_,I=0,A=0,C=0;for(C=y.le,m=y.Qt,I=t.he,A=t.de,S=t.write,z=S<t.read?t.read-S-1:t.end-S;;)switch(e){case 0:if(z>=258&&m>=10&&(t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,b=p(a,w,r,h,i,d,t,y),C=y.le,m=y.Qt,I=t.he,A=t.de,S=t.write,z=S<t.read?t.read-S-1:t.end-S,0!=b)){e=1==b?7:9;break}f=a,n=r,s=h,e=1;case 1:for(k=f;k>A;){if(0===m)return t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);b=0,m--,I|=(255&y.pe(C++))<<A,A+=8}if(g=3*(s+(I&at[k])),I>>>=n[g+1],A-=n[g+1],v=n[g],0===v){c=n[g+2],e=6;break}if(0!=(16&v)){l=15&v,o=n[g+2],e=2;break}if(0==(64&v)){f=v,s=g/3+n[g+2];break}if(0!=(32&v)){e=7;break}return e=9,y.Zt="invalid literal/length code",b=-3,t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);case 2:for(k=l;k>A;){if(0===m)return t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);b=0,m--,I|=(255&y.pe(C++))<<A,A+=8}o+=I&at[k],I>>=k,A-=k,f=w,n=i,s=d,e=3;case 3:for(k=f;k>A;){if(0===m)return t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);b=0,m--,I|=(255&y.pe(C++))<<A,A+=8}if(g=3*(s+(I&at[k])),I>>=n[g+1],A-=n[g+1],v=n[g],0!=(16&v)){l=15&v,u=n[g+2],e=4;break}if(0==(64&v)){f=v,s=g/3+n[g+2];break}return e=9,y.Zt="invalid distance code",b=-3,t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);case 4:for(k=l;k>A;){if(0===m)return t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);b=0,m--,I|=(255&y.pe(C++))<<A,A+=8}u+=I&at[k],I>>=k,A-=k,e=5;case 5:for(_=S-u;0>_;)_+=t.end;for(;0!==o;){if(0===z&&(S==t.end&&0!==t.read&&(S=0,z=S<t.read?t.read-S-1:t.end-S),0===z&&(t.write=S,b=t.ke(y,b),S=t.write,z=S<t.read?t.read-S-1:t.end-S,S==t.end&&0!==t.read&&(S=0,z=S<t.read?t.read-S-1:t.end-S),0===z)))return t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);t.ye[S++]=t.ye[_++],z--,_==t.end&&(_=0),o--}e=0;break;case 6:if(0===z&&(S==t.end&&0!==t.read&&(S=0,z=S<t.read?t.read-S-1:t.end-S),0===z&&(t.write=S,b=t.ke(y,b),S=t.write,z=S<t.read?t.read-S-1:t.end-S,S==t.end&&0!==t.read&&(S=0,z=S<t.read?t.read-S-1:t.end-S),0===z)))return t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);b=0,t.ye[S++]=c,z--,e=0;break;case 7:if(A>7&&(A-=8,m++,C--),t.write=S,b=t.ke(y,b),S=t.write,z=S<t.read?t.read-S-1:t.end-S,t.read!=t.write)return t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);e=8;case 8:return b=1,t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);case 9:return b=-3,t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b);default:return b=-2,t.he=I,t.de=A,y.Qt=m,y.te+=C-y.le,y.le=C,t.write=S,t.ke(y,b)}},t.ge=()=>{}}kt.ve=(t,e,n,r)=>(t[0]=9,e[0]=5,n[0]=wt,r[0]=ht,0);const vt=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];function mt(t,e){const n=this;let r,o=0,s=0,c=0,l=0;const u=[0],a=[0],w=new gt;let h=0,d=new f(4320);const p=new kt;n.de=0,n.he=0,n.ye=new i(e),n.end=e,n.read=0,n.write=0,n.reset=(t,e)=>{e&&(e[0]=0),6==o&&w.ge(t),o=0,n.de=0,n.he=0,n.read=n.write=0},n.reset(t,null),n.ke=(t,e)=>{let r,i,o;return i=t.ue,o=n.read,r=(o>n.write?n.end:n.write)-o,r>t.ce&&(r=t.ce),0!==r&&-5==e&&(e=0),t.ce-=r,t.ee+=r,t.se.set(n.ye.subarray(o,o+r),i),i+=r,o+=r,o==n.end&&(o=0,n.write==n.end&&(n.write=0),r=n.write-o,r>t.ce&&(r=t.ce),0!==r&&-5==e&&(e=0),t.ce-=r,t.ee+=r,t.se.set(n.ye.subarray(o,o+r),i),i+=r,o+=r),t.ue=i,n.read=o,e},n.be=(t,e)=>{let i,f,y,b,k,g,v,m;for(b=t.le,k=t.Qt,f=n.he,y=n.de,g=n.write,v=g<n.read?n.read-g-1:n.end-g;;){let S,z,_,I,A,C,V,B;switch(o){case 0:for(;3>y;){if(0===k)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);e=0,k--,f|=(255&t.pe(b++))<<y,y+=8}switch(i=7&f,h=1&i,i>>>1){case 0:f>>>=3,y-=3,i=7&y,f>>>=i,y-=i,o=1;break;case 1:S=[],z=[],_=[[]],I=[[]],kt.ve(S,z,_,I),w.init(S[0],z[0],_[0],0,I[0],0),f>>>=3,y-=3,o=6;break;case 2:f>>>=3,y-=3,o=3;break;case 3:return f>>>=3,y-=3,o=9,t.Zt="invalid block type",e=-3,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e)}break;case 1:for(;32>y;){if(0===k)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);e=0,k--,f|=(255&t.pe(b++))<<y,y+=8}if((~f>>>16&65535)!=(65535&f))return o=9,t.Zt="invalid stored block lengths",e=-3,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);s=65535&f,f=y=0,o=0!==s?2:0!==h?7:0;break;case 2:if(0===k)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);if(0===v&&(g==n.end&&0!==n.read&&(g=0,v=g<n.read?n.read-g-1:n.end-g),0===v&&(n.write=g,e=n.ke(t,e),g=n.write,v=g<n.read?n.read-g-1:n.end-g,g==n.end&&0!==n.read&&(g=0,v=g<n.read?n.read-g-1:n.end-g),0===v)))return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);if(e=0,i=s,i>k&&(i=k),i>v&&(i=v),n.ye.set(t.Xt(b,i),g),b+=i,k-=i,g+=i,v-=i,0!=(s-=i))break;o=0!==h?7:0;break;case 3:for(;14>y;){if(0===k)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);e=0,k--,f|=(255&t.pe(b++))<<y,y+=8}if(c=i=16383&f,(31&i)>29||(i>>5&31)>29)return o=9,t.Zt="too many length or distance symbols",e=-3,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);if(i=258+(31&i)+(i>>5&31),!r||r.length<i)r=[];else for(m=0;i>m;m++)r[m]=0;f>>>=14,y-=14,l=0,o=4;case 4:for(;4+(c>>>10)>l;){for(;3>y;){if(0===k)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);e=0,k--,f|=(255&t.pe(b++))<<y,y+=8}r[vt[l++]]=7&f,f>>>=3,y-=3}for(;19>l;)r[vt[l++]]=0;if(u[0]=7,i=p.ae(r,u,a,d,t),0!=i)return-3==(e=i)&&(r=null,o=9),n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);l=0,o=5;case 5:for(;i=c,258+(31&i)+(i>>5&31)>l;){let s,w;for(i=u[0];i>y;){if(0===k)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);e=0,k--,f|=(255&t.pe(b++))<<y,y+=8}if(i=d[3*(a[0]+(f&at[i]))+1],w=d[3*(a[0]+(f&at[i]))+2],16>w)f>>>=i,y-=i,r[l++]=w;else{for(m=18==w?7:w-14,s=18==w?11:3;i+m>y;){if(0===k)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);e=0,k--,f|=(255&t.pe(b++))<<y,y+=8}if(f>>>=i,y-=i,s+=f&at[m],f>>>=m,y-=m,m=l,i=c,m+s>258+(31&i)+(i>>5&31)||16==w&&1>m)return r=null,o=9,t.Zt="invalid bit length repeat",e=-3,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);w=16==w?r[m-1]:0;do{r[m++]=w}while(0!=--s);l=m}}if(a[0]=-1,A=[],C=[],V=[],B=[],A[0]=9,C[0]=6,i=c,i=p.we(257+(31&i),1+(i>>5&31),r,A,C,V,B,d,t),0!=i)return-3==i&&(r=null,o=9),e=i,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);w.init(A[0],C[0],d,V[0],d,B[0]),o=6;case 6:if(n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,1!=(e=w.be(n,t,e)))return n.ke(t,e);if(e=0,w.ge(t),b=t.le,k=t.Qt,f=n.he,y=n.de,g=n.write,v=g<n.read?n.read-g-1:n.end-g,0===h){o=0;break}o=7;case 7:if(n.write=g,e=n.ke(t,e),g=n.write,v=g<n.read?n.read-g-1:n.end-g,n.read!=n.write)return n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);o=8;case 8:return e=1,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);case 9:return e=-3,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e);default:return e=-2,n.he=f,n.de=y,t.Qt=k,t.te+=b-t.le,t.le=b,n.write=g,n.ke(t,e)}}},n.ge=t=>{n.reset(t,null),n.ye=null,d=null},n.me=(t,e,r)=>{n.ye.set(t.subarray(e,e+r),0),n.read=n.write=r},n.Se=()=>1==o?1:0}const St=[0,0,255,255];function zt(){const t=this;function e(t){return t&&t.ze?(t.te=t.ee=0,t.Zt=null,t.ze.mode=7,t.ze._e.reset(t,null),0):-2}t.mode=0,t.method=0,t.Ie=[0],t.Ae=0,t.marker=0,t.Ce=0,t.Ve=e=>(t._e&&t._e.ge(e),t._e=null,0),t.Be=(n,r)=>(n.Zt=null,t._e=null,8>r||r>15?(t.Ve(n),-2):(t.Ce=r,n.ze._e=new mt(n,1<<r),e(n),0)),t.it=(t,e)=>{let n,r;if(!t||!t.ze||!t.fe)return-2;const i=t.ze;for(e=4==e?-5:0,n=-5;;)switch(i.mode){case 0:if(0===t.Qt)return n;if(n=e,t.Qt--,t.te++,8!=(15&(i.method=t.pe(t.le++)))){i.mode=13,t.Zt="unknown compression method",i.marker=5;break}if(8+(i.method>>4)>i.Ce){i.mode=13,t.Zt="invalid win size",i.marker=5;break}i.mode=1;case 1:if(0===t.Qt)return n;if(n=e,t.Qt--,t.te++,r=255&t.pe(t.le++),((i.method<<8)+r)%31!=0){i.mode=13,t.Zt="incorrect header check",i.marker=5;break}if(0==(32&r)){i.mode=7;break}i.mode=2;case 2:if(0===t.Qt)return n;n=e,t.Qt--,t.te++,i.Ae=(255&t.pe(t.le++))<<24&4278190080,i.mode=3;case 3:if(0===t.Qt)return n;n=e,t.Qt--,t.te++,i.Ae+=(255&t.pe(t.le++))<<16&16711680,i.mode=4;case 4:if(0===t.Qt)return n;n=e,t.Qt--,t.te++,i.Ae+=(255&t.pe(t.le++))<<8&65280,i.mode=5;case 5:return 0===t.Qt?n:(n=e,t.Qt--,t.te++,i.Ae+=255&t.pe(t.le++),i.mode=6,2);case 6:return i.mode=13,t.Zt="need dictionary",i.marker=0,-2;case 7:if(n=i._e.be(t,n),-3==n){i.mode=13,i.marker=0;break}if(0==n&&(n=e),1!=n)return n;n=e,i._e.reset(t,i.Ie),i.mode=12;case 12:return t.Qt=0,1;case 13:return-3;default:return-2}},t.Ee=(t,e,n)=>{let r=0,i=n;if(!t||!t.ze||6!=t.ze.mode)return-2;const o=t.ze;return i<1<<o.Ce||(i=(1<<o.Ce)-1,r=n-i),o._e.me(e,r,i),o.mode=7,0},t.De=t=>{let n,r,i,o,s;if(!t||!t.ze)return-2;const f=t.ze;if(13!=f.mode&&(f.mode=13,f.marker=0),0===(n=t.Qt))return-5;for(r=t.le,i=f.marker;0!==n&&4>i;)t.pe(r)==St[i]?i++:i=0!==t.pe(r)?0:4-i,r++,n--;return t.te+=r-t.le,t.le=r,t.Qt=n,f.marker=i,4!=i?-3:(o=t.te,s=t.ee,e(t),t.te=o,t.ee=s,f.mode=7,0)},t.Ue=t=>t&&t.ze&&t.ze._e?t.ze._e.Se():-2}function _t(){}function It(t){const e=new _t,o=t&&t.rt?n.floor(2*t.rt):131072,s=new i(o);let f=!1;e.Be(),e.se=s,this.append=(t,n)=>{const c=[];let l,u,a=0,w=0,h=0;if(0!==t.length){e.le=0,e.fe=t,e.Qt=t.length;do{if(e.ue=0,e.ce=o,0!==e.Qt||f||(e.le=0,f=!0),l=e.it(0),f&&-5===l){if(0!==e.Qt)throw new r("inflating: bad input")}else if(0!==l&&1!==l)throw new r("inflating: "+e.Zt);if((f||1===l)&&e.Qt===t.length)throw new r("inflating: bad input");e.ue&&(e.ue===o?c.push(new i(s)):c.push(s.slice(0,e.ue))),h+=e.ue,n&&e.le>0&&e.le!=a&&(n(e.le),a=e.le)}while(e.Qt>0||0===e.ce);return c.length>1?(u=new i(h),c.forEach((t=>{u.set(t,w),w+=t.length}))):u=c[0]||new i(0),u}},this.flush=()=>{e.Ve()}}_t.prototype={Be:function(t){const e=this;return e.ze=new zt,t||(t=15),e.ze.Be(e,t)},it:function(t){const e=this;return e.ze?e.ze.it(e,t):-2},Ve:function(){const t=this;if(!t.ze)return-2;const e=t.ze.Ve(t);return t.ze=null,e},De:function(){const t=this;return t.ze?t.ze.De(t):-2},Ee:function(t,e){const n=this;return n.ze?n.ze.Ee(n,t,e):-2},pe:function(t){return this.fe[t]},Xt:function(t,e){return this.fe.subarray(t,t+e)}},self.initCodec=()=>{self.Deflate=ut,self.Inflate=It};\n'], { type: "text/javascript" }));
    t2({ workerScripts: { inflate: [e], deflate: [e] } });
  }
};

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/io.js
var CONTENT_TYPE_TEXT_PLAIN = "text/plain";
var Stream = class {
  constructor() {
    this.size = 0;
  }
  init() {
    this.initialized = true;
  }
};
var Reader = class extends Stream {
};
var Writer = class extends Stream {
  writeUint8Array(array) {
    this.size += array.length;
  }
};
var TextWriter = class extends Writer {
  constructor(encoding) {
    super();
    this.encoding = encoding;
    this.blob = new Blob([], { type: CONTENT_TYPE_TEXT_PLAIN });
  }
  writeUint8Array(array) {
    super.writeUint8Array(array);
    this.blob = new Blob([this.blob, array.buffer], { type: CONTENT_TYPE_TEXT_PLAIN });
  }
  getData() {
    if (this.blob.text) {
      return this.blob.text();
    } else {
      const reader = new FileReader();
      return new Promise((resolve, reject) => {
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this.blob, this.encoding);
      });
    }
  }
};
var BlobReader = class extends Reader {
  constructor(blob) {
    super();
    this.blob = blob;
    this.size = blob.size;
  }
  async readUint8Array(offset, length) {
    if (this.blob.arrayBuffer) {
      return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
    } else {
      const reader = new FileReader();
      return new Promise((resolve, reject) => {
        reader.onload = (event) => resolve(new Uint8Array(event.target.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this.blob.slice(offset, offset + length));
      });
    }
  }
};
var BlobWriter = class extends Writer {
  constructor(contentType) {
    super();
    this.contentType = contentType;
    this.arrayBuffersMaxlength = 8;
    initArrayBuffers(this);
  }
  writeUint8Array(array) {
    super.writeUint8Array(array);
    if (this.arrayBuffers.length == this.arrayBuffersMaxlength) {
      flushArrayBuffers(this);
    }
    this.arrayBuffers.push(array.buffer);
  }
  getData() {
    if (!this.blob) {
      if (this.arrayBuffers.length) {
        flushArrayBuffers(this);
      }
      this.blob = this.pendingBlob;
      initArrayBuffers(this);
    }
    return this.blob;
  }
};
function initArrayBuffers(blobWriter) {
  blobWriter.pendingBlob = new Blob([], { type: blobWriter.contentType });
  blobWriter.arrayBuffers = [];
}
function flushArrayBuffers(blobWriter) {
  blobWriter.pendingBlob = new Blob([blobWriter.pendingBlob, ...blobWriter.arrayBuffers], { type: blobWriter.contentType });
  blobWriter.arrayBuffers = [];
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/constants.js
var MAX_32_BITS = 4294967295;
var MAX_16_BITS = 65535;
var COMPRESSION_METHOD_DEFLATE = 8;
var COMPRESSION_METHOD_STORE = 0;
var COMPRESSION_METHOD_AES = 99;
var LOCAL_FILE_HEADER_SIGNATURE = 67324752;
var CENTRAL_FILE_HEADER_SIGNATURE = 33639248;
var END_OF_CENTRAL_DIR_SIGNATURE = 101010256;
var ZIP64_END_OF_CENTRAL_DIR_SIGNATURE = 101075792;
var ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE = 117853008;
var END_OF_CENTRAL_DIR_LENGTH = 22;
var ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH = 20;
var ZIP64_END_OF_CENTRAL_DIR_LENGTH = 56;
var ZIP64_END_OF_CENTRAL_DIR_TOTAL_LENGTH = END_OF_CENTRAL_DIR_LENGTH + ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH + ZIP64_END_OF_CENTRAL_DIR_LENGTH;
var EXTRAFIELD_TYPE_ZIP64 = 1;
var EXTRAFIELD_TYPE_AES = 39169;
var EXTRAFIELD_TYPE_NTFS = 10;
var EXTRAFIELD_TYPE_NTFS_TAG1 = 1;
var EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP = 21589;
var EXTRAFIELD_TYPE_UNICODE_PATH = 28789;
var EXTRAFIELD_TYPE_UNICODE_COMMENT = 25461;
var BITFLAG_ENCRYPTED = 1;
var BITFLAG_LEVEL = 6;
var BITFLAG_DATA_DESCRIPTOR = 8;
var BITFLAG_LANG_ENCODING_FLAG = 2048;
var FILE_ATTR_MSDOS_DIR_MASK = 16;
var DIRECTORY_SIGNATURE = "/";
var MAX_DATE = new Date(2107, 11, 31);
var MIN_DATE = new Date(1980, 0, 1);

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/util/cp437-decode.js
var CP437 = "\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ".split("");
var cp437_decode_default = (stringValue) => {
  let result = "";
  for (let indexCharacter = 0; indexCharacter < stringValue.length; indexCharacter++) {
    result += CP437[stringValue[indexCharacter]];
  }
  return result;
};

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/util/decode-text.js
var decode_text_default = decodeText;
function decodeText(value, encoding) {
  if (encoding && encoding.trim().toLowerCase() == "cp437") {
    return cp437_decode_default(value);
  } else if (typeof TextDecoder == "undefined") {
    const fileReader = new FileReader();
    return new Promise((resolve, reject) => {
      fileReader.onload = (event) => resolve(event.target.result);
      fileReader.onerror = () => reject(fileReader.error);
      fileReader.readAsText(new Blob([value]));
    });
  } else {
    return new TextDecoder(encoding).decode(value);
  }
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/engine.js
var MINIMUM_CHUNK_SIZE = 64;
var ERR_ABORT = "Abort error";
async function processData(codec2, reader, writer, offset, inputLengthGetter, config2, options) {
  const chunkSize = Math.max(config2.chunkSize, MINIMUM_CHUNK_SIZE);
  return processChunk();
  async function processChunk(chunkOffset = 0, outputLength = 0) {
    const signal = options.signal;
    const inputLength = inputLengthGetter();
    if (chunkOffset < inputLength) {
      testAborted(signal, codec2);
      const inputData = await reader.readUint8Array(chunkOffset + offset, Math.min(chunkSize, inputLength - chunkOffset));
      const chunkLength = inputData.length;
      testAborted(signal, codec2);
      const data = await codec2.append(inputData);
      testAborted(signal, codec2);
      outputLength += await writeData(writer, data);
      if (options.onprogress) {
        try {
          options.onprogress(chunkOffset + chunkLength, inputLength);
        } catch (error) {
        }
      }
      return processChunk(chunkOffset + chunkSize, outputLength);
    } else {
      const result = await codec2.flush();
      outputLength += await writeData(writer, result.data);
      return { signature: result.signature, length: outputLength };
    }
  }
}
function testAborted(signal, codec2) {
  if (signal && signal.aborted) {
    codec2.abort();
    throw new Error(ERR_ABORT);
  }
}
async function writeData(writer, data) {
  if (data.length) {
    await writer.writeUint8Array(data);
  }
  return data.length;
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/zip-entry.js
var PROPERTY_NAMES = [
  "filename",
  "rawFilename",
  "directory",
  "encrypted",
  "compressedSize",
  "uncompressedSize",
  "lastModDate",
  "rawLastModDate",
  "comment",
  "rawComment",
  "signature",
  "extraField",
  "rawExtraField",
  "bitFlag",
  "extraFieldZip64",
  "extraFieldUnicodePath",
  "extraFieldUnicodeComment",
  "extraFieldAES",
  "filenameUTF8",
  "commentUTF8",
  "offset",
  "zip64",
  "compressionMethod",
  "extraFieldNTFS",
  "lastAccessDate",
  "creationDate",
  "extraFieldExtendedTimestamp",
  "version",
  "versionMadeBy",
  "msDosCompatible",
  "internalFileAttribute",
  "externalFileAttribute"
];
var Entry = class {
  constructor(data) {
    PROPERTY_NAMES.forEach((name) => this[name] = data[name]);
  }
};

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/zip-reader.js
var ERR_BAD_FORMAT = "File format is not recognized";
var ERR_EOCDR_NOT_FOUND = "End of central directory not found";
var ERR_EOCDR_ZIP64_NOT_FOUND = "End of Zip64 central directory not found";
var ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND = "End of Zip64 central directory locator not found";
var ERR_CENTRAL_DIRECTORY_NOT_FOUND = "Central directory header not found";
var ERR_LOCAL_FILE_HEADER_NOT_FOUND = "Local file header not found";
var ERR_EXTRAFIELD_ZIP64_NOT_FOUND = "Zip64 extra field not found";
var ERR_ENCRYPTED = "File contains encrypted entry";
var ERR_UNSUPPORTED_ENCRYPTION = "Encryption method not supported";
var ERR_UNSUPPORTED_COMPRESSION = "Compression method not supported";
var CHARSET_UTF8 = "utf-8";
var CHARSET_CP437 = "cp437";
var ZIP64_PROPERTIES = ["uncompressedSize", "compressedSize", "offset"];
var ZipReader = class {
  constructor(reader, options = {}) {
    Object.assign(this, {
      reader,
      options,
      config: getConfiguration()
    });
  }
  async *getEntriesGenerator(options = {}) {
    const zipReader = this;
    const reader = zipReader.reader;
    if (!reader.initialized) {
      await reader.init();
    }
    if (reader.size < END_OF_CENTRAL_DIR_LENGTH) {
      throw new Error(ERR_BAD_FORMAT);
    }
    const endOfDirectoryInfo = await seekSignature(reader, END_OF_CENTRAL_DIR_SIGNATURE, reader.size, END_OF_CENTRAL_DIR_LENGTH, MAX_16_BITS * 16);
    if (!endOfDirectoryInfo) {
      throw new Error(ERR_EOCDR_NOT_FOUND);
    }
    const endOfDirectoryView = getDataView(endOfDirectoryInfo);
    let directoryDataLength = getUint32(endOfDirectoryView, 12);
    let directoryDataOffset = getUint32(endOfDirectoryView, 16);
    let filesLength = getUint16(endOfDirectoryView, 8);
    let prependedDataLength = 0;
    if (directoryDataOffset == MAX_32_BITS || directoryDataLength == MAX_32_BITS || filesLength == MAX_16_BITS) {
      const endOfDirectoryLocatorArray = await readUint8Array(reader, endOfDirectoryInfo.offset - ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH, ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH);
      const endOfDirectoryLocatorView = getDataView(endOfDirectoryLocatorArray);
      if (getUint32(endOfDirectoryLocatorView, 0) != ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE) {
        throw new Error(ERR_EOCDR_ZIP64_NOT_FOUND);
      }
      directoryDataOffset = getBigUint64(endOfDirectoryLocatorView, 8);
      let endOfDirectoryArray = await readUint8Array(reader, directoryDataOffset, ZIP64_END_OF_CENTRAL_DIR_LENGTH);
      let endOfDirectoryView2 = getDataView(endOfDirectoryArray);
      const expectedDirectoryDataOffset = endOfDirectoryInfo.offset - ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH - ZIP64_END_OF_CENTRAL_DIR_LENGTH;
      if (getUint32(endOfDirectoryView2, 0) != ZIP64_END_OF_CENTRAL_DIR_SIGNATURE && directoryDataOffset != expectedDirectoryDataOffset) {
        const originalDirectoryDataOffset = directoryDataOffset;
        directoryDataOffset = expectedDirectoryDataOffset;
        prependedDataLength = directoryDataOffset - originalDirectoryDataOffset;
        endOfDirectoryArray = await readUint8Array(reader, directoryDataOffset, ZIP64_END_OF_CENTRAL_DIR_LENGTH);
        endOfDirectoryView2 = getDataView(endOfDirectoryArray);
      }
      if (getUint32(endOfDirectoryView2, 0) != ZIP64_END_OF_CENTRAL_DIR_SIGNATURE) {
        throw new Error(ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND);
      }
      filesLength = getBigUint64(endOfDirectoryView2, 32);
      directoryDataLength = getBigUint64(endOfDirectoryView2, 40);
      directoryDataOffset -= directoryDataLength;
    }
    if (directoryDataOffset < 0 || directoryDataOffset >= reader.size) {
      throw new Error(ERR_BAD_FORMAT);
    }
    let offset = 0;
    let directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength);
    let directoryView = getDataView(directoryArray);
    if (directoryDataLength) {
      const expectedDirectoryDataOffset = endOfDirectoryInfo.offset - directoryDataLength;
      if (getUint32(directoryView, offset) != CENTRAL_FILE_HEADER_SIGNATURE && directoryDataOffset != expectedDirectoryDataOffset) {
        const originalDirectoryDataOffset = directoryDataOffset;
        directoryDataOffset = expectedDirectoryDataOffset;
        prependedDataLength = directoryDataOffset - originalDirectoryDataOffset;
        directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength);
        directoryView = getDataView(directoryArray);
      }
    }
    if (directoryDataOffset < 0 || directoryDataOffset >= reader.size) {
      throw new Error(ERR_BAD_FORMAT);
    }
    for (let indexFile = 0; indexFile < filesLength; indexFile++) {
      const fileEntry = new ZipEntry(reader, zipReader.config, zipReader.options);
      if (getUint32(directoryView, offset) != CENTRAL_FILE_HEADER_SIGNATURE) {
        throw new Error(ERR_CENTRAL_DIRECTORY_NOT_FOUND);
      }
      readCommonHeader(fileEntry, directoryView, offset + 6);
      const languageEncodingFlag = Boolean(fileEntry.bitFlag.languageEncodingFlag);
      const filenameOffset = offset + 46;
      const extraFieldOffset = filenameOffset + fileEntry.filenameLength;
      const commentOffset = extraFieldOffset + fileEntry.extraFieldLength;
      const versionMadeBy = getUint16(directoryView, offset + 4);
      const msDosCompatible = (versionMadeBy & 0) == 0;
      Object.assign(fileEntry, {
        versionMadeBy,
        msDosCompatible,
        compressedSize: 0,
        uncompressedSize: 0,
        commentLength: getUint16(directoryView, offset + 32),
        directory: msDosCompatible && (getUint8(directoryView, offset + 38) & FILE_ATTR_MSDOS_DIR_MASK) == FILE_ATTR_MSDOS_DIR_MASK,
        offset: getUint32(directoryView, offset + 42) + prependedDataLength,
        internalFileAttribute: getUint32(directoryView, offset + 34),
        externalFileAttribute: getUint32(directoryView, offset + 38),
        rawFilename: directoryArray.subarray(filenameOffset, extraFieldOffset),
        filenameUTF8: languageEncodingFlag,
        commentUTF8: languageEncodingFlag,
        rawExtraField: directoryArray.subarray(extraFieldOffset, commentOffset)
      });
      const endOffset = commentOffset + fileEntry.commentLength;
      fileEntry.rawComment = directoryArray.subarray(commentOffset, endOffset);
      const filenameEncoding = getOptionValue(zipReader, options, "filenameEncoding");
      const commentEncoding = getOptionValue(zipReader, options, "commentEncoding");
      const [filename, comment] = await Promise.all([
        decode_text_default(fileEntry.rawFilename, fileEntry.filenameUTF8 ? CHARSET_UTF8 : filenameEncoding || CHARSET_CP437),
        decode_text_default(fileEntry.rawComment, fileEntry.commentUTF8 ? CHARSET_UTF8 : commentEncoding || CHARSET_CP437)
      ]);
      fileEntry.filename = filename;
      fileEntry.comment = comment;
      if (!fileEntry.directory && fileEntry.filename.endsWith(DIRECTORY_SIGNATURE)) {
        fileEntry.directory = true;
      }
      await readCommonFooter(fileEntry, fileEntry, directoryView, offset + 6);
      const entry = new Entry(fileEntry);
      entry.getData = (writer, options2) => fileEntry.getData(writer, entry, options2);
      offset = endOffset;
      if (options.onprogress) {
        try {
          options.onprogress(indexFile + 1, filesLength, new Entry(fileEntry));
        } catch (_error) {
        }
      }
      yield entry;
    }
    return true;
  }
  async getEntries(options = {}) {
    const entries = [];
    const iter = this.getEntriesGenerator(options);
    let curr = iter.next();
    while (!(await curr).done) {
      entries.push((await curr).value);
      curr = iter.next();
    }
    return entries;
  }
  async close() {
  }
};
var ZipEntry = class {
  constructor(reader, config2, options) {
    Object.assign(this, {
      reader,
      config: config2,
      options
    });
  }
  async getData(writer, fileEntry, options = {}) {
    const zipEntry = this;
    const {
      reader,
      offset,
      extraFieldAES,
      compressionMethod,
      config: config2,
      bitFlag,
      signature,
      rawLastModDate,
      compressedSize
    } = zipEntry;
    const localDirectory = zipEntry.localDirectory = {};
    if (!reader.initialized) {
      await reader.init();
    }
    let dataArray = await readUint8Array(reader, offset, 30);
    const dataView = getDataView(dataArray);
    let password = getOptionValue(zipEntry, options, "password");
    password = password && password.length && password;
    if (extraFieldAES) {
      if (extraFieldAES.originalCompressionMethod != COMPRESSION_METHOD_AES) {
        throw new Error(ERR_UNSUPPORTED_COMPRESSION);
      }
    }
    if (compressionMethod != COMPRESSION_METHOD_STORE && compressionMethod != COMPRESSION_METHOD_DEFLATE) {
      throw new Error(ERR_UNSUPPORTED_COMPRESSION);
    }
    if (getUint32(dataView, 0) != LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(ERR_LOCAL_FILE_HEADER_NOT_FOUND);
    }
    readCommonHeader(localDirectory, dataView, 4);
    dataArray = await readUint8Array(reader, offset, 30 + localDirectory.filenameLength + localDirectory.extraFieldLength);
    localDirectory.rawExtraField = dataArray.subarray(30 + localDirectory.filenameLength);
    await readCommonFooter(zipEntry, localDirectory, dataView, 4);
    fileEntry.lastAccessDate = localDirectory.lastAccessDate;
    fileEntry.creationDate = localDirectory.creationDate;
    const encrypted = zipEntry.encrypted && localDirectory.encrypted;
    const zipCrypto = encrypted && !extraFieldAES;
    if (encrypted) {
      if (!zipCrypto && extraFieldAES.strength === void 0) {
        throw new Error(ERR_UNSUPPORTED_ENCRYPTION);
      } else if (!password) {
        throw new Error(ERR_ENCRYPTED);
      }
    }
    const codec2 = await createCodec2(config2.Inflate, {
      codecType: CODEC_INFLATE,
      password,
      zipCrypto,
      encryptionStrength: extraFieldAES && extraFieldAES.strength,
      signed: getOptionValue(zipEntry, options, "checkSignature"),
      passwordVerification: zipCrypto && (bitFlag.dataDescriptor ? rawLastModDate >>> 8 & 255 : signature >>> 24 & 255),
      signature,
      compressed: compressionMethod != 0,
      encrypted,
      useWebWorkers: getOptionValue(zipEntry, options, "useWebWorkers")
    }, config2);
    if (!writer.initialized) {
      await writer.init();
    }
    const signal = getOptionValue(zipEntry, options, "signal");
    const dataOffset = offset + 30 + localDirectory.filenameLength + localDirectory.extraFieldLength;
    await processData(codec2, reader, writer, dataOffset, () => compressedSize, config2, { onprogress: options.onprogress, signal });
    return writer.getData();
  }
};
function readCommonHeader(directory, dataView, offset) {
  const rawBitFlag = directory.rawBitFlag = getUint16(dataView, offset + 2);
  const encrypted = (rawBitFlag & BITFLAG_ENCRYPTED) == BITFLAG_ENCRYPTED;
  const rawLastModDate = getUint32(dataView, offset + 6);
  Object.assign(directory, {
    encrypted,
    version: getUint16(dataView, offset),
    bitFlag: {
      level: (rawBitFlag & BITFLAG_LEVEL) >> 1,
      dataDescriptor: (rawBitFlag & BITFLAG_DATA_DESCRIPTOR) == BITFLAG_DATA_DESCRIPTOR,
      languageEncodingFlag: (rawBitFlag & BITFLAG_LANG_ENCODING_FLAG) == BITFLAG_LANG_ENCODING_FLAG
    },
    rawLastModDate,
    lastModDate: getDate(rawLastModDate),
    filenameLength: getUint16(dataView, offset + 22),
    extraFieldLength: getUint16(dataView, offset + 24)
  });
}
async function readCommonFooter(fileEntry, directory, dataView, offset) {
  const rawExtraField = directory.rawExtraField;
  const extraField = directory.extraField = /* @__PURE__ */ new Map();
  const rawExtraFieldView = getDataView(new Uint8Array(rawExtraField));
  let offsetExtraField = 0;
  try {
    while (offsetExtraField < rawExtraField.length) {
      const type = getUint16(rawExtraFieldView, offsetExtraField);
      const size = getUint16(rawExtraFieldView, offsetExtraField + 2);
      extraField.set(type, {
        type,
        data: rawExtraField.slice(offsetExtraField + 4, offsetExtraField + 4 + size)
      });
      offsetExtraField += 4 + size;
    }
  } catch (_error) {
  }
  const compressionMethod = getUint16(dataView, offset + 4);
  directory.signature = getUint32(dataView, offset + 10);
  directory.uncompressedSize = getUint32(dataView, offset + 18);
  directory.compressedSize = getUint32(dataView, offset + 14);
  const extraFieldZip64 = extraField.get(EXTRAFIELD_TYPE_ZIP64);
  if (extraFieldZip64) {
    readExtraFieldZip64(extraFieldZip64, directory);
    directory.extraFieldZip64 = extraFieldZip64;
  }
  const extraFieldUnicodePath = extraField.get(EXTRAFIELD_TYPE_UNICODE_PATH);
  if (extraFieldUnicodePath) {
    await readExtraFieldUnicode(extraFieldUnicodePath, "filename", "rawFilename", directory, fileEntry);
    directory.extraFieldUnicodePath = extraFieldUnicodePath;
  }
  const extraFieldUnicodeComment = extraField.get(EXTRAFIELD_TYPE_UNICODE_COMMENT);
  if (extraFieldUnicodeComment) {
    await readExtraFieldUnicode(extraFieldUnicodeComment, "comment", "rawComment", directory, fileEntry);
    directory.extraFieldUnicodeComment = extraFieldUnicodeComment;
  }
  const extraFieldAES = extraField.get(EXTRAFIELD_TYPE_AES);
  if (extraFieldAES) {
    readExtraFieldAES(extraFieldAES, directory, compressionMethod);
    directory.extraFieldAES = extraFieldAES;
  } else {
    directory.compressionMethod = compressionMethod;
  }
  const extraFieldNTFS = extraField.get(EXTRAFIELD_TYPE_NTFS);
  if (extraFieldNTFS) {
    readExtraFieldNTFS(extraFieldNTFS, directory);
    directory.extraFieldNTFS = extraFieldNTFS;
  }
  const extraFieldExtendedTimestamp = extraField.get(EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP);
  if (extraFieldExtendedTimestamp) {
    readExtraFieldExtendedTimestamp(extraFieldExtendedTimestamp, directory);
    directory.extraFieldExtendedTimestamp = extraFieldExtendedTimestamp;
  }
}
function readExtraFieldZip64(extraFieldZip64, directory) {
  directory.zip64 = true;
  const extraFieldView = getDataView(extraFieldZip64.data);
  extraFieldZip64.values = [];
  for (let indexValue = 0; indexValue < Math.floor(extraFieldZip64.data.length / 8); indexValue++) {
    extraFieldZip64.values.push(getBigUint64(extraFieldView, 0 + indexValue * 8));
  }
  const missingProperties = ZIP64_PROPERTIES.filter((propertyName) => directory[propertyName] == MAX_32_BITS);
  for (let indexMissingProperty = 0; indexMissingProperty < missingProperties.length; indexMissingProperty++) {
    extraFieldZip64[missingProperties[indexMissingProperty]] = extraFieldZip64.values[indexMissingProperty];
  }
  ZIP64_PROPERTIES.forEach((propertyName) => {
    if (directory[propertyName] == MAX_32_BITS) {
      if (extraFieldZip64[propertyName] !== void 0) {
        directory[propertyName] = extraFieldZip64[propertyName];
      } else {
        throw new Error(ERR_EXTRAFIELD_ZIP64_NOT_FOUND);
      }
    }
  });
}
async function readExtraFieldUnicode(extraFieldUnicode, propertyName, rawPropertyName, directory, fileEntry) {
  const extraFieldView = getDataView(extraFieldUnicode.data);
  extraFieldUnicode.version = getUint8(extraFieldView, 0);
  extraFieldUnicode.signature = getUint32(extraFieldView, 1);
  const crc32 = new crc32_default();
  crc32.append(fileEntry[rawPropertyName]);
  const dataViewSignature = getDataView(new Uint8Array(4));
  dataViewSignature.setUint32(0, crc32.get(), true);
  extraFieldUnicode[propertyName] = await decode_text_default(extraFieldUnicode.data.subarray(5));
  extraFieldUnicode.valid = !fileEntry.bitFlag.languageEncodingFlag && extraFieldUnicode.signature == getUint32(dataViewSignature, 0);
  if (extraFieldUnicode.valid) {
    directory[propertyName] = extraFieldUnicode[propertyName];
    directory[propertyName + "UTF8"] = true;
  }
}
function readExtraFieldAES(extraFieldAES, directory, compressionMethod) {
  const extraFieldView = getDataView(extraFieldAES.data);
  extraFieldAES.vendorVersion = getUint8(extraFieldView, 0);
  extraFieldAES.vendorId = getUint8(extraFieldView, 2);
  const strength = getUint8(extraFieldView, 4);
  extraFieldAES.strength = strength;
  extraFieldAES.originalCompressionMethod = compressionMethod;
  directory.compressionMethod = extraFieldAES.compressionMethod = getUint16(extraFieldView, 5);
}
function readExtraFieldNTFS(extraFieldNTFS, directory) {
  const extraFieldView = getDataView(extraFieldNTFS.data);
  let offsetExtraField = 4;
  let tag1Data;
  try {
    while (offsetExtraField < extraFieldNTFS.data.length && !tag1Data) {
      const tagValue = getUint16(extraFieldView, offsetExtraField);
      const attributeSize = getUint16(extraFieldView, offsetExtraField + 2);
      if (tagValue == EXTRAFIELD_TYPE_NTFS_TAG1) {
        tag1Data = extraFieldNTFS.data.slice(offsetExtraField + 4, offsetExtraField + 4 + attributeSize);
      }
      offsetExtraField += 4 + attributeSize;
    }
  } catch (_error) {
  }
  try {
    if (tag1Data && tag1Data.length == 24) {
      const tag1View = getDataView(tag1Data);
      const rawLastModDate = tag1View.getBigUint64(0, true);
      const rawLastAccessDate = tag1View.getBigUint64(8, true);
      const rawCreationDate = tag1View.getBigUint64(16, true);
      Object.assign(extraFieldNTFS, {
        rawLastModDate,
        rawLastAccessDate,
        rawCreationDate
      });
      const lastModDate = getDateNTFS(rawLastModDate);
      const lastAccessDate = getDateNTFS(rawLastAccessDate);
      const creationDate = getDateNTFS(rawCreationDate);
      const extraFieldData = { lastModDate, lastAccessDate, creationDate };
      Object.assign(extraFieldNTFS, extraFieldData);
      Object.assign(directory, extraFieldData);
    }
  } catch (_error) {
  }
}
function readExtraFieldExtendedTimestamp(extraFieldExtendedTimestamp, directory) {
  const extraFieldView = getDataView(extraFieldExtendedTimestamp.data);
  const flags = getUint8(extraFieldView, 0);
  const timeProperties = [];
  const timeRawProperties = [];
  if ((flags & 1) == 1) {
    timeProperties.push("lastModDate");
    timeRawProperties.push("rawLastModDate");
  }
  if ((flags & 2) == 2) {
    timeProperties.push("lastAccessDate");
    timeRawProperties.push("rawLastAccessDate");
  }
  if ((flags & 4) == 4) {
    timeProperties.push("creationDate");
    timeRawProperties.push("rawCreationDate");
  }
  let offset = 1;
  timeProperties.forEach((propertyName, indexProperty) => {
    if (extraFieldExtendedTimestamp.data.length >= offset + 4) {
      const time = getUint32(extraFieldView, offset);
      directory[propertyName] = extraFieldExtendedTimestamp[propertyName] = new Date(time * 1e3);
      const rawPropertyName = timeRawProperties[indexProperty];
      extraFieldExtendedTimestamp[rawPropertyName] = time;
    }
    offset += 4;
  });
}
async function seekSignature(reader, signature, startOffset, minimumBytes, maximumLength) {
  const signatureArray = new Uint8Array(4);
  const signatureView = getDataView(signatureArray);
  setUint32(signatureView, 0, signature);
  const maximumBytes = minimumBytes + maximumLength;
  return await seek(minimumBytes) || await seek(Math.min(maximumBytes, startOffset));
  async function seek(length) {
    const offset = startOffset - length;
    const bytes = await readUint8Array(reader, offset, length);
    for (let indexByte = bytes.length - minimumBytes; indexByte >= 0; indexByte--) {
      if (bytes[indexByte] == signatureArray[0] && bytes[indexByte + 1] == signatureArray[1] && bytes[indexByte + 2] == signatureArray[2] && bytes[indexByte + 3] == signatureArray[3]) {
        return {
          offset: offset + indexByte,
          buffer: bytes.slice(indexByte, indexByte + minimumBytes).buffer
        };
      }
    }
  }
}
function getOptionValue(zipReader, options, name) {
  return options[name] === void 0 ? zipReader.options[name] : options[name];
}
function getDate(timeRaw) {
  const date = (timeRaw & 4294901760) >> 16, time = timeRaw & 65535;
  try {
    return new Date(1980 + ((date & 65024) >> 9), ((date & 480) >> 5) - 1, date & 31, (time & 63488) >> 11, (time & 2016) >> 5, (time & 31) * 2, 0);
  } catch (_error) {
  }
}
function getDateNTFS(timeRaw) {
  return new Date(Number(timeRaw / BigInt(1e4) - BigInt(116444736e5)));
}
function getUint8(view, offset) {
  return view.getUint8(offset);
}
function getUint16(view, offset) {
  return view.getUint16(offset, true);
}
function getUint32(view, offset) {
  return view.getUint32(offset, true);
}
function getBigUint64(view, offset) {
  return Number(view.getBigUint64(offset, true));
}
function setUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}
function getDataView(array) {
  return new DataView(array.buffer);
}
function readUint8Array(reader, offset, size) {
  return reader.readUint8Array(offset, size);
}

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/zip-writer.js
var EXTRAFIELD_DATA_AES = new Uint8Array([7, 0, 2, 0, 65, 69, 3, 0, 0]);

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/core/zip-fs-core.js
var CHUNK_SIZE = 512 * 1024;

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/lib/zip-fs.js
var import_meta = {};
var baseURL;
try {
  baseURL = import_meta.url;
} catch (_error) {
}
configure({ baseURL });
t(configure);

// ../../node_modules/.pnpm/@zip.js+zip.js@2.4.26/node_modules/@zip.js/zip.js/index.js
configure({ Deflate: deflate_default, Inflate: inflate_default });

// src/lib/functions/file-loaders/epub/types.ts
function isOPFType(contents) {
  return contents["opf:package"] !== void 0;
}

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/util.js
var nameStartChar = ":A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
var nameChar = nameStartChar + "\\-.\\d\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
var nameRegexp = "[" + nameStartChar + "][" + nameChar + "]*";
var regexName = new RegExp("^" + nameRegexp + "$");
function getAllMatches(string, regex) {
  const matches = [];
  let match = regex.exec(string);
  while (match) {
    const allmatches = [];
    allmatches.startIndex = regex.lastIndex - match[0].length;
    const len = match.length;
    for (let index = 0; index < len; index++) {
      allmatches.push(match[index]);
    }
    matches.push(allmatches);
    match = regex.exec(string);
  }
  return matches;
}
var isName = function(string) {
  const match = regexName.exec(string);
  return !(match === null || typeof match === "undefined");
};
function isExist(v) {
  return typeof v !== "undefined";
}
var DANGEROUS_PROPERTY_NAMES = [
  // '__proto__',
  // 'constructor',
  // 'prototype',
  "hasOwnProperty",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__"
];
var criticalProperties = ["__proto__", "constructor", "prototype"];

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/validator.js
var defaultOptions = {
  allowBooleanAttributes: false,
  //A tag can have attributes without any value
  unpairedTags: []
};
function validate(xmlData, options) {
  options = Object.assign({}, defaultOptions, options);
  const tags = [];
  let tagFound = false;
  let reachedRoot = false;
  if (xmlData[0] === "\uFEFF") {
    xmlData = xmlData.substr(1);
  }
  for (let i = 0; i < xmlData.length; i++) {
    if (xmlData[i] === "<" && xmlData[i + 1] === "?") {
      i += 2;
      i = readPI(xmlData, i);
      if (i.err) return i;
    } else if (xmlData[i] === "<") {
      let tagStartPos = i;
      i++;
      if (xmlData[i] === "!") {
        i = readCommentAndCDATA(xmlData, i);
        continue;
      } else {
        let closingTag = false;
        if (xmlData[i] === "/") {
          closingTag = true;
          i++;
        }
        let tagName = "";
        for (; i < xmlData.length && xmlData[i] !== ">" && xmlData[i] !== " " && xmlData[i] !== "	" && xmlData[i] !== "\n" && xmlData[i] !== "\r"; i++) {
          tagName += xmlData[i];
        }
        tagName = tagName.trim();
        if (tagName[tagName.length - 1] === "/") {
          tagName = tagName.substring(0, tagName.length - 1);
          i--;
        }
        if (!validateTagName(tagName)) {
          let msg;
          if (tagName.trim().length === 0) {
            msg = "Invalid space after '<'.";
          } else {
            msg = "Tag '" + tagName + "' is an invalid name.";
          }
          return getErrorObject("InvalidTag", msg, getLineNumberForPosition(xmlData, i));
        }
        const result = readAttributeStr(xmlData, i);
        if (result === false) {
          return getErrorObject("InvalidAttr", "Attributes for '" + tagName + "' have open quote.", getLineNumberForPosition(xmlData, i));
        }
        let attrStr = result.value;
        i = result.index;
        if (attrStr[attrStr.length - 1] === "/") {
          const attrStrStart = i - attrStr.length;
          attrStr = attrStr.substring(0, attrStr.length - 1);
          const isValid = validateAttributeString(attrStr, options);
          if (isValid === true) {
            tagFound = true;
          } else {
            return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, attrStrStart + isValid.err.line));
          }
        } else if (closingTag) {
          if (!result.tagClosed) {
            return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' doesn't have proper closing.", getLineNumberForPosition(xmlData, i));
          } else if (attrStr.trim().length > 0) {
            return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' can't have attributes or invalid starting.", getLineNumberForPosition(xmlData, tagStartPos));
          } else if (tags.length === 0) {
            return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' has not been opened.", getLineNumberForPosition(xmlData, tagStartPos));
          } else {
            const otg = tags.pop();
            if (tagName !== otg.tagName) {
              let openPos = getLineNumberForPosition(xmlData, otg.tagStartPos);
              return getErrorObject(
                "InvalidTag",
                "Expected closing tag '" + otg.tagName + "' (opened in line " + openPos.line + ", col " + openPos.col + ") instead of closing tag '" + tagName + "'.",
                getLineNumberForPosition(xmlData, tagStartPos)
              );
            }
            if (tags.length == 0) {
              reachedRoot = true;
            }
          }
        } else {
          const isValid = validateAttributeString(attrStr, options);
          if (isValid !== true) {
            return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, i - attrStr.length + isValid.err.line));
          }
          if (reachedRoot === true) {
            return getErrorObject("InvalidXml", "Multiple possible root nodes found.", getLineNumberForPosition(xmlData, i));
          } else if (options.unpairedTags.indexOf(tagName) !== -1) {
          } else {
            tags.push({ tagName, tagStartPos });
          }
          tagFound = true;
        }
        for (i++; i < xmlData.length; i++) {
          if (xmlData[i] === "<") {
            if (xmlData[i + 1] === "!") {
              i++;
              i = readCommentAndCDATA(xmlData, i);
              continue;
            } else if (xmlData[i + 1] === "?") {
              i = readPI(xmlData, ++i);
              if (i.err) return i;
            } else {
              break;
            }
          } else if (xmlData[i] === "&") {
            const afterAmp = validateAmpersand(xmlData, i);
            if (afterAmp == -1)
              return getErrorObject("InvalidChar", "char '&' is not expected.", getLineNumberForPosition(xmlData, i));
            i = afterAmp;
          } else {
            if (reachedRoot === true && !isWhiteSpace(xmlData[i])) {
              return getErrorObject("InvalidXml", "Extra text at the end", getLineNumberForPosition(xmlData, i));
            }
          }
        }
        if (xmlData[i] === "<") {
          i--;
        }
      }
    } else {
      if (isWhiteSpace(xmlData[i])) {
        continue;
      }
      return getErrorObject("InvalidChar", "char '" + xmlData[i] + "' is not expected.", getLineNumberForPosition(xmlData, i));
    }
  }
  if (!tagFound) {
    return getErrorObject("InvalidXml", "Start tag expected.", 1);
  } else if (tags.length == 1) {
    return getErrorObject("InvalidTag", "Unclosed tag '" + tags[0].tagName + "'.", getLineNumberForPosition(xmlData, tags[0].tagStartPos));
  } else if (tags.length > 0) {
    return getErrorObject("InvalidXml", "Invalid '" + JSON.stringify(tags.map((t2) => t2.tagName), null, 4).replace(/\r?\n/g, "") + "' found.", { line: 1, col: 1 });
  }
  return true;
}
function isWhiteSpace(char) {
  return char === " " || char === "	" || char === "\n" || char === "\r";
}
function readPI(xmlData, i) {
  const start = i;
  for (; i < xmlData.length; i++) {
    if (xmlData[i] == "?" || xmlData[i] == " ") {
      const tagname = xmlData.substr(start, i - start);
      if (i > 5 && tagname === "xml") {
        return getErrorObject("InvalidXml", "XML declaration allowed only at the start of the document.", getLineNumberForPosition(xmlData, i));
      } else if (xmlData[i] == "?" && xmlData[i + 1] == ">") {
        i++;
        break;
      } else {
        continue;
      }
    }
  }
  return i;
}
function readCommentAndCDATA(xmlData, i) {
  if (xmlData.length > i + 5 && xmlData[i + 1] === "-" && xmlData[i + 2] === "-") {
    for (i += 3; i < xmlData.length; i++) {
      if (xmlData[i] === "-" && xmlData[i + 1] === "-" && xmlData[i + 2] === ">") {
        i += 2;
        break;
      }
    }
  } else if (xmlData.length > i + 8 && xmlData[i + 1] === "D" && xmlData[i + 2] === "O" && xmlData[i + 3] === "C" && xmlData[i + 4] === "T" && xmlData[i + 5] === "Y" && xmlData[i + 6] === "P" && xmlData[i + 7] === "E") {
    let angleBracketsCount = 1;
    for (i += 8; i < xmlData.length; i++) {
      if (xmlData[i] === "<") {
        angleBracketsCount++;
      } else if (xmlData[i] === ">") {
        angleBracketsCount--;
        if (angleBracketsCount === 0) {
          break;
        }
      }
    }
  } else if (xmlData.length > i + 9 && xmlData[i + 1] === "[" && xmlData[i + 2] === "C" && xmlData[i + 3] === "D" && xmlData[i + 4] === "A" && xmlData[i + 5] === "T" && xmlData[i + 6] === "A" && xmlData[i + 7] === "[") {
    for (i += 8; i < xmlData.length; i++) {
      if (xmlData[i] === "]" && xmlData[i + 1] === "]" && xmlData[i + 2] === ">") {
        i += 2;
        break;
      }
    }
  }
  return i;
}
var doubleQuote = '"';
var singleQuote = "'";
function readAttributeStr(xmlData, i) {
  let attrStr = "";
  let startChar = "";
  let tagClosed = false;
  for (; i < xmlData.length; i++) {
    if (xmlData[i] === doubleQuote || xmlData[i] === singleQuote) {
      if (startChar === "") {
        startChar = xmlData[i];
      } else if (startChar !== xmlData[i]) {
      } else {
        startChar = "";
      }
    } else if (xmlData[i] === ">") {
      if (startChar === "") {
        tagClosed = true;
        break;
      }
    }
    attrStr += xmlData[i];
  }
  if (startChar !== "") {
    return false;
  }
  return {
    value: attrStr,
    index: i,
    tagClosed
  };
}
var validAttrStrRegxp = new RegExp(`(\\s*)([^\\s=]+)(\\s*=)?(\\s*(['"])(([\\s\\S])*?)\\5)?`, "g");
function validateAttributeString(attrStr, options) {
  const matches = getAllMatches(attrStr, validAttrStrRegxp);
  const attrNames = {};
  for (let i = 0; i < matches.length; i++) {
    if (matches[i][1].length === 0) {
      return getErrorObject("InvalidAttr", "Attribute '" + matches[i][2] + "' has no space in starting.", getPositionFromMatch(matches[i]));
    } else if (matches[i][3] !== void 0 && matches[i][4] === void 0) {
      return getErrorObject("InvalidAttr", "Attribute '" + matches[i][2] + "' is without value.", getPositionFromMatch(matches[i]));
    } else if (matches[i][3] === void 0 && !options.allowBooleanAttributes) {
      return getErrorObject("InvalidAttr", "boolean attribute '" + matches[i][2] + "' is not allowed.", getPositionFromMatch(matches[i]));
    }
    const attrName = matches[i][2];
    if (!validateAttrName(attrName)) {
      return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is an invalid name.", getPositionFromMatch(matches[i]));
    }
    if (!Object.prototype.hasOwnProperty.call(attrNames, attrName)) {
      attrNames[attrName] = 1;
    } else {
      return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is repeated.", getPositionFromMatch(matches[i]));
    }
  }
  return true;
}
function validateNumberAmpersand(xmlData, i) {
  let re = /\d/;
  if (xmlData[i] === "x") {
    i++;
    re = /[\da-fA-F]/;
  }
  for (; i < xmlData.length; i++) {
    if (xmlData[i] === ";")
      return i;
    if (!xmlData[i].match(re))
      break;
  }
  return -1;
}
function validateAmpersand(xmlData, i) {
  i++;
  if (xmlData[i] === ";")
    return -1;
  if (xmlData[i] === "#") {
    i++;
    return validateNumberAmpersand(xmlData, i);
  }
  let count = 0;
  for (; i < xmlData.length; i++, count++) {
    if (xmlData[i].match(/\w/) && count < 20)
      continue;
    if (xmlData[i] === ";")
      break;
    return -1;
  }
  return i;
}
function getErrorObject(code, message, lineNumber) {
  return {
    err: {
      code,
      msg: message,
      line: lineNumber.line || lineNumber,
      col: lineNumber.col
    }
  };
}
function validateAttrName(attrName) {
  return isName(attrName);
}
function validateTagName(tagname) {
  return isName(tagname);
}
function getLineNumberForPosition(xmlData, index) {
  const lines = xmlData.substring(0, index).split(/\r?\n/);
  return {
    line: lines.length,
    // column number is last line's length + 1, because column numbering starts at 1:
    col: lines[lines.length - 1].length + 1
  };
}
function getPositionFromMatch(match) {
  return match.startIndex + match[1].length;
}

// ../../node_modules/.pnpm/@nodable+entities@2.1.0/node_modules/@nodable/entities/src/entities.js
var BASIC_LATIN = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  lsquor: "‚",
  rsquor: "’",
  ldquor: "„",
  bdquo: "„",
  comma: ",",
  period: ".",
  colon: ":",
  semi: ";",
  excl: "!",
  quest: "?",
  num: "#",
  dollar: "$",
  percent: "%",
  amp: "&",
  ast: "*",
  commat: "@",
  lowbar: "_",
  verbar: "|",
  vert: "|",
  sol: "/",
  bsol: "\\",
  lbrace: "{",
  rbrace: "}",
  lbrack: "[",
  rbrack: "]",
  lpar: "(",
  rpar: ")",
  nbsp: " ",
  iexcl: "¡",
  cent: "¢",
  pound: "£",
  curren: "¤",
  yen: "¥",
  brvbar: "¦",
  sect: "§",
  uml: "¨",
  copy: "©",
  COPY: "©",
  ordf: "ª",
  laquo: "«",
  not: "¬",
  shy: "­",
  reg: "®",
  REG: "®",
  macr: "¯",
  deg: "°",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  acute: "´",
  micro: "µ",
  para: "¶",
  middot: "·",
  cedil: "¸",
  sup1: "¹",
  ordm: "º",
  raquo: "»",
  frac14: "¼",
  frac12: "½",
  half: "½",
  frac34: "¾",
  iquest: "¿",
  times: "×",
  div: "÷",
  divide: "÷"
};
var LATIN_ACCENTS = {
  Agrave: "À",
  agrave: "à",
  Aacute: "Á",
  aacute: "á",
  Acirc: "Â",
  acirc: "â",
  Atilde: "Ã",
  atilde: "ã",
  Auml: "Ä",
  auml: "ä",
  Aring: "Å",
  aring: "å",
  AElig: "Æ",
  aelig: "æ",
  Ccedil: "Ç",
  ccedil: "ç",
  Egrave: "È",
  egrave: "è",
  Eacute: "É",
  eacute: "é",
  Ecirc: "Ê",
  ecirc: "ê",
  Euml: "Ë",
  euml: "ë",
  Igrave: "Ì",
  igrave: "ì",
  Iacute: "Í",
  iacute: "í",
  Icirc: "Î",
  icirc: "î",
  Iuml: "Ï",
  iuml: "ï",
  ETH: "Ð",
  eth: "ð",
  Ntilde: "Ñ",
  ntilde: "ñ",
  Ograve: "Ò",
  ograve: "ò",
  Oacute: "Ó",
  oacute: "ó",
  Ocirc: "Ô",
  ocirc: "ô",
  Otilde: "Õ",
  otilde: "õ",
  Ouml: "Ö",
  ouml: "ö",
  Oslash: "Ø",
  oslash: "ø",
  Ugrave: "Ù",
  ugrave: "ù",
  Uacute: "Ú",
  uacute: "ú",
  Ucirc: "Û",
  ucirc: "û",
  Uuml: "Ü",
  uuml: "ü",
  Yacute: "Ý",
  yacute: "ý",
  THORN: "Þ",
  thorn: "þ",
  szlig: "ß",
  yuml: "ÿ",
  Yuml: "Ÿ"
};
var LATIN_EXTENDED = {
  Amacr: "Ā",
  amacr: "ā",
  Abreve: "Ă",
  abreve: "ă",
  Aogon: "Ą",
  aogon: "ą",
  Cacute: "Ć",
  cacute: "ć",
  Ccirc: "Ĉ",
  ccirc: "ĉ",
  Cdot: "Ċ",
  cdot: "ċ",
  Ccaron: "Č",
  ccaron: "č",
  Dcaron: "Ď",
  dcaron: "ď",
  Dstrok: "Đ",
  dstrok: "đ",
  Emacr: "Ē",
  emacr: "ē",
  Ecaron: "Ě",
  ecaron: "ě",
  Edot: "Ė",
  edot: "ė",
  Eogon: "Ę",
  eogon: "ę",
  Gcirc: "Ĝ",
  gcirc: "ĝ",
  Gbreve: "Ğ",
  gbreve: "ğ",
  Gdot: "Ġ",
  gdot: "ġ",
  Gcedil: "Ģ",
  Hcirc: "Ĥ",
  hcirc: "ĥ",
  Hstrok: "Ħ",
  hstrok: "ħ",
  Itilde: "Ĩ",
  itilde: "ĩ",
  Imacr: "Ī",
  imacr: "ī",
  Iogon: "Į",
  iogon: "į",
  Idot: "İ",
  IJlig: "Ĳ",
  ijlig: "ĳ",
  Jcirc: "Ĵ",
  jcirc: "ĵ",
  Kcedil: "Ķ",
  kcedil: "ķ",
  kgreen: "ĸ",
  Lacute: "Ĺ",
  lacute: "ĺ",
  Lcedil: "Ļ",
  lcedil: "ļ",
  Lcaron: "Ľ",
  lcaron: "ľ",
  Lmidot: "Ŀ",
  lmidot: "ŀ",
  Lstrok: "Ł",
  lstrok: "ł",
  Nacute: "Ń",
  nacute: "ń",
  Ncaron: "Ň",
  ncaron: "ň",
  Ncedil: "Ņ",
  ncedil: "ņ",
  ENG: "Ŋ",
  eng: "ŋ",
  Omacr: "Ō",
  omacr: "ō",
  Odblac: "Ő",
  odblac: "ő",
  OElig: "Œ",
  oelig: "œ",
  Racute: "Ŕ",
  racute: "ŕ",
  Rcaron: "Ř",
  rcaron: "ř",
  Rcedil: "Ŗ",
  rcedil: "ŗ",
  Sacute: "Ś",
  sacute: "ś",
  Scirc: "Ŝ",
  scirc: "ŝ",
  Scedil: "Ş",
  scedil: "ş",
  Scaron: "Š",
  scaron: "š",
  Tcedil: "Ţ",
  tcedil: "ţ",
  Tcaron: "Ť",
  tcaron: "ť",
  Tstrok: "Ŧ",
  tstrok: "ŧ",
  Utilde: "Ũ",
  utilde: "ũ",
  Umacr: "Ū",
  umacr: "ū",
  Ubreve: "Ŭ",
  ubreve: "ŭ",
  Uring: "Ů",
  uring: "ů",
  Udblac: "Ű",
  udblac: "ű",
  Uogon: "Ų",
  uogon: "ų",
  Wcirc: "Ŵ",
  wcirc: "ŵ",
  Ycirc: "Ŷ",
  ycirc: "ŷ",
  Zacute: "Ź",
  zacute: "ź",
  Zdot: "Ż",
  zdot: "ż",
  Zcaron: "Ž",
  zcaron: "ž"
};
var GREEK = {
  Alpha: "Α",
  alpha: "α",
  Beta: "Β",
  beta: "β",
  Gamma: "Γ",
  gamma: "γ",
  Delta: "Δ",
  delta: "δ",
  Epsilon: "Ε",
  epsilon: "ε",
  epsiv: "ϵ",
  varepsilon: "ϵ",
  Zeta: "Ζ",
  zeta: "ζ",
  Eta: "Η",
  eta: "η",
  Theta: "Θ",
  theta: "θ",
  thetasym: "ϑ",
  vartheta: "ϑ",
  Iota: "Ι",
  iota: "ι",
  Kappa: "Κ",
  kappa: "κ",
  kappav: "ϰ",
  varkappa: "ϰ",
  Lambda: "Λ",
  lambda: "λ",
  Mu: "Μ",
  mu: "μ",
  Nu: "Ν",
  nu: "ν",
  Xi: "Ξ",
  xi: "ξ",
  Omicron: "Ο",
  omicron: "ο",
  Pi: "Π",
  pi: "π",
  piv: "ϖ",
  varpi: "ϖ",
  Rho: "Ρ",
  rho: "ρ",
  rhov: "ϱ",
  varrho: "ϱ",
  Sigma: "Σ",
  sigma: "σ",
  sigmaf: "ς",
  sigmav: "ς",
  varsigma: "ς",
  Tau: "Τ",
  tau: "τ",
  Upsilon: "Υ",
  upsilon: "υ",
  upsi: "υ",
  Upsi: "ϒ",
  upsih: "ϒ",
  Phi: "Φ",
  phi: "φ",
  phiv: "ϕ",
  varphi: "ϕ",
  Chi: "Χ",
  chi: "χ",
  Psi: "Ψ",
  psi: "ψ",
  Omega: "Ω",
  omega: "ω",
  ohm: "Ω",
  Gammad: "Ϝ",
  gammad: "ϝ",
  digamma: "ϝ"
};
var CYRILLIC = {
  Afr: "𝔄",
  afr: "𝔞",
  Acy: "А",
  acy: "а",
  Bcy: "Б",
  bcy: "б",
  Vcy: "В",
  vcy: "в",
  Gcy: "Г",
  gcy: "г",
  Dcy: "Д",
  dcy: "д",
  IEcy: "Е",
  iecy: "е",
  IOcy: "Ё",
  iocy: "ё",
  ZHcy: "Ж",
  zhcy: "ж",
  Zcy: "З",
  zcy: "з",
  Icy: "И",
  icy: "и",
  Jcy: "Й",
  jcy: "й",
  Kcy: "К",
  kcy: "к",
  Lcy: "Л",
  lcy: "л",
  Mcy: "М",
  mcy: "м",
  Ncy: "Н",
  ncy: "н",
  Ocy: "О",
  ocy: "о",
  Pcy: "П",
  pcy: "п",
  Rcy: "Р",
  rcy: "р",
  Scy: "С",
  scy: "с",
  Tcy: "Т",
  tcy: "т",
  Ucy: "У",
  ucy: "у",
  Fcy: "Ф",
  fcy: "ф",
  KHcy: "Х",
  khcy: "х",
  TScy: "Ц",
  tscy: "ц",
  CHcy: "Ч",
  chcy: "ч",
  SHcy: "Ш",
  shcy: "ш",
  SHCHcy: "Щ",
  shchcy: "щ",
  HARDcy: "Ъ",
  hardcy: "ъ",
  Ycy: "Ы",
  ycy: "ы",
  SOFTcy: "Ь",
  softcy: "ь",
  Ecy: "Э",
  ecy: "э",
  YUcy: "Ю",
  yucy: "ю",
  YAcy: "Я",
  yacy: "я",
  DJcy: "Ђ",
  djcy: "ђ",
  GJcy: "Ѓ",
  gjcy: "ѓ",
  Jukcy: "Є",
  jukcy: "є",
  DScy: "Ѕ",
  dscy: "ѕ",
  Iukcy: "І",
  iukcy: "і",
  YIcy: "Ї",
  yicy: "ї",
  Jsercy: "Ј",
  jsercy: "ј",
  LJcy: "Љ",
  ljcy: "љ",
  NJcy: "Њ",
  njcy: "њ",
  TSHcy: "Ћ",
  tshcy: "ћ",
  KJcy: "Ќ",
  kjcy: "ќ",
  Ubrcy: "Ў",
  ubrcy: "ў",
  DZcy: "Џ",
  dzcy: "џ"
};
var MATH = {
  plus: "+",
  minus: "−",
  mnplus: "∓",
  mp: "∓",
  pm: "±",
  times: "×",
  div: "÷",
  divide: "÷",
  sdot: "⋅",
  star: "☆",
  starf: "★",
  bigstar: "★",
  lowast: "∗",
  ast: "*",
  midast: "*",
  compfn: "∘",
  smallcircle: "∘",
  bullet: "•",
  bull: "•",
  nbsp: " ",
  hellip: "…",
  mldr: "…",
  prime: "′",
  Prime: "″",
  tprime: "‴",
  bprime: "‵",
  backprime: "‵",
  minus: "−",
  minusd: "∸",
  dotminus: "∸",
  plusdo: "∔",
  dotplus: "∔",
  plusmn: "±",
  minusplus: "∓",
  mnplus: "∓",
  mp: "∓",
  setminus: "∖",
  smallsetminus: "∖",
  Backslash: "∖",
  setmn: "∖",
  ssetmn: "∖",
  lowbar: "_",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  colon: ":",
  Colon: "∷",
  Proportion: "∷",
  ratio: "∶",
  equals: "=",
  ne: "≠",
  nequiv: "≢",
  equiv: "≡",
  Congruent: "≡",
  sim: "∼",
  thicksim: "∼",
  thksim: "∼",
  sime: "≃",
  simeq: "≃",
  TildeEqual: "≃",
  asymp: "≈",
  approx: "≈",
  thickapprox: "≈",
  thkap: "≈",
  TildeTilde: "≈",
  ncong: "≇",
  cong: "≅",
  TildeFullEqual: "≅",
  asympeq: "≍",
  CupCap: "≍",
  bump: "≎",
  Bumpeq: "≎",
  HumpDownHump: "≎",
  bumpe: "≏",
  bumpeq: "≏",
  HumpEqual: "≏",
  dotminus: "∸",
  minusd: "∸",
  plusdo: "∔",
  dotplus: "∔",
  le: "≤",
  LessEqual: "≤",
  ge: "≥",
  GreaterEqual: "≥",
  lesseqgtr: "⋚",
  lesseqqgtr: "⪋",
  greater: ">",
  less: "<"
};
var MATH_ADVANCED = {
  alefsym: "ℵ",
  aleph: "ℵ",
  beth: "ℶ",
  gimel: "ℷ",
  daleth: "ℸ",
  forall: "∀",
  ForAll: "∀",
  part: "∂",
  PartialD: "∂",
  exist: "∃",
  Exists: "∃",
  nexist: "∄",
  nexists: "∄",
  empty: "∅",
  emptyset: "∅",
  emptyv: "∅",
  varnothing: "∅",
  nabla: "∇",
  Del: "∇",
  isin: "∈",
  isinv: "∈",
  in: "∈",
  Element: "∈",
  notin: "∉",
  notinva: "∉",
  ni: "∋",
  niv: "∋",
  SuchThat: "∋",
  ReverseElement: "∋",
  notni: "∌",
  notniva: "∌",
  prod: "∏",
  Product: "∏",
  coprod: "∐",
  Coproduct: "∐",
  sum: "∑",
  Sum: "∑",
  minus: "−",
  mp: "∓",
  plusdo: "∔",
  dotplus: "∔",
  setminus: "∖",
  lowast: "∗",
  radic: "√",
  Sqrt: "√",
  prop: "∝",
  propto: "∝",
  Proportional: "∝",
  varpropto: "∝",
  infin: "∞",
  infintie: "⧝",
  ang: "∠",
  angle: "∠",
  angmsd: "∡",
  measuredangle: "∡",
  angsph: "∢",
  mid: "∣",
  VerticalBar: "∣",
  nmid: "∤",
  nsmid: "∤",
  npar: "∦",
  parallel: "∥",
  spar: "∥",
  nparallel: "∦",
  nspar: "∦",
  and: "∧",
  wedge: "∧",
  or: "∨",
  vee: "∨",
  cap: "∩",
  cup: "∪",
  int: "∫",
  Integral: "∫",
  conint: "∮",
  ContourIntegral: "∮",
  Conint: "∯",
  DoubleContourIntegral: "∯",
  Cconint: "∰",
  there4: "∴",
  therefore: "∴",
  Therefore: "∴",
  becaus: "∵",
  because: "∵",
  Because: "∵",
  ratio: "∶",
  Proportion: "∷",
  minusd: "∸",
  dotminus: "∸",
  mDDot: "∺",
  homtht: "∻",
  sim: "∼",
  bsimg: "∽",
  backsim: "∽",
  ac: "∾",
  mstpos: "∾",
  acd: "∿",
  VerticalTilde: "≀",
  wr: "≀",
  wreath: "≀",
  nsime: "≄",
  nsimeq: "≄",
  nsimeq: "≄",
  ncong: "≇",
  simne: "≆",
  ncongdot: "⩭̸",
  ngsim: "≵",
  nsim: "≁",
  napprox: "≉",
  nap: "≉",
  ngeq: "≱",
  nge: "≱",
  nleq: "≰",
  nle: "≰",
  ngtr: "≯",
  ngt: "≯",
  nless: "≮",
  nlt: "≮",
  nprec: "⊀",
  npr: "⊀",
  nsucc: "⊁",
  nsc: "⊁"
};
var ARROWS = {
  larr: "←",
  leftarrow: "←",
  LeftArrow: "←",
  uarr: "↑",
  uparrow: "↑",
  UpArrow: "↑",
  rarr: "→",
  rightarrow: "→",
  RightArrow: "→",
  darr: "↓",
  downarrow: "↓",
  DownArrow: "↓",
  harr: "↔",
  leftrightarrow: "↔",
  LeftRightArrow: "↔",
  varr: "↕",
  updownarrow: "↕",
  UpDownArrow: "↕",
  nwarr: "↖",
  nwarrow: "↖",
  UpperLeftArrow: "↖",
  nearr: "↗",
  nearrow: "↗",
  UpperRightArrow: "↗",
  searr: "↘",
  searrow: "↘",
  LowerRightArrow: "↘",
  swarr: "↙",
  swarrow: "↙",
  LowerLeftArrow: "↙",
  lArr: "⇐",
  Leftarrow: "⇐",
  uArr: "⇑",
  Uparrow: "⇑",
  rArr: "⇒",
  Rightarrow: "⇒",
  dArr: "⇓",
  Downarrow: "⇓",
  hArr: "⇔",
  Leftrightarrow: "⇔",
  iff: "⇔",
  vArr: "⇕",
  Updownarrow: "⇕",
  lAarr: "⇚",
  Lleftarrow: "⇚",
  rAarr: "⇛",
  Rrightarrow: "⇛",
  lrarr: "⇆",
  leftrightarrows: "⇆",
  rlarr: "⇄",
  rightleftarrows: "⇄",
  lrhar: "⇋",
  leftrightharpoons: "⇋",
  ReverseEquilibrium: "⇋",
  rlhar: "⇌",
  rightleftharpoons: "⇌",
  Equilibrium: "⇌",
  udarr: "⇅",
  UpArrowDownArrow: "⇅",
  duarr: "⇵",
  DownArrowUpArrow: "⇵",
  llarr: "⇇",
  leftleftarrows: "⇇",
  rrarr: "⇉",
  rightrightarrows: "⇉",
  ddarr: "⇊",
  downdownarrows: "⇊",
  har: "↽",
  lhard: "↽",
  leftharpoondown: "↽",
  lharu: "↼",
  leftharpoonup: "↼",
  rhard: "⇁",
  rightharpoondown: "⇁",
  rharu: "⇀",
  rightharpoonup: "⇀",
  lsh: "↰",
  Lsh: "↰",
  rsh: "↱",
  Rsh: "↱",
  ldsh: "↲",
  rdsh: "↳",
  hookleftarrow: "↩",
  hookrightarrow: "↪",
  mapstoleft: "↤",
  mapstoup: "↥",
  map: "↦",
  mapsto: "↦",
  mapstodown: "↧",
  crarr: "↵",
  nwarrow: "↖",
  nearrow: "↗",
  searrow: "↘",
  swarrow: "↙",
  nleftarrow: "↚",
  nleftrightarrow: "↮",
  nrightarrow: "↛",
  nrarr: "↛",
  larrtl: "↢",
  rarrtl: "↣",
  leftarrowtail: "↢",
  rightarrowtail: "↣",
  twoheadleftarrow: "↞",
  twoheadrightarrow: "↠",
  Larr: "↞",
  Rarr: "↠",
  larrhk: "↩",
  rarrhk: "↪",
  larrlp: "↫",
  looparrowleft: "↫",
  rarrlp: "↬",
  looparrowright: "↬",
  harrw: "↭",
  leftrightsquigarrow: "↭",
  nrarrw: "↝̸",
  rarrw: "↝",
  rightsquigarrow: "↝",
  larrbfs: "⤟",
  rarrbfs: "⤠",
  nvHarr: "⤄",
  nvlArr: "⤂",
  nvrArr: "⤃",
  larrfs: "⤝",
  rarrfs: "⤞",
  Map: "⤅",
  larrsim: "⥳",
  rarrsim: "⥴",
  harrcir: "⥈",
  Uarrocir: "⥉",
  lurdshar: "⥊",
  ldrdhar: "⥧",
  ldrushar: "⥋",
  rdldhar: "⥩",
  lrhard: "⥭",
  rlhar: "⇌",
  uharr: "↾",
  uharl: "↿",
  dharr: "⇂",
  dharl: "⇃",
  Uarr: "↟",
  Darr: "↡",
  zigrarr: "⇝",
  nwArr: "⇖",
  neArr: "⇗",
  seArr: "⇘",
  swArr: "⇙",
  nharr: "↮",
  nhArr: "⇎",
  nlarr: "↚",
  nlArr: "⇍",
  nrarr: "↛",
  nrArr: "⇏",
  larrb: "⇤",
  LeftArrowBar: "⇤",
  rarrb: "⇥",
  RightArrowBar: "⇥"
};
var SHAPES = {
  square: "□",
  Square: "□",
  squ: "□",
  squf: "▪",
  squarf: "▪",
  blacksquar: "▪",
  blacksquare: "▪",
  FilledVerySmallSquare: "▪",
  blk34: "▓",
  blk12: "▒",
  blk14: "░",
  block: "█",
  srect: "▭",
  rect: "▭",
  sdot: "⋅",
  sdotb: "⊡",
  dotsquare: "⊡",
  triangle: "▵",
  tri: "▵",
  trine: "▵",
  utri: "▵",
  triangledown: "▿",
  dtri: "▿",
  tridown: "▿",
  triangleleft: "◃",
  ltri: "◃",
  triangleright: "▹",
  rtri: "▹",
  blacktriangle: "▴",
  utrif: "▴",
  blacktriangledown: "▾",
  dtrif: "▾",
  blacktriangleleft: "◂",
  ltrif: "◂",
  blacktriangleright: "▸",
  rtrif: "▸",
  loz: "◊",
  lozenge: "◊",
  blacklozenge: "⧫",
  lozf: "⧫",
  bigcirc: "◯",
  xcirc: "◯",
  circ: "ˆ",
  Circle: "○",
  cir: "○",
  o: "○",
  bullet: "•",
  bull: "•",
  hellip: "…",
  mldr: "…",
  nldr: "‥",
  boxh: "─",
  HorizontalLine: "─",
  boxv: "│",
  boxdr: "┌",
  boxdl: "┐",
  boxur: "└",
  boxul: "┘",
  boxvr: "├",
  boxvl: "┤",
  boxhd: "┬",
  boxhu: "┴",
  boxvh: "┼",
  boxH: "═",
  boxV: "║",
  boxdR: "╒",
  boxDr: "╓",
  boxDR: "╔",
  boxDl: "╕",
  boxdL: "╖",
  boxDL: "╗",
  boxuR: "╘",
  boxUr: "╙",
  boxUR: "╚",
  boxUl: "╜",
  boxuL: "╛",
  boxUL: "╝",
  boxvR: "╞",
  boxVr: "╟",
  boxVR: "╠",
  boxVl: "╢",
  boxvL: "╡",
  boxVL: "╣",
  boxHd: "╤",
  boxhD: "╥",
  boxHD: "╦",
  boxHu: "╧",
  boxhU: "╨",
  boxHU: "╩",
  boxvH: "╪",
  boxVh: "╫",
  boxVH: "╬"
};
var PUNCTUATION = {
  excl: "!",
  iexcl: "¡",
  brvbar: "¦",
  sect: "§",
  uml: "¨",
  copy: "©",
  ordf: "ª",
  laquo: "«",
  not: "¬",
  shy: "­",
  reg: "®",
  macr: "¯",
  deg: "°",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  acute: "´",
  micro: "µ",
  para: "¶",
  middot: "·",
  cedil: "¸",
  sup1: "¹",
  ordm: "º",
  raquo: "»",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  iquest: "¿",
  nbsp: " ",
  comma: ",",
  period: ".",
  colon: ":",
  semi: ";",
  vert: "|",
  Verbar: "‖",
  verbar: "|",
  dblac: "˝",
  circ: "ˆ",
  caron: "ˇ",
  breve: "˘",
  dot: "˙",
  ring: "˚",
  ogon: "˛",
  tilde: "˜",
  DiacriticalGrave: "`",
  DiacriticalAcute: "´",
  DiacriticalTilde: "˜",
  DiacriticalDot: "˙",
  DiacriticalDoubleAcute: "˝",
  grave: "`",
  acute: "´"
};
var CURRENCY = {
  cent: "¢",
  pound: "£",
  curren: "¤",
  yen: "¥",
  euro: "€",
  dollar: "$",
  euro: "€",
  fnof: "ƒ",
  inr: "₹",
  af: "؋",
  birr: "ብር",
  peso: "₱",
  rub: "₽",
  won: "₩",
  yuan: "¥",
  cedil: "¸"
};
var FRACTIONS = {
  frac12: "½",
  half: "½",
  frac13: "⅓",
  frac14: "¼",
  frac15: "⅕",
  frac16: "⅙",
  frac18: "⅛",
  frac23: "⅔",
  frac25: "⅖",
  frac34: "¾",
  frac35: "⅗",
  frac38: "⅜",
  frac45: "⅘",
  frac56: "⅚",
  frac58: "⅝",
  frac78: "⅞",
  frasl: "⁄"
};
var MISC_SYMBOLS = {
  trade: "™",
  TRADE: "™",
  telrec: "⌕",
  target: "⌖",
  ulcorn: "⌜",
  ulcorner: "⌜",
  urcorn: "⌝",
  urcorner: "⌝",
  dlcorn: "⌞",
  llcorner: "⌞",
  drcorn: "⌟",
  lrcorner: "⌟",
  intercal: "⊺",
  intcal: "⊺",
  oplus: "⊕",
  CirclePlus: "⊕",
  ominus: "⊖",
  CircleMinus: "⊖",
  otimes: "⊗",
  CircleTimes: "⊗",
  osol: "⊘",
  odot: "⊙",
  CircleDot: "⊙",
  oast: "⊛",
  circledast: "⊛",
  odash: "⊝",
  circleddash: "⊝",
  ocirc: "⊚",
  circledcirc: "⊚",
  boxplus: "⊞",
  plusb: "⊞",
  boxminus: "⊟",
  minusb: "⊟",
  boxtimes: "⊠",
  timesb: "⊠",
  boxdot: "⊡",
  sdotb: "⊡",
  veebar: "⊻",
  vee: "∨",
  barvee: "⊽",
  and: "∧",
  wedge: "∧",
  Cap: "⋒",
  Cup: "⋓",
  Fork: "⋔",
  pitchfork: "⋔",
  epar: "⋕",
  ltlarr: "⥶",
  nvap: "≍⃒",
  nvsim: "∼⃒",
  nvge: "≥⃒",
  nvle: "≤⃒",
  nvlt: "<⃒",
  nvgt: ">⃒",
  nvltrie: "⊴⃒",
  nvrtrie: "⊵⃒",
  Vdash: "⊩",
  dashv: "⊣",
  vDash: "⊨",
  Vdash: "⊩",
  Vvdash: "⊪",
  nvdash: "⊬",
  nvDash: "⊭",
  nVdash: "⊮",
  nVDash: "⊯"
};
var ALL_ENTITIES = {
  ...BASIC_LATIN,
  ...LATIN_ACCENTS,
  ...LATIN_EXTENDED,
  ...GREEK,
  ...CYRILLIC,
  ...MATH,
  ...MATH_ADVANCED,
  ...ARROWS,
  ...SHAPES,
  ...PUNCTUATION,
  ...CURRENCY,
  ...FRACTIONS,
  ...MISC_SYMBOLS
};
var XML = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"'
};
var COMMON_HTML = {
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  para: "¶",
  sect: "§",
  deg: "°",
  frac12: "½",
  frac14: "¼",
  frac34: "¾"
};

// ../../node_modules/.pnpm/@nodable+entities@2.1.0/node_modules/@nodable/entities/src/EntityDecoder.js
var SPECIAL_CHARS = new Set("!?\\\\/[]$%{}^&*()<>|+");
function validateEntityName(name) {
  if (name[0] === "#") {
    throw new Error(`[EntityReplacer] Invalid character '#' in entity name: "${name}"`);
  }
  for (const ch of name) {
    if (SPECIAL_CHARS.has(ch)) {
      throw new Error(`[EntityReplacer] Invalid character '${ch}' in entity name: "${name}"`);
    }
  }
  return name;
}
function mergeEntityMaps(...maps) {
  const out = /* @__PURE__ */ Object.create(null);
  for (const map of maps) {
    if (!map) continue;
    for (const key of Object.keys(map)) {
      const raw = map[key];
      if (typeof raw === "string") {
        out[key] = raw;
      } else if (raw && typeof raw === "object" && raw.val !== void 0) {
        const val = raw.val;
        if (typeof val === "string") {
          out[key] = val;
        }
      }
    }
  }
  return out;
}
var LIMIT_TIER_EXTERNAL = "external";
var LIMIT_TIER_BASE = "base";
var LIMIT_TIER_ALL = "all";
function parseLimitTiers(raw) {
  if (!raw || raw === LIMIT_TIER_EXTERNAL) return /* @__PURE__ */ new Set([LIMIT_TIER_EXTERNAL]);
  if (raw === LIMIT_TIER_ALL) return /* @__PURE__ */ new Set([LIMIT_TIER_ALL]);
  if (raw === LIMIT_TIER_BASE) return /* @__PURE__ */ new Set([LIMIT_TIER_BASE]);
  if (Array.isArray(raw)) return new Set(raw);
  return /* @__PURE__ */ new Set([LIMIT_TIER_EXTERNAL]);
}
var NCR_LEVEL = Object.freeze({ allow: 0, leave: 1, remove: 2, throw: 3 });
var XML10_ALLOWED_C0 = /* @__PURE__ */ new Set([9, 10, 13]);
function parseNCRConfig(ncr) {
  if (!ncr) {
    return { xmlVersion: 1, onLevel: NCR_LEVEL.allow, nullLevel: NCR_LEVEL.remove };
  }
  const xmlVersion = ncr.xmlVersion === 1.1 ? 1.1 : 1;
  const onLevel = NCR_LEVEL[ncr.onNCR] ?? NCR_LEVEL.allow;
  const nullLevel = NCR_LEVEL[ncr.nullNCR] ?? NCR_LEVEL.remove;
  const clampedNull = Math.max(nullLevel, NCR_LEVEL.remove);
  return { xmlVersion, onLevel, nullLevel: clampedNull };
}
var EntityDecoder = class {
  /**
   * @param {object} [options]
   * @param {object|null}  [options.namedEntities]        — extra named entities merged into base map
   * @param {object}  [options.limit]                 — security limits
   * @param {number}       [options.limit.maxTotalExpansions=0]  — 0 = unlimited
   * @param {number}       [options.limit.maxExpandedLength=0]   — 0 = unlimited
   * @param {'external'|'base'|'all'|string[]} [options.limit.applyLimitsTo='external']
   *   Which entity tiers count against the security limits:
   *   - 'external' (default) — only input/runtime + persistent external entities
   *   - 'base'               — only DEFAULT_XML_ENTITIES + namedEntities
   *   - 'all'                — every entity regardless of tier
   *   - string[]             — explicit combination, e.g. ['external', 'base']
   * @param {((resolved: string, original: string) => string)|null} [options.postCheck=null]
   * @param {string[]} [options.remove=[]] — entity names (e.g. ['nbsp', '#13']) to delete (replace with empty string)
   * @param {string[]} [options.leave=[]]  — entity names to keep as literal (unchanged in output)
   * @param {object}   [options.ncr]       — Numeric Character Reference controls
   * @param {1.0|1.1}  [options.ncr.xmlVersion=1.0]
   *   XML version governing which codepoint ranges are restricted:
   *   - 1.0 — C0 controls U+0001–U+001F (except U+0009/000A/000D) are prohibited
   *   - 1.1 — C0 controls are allowed when written as NCRs; C1 (U+007F–U+009F) decoded as-is
   * @param {'allow'|'leave'|'remove'|'throw'} [options.ncr.onNCR='allow']
   *   Base action for numeric references. Severity order: allow < leave < remove < throw.
   *   For codepoint ranges that carry a minimum level (surrogates → remove, XML 1.0 C0 → remove),
   *   the effective action is max(onNCR, rangeMinimum).
   * @param {'remove'|'throw'} [options.ncr.nullNCR='remove']
   *   Action for U+0000 (null). 'allow' and 'leave' are clamped to 'remove' since null is never safe.
   */
  constructor(options = {}) {
    this._limit = options.limit || {};
    this._maxTotalExpansions = this._limit.maxTotalExpansions || 0;
    this._maxExpandedLength = this._limit.maxExpandedLength || 0;
    this._postCheck = typeof options.postCheck === "function" ? options.postCheck : (r) => r;
    this._limitTiers = parseLimitTiers(this._limit.applyLimitsTo ?? LIMIT_TIER_EXTERNAL);
    this._numericAllowed = options.numericAllowed ?? true;
    this._baseMap = mergeEntityMaps(XML, options.namedEntities || null);
    this._externalMap = /* @__PURE__ */ Object.create(null);
    this._inputMap = /* @__PURE__ */ Object.create(null);
    this._totalExpansions = 0;
    this._expandedLength = 0;
    this._removeSet = new Set(options.remove && Array.isArray(options.remove) ? options.remove : []);
    this._leaveSet = new Set(options.leave && Array.isArray(options.leave) ? options.leave : []);
    const ncrCfg = parseNCRConfig(options.ncr);
    this._ncrXmlVersion = ncrCfg.xmlVersion;
    this._ncrOnLevel = ncrCfg.onLevel;
    this._ncrNullLevel = ncrCfg.nullLevel;
  }
  // -------------------------------------------------------------------------
  // Persistent external entity registration
  // -------------------------------------------------------------------------
  /**
   * Replace the full set of persistent external entities.
   * All keys are validated — throws on invalid characters.
   * @param {Record<string, string | { regex?: RegExp, val: string }>} map
   */
  setExternalEntities(map) {
    if (map) {
      for (const key of Object.keys(map)) {
        validateEntityName(key);
      }
    }
    this._externalMap = mergeEntityMaps(map);
  }
  /**
   * Add a single persistent external entity.
   * @param {string} key
   * @param {string} value
   */
  addExternalEntity(key, value) {
    validateEntityName(key);
    if (typeof value === "string" && value.indexOf("&") === -1) {
      this._externalMap[key] = value;
    }
  }
  // -------------------------------------------------------------------------
  // Input / runtime entity registration (per document)
  // -------------------------------------------------------------------------
  /**
   * Inject DOCTYPE entities for the current document.
   * Also resets per-document expansion counters.
   * @param {Record<string, string | { regx?: RegExp, regex?: RegExp, val: string }>} map
   */
  addInputEntities(map) {
    this._totalExpansions = 0;
    this._expandedLength = 0;
    this._inputMap = mergeEntityMaps(map);
  }
  // -------------------------------------------------------------------------
  // Per-document reset
  // -------------------------------------------------------------------------
  /**
   * Wipe input/runtime entities and reset counters.
   * Call this before processing each new document.
   * @returns {this}
   */
  reset() {
    this._inputMap = /* @__PURE__ */ Object.create(null);
    this._totalExpansions = 0;
    this._expandedLength = 0;
    return this;
  }
  // -------------------------------------------------------------------------
  // XML version (can be set after construction, e.g. once parser reads <?xml?>)
  // -------------------------------------------------------------------------
  /**
   * Update the XML version used for NCR classification.
   * Call this as soon as the document's `<?xml version="...">` declaration is parsed.
   * @param {1.0|1.1|number} version
   */
  setXmlVersion(version) {
    this._ncrXmlVersion = version === 1.1 ? 1.1 : 1;
  }
  // -------------------------------------------------------------------------
  // Primary API
  // -------------------------------------------------------------------------
  /**
   * Replace all entity references in `str` in a single pass.
   *
   * @param {string} str
   * @returns {string}
   */
  decode(str) {
    if (typeof str !== "string" || str.length === 0) return str;
    const original = str;
    const chunks = [];
    const len = str.length;
    let last = 0;
    let i = 0;
    const limitExpansions = this._maxTotalExpansions > 0;
    const limitLength = this._maxExpandedLength > 0;
    const checkLimits = limitExpansions || limitLength;
    while (i < len) {
      if (str.charCodeAt(i) !== 38) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < len && str.charCodeAt(j) !== 59 && j - i <= 32) j++;
      if (j >= len || str.charCodeAt(j) !== 59) {
        i++;
        continue;
      }
      const token = str.slice(i + 1, j);
      if (token.length === 0) {
        i++;
        continue;
      }
      let replacement;
      let tier;
      if (this._removeSet.has(token)) {
        replacement = "";
        if (tier === void 0) {
          tier = LIMIT_TIER_EXTERNAL;
        }
      } else if (this._leaveSet.has(token)) {
        i++;
        continue;
      } else if (token.charCodeAt(0) === 35) {
        const ncrResult = this._resolveNCR(token);
        if (ncrResult === void 0) {
          i++;
          continue;
        }
        replacement = ncrResult;
        tier = LIMIT_TIER_BASE;
      } else {
        const resolved = this._resolveName(token);
        replacement = resolved?.value;
        tier = resolved?.tier;
      }
      if (replacement === void 0) {
        i++;
        continue;
      }
      if (i > last) chunks.push(str.slice(last, i));
      chunks.push(replacement);
      last = j + 1;
      i = last;
      if (checkLimits && this._tierCounts(tier)) {
        if (limitExpansions) {
          this._totalExpansions++;
          if (this._totalExpansions > this._maxTotalExpansions) {
            throw new Error(
              `[EntityReplacer] Entity expansion count limit exceeded: ${this._totalExpansions} > ${this._maxTotalExpansions}`
            );
          }
        }
        if (limitLength) {
          const delta = replacement.length - (token.length + 2);
          if (delta > 0) {
            this._expandedLength += delta;
            if (this._expandedLength > this._maxExpandedLength) {
              throw new Error(
                `[EntityReplacer] Expanded content length limit exceeded: ${this._expandedLength} > ${this._maxExpandedLength}`
              );
            }
          }
        }
      }
    }
    if (last < len) chunks.push(str.slice(last));
    const result = chunks.length === 0 ? str : chunks.join("");
    return this._postCheck(result, original);
  }
  // -------------------------------------------------------------------------
  // Private: limit tier check
  // -------------------------------------------------------------------------
  /**
   * Returns true if a resolved entity of the given tier should count
   * against the expansion/length limits.
   * @param {string} tier  — LIMIT_TIER_EXTERNAL | LIMIT_TIER_BASE
   * @returns {boolean}
   */
  _tierCounts(tier) {
    if (this._limitTiers.has(LIMIT_TIER_ALL)) return true;
    return this._limitTiers.has(tier);
  }
  // -------------------------------------------------------------------------
  // Private: entity resolution
  // -------------------------------------------------------------------------
  /**
   * Resolve a named entity token (without & and ;).
   * Priority: inputMap > externalMap > baseMap
   * Returns the resolved value tagged with its limit tier.
   *
   * @param {string} name
   * @returns {{ value: string, tier: string }|undefined}
   */
  _resolveName(name) {
    if (name in this._inputMap) return { value: this._inputMap[name], tier: LIMIT_TIER_EXTERNAL };
    if (name in this._externalMap) return { value: this._externalMap[name], tier: LIMIT_TIER_EXTERNAL };
    if (name in this._baseMap) return { value: this._baseMap[name], tier: LIMIT_TIER_BASE };
    return void 0;
  }
  /**
   * Classify a codepoint and return the minimum action level that must be applied.
   * Returns -1 when no minimum is imposed (normal allow path).
   *
   * Ranges checked (in priority order):
   *   1. U+0000            — null, governed by nullNCR (always ≥ remove)
   *   2. U+D800–U+DFFF     — surrogates, always prohibited (min: remove)
   *   3. U+0001–U+001F \ {0x09,0x0A,0x0D}  — XML 1.0 restricted C0 (min: remove)
   *      (skipped in XML 1.1 — C0 controls are allowed when written as NCRs)
   *
   * @param {number} cp  — codepoint
   * @returns {number}   — minimum NCR_LEVEL value, or -1 for no restriction
   */
  _classifyNCR(cp) {
    if (cp === 0) return this._ncrNullLevel;
    if (cp >= 55296 && cp <= 57343) return NCR_LEVEL.remove;
    if (this._ncrXmlVersion === 1) {
      if (cp >= 1 && cp <= 31 && !XML10_ALLOWED_C0.has(cp)) return NCR_LEVEL.remove;
    }
    return -1;
  }
  /**
   * Execute a resolved NCR action.
   *
   * @param {number} action   — NCR_LEVEL value
   * @param {string} token    — raw token (e.g. '#38') for error messages
   * @param {number} cp       — codepoint, used only for error messages
   * @returns {string|undefined}
   *   - decoded character string  → 'allow'
   *   - ''                        → 'remove'
   *   - undefined                 → 'leave' (caller must skip past '&' only)
   *   - throws Error              → 'throw'
   */
  _applyNCRAction(action, token, cp) {
    switch (action) {
      case NCR_LEVEL.allow:
        return String.fromCodePoint(cp);
      case NCR_LEVEL.remove:
        return "";
      case NCR_LEVEL.leave:
        return void 0;
      case NCR_LEVEL.throw:
        throw new Error(
          `[EntityDecoder] Prohibited numeric character reference &${token}; (U+${cp.toString(16).toUpperCase().padStart(4, "0")})`
        );
      default:
        return String.fromCodePoint(cp);
    }
  }
  /**
   * Full NCR resolution pipeline for a numeric token.
   *
   * Steps:
   *   1. Parse the codepoint (decimal or hex).
   *   2. Validate the raw codepoint range (NaN, <0, >0x10FFFF).
   *   3. If numericAllowed is false and no minimum restriction applies → leave as-is.
   *   4. Classify the codepoint to find the minimum required action level.
   *   5. Resolve effective action = max(onNCR, minimum).
   *   6. Apply and return.
   *
   * @param {string} token  — e.g. '#38', '#x26', '#X26'
   * @returns {string|undefined}
   *   - string (incl. '')  — replacement ('' = remove)
   *   - undefined          — leave original &token; as-is
   */
  _resolveNCR(token) {
    const second = token.charCodeAt(1);
    let cp;
    if (second === 120 || second === 88) {
      cp = parseInt(token.slice(2), 16);
    } else {
      cp = parseInt(token.slice(1), 10);
    }
    if (Number.isNaN(cp) || cp < 0 || cp > 1114111) return void 0;
    const minimum = this._classifyNCR(cp);
    if (!this._numericAllowed && minimum < NCR_LEVEL.remove) return void 0;
    const effective = minimum === -1 ? this._ncrOnLevel : Math.max(this._ncrOnLevel, minimum);
    return this._applyNCRAction(effective, token, cp);
  }
};

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/xmlparser/OptionsBuilder.js
var defaultOnDangerousProperty = (name) => {
  if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
    return "__" + name;
  }
  return name;
};
var defaultOptions2 = {
  preserveOrder: false,
  attributeNamePrefix: "@_",
  attributesGroupName: false,
  textNodeName: "#text",
  ignoreAttributes: true,
  removeNSPrefix: false,
  // remove NS from tag name or attribute name if true
  allowBooleanAttributes: false,
  //a tag can have attributes without any value
  //ignoreRootElement : false,
  parseTagValue: true,
  parseAttributeValue: false,
  trimValues: true,
  //Trim string values of tag and attributes
  cdataPropName: false,
  numberParseOptions: {
    hex: true,
    leadingZeros: true,
    eNotation: true
  },
  tagValueProcessor: function(tagName, val) {
    return val;
  },
  attributeValueProcessor: function(attrName, val) {
    return val;
  },
  stopNodes: [],
  //nested tags will not be parsed even for errors
  alwaysCreateTextNode: false,
  isArray: () => false,
  commentPropName: false,
  unpairedTags: [],
  processEntities: true,
  htmlEntities: false,
  entityDecoder: null,
  ignoreDeclaration: false,
  ignorePiTags: false,
  transformTagName: false,
  transformAttributeName: false,
  updateTag: function(tagName, jPath, attrs) {
    return tagName;
  },
  // skipEmptyListItem: false
  captureMetaData: false,
  maxNestedTags: 100,
  strictReservedNames: true,
  jPath: true,
  // if true, pass jPath string to callbacks; if false, pass matcher instance
  onDangerousProperty: defaultOnDangerousProperty
};
function validatePropertyName(propertyName, optionName) {
  if (typeof propertyName !== "string") {
    return;
  }
  const normalized = propertyName.toLowerCase();
  if (DANGEROUS_PROPERTY_NAMES.some((dangerous) => normalized === dangerous.toLowerCase())) {
    throw new Error(
      `[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`
    );
  }
  if (criticalProperties.some((dangerous) => normalized === dangerous.toLowerCase())) {
    throw new Error(
      `[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`
    );
  }
}
function normalizeProcessEntities(value, htmlEntities) {
  if (typeof value === "boolean") {
    return {
      enabled: value,
      // true or false
      maxEntitySize: 1e4,
      maxExpansionDepth: 1e4,
      maxTotalExpansions: Infinity,
      maxExpandedLength: 1e5,
      maxEntityCount: 1e3,
      allowedTags: null,
      tagFilter: null,
      appliesTo: "all"
    };
  }
  if (typeof value === "object" && value !== null) {
    return {
      enabled: value.enabled !== false,
      maxEntitySize: Math.max(1, value.maxEntitySize ?? 1e4),
      maxExpansionDepth: Math.max(1, value.maxExpansionDepth ?? 1e4),
      maxTotalExpansions: Math.max(1, value.maxTotalExpansions ?? Infinity),
      maxExpandedLength: Math.max(1, value.maxExpandedLength ?? 1e5),
      maxEntityCount: Math.max(1, value.maxEntityCount ?? 1e3),
      allowedTags: value.allowedTags ?? null,
      tagFilter: value.tagFilter ?? null,
      appliesTo: value.appliesTo ?? "all"
    };
  }
  return normalizeProcessEntities(true);
}
var buildOptions = function(options) {
  const built = Object.assign({}, defaultOptions2, options);
  const propertyNameOptions = [
    { value: built.attributeNamePrefix, name: "attributeNamePrefix" },
    { value: built.attributesGroupName, name: "attributesGroupName" },
    { value: built.textNodeName, name: "textNodeName" },
    { value: built.cdataPropName, name: "cdataPropName" },
    { value: built.commentPropName, name: "commentPropName" }
  ];
  for (const { value, name } of propertyNameOptions) {
    if (value) {
      validatePropertyName(value, name);
    }
  }
  if (built.onDangerousProperty === null) {
    built.onDangerousProperty = defaultOnDangerousProperty;
  }
  built.processEntities = normalizeProcessEntities(built.processEntities, built.htmlEntities);
  built.unpairedTagsSet = new Set(built.unpairedTags);
  if (built.stopNodes && Array.isArray(built.stopNodes)) {
    built.stopNodes = built.stopNodes.map((node) => {
      if (typeof node === "string" && node.startsWith("*.")) {
        return ".." + node.substring(2);
      }
      return node;
    });
  }
  return built;
};

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/xmlparser/xmlNode.js
var METADATA_SYMBOL;
if (typeof Symbol !== "function") {
  METADATA_SYMBOL = "@@xmlMetadata";
} else {
  METADATA_SYMBOL = Symbol("XML Node Metadata");
}
var XmlNode = class {
  constructor(tagname) {
    this.tagname = tagname;
    this.child = [];
    this[":@"] = /* @__PURE__ */ Object.create(null);
  }
  add(key, val) {
    if (key === "__proto__") key = "#__proto__";
    this.child.push({ [key]: val });
  }
  addChild(node, startIndex) {
    if (node.tagname === "__proto__") node.tagname = "#__proto__";
    if (node[":@"] && Object.keys(node[":@"]).length > 0) {
      this.child.push({ [node.tagname]: node.child, [":@"]: node[":@"] });
    } else {
      this.child.push({ [node.tagname]: node.child });
    }
    if (startIndex !== void 0) {
      this.child[this.child.length - 1][METADATA_SYMBOL] = { startIndex };
    }
  }
  /** symbol used for metadata */
  static getMetaDataSymbol() {
    return METADATA_SYMBOL;
  }
};

// ../../node_modules/.pnpm/xml-naming@0.1.0/node_modules/xml-naming/src/index.js
var nameStartChar10 = ":A-Za-z_À-ÖØ-öø-˿Ͱ-ͽͿ-҆҈-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�";
var nameChar10 = nameStartChar10 + "\\-\\.\\d·̀-ͯ‿-⁀";
var nameStartChar11 = ":A-Za-z_À-˿Ͱ-ͽͿ-҆҈-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�𐀀-󯿿";
var nameChar11 = nameStartChar11 + "\\-\\.\\d·̀-ͯ҇‿-⁀";
var buildRegexes = (startChar, char, flags = "") => {
  const ncStart = startChar.replace(":", "");
  const ncChar = char.replace(":", "");
  const ncNamePat = `[${ncStart}][${ncChar}]*`;
  return {
    name: new RegExp(`^[${startChar}][${char}]*$`, flags),
    ncName: new RegExp(`^${ncNamePat}$`, flags),
    qName: new RegExp(`^${ncNamePat}(?::${ncNamePat})?$`, flags),
    nmToken: new RegExp(`^[${char}]+$`, flags),
    nmTokens: new RegExp(`^[${char}]+(?:\\s+[${char}]+)*$`, flags)
  };
};
var regexes10 = buildRegexes(nameStartChar10, nameChar10);
var regexes11 = buildRegexes(nameStartChar11, nameChar11, "u");
var getRegexes = (xmlVersion = "1.0") => xmlVersion === "1.1" ? regexes11 : regexes10;
var qName = (str, { xmlVersion = "1.0" } = {}) => getRegexes(xmlVersion).qName.test(str);

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/xmlparser/DocTypeReader.js
var DocTypeReader = class {
  constructor(options, xmlVersion) {
    this.suppressValidationErr = !options;
    this.options = options;
    this.xmlVersion = xmlVersion || 1;
  }
  setXmlVersion(xmlVersion = 1) {
    this.xmlVersion = xmlVersion;
  }
  readDocType(xmlData, i) {
    const entities = /* @__PURE__ */ Object.create(null);
    let entityCount = 0;
    if (xmlData[i + 3] === "O" && xmlData[i + 4] === "C" && xmlData[i + 5] === "T" && xmlData[i + 6] === "Y" && xmlData[i + 7] === "P" && xmlData[i + 8] === "E") {
      i = i + 9;
      let angleBracketsCount = 1;
      let hasBody = false, comment = false;
      let exp = "";
      for (; i < xmlData.length; i++) {
        if (xmlData[i] === "<" && !comment) {
          if (hasBody && hasSeq(xmlData, "!ENTITY", i)) {
            i += 7;
            let entityName, val;
            [entityName, val, i] = this.readEntityExp(xmlData, i + 1, this.suppressValidationErr);
            if (val.indexOf("&") === -1) {
              if (this.options.enabled !== false && this.options.maxEntityCount != null && entityCount >= this.options.maxEntityCount) {
                throw new Error(
                  `Entity count (${entityCount + 1}) exceeds maximum allowed (${this.options.maxEntityCount})`
                );
              }
              entities[entityName] = val;
              entityCount++;
            }
          } else if (hasBody && hasSeq(xmlData, "!ELEMENT", i)) {
            i += 8;
            const { index } = this.readElementExp(xmlData, i + 1);
            i = index;
          } else if (hasBody && hasSeq(xmlData, "!ATTLIST", i)) {
            i += 8;
          } else if (hasBody && hasSeq(xmlData, "!NOTATION", i)) {
            i += 9;
            const { index } = this.readNotationExp(xmlData, i + 1, this.suppressValidationErr);
            i = index;
          } else if (hasSeq(xmlData, "!--", i)) comment = true;
          else throw new Error(`Invalid DOCTYPE`);
          angleBracketsCount++;
          exp = "";
        } else if (xmlData[i] === ">") {
          if (comment) {
            if (xmlData[i - 1] === "-" && xmlData[i - 2] === "-") {
              comment = false;
              angleBracketsCount--;
            }
          } else {
            angleBracketsCount--;
          }
          if (angleBracketsCount === 0) {
            break;
          }
        } else if (xmlData[i] === "[") {
          hasBody = true;
        } else {
          exp += xmlData[i];
        }
      }
      if (angleBracketsCount !== 0) {
        throw new Error(`Unclosed DOCTYPE`);
      }
    } else {
      throw new Error(`Invalid Tag instead of DOCTYPE`);
    }
    return { entities, i };
  }
  readEntityExp(xmlData, i) {
    i = skipWhitespace(xmlData, i);
    const startIndex = i;
    while (i < xmlData.length && !/\s/.test(xmlData[i]) && xmlData[i] !== '"' && xmlData[i] !== "'") {
      i++;
    }
    let entityName = xmlData.substring(startIndex, i);
    validateEntityName2(entityName, { xmlVersion: this.xmlVersion });
    i = skipWhitespace(xmlData, i);
    if (!this.suppressValidationErr) {
      if (xmlData.substring(i, i + 6).toUpperCase() === "SYSTEM") {
        throw new Error("External entities are not supported");
      } else if (xmlData[i] === "%") {
        throw new Error("Parameter entities are not supported");
      }
    }
    let entityValue = "";
    [i, entityValue] = this.readIdentifierVal(xmlData, i, "entity");
    if (this.options.enabled !== false && this.options.maxEntitySize != null && entityValue.length > this.options.maxEntitySize) {
      throw new Error(
        `Entity "${entityName}" size (${entityValue.length}) exceeds maximum allowed size (${this.options.maxEntitySize})`
      );
    }
    i--;
    return [entityName, entityValue, i];
  }
  readNotationExp(xmlData, i) {
    i = skipWhitespace(xmlData, i);
    const startIndex = i;
    while (i < xmlData.length && !/\s/.test(xmlData[i])) {
      i++;
    }
    let notationName = xmlData.substring(startIndex, i);
    !this.suppressValidationErr && validateEntityName2(notationName, { xmlVersion: this.xmlVersion });
    i = skipWhitespace(xmlData, i);
    const identifierType = xmlData.substring(i, i + 6).toUpperCase();
    if (!this.suppressValidationErr && identifierType !== "SYSTEM" && identifierType !== "PUBLIC") {
      throw new Error(`Expected SYSTEM or PUBLIC, found "${identifierType}"`);
    }
    i += identifierType.length;
    i = skipWhitespace(xmlData, i);
    let publicIdentifier = null;
    let systemIdentifier = null;
    if (identifierType === "PUBLIC") {
      [i, publicIdentifier] = this.readIdentifierVal(xmlData, i, "publicIdentifier");
      i = skipWhitespace(xmlData, i);
      if (xmlData[i] === '"' || xmlData[i] === "'") {
        [i, systemIdentifier] = this.readIdentifierVal(xmlData, i, "systemIdentifier");
      }
    } else if (identifierType === "SYSTEM") {
      [i, systemIdentifier] = this.readIdentifierVal(xmlData, i, "systemIdentifier");
      if (!this.suppressValidationErr && !systemIdentifier) {
        throw new Error("Missing mandatory system identifier for SYSTEM notation");
      }
    }
    return { notationName, publicIdentifier, systemIdentifier, index: --i };
  }
  readIdentifierVal(xmlData, i, type) {
    let identifierVal = "";
    const startChar = xmlData[i];
    if (startChar !== '"' && startChar !== "'") {
      throw new Error(`Expected quoted string, found "${startChar}"`);
    }
    i++;
    const startIndex = i;
    while (i < xmlData.length && xmlData[i] !== startChar) {
      i++;
    }
    identifierVal = xmlData.substring(startIndex, i);
    if (xmlData[i] !== startChar) {
      throw new Error(`Unterminated ${type} value`);
    }
    i++;
    return [i, identifierVal];
  }
  readElementExp(xmlData, i) {
    i = skipWhitespace(xmlData, i);
    const startIndex = i;
    while (i < xmlData.length && !/\s/.test(xmlData[i])) {
      i++;
    }
    let elementName = xmlData.substring(startIndex, i);
    if (!this.suppressValidationErr && !qName(elementName, { xmlVersion: this.xmlVersion })) {
      throw new Error(`Invalid element name: "${elementName}"`);
    }
    i = skipWhitespace(xmlData, i);
    let contentModel = "";
    if (xmlData[i] === "E" && hasSeq(xmlData, "MPTY", i)) i += 4;
    else if (xmlData[i] === "A" && hasSeq(xmlData, "NY", i)) i += 2;
    else if (xmlData[i] === "(") {
      i++;
      const startIndex2 = i;
      while (i < xmlData.length && xmlData[i] !== ")") {
        i++;
      }
      contentModel = xmlData.substring(startIndex2, i);
      if (xmlData[i] !== ")") {
        throw new Error("Unterminated content model");
      }
    } else if (!this.suppressValidationErr) {
      throw new Error(`Invalid Element Expression, found "${xmlData[i]}"`);
    }
    return {
      elementName,
      contentModel: contentModel.trim(),
      index: i
    };
  }
  readAttlistExp(xmlData, i) {
    i = skipWhitespace(xmlData, i);
    let startIndex = i;
    while (i < xmlData.length && !/\s/.test(xmlData[i])) {
      i++;
    }
    let elementName = xmlData.substring(startIndex, i);
    validateEntityName2(elementName, { xmlVersion: this.xmlVersion });
    i = skipWhitespace(xmlData, i);
    startIndex = i;
    while (i < xmlData.length && !/\s/.test(xmlData[i])) {
      i++;
    }
    let attributeName = xmlData.substring(startIndex, i);
    if (!validateEntityName2(attributeName, { xmlVersion: this.xmlVersion })) {
      throw new Error(`Invalid attribute name: "${attributeName}"`);
    }
    i = skipWhitespace(xmlData, i);
    let attributeType = "";
    if (xmlData.substring(i, i + 8).toUpperCase() === "NOTATION") {
      attributeType = "NOTATION";
      i += 8;
      i = skipWhitespace(xmlData, i);
      if (xmlData[i] !== "(") {
        throw new Error(`Expected '(', found "${xmlData[i]}"`);
      }
      i++;
      let allowedNotations = [];
      while (i < xmlData.length && xmlData[i] !== ")") {
        const startIndex2 = i;
        while (i < xmlData.length && xmlData[i] !== "|" && xmlData[i] !== ")") {
          i++;
        }
        let notation = xmlData.substring(startIndex2, i);
        notation = notation.trim();
        if (!validateEntityName2(notation, { xmlVersion: this.xmlVersion })) {
          throw new Error(`Invalid notation name: "${notation}"`);
        }
        allowedNotations.push(notation);
        if (xmlData[i] === "|") {
          i++;
          i = skipWhitespace(xmlData, i);
        }
      }
      if (xmlData[i] !== ")") {
        throw new Error("Unterminated list of notations");
      }
      i++;
      attributeType += " (" + allowedNotations.join("|") + ")";
    } else {
      const startIndex2 = i;
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        i++;
      }
      attributeType += xmlData.substring(startIndex2, i);
      const validTypes = ["CDATA", "ID", "IDREF", "IDREFS", "ENTITY", "ENTITIES", "NMTOKEN", "NMTOKENS"];
      if (!this.suppressValidationErr && !validTypes.includes(attributeType.toUpperCase())) {
        throw new Error(`Invalid attribute type: "${attributeType}"`);
      }
    }
    i = skipWhitespace(xmlData, i);
    let defaultValue = "";
    if (xmlData.substring(i, i + 8).toUpperCase() === "#REQUIRED") {
      defaultValue = "#REQUIRED";
      i += 8;
    } else if (xmlData.substring(i, i + 7).toUpperCase() === "#IMPLIED") {
      defaultValue = "#IMPLIED";
      i += 7;
    } else {
      [i, defaultValue] = this.readIdentifierVal(xmlData, i, "ATTLIST");
    }
    return {
      elementName,
      attributeName,
      attributeType,
      defaultValue,
      index: i
    };
  }
};
var skipWhitespace = (data, index) => {
  while (index < data.length && /\s/.test(data[index])) {
    index++;
  }
  return index;
};
function hasSeq(data, seq, i) {
  for (let j = 0; j < seq.length; j++) {
    if (seq[j] !== data[i + j + 1]) return false;
  }
  return true;
}
function validateEntityName2(name, xmlVersion) {
  if (qName(name, { xmlVersion }))
    return name;
  else
    throw new Error(`Invalid entity name ${name}`);
}

// ../../node_modules/.pnpm/strnum@2.3.0/node_modules/strnum/strnum.js
var hexRegex = /^[-+]?0x[a-fA-F0-9]+$/;
var binRegex = /^0b[01]+$/;
var octRegex = /^0o[0-7]+$/;
var numRegex = /^([\-\+])?(0*)([0-9]*(\.[0-9]*)?)$/;
var consider = {
  hex: true,
  binary: false,
  octal: false,
  leadingZeros: true,
  decimalPoint: ".",
  eNotation: true,
  //skipLike: /regex/,
  infinity: "original"
  // "null", "infinity" (Infinity type), "string" ("Infinity" (the string literal))
};
function toNumber(str, options = {}) {
  options = Object.assign({}, consider, options);
  if (!str || typeof str !== "string") return str;
  let trimmedStr = str.trim();
  if (trimmedStr.length === 0) return str;
  else if (options.skipLike !== void 0 && options.skipLike.test(trimmedStr)) return str;
  else if (trimmedStr === "0") return 0;
  else if (options.hex && hexRegex.test(trimmedStr)) {
    return parse_int(trimmedStr, 16);
  } else if (options.binary && binRegex.test(trimmedStr)) {
    return parse_int(trimmedStr, 2);
  } else if (options.octal && octRegex.test(trimmedStr)) {
    return parse_int(trimmedStr, 8);
  } else if (!isFinite(trimmedStr)) {
    return handleInfinity(str, Number(trimmedStr), options);
  } else if (trimmedStr.includes("e") || trimmedStr.includes("E")) {
    return resolveEnotation(str, trimmedStr, options);
  } else {
    const match = numRegex.exec(trimmedStr);
    if (match) {
      const sign = match[1] || "";
      const leadingZeros = match[2];
      let numTrimmedByZeros = trimZeros(match[3]);
      const decimalAdjacentToLeadingZeros = sign ? (
        // 0., -00., 000.
        str[leadingZeros.length + 1] === "."
      ) : str[leadingZeros.length] === ".";
      if (!options.leadingZeros && (leadingZeros.length > 1 || leadingZeros.length === 1 && !decimalAdjacentToLeadingZeros)) {
        return str;
      } else {
        const num = Number(trimmedStr);
        const parsedStr = String(num);
        if (num === 0) return num;
        if (parsedStr.search(/[eE]/) !== -1) {
          if (options.eNotation) return num;
          else return str;
        } else if (trimmedStr.indexOf(".") !== -1) {
          if (parsedStr === "0") return num;
          else if (parsedStr === numTrimmedByZeros) return num;
          else if (parsedStr === `${sign}${numTrimmedByZeros}`) return num;
          else return str;
        }
        let n = leadingZeros ? numTrimmedByZeros : trimmedStr;
        if (leadingZeros) {
          return n === parsedStr || sign + n === parsedStr ? num : str;
        } else {
          return n === parsedStr || n === sign + parsedStr ? num : str;
        }
      }
    } else {
      return str;
    }
  }
}
var eNotationRegx = /^([-+])?(0*)(\d*(\.\d*)?[eE][-\+]?\d+)$/;
function resolveEnotation(str, trimmedStr, options) {
  if (!options.eNotation) return str;
  const notation = trimmedStr.match(eNotationRegx);
  if (notation) {
    let sign = notation[1] || "";
    const eChar = notation[3].indexOf("e") === -1 ? "E" : "e";
    const leadingZeros = notation[2];
    const eAdjacentToLeadingZeros = sign ? (
      // 0E.
      str[leadingZeros.length + 1] === eChar
    ) : str[leadingZeros.length] === eChar;
    if (leadingZeros.length > 1 && eAdjacentToLeadingZeros) return str;
    else if (leadingZeros.length === 1 && (notation[3].startsWith(`.${eChar}`) || notation[3][0] === eChar)) {
      return Number(trimmedStr);
    } else if (leadingZeros.length > 0) {
      if (options.leadingZeros && !eAdjacentToLeadingZeros) {
        trimmedStr = (notation[1] || "") + notation[3];
        return Number(trimmedStr);
      } else return str;
    } else {
      return Number(trimmedStr);
    }
  } else {
    return str;
  }
}
function trimZeros(numStr) {
  if (numStr && numStr.indexOf(".") !== -1) {
    numStr = numStr.replace(/0+$/, "");
    if (numStr === ".") numStr = "0";
    else if (numStr[0] === ".") numStr = "0" + numStr;
    else if (numStr[numStr.length - 1] === ".") numStr = numStr.substring(0, numStr.length - 1);
    return numStr;
  }
  return numStr;
}
function parse_int(numStr, base) {
  const str = numStr.trim();
  if (base === 2 || base === 8) numStr = str.substring(2);
  if (parseInt) return parseInt(numStr, base);
  else if (Number.parseInt) return Number.parseInt(numStr, base);
  else if (window && window.parseInt) return window.parseInt(numStr, base);
  else throw new Error("parseInt, Number.parseInt, window.parseInt are not supported");
}
function handleInfinity(str, num, options) {
  const isPositive = num === Infinity;
  switch (options.infinity.toLowerCase()) {
    case "null":
      return null;
    case "infinity":
      return num;
    case "string":
      return isPositive ? "Infinity" : "-Infinity";
    case "original":
    default:
      return str;
  }
}

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/ignoreAttributes.js
function getIgnoreAttributesFn(ignoreAttributes) {
  if (typeof ignoreAttributes === "function") {
    return ignoreAttributes;
  }
  if (Array.isArray(ignoreAttributes)) {
    return (attrName) => {
      for (const pattern of ignoreAttributes) {
        if (typeof pattern === "string" && attrName === pattern) {
          return true;
        }
        if (pattern instanceof RegExp && pattern.test(attrName)) {
          return true;
        }
      }
    };
  }
  return () => false;
}

// ../../node_modules/.pnpm/path-expression-matcher@1.5.0/node_modules/path-expression-matcher/src/Expression.js
var Expression = class {
  /**
   * Create a new Expression
   * @param {string} pattern - Pattern string (e.g., "root.users.user", "..user[id]")
   * @param {Object} options - Configuration options
   * @param {string} options.separator - Path separator (default: '.')
   */
  constructor(pattern, options = {}, data) {
    this.pattern = pattern;
    this.separator = options.separator || ".";
    this.segments = this._parse(pattern);
    this.data = data;
    this._hasDeepWildcard = this.segments.some((seg) => seg.type === "deep-wildcard");
    this._hasAttributeCondition = this.segments.some((seg) => seg.attrName !== void 0);
    this._hasPositionSelector = this.segments.some((seg) => seg.position !== void 0);
  }
  /**
   * Parse pattern string into segments
   * @private
   * @param {string} pattern - Pattern to parse
   * @returns {Array} Array of segment objects
   */
  _parse(pattern) {
    const segments = [];
    let i = 0;
    let currentPart = "";
    while (i < pattern.length) {
      if (pattern[i] === this.separator) {
        if (i + 1 < pattern.length && pattern[i + 1] === this.separator) {
          if (currentPart.trim()) {
            segments.push(this._parseSegment(currentPart.trim()));
            currentPart = "";
          }
          segments.push({ type: "deep-wildcard" });
          i += 2;
        } else {
          if (currentPart.trim()) {
            segments.push(this._parseSegment(currentPart.trim()));
          }
          currentPart = "";
          i++;
        }
      } else {
        currentPart += pattern[i];
        i++;
      }
    }
    if (currentPart.trim()) {
      segments.push(this._parseSegment(currentPart.trim()));
    }
    return segments;
  }
  /**
   * Parse a single segment
   * @private
   * @param {string} part - Segment string (e.g., "user", "ns::user", "user[id]", "ns::user:first")
   * @returns {Object} Segment object
   */
  _parseSegment(part) {
    const segment = { type: "tag" };
    let bracketContent = null;
    let withoutBrackets = part;
    const bracketMatch = part.match(/^([^\[]+)(\[[^\]]*\])(.*)$/);
    if (bracketMatch) {
      withoutBrackets = bracketMatch[1] + bracketMatch[3];
      if (bracketMatch[2]) {
        const content = bracketMatch[2].slice(1, -1);
        if (content) {
          bracketContent = content;
        }
      }
    }
    let namespace = void 0;
    let tagAndPosition = withoutBrackets;
    if (withoutBrackets.includes("::")) {
      const nsIndex = withoutBrackets.indexOf("::");
      namespace = withoutBrackets.substring(0, nsIndex).trim();
      tagAndPosition = withoutBrackets.substring(nsIndex + 2).trim();
      if (!namespace) {
        throw new Error(`Invalid namespace in pattern: ${part}`);
      }
    }
    let tag = void 0;
    let positionMatch = null;
    if (tagAndPosition.includes(":")) {
      const colonIndex = tagAndPosition.lastIndexOf(":");
      const tagPart = tagAndPosition.substring(0, colonIndex).trim();
      const posPart = tagAndPosition.substring(colonIndex + 1).trim();
      const isPositionKeyword = ["first", "last", "odd", "even"].includes(posPart) || /^nth\(\d+\)$/.test(posPart);
      if (isPositionKeyword) {
        tag = tagPart;
        positionMatch = posPart;
      } else {
        tag = tagAndPosition;
      }
    } else {
      tag = tagAndPosition;
    }
    if (!tag) {
      throw new Error(`Invalid segment pattern: ${part}`);
    }
    segment.tag = tag;
    if (namespace) {
      segment.namespace = namespace;
    }
    if (bracketContent) {
      if (bracketContent.includes("=")) {
        const eqIndex = bracketContent.indexOf("=");
        segment.attrName = bracketContent.substring(0, eqIndex).trim();
        segment.attrValue = bracketContent.substring(eqIndex + 1).trim();
      } else {
        segment.attrName = bracketContent.trim();
      }
    }
    if (positionMatch) {
      const nthMatch = positionMatch.match(/^nth\((\d+)\)$/);
      if (nthMatch) {
        segment.position = "nth";
        segment.positionValue = parseInt(nthMatch[1], 10);
      } else {
        segment.position = positionMatch;
      }
    }
    return segment;
  }
  /**
   * Get the number of segments
   * @returns {number}
   */
  get length() {
    return this.segments.length;
  }
  /**
   * Check if expression contains deep wildcard
   * @returns {boolean}
   */
  hasDeepWildcard() {
    return this._hasDeepWildcard;
  }
  /**
   * Check if expression has attribute conditions
   * @returns {boolean}
   */
  hasAttributeCondition() {
    return this._hasAttributeCondition;
  }
  /**
   * Check if expression has position selectors
   * @returns {boolean}
   */
  hasPositionSelector() {
    return this._hasPositionSelector;
  }
  /**
   * Get string representation
   * @returns {string}
   */
  toString() {
    return this.pattern;
  }
};

// ../../node_modules/.pnpm/path-expression-matcher@1.5.0/node_modules/path-expression-matcher/src/ExpressionSet.js
var ExpressionSet = class {
  constructor() {
    this._byDepthAndTag = /* @__PURE__ */ new Map();
    this._wildcardByDepth = /* @__PURE__ */ new Map();
    this._deepWildcards = [];
    this._patterns = /* @__PURE__ */ new Set();
    this._sealed = false;
  }
  /**
   * Add an Expression to the set.
   * Duplicate patterns (same pattern string) are silently ignored.
   *
   * @param {import('./Expression.js').default} expression - A pre-constructed Expression instance
   * @returns {this} for chaining
   * @throws {TypeError} if called after seal()
   *
   * @example
   * set.add(new Expression('root.users.user'));
   * set.add(new Expression('..script'));
   */
  add(expression) {
    if (this._sealed) {
      throw new TypeError(
        "ExpressionSet is sealed. Create a new ExpressionSet to add more expressions."
      );
    }
    if (this._patterns.has(expression.pattern)) return this;
    this._patterns.add(expression.pattern);
    if (expression.hasDeepWildcard()) {
      this._deepWildcards.push(expression);
      return this;
    }
    const depth = expression.length;
    const lastSeg = expression.segments[expression.segments.length - 1];
    const tag = lastSeg?.tag;
    if (!tag || tag === "*") {
      if (!this._wildcardByDepth.has(depth)) this._wildcardByDepth.set(depth, []);
      this._wildcardByDepth.get(depth).push(expression);
    } else {
      const key = `${depth}:${tag}`;
      if (!this._byDepthAndTag.has(key)) this._byDepthAndTag.set(key, []);
      this._byDepthAndTag.get(key).push(expression);
    }
    return this;
  }
  /**
   * Add multiple expressions at once.
   *
   * @param {import('./Expression.js').default[]} expressions - Array of Expression instances
   * @returns {this} for chaining
   *
   * @example
   * set.addAll([
   *   new Expression('root.users.user'),
   *   new Expression('root.config.setting'),
   * ]);
   */
  addAll(expressions) {
    for (const expr of expressions) this.add(expr);
    return this;
  }
  /**
   * Check whether a pattern string is already present in the set.
   *
   * @param {import('./Expression.js').default} expression
   * @returns {boolean}
   */
  has(expression) {
    return this._patterns.has(expression.pattern);
  }
  /**
   * Number of expressions in the set.
   * @type {number}
   */
  get size() {
    return this._patterns.size;
  }
  /**
   * Seal the set against further modifications.
   * Useful to prevent accidental mutations after config is built.
   * Calling add() or addAll() on a sealed set throws a TypeError.
   *
   * @returns {this}
   */
  seal() {
    this._sealed = true;
    return this;
  }
  /**
   * Whether the set has been sealed.
   * @type {boolean}
   */
  get isSealed() {
    return this._sealed;
  }
  /**
   * Test whether the matcher's current path matches any expression in the set.
   *
   * Evaluation order (cheapest → most expensive):
   *  1. Exact depth + tag bucket  — O(1) lookup, typically 0–2 expressions
   *  2. Depth-only wildcard bucket — O(1) lookup, rare
   *  3. Deep-wildcard list         — always checked, but usually small
   *
   * @param {import('./Matcher.js').default} matcher - Matcher instance (or readOnly view)
   * @returns {boolean} true if any expression matches the current path
   *
   * @example
   * if (stopNodes.matchesAny(matcher)) {
   *   // handle stop node
   * }
   */
  matchesAny(matcher) {
    return this.findMatch(matcher) !== null;
  }
  /**
  * Find and return the first Expression that matches the matcher's current path.
  *
  * Uses the same evaluation order as matchesAny (cheapest → most expensive):
  *  1. Exact depth + tag bucket
  *  2. Depth-only wildcard bucket
  *  3. Deep-wildcard list
  *
  * @param {import('./Matcher.js').default} matcher - Matcher instance (or readOnly view)
  * @returns {import('./Expression.js').default | null} the first matching Expression, or null
  *
  * @example
  * const expr = stopNodes.findMatch(matcher);
  * if (expr) {
  *   // access expr.config, expr.pattern, etc.
  * }
  */
  findMatch(matcher) {
    const depth = matcher.getDepth();
    const tag = matcher.getCurrentTag();
    const exactKey = `${depth}:${tag}`;
    const exactBucket = this._byDepthAndTag.get(exactKey);
    if (exactBucket) {
      for (let i = 0; i < exactBucket.length; i++) {
        if (matcher.matches(exactBucket[i])) return exactBucket[i];
      }
    }
    const wildcardBucket = this._wildcardByDepth.get(depth);
    if (wildcardBucket) {
      for (let i = 0; i < wildcardBucket.length; i++) {
        if (matcher.matches(wildcardBucket[i])) return wildcardBucket[i];
      }
    }
    for (let i = 0; i < this._deepWildcards.length; i++) {
      if (matcher.matches(this._deepWildcards[i])) return this._deepWildcards[i];
    }
    return null;
  }
};

// ../../node_modules/.pnpm/path-expression-matcher@1.5.0/node_modules/path-expression-matcher/src/Matcher.js
var MatcherView = class {
  /**
   * @param {Matcher} matcher - The parent Matcher instance to read from.
   */
  constructor(matcher) {
    this._matcher = matcher;
  }
  /**
   * Get the path separator used by the parent matcher.
   * @returns {string}
   */
  get separator() {
    return this._matcher.separator;
  }
  /**
   * Get current tag name.
   * @returns {string|undefined}
   */
  getCurrentTag() {
    const path3 = this._matcher.path;
    return path3.length > 0 ? path3[path3.length - 1].tag : void 0;
  }
  /**
   * Get current namespace.
   * @returns {string|undefined}
   */
  getCurrentNamespace() {
    const path3 = this._matcher.path;
    return path3.length > 0 ? path3[path3.length - 1].namespace : void 0;
  }
  /**
   * Get current node's attribute value.
   * @param {string} attrName
   * @returns {*}
   */
  getAttrValue(attrName) {
    const path3 = this._matcher.path;
    if (path3.length === 0) return void 0;
    return path3[path3.length - 1].values?.[attrName];
  }
  /**
   * Check if current node has an attribute.
   * @param {string} attrName
   * @returns {boolean}
   */
  hasAttr(attrName) {
    const path3 = this._matcher.path;
    if (path3.length === 0) return false;
    const current = path3[path3.length - 1];
    return current.values !== void 0 && attrName in current.values;
  }
  /**
   * Get current node's sibling position (child index in parent).
   * @returns {number}
   */
  getPosition() {
    const path3 = this._matcher.path;
    if (path3.length === 0) return -1;
    return path3[path3.length - 1].position ?? 0;
  }
  /**
   * Get current node's repeat counter (occurrence count of this tag name).
   * @returns {number}
   */
  getCounter() {
    const path3 = this._matcher.path;
    if (path3.length === 0) return -1;
    return path3[path3.length - 1].counter ?? 0;
  }
  /**
   * Get current node's sibling index (alias for getPosition).
   * @returns {number}
   * @deprecated Use getPosition() or getCounter() instead
   */
  getIndex() {
    return this.getPosition();
  }
  /**
   * Get current path depth.
   * @returns {number}
   */
  getDepth() {
    return this._matcher.path.length;
  }
  /**
   * Get path as string.
   * @param {string} [separator] - Optional separator (uses default if not provided)
   * @param {boolean} [includeNamespace=true]
   * @returns {string}
   */
  toString(separator, includeNamespace = true) {
    return this._matcher.toString(separator, includeNamespace);
  }
  /**
   * Get path as array of tag names.
   * @returns {string[]}
   */
  toArray() {
    return this._matcher.path.map((n) => n.tag);
  }
  /**
   * Match current path against an Expression.
   * @param {Expression} expression
   * @returns {boolean}
   */
  matches(expression) {
    return this._matcher.matches(expression);
  }
  /**
   * Match any expression in the given set against the current path.
   * @param {ExpressionSet} exprSet
   * @returns {boolean}
   */
  matchesAny(exprSet) {
    return exprSet.matchesAny(this._matcher);
  }
};
var Matcher = class {
  /**
   * Create a new Matcher.
   * @param {Object} [options={}]
   * @param {string} [options.separator='.'] - Default path separator
   */
  constructor(options = {}) {
    this.separator = options.separator || ".";
    this.path = [];
    this.siblingStacks = [];
    this._pathStringCache = null;
    this._view = new MatcherView(this);
  }
  /**
   * Push a new tag onto the path.
   * @param {string} tagName
   * @param {Object|null} [attrValues=null]
   * @param {string|null} [namespace=null]
   */
  push(tagName, attrValues = null, namespace = null) {
    this._pathStringCache = null;
    if (this.path.length > 0) {
      this.path[this.path.length - 1].values = void 0;
    }
    const currentLevel = this.path.length;
    if (!this.siblingStacks[currentLevel]) {
      this.siblingStacks[currentLevel] = /* @__PURE__ */ new Map();
    }
    const siblings = this.siblingStacks[currentLevel];
    const siblingKey = namespace ? `${namespace}:${tagName}` : tagName;
    const counter = siblings.get(siblingKey) || 0;
    let position = 0;
    for (const count of siblings.values()) {
      position += count;
    }
    siblings.set(siblingKey, counter + 1);
    const node = {
      tag: tagName,
      position,
      counter
    };
    if (namespace !== null && namespace !== void 0) {
      node.namespace = namespace;
    }
    if (attrValues !== null && attrValues !== void 0) {
      node.values = attrValues;
    }
    this.path.push(node);
  }
  /**
   * Pop the last tag from the path.
   * @returns {Object|undefined} The popped node
   */
  pop() {
    if (this.path.length === 0) return void 0;
    this._pathStringCache = null;
    const node = this.path.pop();
    if (this.siblingStacks.length > this.path.length + 1) {
      this.siblingStacks.length = this.path.length + 1;
    }
    return node;
  }
  /**
   * Update current node's attribute values.
   * Useful when attributes are parsed after push.
   * @param {Object} attrValues
   */
  updateCurrent(attrValues) {
    if (this.path.length > 0) {
      const current = this.path[this.path.length - 1];
      if (attrValues !== null && attrValues !== void 0) {
        current.values = attrValues;
      }
    }
  }
  /**
   * Get current tag name.
   * @returns {string|undefined}
   */
  getCurrentTag() {
    return this.path.length > 0 ? this.path[this.path.length - 1].tag : void 0;
  }
  /**
   * Get current namespace.
   * @returns {string|undefined}
   */
  getCurrentNamespace() {
    return this.path.length > 0 ? this.path[this.path.length - 1].namespace : void 0;
  }
  /**
   * Get current node's attribute value.
   * @param {string} attrName
   * @returns {*}
   */
  getAttrValue(attrName) {
    if (this.path.length === 0) return void 0;
    return this.path[this.path.length - 1].values?.[attrName];
  }
  /**
   * Check if current node has an attribute.
   * @param {string} attrName
   * @returns {boolean}
   */
  hasAttr(attrName) {
    if (this.path.length === 0) return false;
    const current = this.path[this.path.length - 1];
    return current.values !== void 0 && attrName in current.values;
  }
  /**
   * Get current node's sibling position (child index in parent).
   * @returns {number}
   */
  getPosition() {
    if (this.path.length === 0) return -1;
    return this.path[this.path.length - 1].position ?? 0;
  }
  /**
   * Get current node's repeat counter (occurrence count of this tag name).
   * @returns {number}
   */
  getCounter() {
    if (this.path.length === 0) return -1;
    return this.path[this.path.length - 1].counter ?? 0;
  }
  /**
   * Get current node's sibling index (alias for getPosition).
   * @returns {number}
   * @deprecated Use getPosition() or getCounter() instead
   */
  getIndex() {
    return this.getPosition();
  }
  /**
   * Get current path depth.
   * @returns {number}
   */
  getDepth() {
    return this.path.length;
  }
  /**
   * Get path as string.
   * @param {string} [separator] - Optional separator (uses default if not provided)
   * @param {boolean} [includeNamespace=true]
   * @returns {string}
   */
  toString(separator, includeNamespace = true) {
    const sep = separator || this.separator;
    const isDefault = sep === this.separator && includeNamespace === true;
    if (isDefault) {
      if (this._pathStringCache !== null) {
        return this._pathStringCache;
      }
      const result = this.path.map(
        (n) => n.namespace ? `${n.namespace}:${n.tag}` : n.tag
      ).join(sep);
      this._pathStringCache = result;
      return result;
    }
    return this.path.map(
      (n) => includeNamespace && n.namespace ? `${n.namespace}:${n.tag}` : n.tag
    ).join(sep);
  }
  /**
   * Get path as array of tag names.
   * @returns {string[]}
   */
  toArray() {
    return this.path.map((n) => n.tag);
  }
  /**
   * Reset the path to empty.
   */
  reset() {
    this._pathStringCache = null;
    this.path = [];
    this.siblingStacks = [];
  }
  /**
   * Match current path against an Expression.
   * @param {Expression} expression
   * @returns {boolean}
   */
  matches(expression) {
    const segments = expression.segments;
    if (segments.length === 0) {
      return false;
    }
    if (expression.hasDeepWildcard()) {
      return this._matchWithDeepWildcard(segments);
    }
    return this._matchSimple(segments);
  }
  /**
   * @private
   */
  _matchSimple(segments) {
    if (this.path.length !== segments.length) {
      return false;
    }
    for (let i = 0; i < segments.length; i++) {
      if (!this._matchSegment(segments[i], this.path[i], i === this.path.length - 1)) {
        return false;
      }
    }
    return true;
  }
  /**
   * @private
   */
  _matchWithDeepWildcard(segments) {
    let pathIdx = this.path.length - 1;
    let segIdx = segments.length - 1;
    while (segIdx >= 0 && pathIdx >= 0) {
      const segment = segments[segIdx];
      if (segment.type === "deep-wildcard") {
        segIdx--;
        if (segIdx < 0) {
          return true;
        }
        const nextSeg = segments[segIdx];
        let found = false;
        for (let i = pathIdx; i >= 0; i--) {
          if (this._matchSegment(nextSeg, this.path[i], i === this.path.length - 1)) {
            pathIdx = i - 1;
            segIdx--;
            found = true;
            break;
          }
        }
        if (!found) {
          return false;
        }
      } else {
        if (!this._matchSegment(segment, this.path[pathIdx], pathIdx === this.path.length - 1)) {
          return false;
        }
        pathIdx--;
        segIdx--;
      }
    }
    return segIdx < 0;
  }
  /**
   * @private
   */
  _matchSegment(segment, node, isCurrentNode) {
    if (segment.tag !== "*" && segment.tag !== node.tag) {
      return false;
    }
    if (segment.namespace !== void 0) {
      if (segment.namespace !== "*" && segment.namespace !== node.namespace) {
        return false;
      }
    }
    if (segment.attrName !== void 0) {
      if (!isCurrentNode) {
        return false;
      }
      if (!node.values || !(segment.attrName in node.values)) {
        return false;
      }
      if (segment.attrValue !== void 0) {
        if (String(node.values[segment.attrName]) !== String(segment.attrValue)) {
          return false;
        }
      }
    }
    if (segment.position !== void 0) {
      if (!isCurrentNode) {
        return false;
      }
      const counter = node.counter ?? 0;
      if (segment.position === "first" && counter !== 0) {
        return false;
      } else if (segment.position === "odd" && counter % 2 !== 1) {
        return false;
      } else if (segment.position === "even" && counter % 2 !== 0) {
        return false;
      } else if (segment.position === "nth" && counter !== segment.positionValue) {
        return false;
      }
    }
    return true;
  }
  /**
   * Match any expression in the given set against the current path.
   * @param {ExpressionSet} exprSet
   * @returns {boolean}
   */
  matchesAny(exprSet) {
    return exprSet.matchesAny(this);
  }
  /**
   * Create a snapshot of current state.
   * @returns {Object}
   */
  snapshot() {
    return {
      path: this.path.map((node) => ({ ...node })),
      siblingStacks: this.siblingStacks.map((map) => new Map(map))
    };
  }
  /**
   * Restore state from snapshot.
   * @param {Object} snapshot
   */
  restore(snapshot) {
    this._pathStringCache = null;
    this.path = snapshot.path.map((node) => ({ ...node }));
    this.siblingStacks = snapshot.siblingStacks.map((map) => new Map(map));
  }
  /**
   * Return the read-only {@link MatcherView} for this matcher.
   *
   * The same instance is returned on every call — no allocation occurs.
   * It always reflects the current parser state and is safe to pass to
   * user callbacks without risk of accidental mutation.
   *
   * @returns {MatcherView}
   *
   * @example
   * const view = matcher.readOnly();
   * // pass view to callbacks — it stays in sync automatically
   * view.matches(expr);       // ✓
   * view.getCurrentTag();     // ✓
   * // view.push(...)         // ✗ method does not exist — caught by TypeScript
   */
  readOnly() {
    return this._view;
  }
};

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/xmlparser/OrderedObjParser.js
function extractRawAttributes(prefixedAttrs, options) {
  if (!prefixedAttrs) return {};
  const attrs = options.attributesGroupName ? prefixedAttrs[options.attributesGroupName] : prefixedAttrs;
  if (!attrs) return {};
  const rawAttrs = {};
  for (const key in attrs) {
    if (key.startsWith(options.attributeNamePrefix)) {
      const rawName = key.substring(options.attributeNamePrefix.length);
      rawAttrs[rawName] = attrs[key];
    } else {
      rawAttrs[key] = attrs[key];
    }
  }
  return rawAttrs;
}
function extractNamespace(rawTagName) {
  if (!rawTagName || typeof rawTagName !== "string") return void 0;
  const colonIndex = rawTagName.indexOf(":");
  if (colonIndex !== -1 && colonIndex > 0) {
    const ns = rawTagName.substring(0, colonIndex);
    if (ns !== "xmlns") {
      return ns;
    }
  }
  return void 0;
}
var OrderedObjParser = class {
  constructor(options, externalEntities) {
    this.options = options;
    this.currentNode = null;
    this.tagsNodeStack = [];
    this.parseXml = parseXml;
    this.parseTextData = parseTextData;
    this.resolveNameSpace = resolveNameSpace;
    this.buildAttributesMap = buildAttributesMap;
    this.isItStopNode = isItStopNode;
    this.replaceEntitiesValue = replaceEntitiesValue;
    this.readStopNodeData = readStopNodeData;
    this.saveTextToParentTag = saveTextToParentTag;
    this.addChild = addChild;
    this.ignoreAttributesFn = getIgnoreAttributesFn(this.options.ignoreAttributes);
    this.entityExpansionCount = 0;
    this.currentExpandedLength = 0;
    let namedEntities = { ...XML };
    if (this.options.entityDecoder) {
      this.entityDecoder = this.options.entityDecoder;
    } else {
      if (typeof this.options.htmlEntities === "object") namedEntities = this.options.htmlEntities;
      else if (this.options.htmlEntities === true) namedEntities = { ...COMMON_HTML, ...CURRENCY };
      this.entityDecoder = new EntityDecoder({
        namedEntities: { ...namedEntities, ...externalEntities },
        numericAllowed: this.options.htmlEntities,
        limit: {
          maxTotalExpansions: this.options.processEntities.maxTotalExpansions,
          maxExpandedLength: this.options.processEntities.maxExpandedLength,
          applyLimitsTo: this.options.processEntities.appliesTo
        }
        //postCheck: resolved => resolved
      });
    }
    this.matcher = new Matcher();
    this.readonlyMatcher = this.matcher.readOnly();
    this.isCurrentNodeStopNode = false;
    this.stopNodeExpressionsSet = new ExpressionSet();
    const stopNodesOpts = this.options.stopNodes;
    if (stopNodesOpts && stopNodesOpts.length > 0) {
      for (let i = 0; i < stopNodesOpts.length; i++) {
        const stopNodeExp = stopNodesOpts[i];
        if (typeof stopNodeExp === "string") {
          this.stopNodeExpressionsSet.add(new Expression(stopNodeExp));
        } else if (stopNodeExp instanceof Expression) {
          this.stopNodeExpressionsSet.add(stopNodeExp);
        }
      }
      this.stopNodeExpressionsSet.seal();
    }
  }
};
function parseTextData(val, tagName, jPath, dontTrim, hasAttributes, isLeafNode, escapeEntities) {
  const options = this.options;
  if (val !== void 0) {
    if (options.trimValues && !dontTrim) {
      val = val.trim();
    }
    if (val.length > 0) {
      if (!escapeEntities) val = this.replaceEntitiesValue(val, tagName, jPath);
      const jPathOrMatcher = options.jPath ? jPath.toString() : jPath;
      const newval = options.tagValueProcessor(tagName, val, jPathOrMatcher, hasAttributes, isLeafNode);
      if (newval === null || newval === void 0) {
        return val;
      } else if (typeof newval !== typeof val || newval !== val) {
        return newval;
      } else if (options.trimValues) {
        return parseValue(val, options.parseTagValue, options.numberParseOptions);
      } else {
        const trimmedVal = val.trim();
        if (trimmedVal === val) {
          return parseValue(val, options.parseTagValue, options.numberParseOptions);
        } else {
          return val;
        }
      }
    }
  }
}
function resolveNameSpace(tagname) {
  if (this.options.removeNSPrefix) {
    const tags = tagname.split(":");
    const prefix = tagname.charAt(0) === "/" ? "/" : "";
    if (tags[0] === "xmlns") {
      return "";
    }
    if (tags.length === 2) {
      tagname = prefix + tags[1];
    }
  }
  return tagname;
}
var attrsRegx = new RegExp(`([^\\s=]+)\\s*(=\\s*(['"])([\\s\\S]*?)\\3)?`, "gm");
function buildAttributesMap(attrStr, jPath, tagName, force = false) {
  const options = this.options;
  if (force === true || options.ignoreAttributes !== true && typeof attrStr === "string") {
    const matches = getAllMatches(attrStr, attrsRegx);
    const len = matches.length;
    const attrs = {};
    const processedVals = new Array(len);
    let hasRawAttrs = false;
    const rawAttrsForMatcher = {};
    for (let i = 0; i < len; i++) {
      const attrName = this.resolveNameSpace(matches[i][1]);
      const oldVal = matches[i][4];
      if (attrName.length && oldVal !== void 0) {
        let val = oldVal;
        if (options.trimValues) val = val.trim();
        val = this.replaceEntitiesValue(val, tagName, this.readonlyMatcher);
        processedVals[i] = val;
        rawAttrsForMatcher[attrName] = val;
        hasRawAttrs = true;
      }
    }
    if (hasRawAttrs && typeof jPath === "object" && jPath.updateCurrent) {
      jPath.updateCurrent(rawAttrsForMatcher);
    }
    const jPathStr = options.jPath ? jPath.toString() : this.readonlyMatcher;
    let hasAttrs = false;
    for (let i = 0; i < len; i++) {
      const attrName = this.resolveNameSpace(matches[i][1]);
      if (this.ignoreAttributesFn(attrName, jPathStr)) continue;
      let aName = options.attributeNamePrefix + attrName;
      if (attrName.length) {
        if (options.transformAttributeName) {
          aName = options.transformAttributeName(aName);
        }
        aName = sanitizeName(aName, options);
        if (matches[i][4] !== void 0) {
          const oldVal = processedVals[i];
          const newVal = options.attributeValueProcessor(attrName, oldVal, jPathStr);
          if (newVal === null || newVal === void 0) {
            attrs[aName] = oldVal;
          } else if (typeof newVal !== typeof oldVal || newVal !== oldVal) {
            attrs[aName] = newVal;
          } else {
            attrs[aName] = parseValue(oldVal, options.parseAttributeValue, options.numberParseOptions);
          }
          hasAttrs = true;
        } else if (options.allowBooleanAttributes) {
          attrs[aName] = true;
          hasAttrs = true;
        }
      }
    }
    if (!hasAttrs) return;
    if (options.attributesGroupName && !options.preserveOrder) {
      const attrCollection = {};
      attrCollection[options.attributesGroupName] = attrs;
      return attrCollection;
    }
    return attrs;
  }
}
var parseXml = function(xmlData) {
  xmlData = xmlData.replace(/\r\n?/g, "\n");
  const xmlObj = new XmlNode("!xml");
  let currentNode = xmlObj;
  let textData = "";
  this.matcher.reset();
  this.entityDecoder.reset();
  this.entityExpansionCount = 0;
  this.currentExpandedLength = 0;
  const options = this.options;
  const docTypeReader = new DocTypeReader(options.processEntities);
  const xmlLen = xmlData.length;
  for (let i = 0; i < xmlLen; i++) {
    const ch = xmlData[i];
    if (ch === "<") {
      const c1 = xmlData.charCodeAt(i + 1);
      if (c1 === 47) {
        const closeIndex = findClosingIndex(xmlData, ">", i, "Closing Tag is not closed.");
        let tagName = xmlData.substring(i + 2, closeIndex).trim();
        if (options.removeNSPrefix) {
          const colonIndex = tagName.indexOf(":");
          if (colonIndex !== -1) {
            tagName = tagName.substr(colonIndex + 1);
          }
        }
        tagName = transformTagName(options.transformTagName, tagName, "", options).tagName;
        if (currentNode) {
          textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
        }
        const lastTagName = this.matcher.getCurrentTag();
        if (tagName && options.unpairedTagsSet.has(tagName)) {
          throw new Error(`Unpaired tag can not be used as closing tag: </${tagName}>`);
        }
        if (lastTagName && options.unpairedTagsSet.has(lastTagName)) {
          this.matcher.pop();
          this.tagsNodeStack.pop();
        }
        this.matcher.pop();
        this.isCurrentNodeStopNode = false;
        currentNode = this.tagsNodeStack.pop();
        textData = "";
        i = closeIndex;
      } else if (c1 === 63) {
        let tagData = readTagExp(xmlData, i, false, "?>");
        if (!tagData) throw new Error("Pi Tag is not closed.");
        textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
        const attsMap = this.buildAttributesMap(tagData.tagExp, this.matcher, tagData.tagName, true);
        if (attsMap) {
          const ver = attsMap[this.options.attributeNamePrefix + "version"];
          this.entityDecoder.setXmlVersion(Number(ver) || 1);
          docTypeReader.setXmlVersion(Number(ver) || 1);
        }
        if (options.ignoreDeclaration && tagData.tagName === "?xml" || options.ignorePiTags) {
        } else {
          const childNode = new XmlNode(tagData.tagName);
          childNode.add(options.textNodeName, "");
          if (tagData.tagName !== tagData.tagExp && tagData.attrExpPresent && options.ignoreAttributes !== true) {
            childNode[":@"] = attsMap;
          }
          this.addChild(currentNode, childNode, this.readonlyMatcher, i);
        }
        i = tagData.closeIndex + 1;
      } else if (c1 === 33 && xmlData.charCodeAt(i + 2) === 45 && xmlData.charCodeAt(i + 3) === 45) {
        const endIndex = findClosingIndex(xmlData, "-->", i + 4, "Comment is not closed.");
        if (options.commentPropName) {
          const comment = xmlData.substring(i + 4, endIndex - 2);
          textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
          currentNode.add(options.commentPropName, [{ [options.textNodeName]: comment }]);
        }
        i = endIndex;
      } else if (c1 === 33 && xmlData.charCodeAt(i + 2) === 68) {
        const result = docTypeReader.readDocType(xmlData, i);
        this.entityDecoder.addInputEntities(result.entities);
        i = result.i;
      } else if (c1 === 33 && xmlData.charCodeAt(i + 2) === 91) {
        const closeIndex = findClosingIndex(xmlData, "]]>", i, "CDATA is not closed.") - 2;
        const tagExp = xmlData.substring(i + 9, closeIndex);
        textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
        let val = this.parseTextData(tagExp, currentNode.tagname, this.readonlyMatcher, true, false, true, true);
        if (val == void 0) val = "";
        if (options.cdataPropName) {
          currentNode.add(options.cdataPropName, [{ [options.textNodeName]: tagExp }]);
        } else {
          currentNode.add(options.textNodeName, val);
        }
        i = closeIndex + 2;
      } else {
        let result = readTagExp(xmlData, i, options.removeNSPrefix);
        if (!result) {
          const context = xmlData.substring(Math.max(0, i - 50), Math.min(xmlLen, i + 50));
          throw new Error(`readTagExp returned undefined at position ${i}. Context: "${context}"`);
        }
        let tagName = result.tagName;
        const rawTagName = result.rawTagName;
        let tagExp = result.tagExp;
        let attrExpPresent = result.attrExpPresent;
        let closeIndex = result.closeIndex;
        ({ tagName, tagExp } = transformTagName(options.transformTagName, tagName, tagExp, options));
        if (options.strictReservedNames && (tagName === options.commentPropName || tagName === options.cdataPropName || tagName === options.textNodeName || tagName === options.attributesGroupName)) {
          throw new Error(`Invalid tag name: ${tagName}`);
        }
        if (currentNode && textData) {
          if (currentNode.tagname !== "!xml") {
            textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher, false);
          }
        }
        const lastTag = currentNode;
        if (lastTag && options.unpairedTagsSet.has(lastTag.tagname)) {
          currentNode = this.tagsNodeStack.pop();
          this.matcher.pop();
        }
        let isSelfClosing = false;
        if (tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1) {
          isSelfClosing = true;
          if (tagName[tagName.length - 1] === "/") {
            tagName = tagName.substr(0, tagName.length - 1);
            tagExp = tagName;
          } else {
            tagExp = tagExp.substr(0, tagExp.length - 1);
          }
          attrExpPresent = tagName !== tagExp;
        }
        let prefixedAttrs = null;
        let rawAttrs = {};
        let namespace = void 0;
        namespace = extractNamespace(rawTagName);
        if (tagName !== xmlObj.tagname) {
          this.matcher.push(tagName, {}, namespace);
        }
        if (tagName !== tagExp && attrExpPresent) {
          prefixedAttrs = this.buildAttributesMap(tagExp, this.matcher, tagName);
          if (prefixedAttrs) {
            rawAttrs = extractRawAttributes(prefixedAttrs, options);
          }
        }
        if (tagName !== xmlObj.tagname) {
          this.isCurrentNodeStopNode = this.isItStopNode();
        }
        const startIndex = i;
        if (this.isCurrentNodeStopNode) {
          let tagContent = "";
          if (isSelfClosing) {
            i = result.closeIndex;
          } else if (options.unpairedTagsSet.has(tagName)) {
            i = result.closeIndex;
          } else {
            const result2 = this.readStopNodeData(xmlData, rawTagName, closeIndex + 1);
            if (!result2) throw new Error(`Unexpected end of ${rawTagName}`);
            i = result2.i;
            tagContent = result2.tagContent;
          }
          const childNode = new XmlNode(tagName);
          if (prefixedAttrs) {
            childNode[":@"] = prefixedAttrs;
          }
          childNode.add(options.textNodeName, tagContent);
          this.matcher.pop();
          this.isCurrentNodeStopNode = false;
          this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
        } else {
          if (isSelfClosing) {
            ({ tagName, tagExp } = transformTagName(options.transformTagName, tagName, tagExp, options));
            const childNode = new XmlNode(tagName);
            if (prefixedAttrs) {
              childNode[":@"] = prefixedAttrs;
            }
            this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
            this.matcher.pop();
            this.isCurrentNodeStopNode = false;
          } else if (options.unpairedTagsSet.has(tagName)) {
            const childNode = new XmlNode(tagName);
            if (prefixedAttrs) {
              childNode[":@"] = prefixedAttrs;
            }
            this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
            this.matcher.pop();
            this.isCurrentNodeStopNode = false;
            i = result.closeIndex;
            continue;
          } else {
            const childNode = new XmlNode(tagName);
            if (this.tagsNodeStack.length > options.maxNestedTags) {
              throw new Error("Maximum nested tags exceeded");
            }
            this.tagsNodeStack.push(currentNode);
            if (prefixedAttrs) {
              childNode[":@"] = prefixedAttrs;
            }
            this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
            currentNode = childNode;
          }
          textData = "";
          i = closeIndex;
        }
      }
    } else {
      textData += xmlData[i];
    }
  }
  return xmlObj.child;
};
function addChild(currentNode, childNode, matcher, startIndex) {
  if (!this.options.captureMetaData) startIndex = void 0;
  const jPathOrMatcher = this.options.jPath ? matcher.toString() : matcher;
  const result = this.options.updateTag(childNode.tagname, jPathOrMatcher, childNode[":@"]);
  if (result === false) {
  } else if (typeof result === "string") {
    childNode.tagname = result;
    currentNode.addChild(childNode, startIndex);
  } else {
    currentNode.addChild(childNode, startIndex);
  }
}
function replaceEntitiesValue(val, tagName, jPath) {
  const entityConfig = this.options.processEntities;
  if (!entityConfig || !entityConfig.enabled) {
    return val;
  }
  if (entityConfig.allowedTags) {
    const jPathOrMatcher = this.options.jPath ? jPath.toString() : jPath;
    const allowed = Array.isArray(entityConfig.allowedTags) ? entityConfig.allowedTags.includes(tagName) : entityConfig.allowedTags(tagName, jPathOrMatcher);
    if (!allowed) {
      return val;
    }
  }
  if (entityConfig.tagFilter) {
    const jPathOrMatcher = this.options.jPath ? jPath.toString() : jPath;
    if (!entityConfig.tagFilter(tagName, jPathOrMatcher)) {
      return val;
    }
  }
  return this.entityDecoder.decode(val);
}
function saveTextToParentTag(textData, parentNode, matcher, isLeafNode) {
  if (textData) {
    if (isLeafNode === void 0) isLeafNode = parentNode.child.length === 0;
    textData = this.parseTextData(
      textData,
      parentNode.tagname,
      matcher,
      false,
      parentNode[":@"] ? Object.keys(parentNode[":@"]).length !== 0 : false,
      isLeafNode
    );
    if (textData !== void 0 && textData !== "")
      parentNode.add(this.options.textNodeName, textData);
    textData = "";
  }
  return textData;
}
function isItStopNode() {
  if (this.stopNodeExpressionsSet.size === 0) return false;
  return this.matcher.matchesAny(this.stopNodeExpressionsSet);
}
function tagExpWithClosingIndex(xmlData, i, closingChar = ">") {
  let attrBoundary = 0;
  const len = xmlData.length;
  const closeCode0 = closingChar.charCodeAt(0);
  const closeCode1 = closingChar.length > 1 ? closingChar.charCodeAt(1) : -1;
  let result = "";
  let segmentStart = i;
  for (let index = i; index < len; index++) {
    const code = xmlData.charCodeAt(index);
    if (attrBoundary) {
      if (code === attrBoundary) attrBoundary = 0;
    } else if (code === 34 || code === 39) {
      attrBoundary = code;
    } else if (code === closeCode0) {
      if (closeCode1 !== -1) {
        if (xmlData.charCodeAt(index + 1) === closeCode1) {
          result += xmlData.substring(segmentStart, index);
          return { data: result, index };
        }
      } else {
        result += xmlData.substring(segmentStart, index);
        return { data: result, index };
      }
    } else if (code === 9 && !attrBoundary) {
      result += xmlData.substring(segmentStart, index) + " ";
      segmentStart = index + 1;
    }
  }
}
function findClosingIndex(xmlData, str, i, errMsg) {
  const closingIndex = xmlData.indexOf(str, i);
  if (closingIndex === -1) {
    throw new Error(errMsg);
  } else {
    return closingIndex + str.length - 1;
  }
}
function findClosingChar(xmlData, char, i, errMsg) {
  const closingIndex = xmlData.indexOf(char, i);
  if (closingIndex === -1) throw new Error(errMsg);
  return closingIndex;
}
function readTagExp(xmlData, i, removeNSPrefix, closingChar = ">") {
  const result = tagExpWithClosingIndex(xmlData, i + 1, closingChar);
  if (!result) return;
  let tagExp = result.data;
  const closeIndex = result.index;
  const separatorIndex = tagExp.search(/\s/);
  let tagName = tagExp;
  let attrExpPresent = true;
  if (separatorIndex !== -1) {
    tagName = tagExp.substring(0, separatorIndex);
    tagExp = tagExp.substring(separatorIndex + 1).trimStart();
  }
  const rawTagName = tagName;
  if (removeNSPrefix) {
    const colonIndex = tagName.indexOf(":");
    if (colonIndex !== -1) {
      tagName = tagName.substr(colonIndex + 1);
      attrExpPresent = tagName !== result.data.substr(colonIndex + 1);
    }
  }
  return {
    tagName,
    tagExp,
    closeIndex,
    attrExpPresent,
    rawTagName
  };
}
function readStopNodeData(xmlData, tagName, i) {
  const startIndex = i;
  let openTagCount = 1;
  const xmllen = xmlData.length;
  for (; i < xmllen; i++) {
    if (xmlData[i] === "<") {
      const c1 = xmlData.charCodeAt(i + 1);
      if (c1 === 47) {
        const closeIndex = findClosingChar(xmlData, ">", i, `${tagName} is not closed`);
        let closeTagName = xmlData.substring(i + 2, closeIndex).trim();
        if (closeTagName === tagName) {
          openTagCount--;
          if (openTagCount === 0) {
            return {
              tagContent: xmlData.substring(startIndex, i),
              i: closeIndex
            };
          }
        }
        i = closeIndex;
      } else if (c1 === 63) {
        const closeIndex = findClosingIndex(xmlData, "?>", i + 1, "StopNode is not closed.");
        i = closeIndex;
      } else if (c1 === 33 && xmlData.charCodeAt(i + 2) === 45 && xmlData.charCodeAt(i + 3) === 45) {
        const closeIndex = findClosingIndex(xmlData, "-->", i + 3, "StopNode is not closed.");
        i = closeIndex;
      } else if (c1 === 33 && xmlData.charCodeAt(i + 2) === 91) {
        const closeIndex = findClosingIndex(xmlData, "]]>", i, "StopNode is not closed.") - 2;
        i = closeIndex;
      } else {
        const tagData = readTagExp(xmlData, i, false);
        if (tagData) {
          const openTagName = tagData && tagData.tagName;
          if (openTagName === tagName && tagData.tagExp[tagData.tagExp.length - 1] !== "/") {
            openTagCount++;
          }
          i = tagData.closeIndex;
        }
      }
    }
  }
}
function parseValue(val, shouldParse, options) {
  if (shouldParse && typeof val === "string") {
    const newval = val.trim();
    if (newval === "true") return true;
    else if (newval === "false") return false;
    else return toNumber(val, options);
  } else {
    if (isExist(val)) {
      return val;
    } else {
      return "";
    }
  }
}
function transformTagName(fn, tagName, tagExp, options) {
  if (fn) {
    const newTagName = fn(tagName);
    if (tagExp === tagName) {
      tagExp = newTagName;
    }
    tagName = newTagName;
  }
  tagName = sanitizeName(tagName, options);
  return { tagName, tagExp };
}
function sanitizeName(name, options) {
  if (criticalProperties.includes(name)) {
    throw new Error(`[SECURITY] Invalid name: "${name}" is a reserved JavaScript keyword that could cause prototype pollution`);
  } else if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
    return options.onDangerousProperty(name);
  }
  return name;
}

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/xmlparser/node2json.js
var METADATA_SYMBOL2 = XmlNode.getMetaDataSymbol();
function stripAttributePrefix(attrs, prefix) {
  if (!attrs || typeof attrs !== "object") return {};
  if (!prefix) return attrs;
  const rawAttrs = {};
  for (const key in attrs) {
    if (key.startsWith(prefix)) {
      const rawName = key.substring(prefix.length);
      rawAttrs[rawName] = attrs[key];
    } else {
      rawAttrs[key] = attrs[key];
    }
  }
  return rawAttrs;
}
function prettify(node, options, matcher, readonlyMatcher) {
  return compress(node, options, matcher, readonlyMatcher);
}
function compress(arr, options, matcher, readonlyMatcher) {
  let text;
  const compressedObj = {};
  for (let i = 0; i < arr.length; i++) {
    const tagObj = arr[i];
    const property = propName(tagObj);
    if (property !== void 0 && property !== options.textNodeName) {
      const rawAttrs = stripAttributePrefix(
        tagObj[":@"] || {},
        options.attributeNamePrefix
      );
      matcher.push(property, rawAttrs);
    }
    if (property === options.textNodeName) {
      if (text === void 0) text = tagObj[property];
      else text += "" + tagObj[property];
    } else if (property === void 0) {
      continue;
    } else if (tagObj[property]) {
      let val = compress(tagObj[property], options, matcher, readonlyMatcher);
      const isLeaf = isLeafTag(val, options);
      if (Object.keys(val).length === 0 && options.alwaysCreateTextNode) {
        val[options.textNodeName] = "";
      }
      if (tagObj[":@"]) {
        assignAttributes(val, tagObj[":@"], readonlyMatcher, options);
      } else if (Object.keys(val).length === 1 && val[options.textNodeName] !== void 0 && !options.alwaysCreateTextNode) {
        val = val[options.textNodeName];
      } else if (Object.keys(val).length === 0) {
        if (options.alwaysCreateTextNode) val[options.textNodeName] = "";
        else val = "";
      }
      if (tagObj[METADATA_SYMBOL2] !== void 0 && typeof val === "object" && val !== null) {
        val[METADATA_SYMBOL2] = tagObj[METADATA_SYMBOL2];
      }
      if (compressedObj[property] !== void 0 && Object.prototype.hasOwnProperty.call(compressedObj, property)) {
        if (!Array.isArray(compressedObj[property])) {
          compressedObj[property] = [compressedObj[property]];
        }
        compressedObj[property].push(val);
      } else {
        const jPathOrMatcher = options.jPath ? readonlyMatcher.toString() : readonlyMatcher;
        if (options.isArray(property, jPathOrMatcher, isLeaf)) {
          compressedObj[property] = [val];
        } else {
          compressedObj[property] = val;
        }
      }
      if (property !== void 0 && property !== options.textNodeName) {
        matcher.pop();
      }
    }
  }
  if (typeof text === "string") {
    if (text.length > 0) compressedObj[options.textNodeName] = text;
  } else if (text !== void 0) compressedObj[options.textNodeName] = text;
  return compressedObj;
}
function propName(obj) {
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key !== ":@") return key;
  }
}
function assignAttributes(obj, attrMap, readonlyMatcher, options) {
  if (attrMap) {
    const keys = Object.keys(attrMap);
    const len = keys.length;
    for (let i = 0; i < len; i++) {
      const atrrName = keys[i];
      const rawAttrName = atrrName.startsWith(options.attributeNamePrefix) ? atrrName.substring(options.attributeNamePrefix.length) : atrrName;
      const jPathOrMatcher = options.jPath ? readonlyMatcher.toString() + "." + rawAttrName : readonlyMatcher;
      if (options.isArray(atrrName, jPathOrMatcher, true, true)) {
        obj[atrrName] = [attrMap[atrrName]];
      } else {
        obj[atrrName] = attrMap[atrrName];
      }
    }
  }
}
function isLeafTag(obj, options) {
  const { textNodeName } = options;
  const propCount = Object.keys(obj).length;
  if (propCount === 0) {
    return true;
  }
  if (propCount === 1 && (obj[textNodeName] || typeof obj[textNodeName] === "boolean" || obj[textNodeName] === 0)) {
    return true;
  }
  return false;
}

// ../../node_modules/.pnpm/fast-xml-parser@5.8.0/node_modules/fast-xml-parser/src/xmlparser/XMLParser.js
var XMLParser = class {
  constructor(options) {
    this.externalEntities = {};
    this.options = buildOptions(options);
  }
  /**
   * Parse XML dats to JS object 
   * @param {string|Uint8Array} xmlData 
   * @param {boolean|Object} validationOption 
   */
  parse(xmlData, validationOption) {
    if (typeof xmlData !== "string" && xmlData.toString) {
      xmlData = xmlData.toString();
    } else if (typeof xmlData !== "string") {
      throw new Error("XML data is accepted in String or Bytes[] form.");
    }
    if (validationOption) {
      if (validationOption === true) validationOption = {};
      const result = validate(xmlData, validationOption);
      if (result !== true) {
        throw Error(`${result.err.msg}:${result.err.line}:${result.err.col}`);
      }
    }
    const orderedObjParser = new OrderedObjParser(this.options, this.externalEntities);
    const orderedResult = orderedObjParser.parseXml(xmlData);
    if (this.options.preserveOrder || orderedResult === void 0) return orderedResult;
    else return prettify(orderedResult, this.options, orderedObjParser.matcher, orderedObjParser.readonlyMatcher);
  }
  /**
   * Add Entity which is not by default supported by this library
   * @param {string} key 
   * @param {string} value 
   */
  addEntity(key, value) {
    if (value.indexOf("&") !== -1) {
      throw new Error("Entity value can't have '&'");
    } else if (key.indexOf("&") !== -1 || key.indexOf(";") !== -1) {
      throw new Error("An entity must be set without '&' and ';'. Eg. use '#xD' for '&#xD;'");
    } else if (value === "&") {
      throw new Error("An entity with value '&' is not permitted");
    } else {
      this.externalEntities[key] = value;
    }
  }
  /**
   * Returns a Symbol that can be used to access the metadata
   * property on a node.
   * 
   * If Symbol is not available in the environment, an ordinary property is used
   * and the name of the property is here returned.
   * 
   * The XMLMetaData property is only present when `captureMetaData`
   * is true in the options.
   */
  static getMetaDataSymbol() {
    return XmlNode.getMetaDataSymbol();
  }
};

// ../../node_modules/.pnpm/ua-parser-js@2.0.9/node_modules/ua-parser-js/src/main/ua-parser.mjs
var LIBVERSION = "2.0.9";
var UA_MAX_LENGTH = 500;
var USER_AGENT = "user-agent";
var EMPTY = "";
var UNKNOWN = "?";
var TYPEOF = {
  FUNCTION: "function",
  OBJECT: "object",
  STRING: "string",
  UNDEFINED: "undefined"
};
var BROWSER = "browser";
var CPU = "cpu";
var DEVICE = "device";
var ENGINE = "engine";
var OS = "os";
var RESULT = "result";
var NAME = "name";
var TYPE2 = "type";
var VENDOR = "vendor";
var VERSION = "version";
var ARCHITECTURE = "architecture";
var MAJOR = "major";
var MODEL = "model";
var CONSOLE = "console";
var MOBILE = "mobile";
var TABLET = "tablet";
var SMARTTV = "smarttv";
var WEARABLE = "wearable";
var XR = "xr";
var EMBEDDED = "embedded";
var FETCHER = "fetcher";
var INAPP = "inapp";
var BRANDS = "brands";
var FORMFACTORS = "formFactors";
var FULLVERLIST = "fullVersionList";
var PLATFORM = "platform";
var PLATFORMVER = "platformVersion";
var BITNESS = "bitness";
var CH = "sec-ch-ua";
var CH_FULL_VER_LIST = CH + "-full-version-list";
var CH_ARCH = CH + "-arch";
var CH_BITNESS = CH + "-" + BITNESS;
var CH_FORM_FACTORS = CH + "-form-factors";
var CH_MOBILE = CH + "-" + MOBILE;
var CH_MODEL = CH + "-" + MODEL;
var CH_PLATFORM = CH + "-" + PLATFORM;
var CH_PLATFORM_VER = CH_PLATFORM + "-version";
var CH_ALL_VALUES = [BRANDS, FULLVERLIST, MOBILE, MODEL, PLATFORM, PLATFORMVER, ARCHITECTURE, FORMFACTORS, BITNESS];
var AMAZON = "Amazon";
var APPLE = "Apple";
var ASUS = "ASUS";
var BLACKBERRY = "BlackBerry";
var GOOGLE = "Google";
var HUAWEI = "Huawei";
var LENOVO = "Lenovo";
var HONOR = "Honor";
var LG = "LG";
var MICROSOFT = "Microsoft";
var MOTOROLA = "Motorola";
var NVIDIA = "Nvidia";
var ONEPLUS = "OnePlus";
var OPPO = "OPPO";
var SAMSUNG = "Samsung";
var SHARP = "Sharp";
var SONY = "Sony";
var XIAOMI = "Xiaomi";
var ZEBRA = "Zebra";
var CHROME = "Chrome";
var CHROMIUM = "Chromium";
var CHROMECAST = "Chromecast";
var EDGE = "Edge";
var FIREFOX = "Firefox";
var OPERA = "Opera";
var FACEBOOK = "Facebook";
var SOGOU = "Sogou";
var PREFIX_MOBILE = "Mobile ";
var SUFFIX_BROWSER = " Browser";
var WINDOWS = "Windows";
var isWindow = typeof window !== TYPEOF.UNDEFINED;
var NAVIGATOR = isWindow && window.navigator ? window.navigator : void 0;
var NAVIGATOR_UADATA = NAVIGATOR && NAVIGATOR.userAgentData ? NAVIGATOR.userAgentData : void 0;
var extend = function(defaultRgx, extensions) {
  var mergedRgx = {};
  var extraRgx = extensions;
  if (!isExtensions(extensions)) {
    extraRgx = {};
    for (var i in extensions) {
      for (var j in extensions[i]) {
        extraRgx[j] = extensions[i][j].concat(extraRgx[j] ? extraRgx[j] : []);
      }
    }
  }
  for (var k in defaultRgx) {
    mergedRgx[k] = extraRgx[k] && extraRgx[k].length % 2 === 0 ? extraRgx[k].concat(defaultRgx[k]) : defaultRgx[k];
  }
  return mergedRgx;
};
var enumerize = function(arr) {
  var enums = {};
  for (var i = 0; i < arr.length; i++) {
    enums[arr[i].toUpperCase()] = arr[i];
  }
  return enums;
};
var has = function(str1, str2) {
  if (typeof str1 === TYPEOF.OBJECT && str1.length > 0) {
    for (var i in str1) {
      if (lowerize(str2) == lowerize(str1[i])) return true;
    }
    return false;
  }
  return isString(str1) ? lowerize(str2) == lowerize(str1) : false;
};
var isExtensions = function(obj, deep) {
  for (var prop in obj) {
    return /^(browser|cpu|device|engine|os)$/.test(prop) || (deep ? isExtensions(obj[prop]) : false);
  }
};
var isString = function(val) {
  return typeof val === TYPEOF.STRING;
};
var itemListToArray = function(header) {
  if (!header) return void 0;
  var arr = [];
  var tokens = strip(/\\?\"/g, header).split(",");
  for (var i = 0; i < tokens.length; i++) {
    if (tokens[i].indexOf(";") > -1) {
      var token = trim(tokens[i]).split(";v=");
      arr[i] = { brand: token[0], version: token[1] };
    } else {
      arr[i] = trim(tokens[i]);
    }
  }
  return arr;
};
var lowerize = function(str) {
  return isString(str) ? str.toLowerCase() : str;
};
var majorize = function(version) {
  return isString(version) ? strip(/[^\d\.]/g, version).split(".")[0] : void 0;
};
var setProps = function(arr) {
  for (var i in arr) {
    if (!arr.hasOwnProperty(i)) continue;
    var propName2 = arr[i];
    if (typeof propName2 == TYPEOF.OBJECT && propName2.length == 2) {
      this[propName2[0]] = propName2[1];
    } else {
      this[propName2] = void 0;
    }
  }
  return this;
};
var strip = function(pattern, str) {
  return isString(str) ? str.replace(pattern, EMPTY) : str;
};
var stripQuotes = function(str) {
  return strip(/\\?\"/g, str);
};
var trim = function(str, len) {
  str = strip(/^\s\s*/, String(str));
  return typeof len === TYPEOF.UNDEFINED ? str : str.substring(0, len);
};
var rgxMapper = function(ua, arrays) {
  if (!ua || !arrays) return;
  var i = 0, j, k, p, q, matches, match;
  while (i < arrays.length && !matches) {
    var regex = arrays[i], props = arrays[i + 1];
    j = k = 0;
    while (j < regex.length && !matches) {
      if (!regex[j]) {
        break;
      }
      matches = regex[j++].exec(ua);
      if (!!matches) {
        for (p = 0; p < props.length; p++) {
          match = matches[++k];
          q = props[p];
          if (typeof q === TYPEOF.OBJECT && q.length > 0) {
            if (q.length === 2) {
              if (typeof q[1] == TYPEOF.FUNCTION) {
                this[q[0]] = q[1].call(this, match);
              } else {
                this[q[0]] = q[1];
              }
            } else if (q.length >= 3) {
              if (typeof q[1] === TYPEOF.FUNCTION && !(q[1].exec && q[1].test)) {
                if (q.length > 3) {
                  this[q[0]] = match ? q[1].apply(this, q.slice(2)) : void 0;
                } else {
                  this[q[0]] = match ? q[1].call(this, match, q[2]) : void 0;
                }
              } else {
                if (q.length == 3) {
                  this[q[0]] = match ? match.replace(q[1], q[2]) : void 0;
                } else if (q.length == 4) {
                  this[q[0]] = match ? q[3].call(this, match.replace(q[1], q[2])) : void 0;
                } else if (q.length > 4) {
                  this[q[0]] = match ? q[3].apply(this, [match.replace(q[1], q[2])].concat(q.slice(4))) : void 0;
                }
              }
            }
          } else {
            this[q] = match ? match : void 0;
          }
        }
      }
    }
    i += 2;
  }
};
var strMapper = function(str, map) {
  for (var i in map) {
    if (typeof map[i] === TYPEOF.OBJECT && map[i].length > 0) {
      for (var j = 0; j < map[i].length; j++) {
        if (has(map[i][j], str)) {
          return i === UNKNOWN ? void 0 : i;
        }
      }
    } else if (has(map[i], str)) {
      return i === UNKNOWN ? void 0 : i;
    }
  }
  return map.hasOwnProperty("*") ? map["*"] : str;
};
var windowsVersionMap = {
  "ME": "4.90",
  "NT 3.51": "3.51",
  "NT 4.0": "4.0",
  "2000": ["5.0", "5.01"],
  "XP": ["5.1", "5.2"],
  "Vista": "6.0",
  "7": "6.1",
  "8": "6.2",
  "8.1": "6.3",
  "10": ["6.4", "10.0"],
  "NT": ""
};
var formFactorsMap = {
  "embedded": "Automotive",
  "mobile": "Mobile",
  "tablet": ["Tablet", "EInk"],
  "smarttv": "TV",
  "wearable": "Watch",
  "xr": ["VR", "XR"],
  "?": ["Desktop", "Unknown"],
  "*": void 0
};
var browserHintsMap = {
  "Chrome": "Google Chrome",
  "Edge": "Microsoft Edge",
  "Edge WebView2": "Microsoft Edge WebView2",
  "Chrome WebView": "Android WebView",
  "Chrome Headless": "HeadlessChrome",
  "Huawei Browser": "HuaweiBrowser",
  "MIUI Browser": "Miui Browser",
  "Opera Mobi": "OperaMobile",
  "Yandex": "YaBrowser"
};
var defaultRegexes = {
  browser: [
    [
      // Most common regardless engine
      /\b(?:crmo|crios)\/([\w\.]+)/i
      // Chrome for Android/iOS
    ],
    [VERSION, [NAME, PREFIX_MOBILE + "Chrome"]],
    [
      /webview.+edge\/([\w\.]+)/i
      // Microsoft Edge
    ],
    [VERSION, [NAME, EDGE + " WebView"]],
    [
      /edg(?:e|ios|a)?\/([\w\.]+)/i
    ],
    [VERSION, [NAME, "Edge"]],
    [
      // Presto based
      /(opera mini)\/([-\w\.]+)/i,
      // Opera Mini
      /(opera [mobiletab]{3,6})\b.+version\/([-\w\.]+)/i,
      // Opera Mobi/Tablet
      /(opera)(?:.+version\/|[\/ ]+)([\w\.]+)/i
      // Opera
    ],
    [NAME, VERSION],
    [
      /opios[\/ ]+([\w\.]+)/i
      // Opera mini on iphone >= 8.0
    ],
    [VERSION, [NAME, OPERA + " Mini"]],
    [
      /\bop(?:rg)?x\/([\w\.]+)/i
      // Opera GX
    ],
    [VERSION, [NAME, OPERA + " GX"]],
    [
      /\bopr\/([\w\.]+)/i
      // Opera Webkit
    ],
    [VERSION, [NAME, OPERA]],
    [
      // Mixed
      /\bb[ai]*d(?:uhd|[ub]*[aekoprswx]{5,6})[\/ ]?([\w\.]+)/i
      // Baidu
    ],
    [VERSION, [NAME, "Baidu"]],
    [
      /\b(?:mxbrowser|mxios|myie2)\/?([-\w\.]*)\b/i
      // Maxthon
    ],
    [VERSION, [NAME, "Maxthon"]],
    [
      /(kindle)\/([\w\.]+)/i,
      // Kindle
      /(lunascape|maxthon|netfront|jasmine|blazer|sleipnir)[\/ ]?([\w\.]*)/i,
      // Lunascape/Maxthon/Netfront/Jasmine/Blazer/Sleipnir
      // Trident based
      /(avant|iemobile|slim(?:browser|boat|jet))[\/ ]?([\d\.]*)/i,
      // Avant/IEMobile/SlimBrowser/SlimBoat/Slimjet
      /(?:ms|\()(ie) ([\w\.]+)/i,
      // Internet Explorer
      // Blink/Webkit/KHTML based                                         // Flock/RockMelt/Midori/Epiphany/Silk/Skyfire/Bolt/Iron/Iridium/PhantomJS/Bowser/QupZilla/Falkon/LG Browser/Otter/qutebrowser/Dooble/Palemoon/HiBrowser
      /(atlas|flock|rockmelt|midori|epiphany|silk|skyfire|bolt|iron|vivaldi|iridium|phantomjs|bowser|qupzilla|falkon|rekonq|puffin|whale(?!.+naver)|qqbrowserlite|duckduckgo|klar|helio|(?=comodo_)?dragon|otter|dooble|(?:hi|lg |ovi|qute)browser|palemoon)\/v?([-\w\.]+)/i,
      // Atlas/Rekonq/Puffin/Whale/QQBrowserLite/QQ//Vivaldi/DuckDuckGo/Klar/Helio/Dragon
      /(brave)(?: chrome)?\/([\d\.]+)/i,
      // Brave
      /(aloha|heytap|ovi|115|surf|qwant)browser\/([\d\.]+)/i,
      // Aloha/HeyTap/Ovi/115/Surf
      /(qwant)(?:ios|mobile)\/([\d\.]+)/i,
      // Qwant
      /(ecosia|weibo)(?:__| \w+@)([\d\.]+)/i
      // Ecosia/Weibo
    ],
    [NAME, VERSION],
    [
      /quark(?:pc)?\/([-\w\.]+)/i
      // Quark
    ],
    [VERSION, [NAME, "Quark"]],
    [
      /\bddg\/([\w\.]+)/i
      // DuckDuckGo
    ],
    [VERSION, [NAME, "DuckDuckGo"]],
    [
      /(?:\buc? ?browser|(?:juc.+)ucweb)[\/ ]?([\w\.]+)/i
      // UCBrowser
    ],
    [VERSION, [NAME, "UCBrowser"]],
    [
      /microm.+\bqbcore\/([\w\.]+)/i,
      // WeChat Desktop for Windows Built-in Browser
      /\bqbcore\/([\w\.]+).+microm/i,
      /micromessenger\/([\w\.]+)/i
      // WeChat
    ],
    [VERSION, [NAME, "WeChat"]],
    [
      /konqueror\/([\w\.]+)/i
      // Konqueror
    ],
    [VERSION, [NAME, "Konqueror"]],
    [
      /trident.+rv[: ]([\w\.]{1,9})\b.+like gecko/i
      // IE11
    ],
    [VERSION, [NAME, "IE"]],
    [
      /ya(?:search)?browser\/([\w\.]+)/i
      // Yandex
    ],
    [VERSION, [NAME, "Yandex"]],
    [
      /slbrowser\/([\w\.]+)/i
      // Smart Lenovo Browser
    ],
    [VERSION, [NAME, "Smart " + LENOVO + SUFFIX_BROWSER]],
    [
      /(av(?:ast|g|ira))\/([\w\.]+)/i
      // Avast/AVG/Avira Secure Browser
    ],
    [[NAME, /(.+)/, "$1 Secure" + SUFFIX_BROWSER], VERSION],
    [
      /norton\/([\w\.]+)/i
      // Norton Private Browser
    ],
    [VERSION, [NAME, "Norton Private" + SUFFIX_BROWSER]],
    [
      /\bfocus\/([\w\.]+)/i
      // Firefox Focus
    ],
    [VERSION, [NAME, FIREFOX + " Focus"]],
    [
      / mms\/([\w\.]+)$/i
      // Opera Neon
    ],
    [VERSION, [NAME, OPERA + " Neon"]],
    [
      / opt\/([\w\.]+)$/i
      // Opera Touch
    ],
    [VERSION, [NAME, OPERA + " Touch"]],
    [
      /coc_coc\w+\/([\w\.]+)/i
      // Coc Coc Browser
    ],
    [VERSION, [NAME, "Coc Coc"]],
    [
      /dolfin\/([\w\.]+)/i
      // Dolphin
    ],
    [VERSION, [NAME, "Dolphin"]],
    [
      /coast\/([\w\.]+)/i
      // Opera Coast
    ],
    [VERSION, [NAME, OPERA + " Coast"]],
    [
      /miuibrowser\/([\w\.]+)/i
      // MIUI Browser
    ],
    [VERSION, [NAME, "MIUI" + SUFFIX_BROWSER]],
    [
      /fxios\/([\w\.-]+)/i
      // Firefox for iOS
    ],
    [VERSION, [NAME, PREFIX_MOBILE + FIREFOX]],
    [
      /\bqihoobrowser\/?([\w\.]*)/i
      // 360
    ],
    [VERSION, [NAME, "360"]],
    [
      /\b(qq)\/([\w\.]+)/i
      // QQ
    ],
    [[NAME, /(.+)/, "$1Browser"], VERSION],
    [
      /(oculus|sailfish|huawei|vivo|pico)browser\/([\w\.]+)/i
    ],
    [[NAME, /(.+)/, "$1" + SUFFIX_BROWSER], VERSION],
    [
      // Oculus/Sailfish/HuaweiBrowser/VivoBrowser/PicoBrowser
      /samsungbrowser\/([\w\.]+)/i
      // Samsung Internet
    ],
    [VERSION, [NAME, SAMSUNG + " Internet"]],
    [
      /metasr[\/ ]?([\d\.]+)/i
      // Sogou Explorer
    ],
    [VERSION, [NAME, SOGOU + " Explorer"]],
    [
      /(sogou)mo\w+\/([\d\.]+)/i
      // Sogou Mobile
    ],
    [[NAME, SOGOU + " Mobile"], VERSION],
    [
      /(electron)\/([\w\.]+) safari/i,
      // Electron-based App
      /(tesla)(?: qtcarbrowser|\/(20\d\d\.[-\w\.]+))/i,
      // Tesla
      /m?(qqbrowser|2345(?=browser|chrome|explorer))\w*[\/ ]?v?([\w\.]+)/i
      // QQ/2345
    ],
    [NAME, VERSION],
    [
      /(lbbrowser|luakit|rekonq|steam(?= (clie|tenf|gameo)))/i
      // LieBao Browser/Luakit/Rekonq/Steam
    ],
    [NAME],
    [
      /ome\/([\w\.]+).+(iron(?= saf)|360(?=[es]e$))/i
      // Iron / 360
    ],
    [VERSION, NAME],
    [
      // WebView
      /((?:fban\/fbios|fb_iab\/fb4a)(?!.+fbav)|;fbav\/([\w\.]+);)/i
      // Facebook App for iOS & Android
    ],
    [[NAME, FACEBOOK], VERSION, [TYPE2, INAPP]],
    [
      /(kakao(?:talk|story))[\/ ]([\w\.]+)/i,
      // Kakao App
      /(naver)\(.*?(\d+\.[\w\.]+).*\)/i,
      // Naver InApp
      /(daum)apps[\/ ]([\w\.]+)/i,
      // Daum App
      /safari (line)\/([\w\.]+)/i,
      // Line App for iOS
      /\b(line)\/([\w\.]+)\/iab/i,
      // Line App for Android
      /(alipay)client\/([\w\.]+)/i,
      // Alipay
      /(twitter)(?:and| f.+e\/([\w\.]+))/i,
      // Twitter
      /(bing)(?:web|sapphire)\/([\w\.]+)/i,
      // Bing
      /(instagram|snapchat|klarna)[\/ ]([-\w\.]+)/i
      // Instagram/Snapchat/Klarna
    ],
    [NAME, VERSION, [TYPE2, INAPP]],
    [
      /\bgsa\/([\w\.]+) .*safari\//i
      // Google Search Appliance on iOS
    ],
    [VERSION, [NAME, "GSA"], [TYPE2, INAPP]],
    [
      /(?:musical_ly|trill)(?:.+app_?version\/|_)([\w\.]+)/i
      // TikTok
    ],
    [VERSION, [NAME, "TikTok"], [TYPE2, INAPP]],
    [
      /\[(linkedin)app\]/i
      // LinkedIn App for iOS & Android
    ],
    [NAME, [TYPE2, INAPP]],
    [
      /(zalo(?:app)?)[\/\sa-z]*([\w\.-]+)/i
      // Zalo 
    ],
    [[NAME, /(.+)/, "Zalo"], VERSION, [TYPE2, INAPP]],
    [
      /(chromium)[\/ ]([-\w\.]+)/i
      // Chromium
    ],
    [NAME, VERSION],
    [
      /ome-(lighthouse)$/i
      // Chrome Lighthouse
    ],
    [NAME, [TYPE2, FETCHER]],
    [
      /headlesschrome(?:\/([\w\.]+)| )/i
      // Chrome Headless
    ],
    [VERSION, [NAME, CHROME + " Headless"]],
    [
      /wv\).+chrome\/([\w\.]+).+edgw\//i
      // Edge WebView2
    ],
    [VERSION, [NAME, EDGE + " WebView2"]],
    [
      / wv\).+(chrome)\/([\w\.]+)/i
      // Chrome WebView
    ],
    [[NAME, CHROME + " WebView"], VERSION],
    [
      /droid.+ version\/([\w\.]+)\b.+(?:mobile safari|safari)/i
      // Android Browser
    ],
    [VERSION, [NAME, "Android" + SUFFIX_BROWSER]],
    [
      /chrome\/([\w\.]+) mobile/i
      // Chrome Mobile
    ],
    [VERSION, [NAME, PREFIX_MOBILE + "Chrome"]],
    [
      /(chrome|omniweb|arora|[tizenoka]{5} ?browser)\/v?([\w\.]+)/i
      // Chrome/OmniWeb/Arora/Tizen/Nokia
    ],
    [NAME, VERSION],
    [
      /version\/([\w\.\,]+) .*mobile(?:\/\w+ | ?)safari/i
      // Safari Mobile
    ],
    [VERSION, [NAME, PREFIX_MOBILE + "Safari"]],
    [
      /iphone .*mobile(?:\/\w+ | ?)safari/i
    ],
    [[NAME, PREFIX_MOBILE + "Safari"]],
    [
      /version\/([\w\.\,]+) .*(safari)/i
      // Safari
    ],
    [VERSION, NAME],
    [
      /webkit.+?(mobile ?safari|safari)(\/[\w\.]+)/i
      // Safari < 3.0
    ],
    [NAME, [VERSION, "1"]],
    [
      /(webkit|khtml)\/([\w\.]+)/i
    ],
    [NAME, VERSION],
    [
      // Gecko based
      /(?:mobile|tablet);.*(firefox)\/([\w\.-]+)/i
      // Firefox Mobile
    ],
    [[NAME, PREFIX_MOBILE + FIREFOX], VERSION],
    [
      /(navigator|netscape\d?)\/([-\w\.]+)/i
      // Netscape
    ],
    [[NAME, "Netscape"], VERSION],
    [
      /(wolvic|librewolf)\/([\w\.]+)/i
      // Wolvic/LibreWolf
    ],
    [NAME, VERSION],
    [
      /mobile vr; rv:([\w\.]+)\).+firefox/i
      // Firefox Reality
    ],
    [VERSION, [NAME, FIREFOX + " Reality"]],
    [
      /ekiohf.+(flow)\/([\w\.]+)/i,
      // Flow
      /(swiftfox)/i,
      // Swiftfox
      /(icedragon|iceweasel|camino|chimera|fennec|maemo browser|minimo|conkeror)[\/ ]?([\w\.\+]+)/i,
      // IceDragon/Iceweasel/Camino/Chimera/Fennec/Maemo/Minimo/Conkeror
      /(seamonkey|k-meleon|icecat|iceape|firebird|phoenix|basilisk|waterfox)\/([-\w\.]+)$/i,
      // Firefox/SeaMonkey/K-Meleon/IceCat/IceApe/Firebird/Phoenix
      /(firefox)\/([\w\.]+)/i,
      // Other Firefox-based
      /(mozilla)\/([\w\.]+(?= .+rv\:.+gecko\/\d+)|[0-4][\w\.]+(?!.+compatible))/i,
      // Mozilla
      // Other
      /(amaya|dillo|doris|icab|ladybird|lynx|mosaic|netsurf|obigo|polaris|w3m|(?:go|ice|up)[\. ]?browser)[-\/ ]?v?([\w\.]+)/i,
      // Polaris/Lynx/Dillo/iCab/Doris/Amaya/w3m/NetSurf/Obigo/Mosaic/Go/ICE/UP.Browser/Ladybird
      /\b(links) \(([\w\.]+)/i
      // Links
    ],
    [NAME, [VERSION, /_/g, "."]],
    [
      /(cobalt)\/([\w\.]+)/i
      // Cobalt
    ],
    [NAME, [VERSION, /[^\d\.]+./, EMPTY]]
  ],
  cpu: [
    [
      /\b((amd|x|x86[-_]?|wow|win)64)\b/i
      // AMD64 (x64)
    ],
    [[ARCHITECTURE, "amd64"]],
    [
      /(ia32(?=;))/i,
      // IA32 (quicktime)
      /\b((i[346]|x)86)(pc)?\b/i
      // IA32 (x86)
    ],
    [[ARCHITECTURE, "ia32"]],
    [
      /\b(aarch64|arm(v?[89]e?l?|_?64))\b/i
      // ARM64
    ],
    [[ARCHITECTURE, "arm64"]],
    [
      /\b(arm(v[67])?ht?n?[fl]p?)\b/i
      // ARMHF
    ],
    [[ARCHITECTURE, "armhf"]],
    [
      // PocketPC mistakenly identified as PowerPC
      /( (ce|mobile); ppc;|\/[\w\.]+arm\b)/i
    ],
    [[ARCHITECTURE, "arm"]],
    [
      / sun4\w[;\)]/i
      // SPARC
    ],
    [[ARCHITECTURE, "sparc"]],
    [
      // IA64, 68K, ARM/64, AVR/32, IRIX/64, MIPS/64, SPARC/64, PA-RISC
      /\b(avr32|ia64(?=;)|68k(?=\))|\barm(?=v([1-7]|[5-7]1)l?|;|eabi)|(irix|mips|sparc)(64)?\b|pa-risc)/i,
      /((ppc|powerpc)(64)?)( mac|;|\))/i,
      // PowerPC
      /(?:osf1|[freopnt]{3,4}bsd) (alpha)/i
      // Alpha
    ],
    [[ARCHITECTURE, /ower/, EMPTY, lowerize]],
    [
      /mc680.0/i
    ],
    [[ARCHITECTURE, "68k"]],
    [
      /winnt.+\[axp/i
    ],
    [[ARCHITECTURE, "alpha"]]
  ],
  device: [
    [
      //////////////////////////
      // MOBILES & TABLETS
      /////////////////////////
      // Samsung
      /\b(sch-i[89]0\d|shw-m380s|sm-[ptx]\w{2,4}|gt-[pn]\d{2,4}|sgh-t8[56]9|nexus 10)/i
    ],
    [MODEL, [VENDOR, SAMSUNG], [TYPE2, TABLET]],
    [
      /\b((?:s[cgp]h|gt|sm)-(?![lr])\w+|sc[g-]?[\d]+a?|galaxy nexus)/i,
      /samsung[- ]((?!sm-[lr]|browser)[-\w]+)/i,
      /sec-(sgh\w+)/i
    ],
    [MODEL, [VENDOR, SAMSUNG], [TYPE2, MOBILE]],
    [
      // Apple
      /(?:\/|\()(ip(?:hone|od)[\w, ]*)[\/\);]/i
      // iPod/iPhone
    ],
    [MODEL, [VENDOR, APPLE], [TYPE2, MOBILE]],
    [
      /\b(?:ios|apple\w+)\/.+[\(\/](ipad)/i,
      // iPad
      /\b(ipad)[\d,]*[;\] ].+(mac |i(pad)?)os/i
    ],
    [MODEL, [VENDOR, APPLE], [TYPE2, TABLET]],
    [
      /(macintosh);/i
    ],
    [MODEL, [VENDOR, APPLE]],
    [
      // Sharp
      /\b(sh-?[altvz]?\d\d[a-ekm]?)/i
    ],
    [MODEL, [VENDOR, SHARP], [TYPE2, MOBILE]],
    [
      // Honor
      /\b((?:brt|eln|hey2?|gdi|jdn)-a?[lnw]09|(?:ag[rm]3?|jdn2|kob2)-a?[lw]0[09]hn)(?: bui|\)|;)/i
    ],
    [MODEL, [VENDOR, HONOR], [TYPE2, TABLET]],
    [
      /honor([-\w ]+)[;\)]/i
    ],
    [MODEL, [VENDOR, HONOR], [TYPE2, MOBILE]],
    [
      // Huawei
      /\b((?:ag[rs][2356]?k?|bah[234]?|bg[2o]|bt[kv]|cmr|cpn|db[ry]2?|jdn2|got|kob2?k?|mon|pce|scm|sht?|[tw]gr|vrd)-[ad]?[lw][0125][09]b?|605hw|bg2-u03|(?:gem|fdr|m2|ple|t1)-[7a]0[1-4][lu]|t1-a2[13][lw]|mediapad[\w\. ]*(?= bui|\)))\b(?!.+d\/s)/i
    ],
    [MODEL, [VENDOR, HUAWEI], [TYPE2, TABLET]],
    [
      /(?:huawei) ?([-\w ]+)[;\)]/i,
      /\b(nexus 6p|\w{2,4}e?-[atu]?[ln][\dx][\dc][adnt]?)\b(?!.+d\/s)/i
    ],
    [MODEL, [VENDOR, HUAWEI], [TYPE2, MOBILE]],
    [
      // Xiaomi
      /oid[^\)]+; (2[\dbc]{4}(182|283|rp\w{2})[cgl]|m2105k81a?c)(?: bui|\))/i,
      /\b(?:xiao)?((?:red)?mi[-_ ]?pad[\w- ]*)(?: bui|\))/i
      // Mi Pad tablets
    ],
    [[MODEL, /_/g, " "], [VENDOR, XIAOMI], [TYPE2, TABLET]],
    [
      /\b; (\w+) build\/hm\1/i,
      // Xiaomi Hongmi 'numeric' models
      /\b(hm[-_ ]?note?[_ ]?(?:\d\w)?) bui/i,
      // Xiaomi Hongmi
      // Xiaomi Redmi / POCO / Black Shark / Qin
      /oid[^\)]+; (redmi[\-_ ]?(?:note|k)?[\w_ ]+|m?[12]\d[01]\d\w{3,6}|poco[\w ]+|(shark )?\w{3}-[ah]0|qin ?[1-3](s\+|ultra| pro)?)( bui|; wv|\))/i,
      // Xiaomi Mi
      /\b(mi[-_ ]?(?:a\d|one|one[_ ]plus|note|max|cc)?[_ ]?(?:\d{0,2}\w?)[_ ]?(?:plus|se|lite|pro)?( 5g|lte)?)(?: bui|\))/i,
      / ([\w ]+) miui\/v?\d/i
    ],
    [[MODEL, /_/g, " "], [VENDOR, XIAOMI], [TYPE2, MOBILE]],
    [
      // OnePlus
      /droid.+; (cph2[3-6]\d[13579]|((gm|hd)19|(ac|be|in|kb)20|(d[en]|eb|le|mt)21|ne22)[0-2]\d|p[g-l]\w[1m]10)\b/i,
      /(?:one)?(?:plus)? (a\d0\d\d)(?: b|\))/i
    ],
    [MODEL, [VENDOR, ONEPLUS], [TYPE2, MOBILE]],
    [
      // OPPO
      /; (\w+) bui.+ oppo/i,
      /\b(cph[12]\d{3}|p(?:af|c[al]|d\w|e[ar])[mt]\d0|x9007|a101op)\b/i
    ],
    [MODEL, [VENDOR, OPPO], [TYPE2, MOBILE]],
    [
      /\b(opd2(\d{3}a?))(?: bui|\))/i
    ],
    [MODEL, [VENDOR, strMapper, { "OnePlus": ["203", "304", "403", "404", "413", "415"], "*": OPPO }], [TYPE2, TABLET]],
    [
      // BLU
      /(vivo (5r?|6|8l?|go|one|s|x[il]?[2-4]?)[\w\+ ]*)(?: bui|\))/i
      // Vivo series
    ],
    [MODEL, [VENDOR, "BLU"], [TYPE2, MOBILE]],
    [
      // Vivo
      /; vivo (\w+)(?: bui|\))/i,
      /\b(v[12]\d{3}\w?[at])(?: bui|;)/i
    ],
    [MODEL, [VENDOR, "Vivo"], [TYPE2, MOBILE]],
    [
      // Realme
      /\b(rmx[1-3]\d{3})(?: bui|;|\))/i
    ],
    [MODEL, [VENDOR, "Realme"], [TYPE2, MOBILE]],
    [
      // Lenovo
      /(ideatab[-\w ]+|602lv|d-42a|a101lv|a2109a|a3500-hv|s[56]000|pb-6505[my]|tb-?x?\d{3,4}(?:f[cu]|xu|[av])|yt\d?-[jx]?\d+[lfmx])( bui|;|\)|\/)/i,
      /lenovo ?(b[68]0[08]0-?[hf]?|tab(?:[\w- ]+?)|tb[\w-]{6,7})( bui|;|\)|\/)/i
    ],
    [MODEL, [VENDOR, LENOVO], [TYPE2, TABLET]],
    [
      /lenovo[-_ ]?([-\w ]+?)(?: bui|\)|\/)/i
    ],
    [MODEL, [VENDOR, LENOVO], [TYPE2, MOBILE]],
    [
      // Motorola
      /\b(milestone|droid(?:[2-4x]| (?:bionic|x2|pro|razr))?:?( 4g)?)\b[\w ]+build\//i,
      /\bmot(?:orola)?[- ]([\w\s]+)(\)| bui)/i,
      /((?:moto(?! 360)[-\w\(\) ]+|xt\d{3,4}[cgkosw\+]?[-\d]*|nexus 6)(?= bui|\)))/i
    ],
    [MODEL, [VENDOR, MOTOROLA], [TYPE2, MOBILE]],
    [
      /\b(mz60\d|xoom[2 ]{0,2}) build\//i
    ],
    [MODEL, [VENDOR, MOTOROLA], [TYPE2, TABLET]],
    [
      // LG
      /\b(?:lg)?([vl]k\-?\d{3}) bui| 3\.[-\w; ]{10}lg?-([06cv9]{3,4})/i
    ],
    [MODEL, [VENDOR, LG], [TYPE2, TABLET]],
    [
      /(lm(?:-?f100[nv]?|-[\w\.]+)(?= bui|\))|nexus [45])/i,
      /\blg[-e;\/ ]+(?!.*(?:browser|netcast|android tv|watch|webos))(\w+)/i,
      /\blg-?([\d\w]+) bui/i
    ],
    [MODEL, [VENDOR, LG], [TYPE2, MOBILE]],
    [
      // Nokia
      /(nokia) (t[12][01])/i
    ],
    [VENDOR, MODEL, [TYPE2, TABLET]],
    [
      /(?:maemo|nokia).*(n900|lumia \d+|rm-\d+)/i,
      /nokia[-_ ]?(([-\w\. ]*?))( bui|\)|;|\/)/i
    ],
    [[MODEL, /_/g, " "], [TYPE2, MOBILE], [VENDOR, "Nokia"]],
    [
      // Google
      /(pixel (c|tablet))\b/i
      // Google Pixel C/Tablet
    ],
    [MODEL, [VENDOR, GOOGLE], [TYPE2, TABLET]],
    [
      // Google Pixel
      /droid.+;(?: google)? (g(01[13]a|020[aem]|025[jn]|1b60|1f8f|2ybb|4s1m|576d|5nz6|8hhn|8vou|a02099|c15s|d1yq|e2ae|ec77|gh2x|kv4x|p4bc|pj41|r83y|tt9q|ur25|wvk6)|pixel[\d ]*a?( pro)?( xl)?( fold)?( \(5g\))?)( bui|\))/i
    ],
    [MODEL, [VENDOR, GOOGLE], [TYPE2, MOBILE]],
    [
      /(google) (pixelbook( go)?)/i
    ],
    [VENDOR, MODEL],
    [
      // Sony
      /droid.+; (a?\d[0-2]{2}so|[c-g]\d{4}|so[-gl]\w+|xq-\w\w\d\d)(?= bui|\).+chrome\/(?![1-6]{0,1}\d\.))/i
    ],
    [MODEL, [VENDOR, SONY], [TYPE2, MOBILE]],
    [
      /sony tablet [ps]/i,
      /\b(?:sony)?sgp\w+(?: bui|\))/i
    ],
    [[MODEL, "Xperia Tablet"], [VENDOR, SONY], [TYPE2, TABLET]],
    [
      // Amazon
      /(alexa)webm/i,
      /(kf[a-z]{2}wi|aeo(?!bc)\w\w)( bui|\))/i,
      // Kindle Fire without Silk / Echo Show
      /(kf[a-z]+)( bui|\)).+silk\//i
      // Kindle Fire HD
    ],
    [MODEL, [VENDOR, AMAZON], [TYPE2, TABLET]],
    [
      /((?:sd|kf)[0349hijorstuw]+)( bui|\)).+silk\//i
      // Fire Phone
    ],
    [[MODEL, /(.+)/g, "Fire Phone $1"], [VENDOR, AMAZON], [TYPE2, MOBILE]],
    [
      // BlackBerry
      /(playbook);[-\w\),; ]+(rim)/i
      // BlackBerry PlayBook
    ],
    [MODEL, VENDOR, [TYPE2, TABLET]],
    [
      /\b((?:bb[a-f]|st[hv])100-\d)/i,
      /(?:blackberry|\(bb10;) (\w+)/i
    ],
    [MODEL, [VENDOR, BLACKBERRY], [TYPE2, MOBILE]],
    [
      // Asus
      /(?:\b|asus_)(transfo[prime ]{4,10} \w+|eeepc|slider \w+|nexus 7|padfone|p00[cj])/i
    ],
    [MODEL, [VENDOR, ASUS], [TYPE2, TABLET]],
    [
      / (z[bes]6[027][012][km][ls]|zenfone \d\w?)\b/i
    ],
    [MODEL, [VENDOR, ASUS], [TYPE2, MOBILE]],
    [
      // HTC
      /(nexus 9)/i
      // HTC Nexus 9
    ],
    [MODEL, [VENDOR, "HTC"], [TYPE2, TABLET]],
    [
      /(htc)[-;_ ]{1,2}([\w ]+(?=\)| bui)|\w+)/i,
      // HTC
      // ZTE
      /(zte)[- ]([\w ]+?)(?: bui|\/|\))/i,
      /(alcatel|geeksphone|nexian|panasonic(?!(?:;|\.))|sony(?!-bra))[-_ ]?([-\w]*)/i
      // Alcatel/GeeksPhone/Nexian/Panasonic/Sony
    ],
    [VENDOR, [MODEL, /_/g, " "], [TYPE2, MOBILE]],
    [
      // TCL
      /tcl (xess p17aa)/i,
      /droid [\w\.]+; ((?:8[14]9[16]|9(?:0(?:48|60|8[01])|1(?:3[27]|66)|2(?:6[69]|9[56])|466))[gqswx])(_\w(\w|\w\w))?(\)| bui)/i
    ],
    [MODEL, [VENDOR, "TCL"], [TYPE2, TABLET]],
    [
      /droid [\w\.]+; (418(?:7d|8v)|5087z|5102l|61(?:02[dh]|25[adfh]|27[ai]|56[dh]|59k|65[ah])|a509dl|t(?:43(?:0w|1[adepqu])|50(?:6d|7[adju])|6(?:09dl|10k|12b|71[efho]|76[hjk])|7(?:66[ahju]|67[hw]|7[045][bh]|71[hk]|73o|76[ho]|79w|81[hks]?|82h|90[bhsy]|99b)|810[hs]))(_\w(\w|\w\w))?(\)| bui)/i
    ],
    [MODEL, [VENDOR, "TCL"], [TYPE2, MOBILE]],
    [
      // itel
      /(itel) ((\w+))/i
    ],
    [[VENDOR, lowerize], MODEL, [TYPE2, strMapper, { "tablet": ["p10001l", "w7001"], "*": "mobile" }]],
    [
      // Acer
      /droid.+; ([ab][1-7]-?[0178a]\d\d?)/i
    ],
    [MODEL, [VENDOR, "Acer"], [TYPE2, TABLET]],
    [
      // Meizu
      /droid.+; (m[1-5] note) bui/i,
      /\bmz-([-\w]{2,})/i
    ],
    [MODEL, [VENDOR, "Meizu"], [TYPE2, MOBILE]],
    [
      // Ulefone
      /; ((?:power )?armor(?:[\w ]{0,8}))(?: bui|\))/i
    ],
    [MODEL, [VENDOR, "Ulefone"], [TYPE2, MOBILE]],
    [
      // Energizer
      /; (energy ?\w+)(?: bui|\))/i,
      /; energizer ([\w ]+)(?: bui|\))/i
    ],
    [MODEL, [VENDOR, "Energizer"], [TYPE2, MOBILE]],
    [
      // Cat
      /; cat (b35);/i,
      /; (b15q?|s22 flip|s48c|s62 pro)(?: bui|\))/i
    ],
    [MODEL, [VENDOR, "Cat"], [TYPE2, MOBILE]],
    [
      // Smartfren
      /((?:new )?andromax[\w- ]+)(?: bui|\))/i
    ],
    [MODEL, [VENDOR, "Smartfren"], [TYPE2, MOBILE]],
    [
      // Nothing
      /droid.+; (a(in)?(0(15|59|6[35])|142)p?)/i
    ],
    [MODEL, [VENDOR, "Nothing"], [TYPE2, MOBILE]],
    [
      // Archos
      /; (x67 5g|tikeasy \w+|ac[1789]\d\w+)( b|\))/i,
      /archos ?(5|gamepad2?|([\w ]*[t1789]|hello) ?\d+[\w ]*)( b|\))/i
    ],
    [MODEL, [VENDOR, "Archos"], [TYPE2, TABLET]],
    [
      /archos ([\w ]+)( b|\))/i,
      /; (ac[3-6]\d\w{2,8})( b|\))/i
    ],
    [MODEL, [VENDOR, "Archos"], [TYPE2, MOBILE]],
    [
      // HMD
      /; (n159v)/i
    ],
    [MODEL, [VENDOR, "HMD"], [TYPE2, MOBILE]],
    [
      // MIXED
      /(imo) (tab \w+)/i,
      // IMO
      /(infinix|tecno) (x1101b?|p904|dp(7c|8d|10a)( pro)?|p70[1-3]a?|p904|t1101)/i
      // Infinix XPad / Tecno
    ],
    [VENDOR, MODEL, [TYPE2, TABLET]],
    [
      /(blackberry|benq|palm(?=\-)|sonyericsson|acer|asus(?! zenw)|dell|jolla|meizu|motorola|polytron|tecno|micromax|advan)[-_ ]?([-\w]*)/i,
      // BlackBerry/BenQ/Palm/Sony-Ericsson/Acer/Asus/Dell/Meizu/Motorola/Polytron/Tecno/Micromax/Advan
      // BLU/HMD/IMO/Infinix/Lava/OnePlus/TCL/Wiko
      /; (blu|hmd|imo|infinix|lava|oneplus|tcl|wiko)[_ ]([\w\+ ]+?)(?: bui|\)|; r)/i,
      /(hp) ([\w ]+\w)/i,
      // HP iPAQ
      /(microsoft); (lumia[\w ]+)/i,
      // Microsoft Lumia
      /(oppo) ?([\w ]+) bui/i,
      // OPPO
      /(hisense) ([ehv][\w ]+)\)/i,
      // Hisense
      /droid[^;]+; (philips)[_ ]([sv-x][\d]{3,4}[xz]?)/i
      // Philips
    ],
    [VENDOR, MODEL, [TYPE2, MOBILE]],
    [
      /(kobo)\s(ereader|touch)/i,
      // Kobo
      /(hp).+(touchpad(?!.+tablet)|tablet)/i,
      // HP TouchPad
      /(kindle)\/([\w\.]+)/i
      // Kindle
    ],
    [VENDOR, MODEL, [TYPE2, TABLET]],
    [
      /(surface duo)/i
      // Surface Duo
    ],
    [MODEL, [VENDOR, MICROSOFT], [TYPE2, TABLET]],
    [
      /droid [\d\.]+; (fp\du?)(?: b|\))/i
      // Fairphone
    ],
    [MODEL, [VENDOR, "Fairphone"], [TYPE2, MOBILE]],
    [
      /((?:tegranote|shield t(?!.+d tv))[\w- ]*?)(?: b|\))/i
      // Nvidia Tablets
    ],
    [MODEL, [VENDOR, NVIDIA], [TYPE2, TABLET]],
    [
      /(sprint) (\w+)/i
      // Sprint Phones
    ],
    [VENDOR, MODEL, [TYPE2, MOBILE]],
    [
      /(kin\.[onetw]{3})/i
      // Microsoft Kin
    ],
    [[MODEL, /\./g, " "], [VENDOR, MICROSOFT], [TYPE2, MOBILE]],
    [
      /droid.+; ([c6]+|et5[16]|mc[239][23]x?|vc8[03]x?)\)/i
      // Zebra
    ],
    [MODEL, [VENDOR, ZEBRA], [TYPE2, TABLET]],
    [
      /droid.+; (ec30|ps20|tc[2-8]\d[kx])\)/i
    ],
    [MODEL, [VENDOR, ZEBRA], [TYPE2, MOBILE]],
    [
      ///////////////////
      // SMARTTVS
      ///////////////////
      /(philips)[\w ]+tv/i,
      // Philips
      /smart-tv.+(samsung)/i
      // Samsung
    ],
    [VENDOR, [TYPE2, SMARTTV]],
    [
      /hbbtv.+maple;(\d+)/i
    ],
    [[MODEL, /^/, "SmartTV"], [VENDOR, SAMSUNG], [TYPE2, SMARTTV]],
    [
      /(vizio)(?: |.+model\/)(\w+-\w+)/i,
      // Vizio
      /tcast.+(lg)e?. ([-\w]+)/i
      // LG SmartTV
    ],
    [VENDOR, MODEL, [TYPE2, SMARTTV]],
    [
      /(nux; netcast.+smarttv|lg (netcast\.tv-201\d|android tv))/i
    ],
    [[VENDOR, LG], [TYPE2, SMARTTV]],
    [
      /(apple) ?tv/i
      // Apple TV
    ],
    [VENDOR, [MODEL, APPLE + " TV"], [TYPE2, SMARTTV]],
    [
      /crkey.*devicetype\/chromecast/i
      // Google Chromecast Third Generation
    ],
    [[MODEL, CHROMECAST + " Third Generation"], [VENDOR, GOOGLE], [TYPE2, SMARTTV]],
    [
      /crkey.*devicetype\/([^/]*)/i
      // Google Chromecast with specific device type
    ],
    [[MODEL, /^/, "Chromecast "], [VENDOR, GOOGLE], [TYPE2, SMARTTV]],
    [
      /fuchsia.*crkey/i
      // Google Chromecast Nest Hub
    ],
    [[MODEL, CHROMECAST + " Nest Hub"], [VENDOR, GOOGLE], [TYPE2, SMARTTV]],
    [
      /crkey/i
      // Google Chromecast, Linux-based or unknown
    ],
    [[MODEL, CHROMECAST], [VENDOR, GOOGLE], [TYPE2, SMARTTV]],
    [
      /(portaltv)/i
      // Facebook Portal TV
    ],
    [MODEL, [VENDOR, FACEBOOK], [TYPE2, SMARTTV]],
    [
      /droid.+aft(\w+)( bui|\))/i
      // Fire TV
    ],
    [MODEL, [VENDOR, AMAZON], [TYPE2, SMARTTV]],
    [
      /(shield \w+ tv)/i
      // Nvidia Shield TV
    ],
    [MODEL, [VENDOR, NVIDIA], [TYPE2, SMARTTV]],
    [
      /\(dtv[\);].+(aquos)/i,
      /(aquos-tv[\w ]+)\)/i
      // Sharp
    ],
    [MODEL, [VENDOR, SHARP], [TYPE2, SMARTTV]],
    [
      /(bravia[\w ]+)( bui|\))/i
      // Sony
    ],
    [MODEL, [VENDOR, SONY], [TYPE2, SMARTTV]],
    [
      /(mi(tv|box)-?\w+) bui/i
      // Xiaomi
    ],
    [MODEL, [VENDOR, XIAOMI], [TYPE2, SMARTTV]],
    [
      /Hbbtv.*(technisat) (.*);/i
      // TechniSAT
    ],
    [VENDOR, MODEL, [TYPE2, SMARTTV]],
    [
      /\b(roku)[\dx]*[\)\/]((?:dvp-)?[\d\.]*)/i,
      // Roku
      /hbbtv\/\d+\.\d+\.\d+ +\([\w\+ ]*; *([\w\d][^;]*);([^;]*)/i
      // HbbTV devices
    ],
    [[VENDOR, /.+\/(\w+)/, "$1", strMapper, { "LG": "lge" }], [MODEL, trim], [TYPE2, SMARTTV]],
    [
      ///////////////////
      // CONSOLES
      ///////////////////
      /(playstation \w+)/i
      // Playstation
    ],
    [MODEL, [VENDOR, SONY], [TYPE2, CONSOLE]],
    [
      /\b(xbox(?: one)?(?!; xbox))[\); ]/i
      // Microsoft Xbox
    ],
    [MODEL, [VENDOR, MICROSOFT], [TYPE2, CONSOLE]],
    [
      /(ouya)/i,
      // Ouya
      /(nintendo) (\w+)/i,
      // Nintendo
      /(retroid) (pocket ([^\)]+))/i,
      // Retroid Pocket
      /(valve).+(steam deck)/i,
      /droid.+; ((shield|rgcube|gr0006))( bui|\))/i
      // Nvidia Portable/Anbernic/Logitech
    ],
    [[VENDOR, strMapper, { "Nvidia": "Shield", "Anbernic": "RGCUBE", "Logitech": "GR0006" }], MODEL, [TYPE2, CONSOLE]],
    [
      ///////////////////
      // WEARABLES
      ///////////////////
      /\b(sm-[lr]\d\d[0156][fnuw]?s?|gear live)\b/i
      // Samsung Galaxy Watch
    ],
    [MODEL, [VENDOR, SAMSUNG], [TYPE2, WEARABLE]],
    [
      /((pebble))app/i,
      // Pebble
      /(asus|google|lg|oppo|xiaomi) ((pixel |zen)?watch[\w ]*)( bui|\))/i
      // Asus ZenWatch / LG Watch / Pixel Watch / Xiaomi Watch
    ],
    [VENDOR, MODEL, [TYPE2, WEARABLE]],
    [
      /(ow(?:19|20)?we?[1-3]{1,3})/i
      // Oppo Watch
    ],
    [MODEL, [VENDOR, OPPO], [TYPE2, WEARABLE]],
    [
      /(watch)(?: ?os[,\/]|\d,\d\/)[\d\.]+/i
      // Apple Watch
    ],
    [MODEL, [VENDOR, APPLE], [TYPE2, WEARABLE]],
    [
      /(opwwe\d{3})/i
      // OnePlus Watch
    ],
    [MODEL, [VENDOR, ONEPLUS], [TYPE2, WEARABLE]],
    [
      /(moto 360)/i
      // Motorola 360
    ],
    [MODEL, [VENDOR, MOTOROLA], [TYPE2, WEARABLE]],
    [
      /(smartwatch 3)/i
      // Sony SmartWatch
    ],
    [MODEL, [VENDOR, SONY], [TYPE2, WEARABLE]],
    [
      /(g watch r)/i
      // LG G Watch R
    ],
    [MODEL, [VENDOR, LG], [TYPE2, WEARABLE]],
    [
      /droid.+; (wt63?0{2,3})\)/i
    ],
    [MODEL, [VENDOR, ZEBRA], [TYPE2, WEARABLE]],
    [
      ///////////////////
      // XR
      ///////////////////
      /droid.+; (glass) \d/i
      // Google Glass
    ],
    [MODEL, [VENDOR, GOOGLE], [TYPE2, XR]],
    [
      /(pico) ([\w ]+) os\d/i
      // Pico
    ],
    [VENDOR, MODEL, [TYPE2, XR]],
    [
      /(quest( \d| pro)?s?).+vr/i
      // Meta Quest
    ],
    [MODEL, [VENDOR, FACEBOOK], [TYPE2, XR]],
    [
      /mobile vr; rv.+firefox/i
      // Unidentifiable VR device using Firefox Reality / Wolvic
    ],
    [[TYPE2, XR]],
    [
      ///////////////////
      // EMBEDDED
      ///////////////////
      /(tesla)(?: qtcarbrowser|\/[-\w\.]+)/i
      // Tesla
    ],
    [VENDOR, [TYPE2, EMBEDDED]],
    [
      /(aeobc)\b/i
      // Echo Dot
    ],
    [MODEL, [VENDOR, AMAZON], [TYPE2, EMBEDDED]],
    [
      /(homepod).+mac os/i
      // Apple HomePod
    ],
    [MODEL, [VENDOR, APPLE], [TYPE2, EMBEDDED]],
    [
      /windows iot/i
      // Unidentifiable embedded device using Windows IoT
    ],
    [[TYPE2, EMBEDDED]],
    [
      ////////////////////
      // MIXED (GENERIC)
      ///////////////////
      /droid.+; ([\w- ]+) (4k|android|smart|google)[- ]?tv/i
      // Unidentifiable SmartTV
    ],
    [MODEL, [TYPE2, SMARTTV]],
    [
      /\b((4k|android|smart|opera)[- ]?tv|tv; rv:|large screen[\w ]+safari)\b/i
    ],
    [[TYPE2, SMARTTV]],
    [
      /droid .+?; ([^;]+?)(?: bui|; wv\)|\) applew|; hmsc).+?(mobile|vr|\d) safari/i
    ],
    [MODEL, [TYPE2, strMapper, { "mobile": "Mobile", "xr": "VR", "*": TABLET }]],
    [
      /\b((tablet|tab)[;\/]|focus\/\d(?!.+mobile))/i
      // Unidentifiable Tablet
    ],
    [[TYPE2, TABLET]],
    [
      /(phone|mobile(?:[;\/]| [ \w\/\.]*safari)|pda(?=.+windows ce))/i
      // Unidentifiable Mobile
    ],
    [[TYPE2, MOBILE]],
    [
      /droid .+?; ([\w\. -]+)( bui|\))/i
      // Generic Android Device
    ],
    [MODEL, [VENDOR, "Generic"]]
  ],
  engine: [
    [
      /windows.+ edge\/([\w\.]+)/i
      // EdgeHTML
    ],
    [VERSION, [NAME, EDGE + "HTML"]],
    [
      /(arkweb)\/([\w\.]+)/i
      // ArkWeb
    ],
    [NAME, VERSION],
    [
      /webkit\/537\.36.+chrome\/(?!27)([\w\.]+)/i
      // Blink
    ],
    [VERSION, [NAME, "Blink"]],
    [
      /(presto)\/([\w\.]+)/i,
      // Presto
      /(webkit|trident|netfront|netsurf|amaya|lynx|w3m|goanna|servo)\/([\w\.]+)/i,
      // WebKit/Trident/NetFront/NetSurf/Amaya/Lynx/w3m/Goanna/Servo
      /ekioh(flow)\/([\w\.]+)/i,
      // Flow
      /(khtml|tasman|links|dillo)[\/ ]\(?([\w\.]+)/i,
      // KHTML/Tasman/Links/Dillo
      /(icab)[\/ ]([23]\.[\d\.]+)/i,
      // iCab
      /\b(libweb)/i
      // LibWeb
    ],
    [NAME, VERSION],
    [
      /ladybird\//i
    ],
    [[NAME, "LibWeb"]],
    [
      /rv\:([\w\.]{1,9})\b.+(gecko)/i
      // Gecko
    ],
    [VERSION, NAME]
  ],
  os: [
    [
      // Windows
      /(windows nt) (6\.[23]); arm/i
      // Windows RT
    ],
    [[NAME, /N/, "R"], [VERSION, strMapper, windowsVersionMap]],
    [
      /(windows (?:phone|mobile|iot))(?: os)?[\/ ]?([\d\.]*( se)?)/i,
      // Windows IoT/Mobile/Phone
      // Windows NT/3.1/95/98/ME/2000/XP/Vista/7/8/8.1/10/11
      /(windows)[\/ ](1[01]|2000|3\.1|7|8(\.1)?|9[58]|me|server 20\d\d( r2)?|vista|xp)/i
    ],
    [NAME, VERSION],
    [
      /windows nt ?([\d\.\)]*)(?!.+xbox)/i,
      /\bwin(?=3| ?9|n)(?:nt| 9x )?([\d\.;]*)/i
    ],
    [[VERSION, /(;|\))/g, "", strMapper, windowsVersionMap], [NAME, WINDOWS]],
    [
      /(windows ce)\/?([\d\.]*)/i
      // Windows CE
    ],
    [NAME, VERSION],
    [
      // iOS/macOS
      /[adehimnop]{4,7}\b(?:.*os ([\w]+) like mac|; opera)/i,
      // iOS
      /(?:ios;fbsv|ios(?=.+ip(?:ad|hone)|.+apple ?tv)|ip(?:ad|hone)(?: |.+i(?:pad)?)os|apple ?tv.+ios)[\/ ]([\w\.]+)/i,
      /\btvos ?([\w\.]+)/i,
      /cfnetwork\/.+darwin/i
    ],
    [[VERSION, /_/g, "."], [NAME, "iOS"]],
    [
      /(mac os x) ?([\w\. ]*)/i,
      /(macintosh|mac_powerpc\b)(?!.+(haiku|morphos))/i
      // Mac OS
    ],
    [[NAME, "macOS"], [VERSION, /_/g, "."]],
    [
      // Google Chromecast
      /android ([\d\.]+).*crkey/i
      // Google Chromecast, Android-based
    ],
    [VERSION, [NAME, CHROMECAST + " Android"]],
    [
      /fuchsia.*crkey\/([\d\.]+)/i
      // Google Chromecast, Fuchsia-based
    ],
    [VERSION, [NAME, CHROMECAST + " Fuchsia"]],
    [
      /crkey\/([\d\.]+).*devicetype\/smartspeaker/i
      // Google Chromecast, Linux-based Smart Speaker
    ],
    [VERSION, [NAME, CHROMECAST + " SmartSpeaker"]],
    [
      /linux.*crkey\/([\d\.]+)/i
      // Google Chromecast, Legacy Linux-based
    ],
    [VERSION, [NAME, CHROMECAST + " Linux"]],
    [
      /crkey\/([\d\.]+)/i
      // Google Chromecast, unknown
    ],
    [VERSION, [NAME, CHROMECAST]],
    [
      // Mobile OSes
      /droid ([\w\.]+)\b.+(android[- ]x86)/i
      // Android-x86
    ],
    [VERSION, NAME],
    [
      /(ubuntu) ([\w\.]+) like android/i
      // Ubuntu Touch
    ],
    [[NAME, /(.+)/, "$1 Touch"], VERSION],
    [
      /(harmonyos)[\/ ]?([\d\.]*)/i,
      // HarmonyOS
      // Android/Blackberry/WebOS/QNX/Bada/RIM/KaiOS/Maemo/MeeGo/S40/Sailfish OS/OpenHarmony/Tizen
      /(android|bada|blackberry|kaios|maemo|meego|openharmony|qnx|rim tablet os|sailfish|series40|symbian|tizen)\w*[-\/\.; ]?([\d\.]*)/i
    ],
    [NAME, VERSION],
    [
      /\(bb(10);/i
      // BlackBerry 10
    ],
    [VERSION, [NAME, BLACKBERRY]],
    [
      /(?:symbian ?os|symbos|s60(?=;)|series ?60)[-\/ ]?([\w\.]*)/i
      // Symbian
    ],
    [VERSION, [NAME, "Symbian"]],
    [
      /mozilla\/[\d\.]+ \((?:mobile[;\w ]*|tablet|tv|[^\)]*(?:viera|lg(?:l25|-d300)|alcatel ?o.+|y300-f1)); rv:([\w\.]+)\).+gecko\//i
      // Firefox OS
    ],
    [VERSION, [NAME, FIREFOX + " OS"]],
    [
      /\b(?:hp)?wos(?:browser)?\/([\w\.]+)/i,
      // WebOS
      /webos(?:[ \/]?|\.tv-20(?=2[2-9]))(\d[\d\.]*)/i
    ],
    [VERSION, [NAME, "webOS"]],
    [
      /web0s;.+?(?:chr[o0]me|safari)\/(\d+)/i
      // https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine
    ],
    [[VERSION, strMapper, { "25": "120", "24": "108", "23": "94", "22": "87", "6": "79", "5": "68", "4": "53", "3": "38", "2": "538", "1": "537", "*": "TV" }], [NAME, "webOS"]],
    [
      /watch(?: ?os[,\/ ]|\d,\d\/)([\d\.]+)/i
      // watchOS
    ],
    [VERSION, [NAME, "watchOS"]],
    [
      // Google ChromeOS
      /cros [\w]+(?:\)| ([\w\.]+)\b)/i
      // Chromium OS
    ],
    [VERSION, [NAME, "Chrome OS"]],
    [
      // Smart TVs
      /kepler ([\w\.]+); (aft|aeo)/i
      // Vega OS
    ],
    [VERSION, [NAME, "Vega OS"]],
    [
      /(netrange)mmh/i,
      // Netrange
      /(nettv)\/(\d+\.[\w\.]+)/i,
      // NetTV
      // Console
      /(nintendo|playstation) (\w+)/i,
      // Nintendo/Playstation
      /(xbox); +xbox ([^\);]+)/i,
      // Microsoft Xbox (360, One, X, S, Series X, Series S)
      /(pico) .+os([\w\.]+)/i,
      // Pico
      // Other
      /\b(joli|palm)\b ?(?:os)?\/?([\w\.]*)/i,
      // Joli/Palm
      /linux.+(mint)[\/\(\) ]?([\w\.]*)/i,
      // Mint
      /(mageia|vectorlinux|fuchsia|arcaos|arch(?= ?linux))[;l ]([\d\.]*)/i,
      // Mageia/VectorLinux/Fuchsia/ArcaOS/Arch
      /([kxln]?ubuntu|debian|suse|opensuse|gentoo|slackware|fedora|mandriva|centos|pclinuxos|red ?hat|zenwalk|linpus|raspbian|plan 9|minix|risc os|contiki|deepin|manjaro|elementary os|sabayon|linspire|knoppix)(?: gnu[\/ ]linux)?(?: enterprise)?(?:[- ]linux)?(?:-gnu)?[-\/ ]?(?!chrom|package)([-\w\.]*)/i,
      // Ubuntu/Debian/SUSE/Gentoo/Slackware/Fedora/Mandriva/CentOS/PCLinuxOS/RedHat/Zenwalk/Linpus/Raspbian/Plan9/Minix/RISCOS/Contiki/Deepin/Manjaro/elementary/Sabayon/Linspire/Knoppix
      /((?:open)?solaris)[-\/ ]?([\w\.]*)/i,
      // Solaris
      /\b(aix)[; ]([1-9\.]{0,4})/i,
      // AIX
      /(hurd|linux|morphos)(?: (?:arm|x86|ppc)\w*| ?)([\w\.]*)/i,
      // Hurd/Linux/MorphOS
      /(gnu) ?([\w\.]*)/i,
      // GNU
      /\b([-frentopcghs]{0,5}bsd|dragonfly)[\/ ]?(?!amd|[ix346]{1,2}86)([\w\.]*)/i,
      // FreeBSD/NetBSD/OpenBSD/PC-BSD/GhostBSD/DragonFly
      /(haiku) ?(r\d)?/i
      // Haiku
    ],
    [NAME, VERSION],
    [
      /(sunos) ?([\d\.]*)/i
      // Solaris
    ],
    [[NAME, "Solaris"], VERSION],
    [
      /\b(beos|os\/2|amigaos|openvms|hp-ux|serenityos)/i,
      // BeOS/OS2/AmigaOS/OpenVMS/HP-UX/SerenityOS
      /(unix) ?([\w\.]*)/i
      // UNIX
    ],
    [NAME, VERSION]
  ]
};
var defaultProps = function() {
  var props = { init: {}, isIgnore: {}, isIgnoreRgx: {}, toString: {} };
  setProps.call(props.init, [
    [BROWSER, [NAME, VERSION, MAJOR, TYPE2]],
    [CPU, [ARCHITECTURE]],
    [DEVICE, [TYPE2, MODEL, VENDOR]],
    [ENGINE, [NAME, VERSION]],
    [OS, [NAME, VERSION]]
  ]);
  setProps.call(props.isIgnore, [
    [BROWSER, [VERSION, MAJOR]],
    [ENGINE, [VERSION]],
    [OS, [VERSION]]
  ]);
  setProps.call(props.isIgnoreRgx, [
    [BROWSER, / ?browser$/i],
    [OS, / ?os$/i]
  ]);
  setProps.call(props.toString, [
    [BROWSER, [NAME, VERSION]],
    [CPU, [ARCHITECTURE]],
    [DEVICE, [VENDOR, MODEL]],
    [ENGINE, [NAME, VERSION]],
    [OS, [NAME, VERSION]]
  ]);
  return props;
}();
var createIData = function(item, itemType) {
  var init_props = defaultProps.init[itemType], is_ignoreProps = defaultProps.isIgnore[itemType] || 0, is_ignoreRgx = defaultProps.isIgnoreRgx[itemType] || 0, toString_props = defaultProps.toString[itemType] || 0;
  function IData() {
    setProps.call(this, init_props);
  }
  IData.prototype.getItem = function() {
    return item;
  };
  IData.prototype.withClientHints = function() {
    if (!NAVIGATOR_UADATA) {
      return item.parseCH().get();
    }
    return NAVIGATOR_UADATA.getHighEntropyValues(CH_ALL_VALUES).then(function(res) {
      return item.setCH(new UACHData(res, false)).parseCH().get();
    });
  };
  IData.prototype.withFeatureCheck = function() {
    return item.detectFeature().get();
  };
  if (itemType != RESULT) {
    IData.prototype.is = function(strToCheck) {
      var is = false;
      for (var i in this) {
        if (this.hasOwnProperty(i) && !has(is_ignoreProps, i) && lowerize(is_ignoreRgx ? strip(is_ignoreRgx, this[i]) : this[i]) == lowerize(is_ignoreRgx ? strip(is_ignoreRgx, strToCheck) : strToCheck)) {
          is = true;
          if (strToCheck != TYPEOF.UNDEFINED) break;
        } else if (strToCheck == TYPEOF.UNDEFINED && is) {
          is = !is;
          break;
        }
      }
      return is;
    };
    IData.prototype.toString = function() {
      var str = EMPTY;
      for (var i in toString_props) {
        if (typeof this[toString_props[i]] !== TYPEOF.UNDEFINED) {
          str += (str ? " " : EMPTY) + this[toString_props[i]];
        }
      }
      return str || TYPEOF.UNDEFINED;
    };
  }
  IData.prototype.then = function(cb) {
    var that = this;
    var IDataResolve = function() {
      for (var prop in that) {
        if (that.hasOwnProperty(prop)) {
          this[prop] = that[prop];
        }
      }
    };
    IDataResolve.prototype = {
      is: IData.prototype.is,
      toString: IData.prototype.toString,
      withClientHints: IData.prototype.withClientHints,
      withFeatureCheck: IData.prototype.withFeatureCheck
    };
    var resolveData = new IDataResolve();
    cb(resolveData);
    return resolveData;
  };
  return new IData();
};
function UACHData(uach, isHttpUACH) {
  uach = uach || {};
  setProps.call(this, CH_ALL_VALUES);
  if (isHttpUACH) {
    setProps.call(this, [
      [BRANDS, itemListToArray(uach[CH])],
      [FULLVERLIST, itemListToArray(uach[CH_FULL_VER_LIST])],
      [MOBILE, /\?1/.test(uach[CH_MOBILE])],
      [MODEL, stripQuotes(uach[CH_MODEL])],
      [PLATFORM, stripQuotes(uach[CH_PLATFORM])],
      [PLATFORMVER, stripQuotes(uach[CH_PLATFORM_VER])],
      [ARCHITECTURE, stripQuotes(uach[CH_ARCH])],
      [FORMFACTORS, itemListToArray(uach[CH_FORM_FACTORS])],
      [BITNESS, stripQuotes(uach[CH_BITNESS])]
    ]);
  } else {
    for (var prop in uach) {
      if (this.hasOwnProperty(prop) && typeof uach[prop] !== TYPEOF.UNDEFINED) this[prop] = uach[prop];
    }
  }
}
function UAItem(itemType, ua, rgxMap, uaCH) {
  setProps.call(this, [
    ["itemType", itemType],
    ["ua", ua],
    ["uaCH", uaCH],
    ["rgxMap", rgxMap],
    ["data", createIData(this, itemType)]
  ]);
  return this;
}
UAItem.prototype.get = function(prop) {
  if (!prop) return this.data;
  return this.data.hasOwnProperty(prop) ? this.data[prop] : void 0;
};
UAItem.prototype.set = function(prop, val) {
  this.data[prop] = val;
  return this;
};
UAItem.prototype.setCH = function(ch) {
  this.uaCH = ch;
  return this;
};
UAItem.prototype.detectFeature = function() {
  if (NAVIGATOR && NAVIGATOR.userAgent == this.ua) {
    switch (this.itemType) {
      case BROWSER:
        if (NAVIGATOR.brave && typeof NAVIGATOR.brave.isBrave == TYPEOF.FUNCTION) {
          this.set(NAME, "Brave");
        }
        break;
      case DEVICE:
        if (!this.get(TYPE2) && NAVIGATOR_UADATA && NAVIGATOR_UADATA[MOBILE]) {
          this.set(TYPE2, MOBILE);
        }
        if (this.get(MODEL) == "Macintosh" && NAVIGATOR && typeof NAVIGATOR.standalone !== TYPEOF.UNDEFINED && NAVIGATOR.maxTouchPoints && NAVIGATOR.maxTouchPoints > 2) {
          this.set(MODEL, "iPad").set(TYPE2, TABLET);
        }
        break;
      case OS:
        if (!this.get(NAME) && NAVIGATOR_UADATA && NAVIGATOR_UADATA[PLATFORM]) {
          this.set(NAME, NAVIGATOR_UADATA[PLATFORM]);
        }
        break;
      case RESULT:
        var data = this.data;
        var detect = function(itemType) {
          return data[itemType].getItem().detectFeature().get();
        };
        this.set(BROWSER, detect(BROWSER)).set(CPU, detect(CPU)).set(DEVICE, detect(DEVICE)).set(ENGINE, detect(ENGINE)).set(OS, detect(OS));
    }
  }
  return this;
};
UAItem.prototype.parseUA = function() {
  if (this.itemType != RESULT) {
    rgxMapper.call(this.data, this.ua, this.rgxMap);
  }
  switch (this.itemType) {
    case BROWSER:
      this.set(MAJOR, majorize(this.get(VERSION)));
      break;
    case OS:
      if (this.get(NAME) == "iOS" && this.get(VERSION) == "18.6") {
        var realVersion = /\) Version\/([\d\.]+)/.exec(this.ua);
        if (realVersion && parseInt(realVersion[1].substring(0, 2), 10) >= 26) {
          this.set(VERSION, realVersion[1]);
        }
      }
      break;
  }
  return this;
};
UAItem.prototype.parseCH = function() {
  var uaCH = this.uaCH, rgxMap = this.rgxMap;
  switch (this.itemType) {
    case BROWSER:
    case ENGINE:
      var brands = uaCH[FULLVERLIST] || uaCH[BRANDS], prevName;
      if (brands) {
        for (var i = 0; i < brands.length; i++) {
          var brandName = brands[i].brand || brands[i], brandVersion = brands[i].version;
          if (this.itemType == BROWSER && !/not.a.brand/i.test(brandName) && (!prevName || /Chrom/.test(prevName) && brandName != CHROMIUM || prevName == EDGE && /WebView2/.test(brandName))) {
            brandName = strMapper(brandName, browserHintsMap);
            prevName = this.get(NAME);
            if (!(prevName && !/Chrom/.test(prevName) && /Chrom/.test(brandName))) {
              this.set(NAME, brandName).set(VERSION, brandVersion).set(MAJOR, majorize(brandVersion));
            }
            prevName = brandName;
          }
          if (this.itemType == ENGINE && brandName == CHROMIUM) {
            this.set(VERSION, brandVersion);
          }
        }
      }
      break;
    case CPU:
      var archName = uaCH[ARCHITECTURE];
      if (archName) {
        if (archName && uaCH[BITNESS] == "64") archName += "64";
        rgxMapper.call(this.data, archName + ";", rgxMap);
      }
      break;
    case DEVICE:
      if (uaCH[MOBILE]) {
        this.set(TYPE2, MOBILE);
      }
      if (uaCH[MODEL]) {
        this.set(MODEL, uaCH[MODEL]);
        if (!this.get(TYPE2) || !this.get(VENDOR)) {
          var reParse = {};
          rgxMapper.call(reParse, "droid 9; " + uaCH[MODEL] + ")", rgxMap);
          if (!this.get(TYPE2) && !!reParse.type) {
            this.set(TYPE2, reParse.type);
          }
          if (!this.get(VENDOR) && !!reParse.vendor) {
            this.set(VENDOR, reParse.vendor);
          }
        }
      }
      if (uaCH[FORMFACTORS]) {
        var ff;
        if (typeof uaCH[FORMFACTORS] !== "string") {
          var idx = 0;
          while (!ff && idx < uaCH[FORMFACTORS].length) {
            ff = strMapper(uaCH[FORMFACTORS][idx++], formFactorsMap);
          }
        } else {
          ff = strMapper(uaCH[FORMFACTORS], formFactorsMap);
        }
        this.set(TYPE2, ff);
      }
      break;
    case OS:
      var osName = uaCH[PLATFORM];
      if (osName) {
        var osVersion = uaCH[PLATFORMVER];
        if (osName == WINDOWS) osVersion = parseInt(majorize(osVersion), 10) >= 13 ? "11" : "10";
        this.set(NAME, osName).set(VERSION, osVersion);
      }
      if (this.get(NAME) == WINDOWS && uaCH[MODEL] == "Xbox") {
        this.set(NAME, "Xbox").set(VERSION, void 0);
      }
      break;
    case RESULT:
      var data = this.data;
      var parse = function(itemType) {
        return data[itemType].getItem().setCH(uaCH).parseCH().get();
      };
      this.set(BROWSER, parse(BROWSER)).set(CPU, parse(CPU)).set(DEVICE, parse(DEVICE)).set(ENGINE, parse(ENGINE)).set(OS, parse(OS));
  }
  return this;
};
function UAParser(ua, extensions, headers) {
  if (typeof ua === TYPEOF.OBJECT) {
    if (isExtensions(ua, true)) {
      if (typeof extensions === TYPEOF.OBJECT) {
        headers = extensions;
      }
      extensions = ua;
    } else {
      headers = ua;
      extensions = void 0;
    }
    ua = void 0;
  } else if (typeof ua === TYPEOF.STRING && !isExtensions(extensions, true)) {
    headers = extensions;
    extensions = void 0;
  }
  if (headers) {
    if (typeof headers.append === TYPEOF.FUNCTION) {
      var kv = {};
      headers.forEach(function(v, k) {
        kv[String(k).toLowerCase()] = v;
      });
      headers = kv;
    } else {
      var normalized = {};
      for (var header in headers) {
        if (headers.hasOwnProperty(header)) {
          normalized[String(header).toLowerCase()] = headers[header];
        }
      }
      headers = normalized;
    }
  }
  if (!(this instanceof UAParser)) {
    return new UAParser(ua, extensions, headers).getResult();
  }
  var userAgent = typeof ua === TYPEOF.STRING ? ua : (
    // Passed user-agent string
    headers && headers[USER_AGENT] ? headers[USER_AGENT] : (
      // User-Agent from passed headers
      NAVIGATOR && NAVIGATOR.userAgent ? NAVIGATOR.userAgent : (
        // navigator.userAgent
        EMPTY
      )
    )
  ), httpUACH = new UACHData(headers, true), regexMap = extensions ? extend(defaultRegexes, extensions) : defaultRegexes, createItemFunc = function(itemType) {
    if (itemType == RESULT) {
      return function() {
        return new UAItem(itemType, userAgent, regexMap, httpUACH).set("ua", userAgent).set(BROWSER, this.getBrowser()).set(CPU, this.getCPU()).set(DEVICE, this.getDevice()).set(ENGINE, this.getEngine()).set(OS, this.getOS()).get();
      };
    } else {
      return function() {
        return new UAItem(itemType, userAgent, regexMap[itemType], httpUACH).parseUA().get();
      };
    }
  };
  setProps.call(this, [
    ["getBrowser", createItemFunc(BROWSER)],
    ["getCPU", createItemFunc(CPU)],
    ["getDevice", createItemFunc(DEVICE)],
    ["getEngine", createItemFunc(ENGINE)],
    ["getOS", createItemFunc(OS)],
    ["getResult", createItemFunc(RESULT)],
    ["getUA", function() {
      return userAgent;
    }],
    ["setUA", function(ua2) {
      if (isString(ua2)) userAgent = trim(ua2, UA_MAX_LENGTH);
      return this;
    }]
  ]).setUA(userAgent);
  return this;
}
UAParser.VERSION = LIBVERSION;
UAParser.BROWSER = enumerize([NAME, VERSION, MAJOR, TYPE2]);
UAParser.CPU = enumerize([ARCHITECTURE]);
UAParser.DEVICE = enumerize([MODEL, VENDOR, TYPE2, CONSOLE, MOBILE, SMARTTV, TABLET, WEARABLE, EMBEDDED]);
UAParser.ENGINE = UAParser.OS = enumerize([NAME, VERSION]);

// src/lib/functions/file-loaders/utils/init-zip-settings.ts
function initZipSettings() {
  configure({
    useWebWorkers: !isKiwiBrowser()
  });
}
function isKiwiBrowser() {
  if (typeof window === "undefined") return false;
  const parseResult = new UAParser(window.navigator.userAgent).getResult();
  return parseResult.os.name === "Android" && parseResult.browser.name === "Chrome";
}

// src/lib/functions/file-loaders/epub/extract-epub.ts
var import_path_browserify = __toESM(require_path_browserify(), 1);
initZipSettings();
async function extractEpub(blob, options = {}) {
  const skipImageData = options.imageData === false;
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const result = {};
  let contentsDirectory = "";
  let contents;
  if (entries.length) {
    const fileMap = entries.reduce((acc, cur) => {
      acc[cur.filename] = cur;
      return acc;
    }, {});
    const containerXml = await fileMap["META-INF/container.xml"].getData(new TextWriter());
    const parser = new XMLParser({
      ignoreAttributes: false
    });
    const container = parser.parse(containerXml);
    const rootFiles = container.container.rootfiles.rootfile;
    const rootFile = Array.isArray(rootFiles) ? rootFiles[0] : rootFiles;
    const contentOpfFilename = rootFile["@_full-path"];
    const contentsXml = await fileMap[contentOpfFilename].getData(new TextWriter());
    result[contentOpfFilename] = contentsXml;
    contentsDirectory = import_path_browserify.default.dirname(contentOpfFilename);
    contents = parser.parse(contentsXml);
    await Promise.all(
      (isOPFType(contents) ? contents["opf:package"]["opf:manifest"]["opf:item"] : contents.package.manifest.item).map(async (item) => {
        const fileRelativePath = item["@_href"];
        const entry = fileMap[import_path_browserify.default.join(contentsDirectory, fileRelativePath)];
        if (!entry) {
          throw new Error(`item ${fileRelativePath} not found`);
        }
        if (entry.getData && !entry.directory) {
          let value;
          const mediaType = item["@_media-type"];
          if (mediaType.startsWith("image/")) {
            value = skipImageData ? new Blob([], { type: mediaType }) : await entry.getData(new BlobWriter(mediaType));
          } else {
            value = await entry.getData(new TextWriter());
          }
          result[fileRelativePath] = value;
        }
      })
    );
  }
  await reader.close();
  return {
    contentsDirectory,
    contents,
    result
  };
}

// src/lib/functions/file-loaders/utils/build-dummy-book-image.ts
function buildDummyBookImage(key) {
  return `data:image/gif;ttu:${key};base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==`;
}

// src/lib/functions/file-loaders/utils/clear-all-bad-image-ref.ts
function clearAllBadImageRef(el) {
  const clearTagBadImageAttribute = (tag, attributeName) => {
    const attr = tag.getAttribute(attributeName);
    if (attr && !(attr.startsWith("ttu:") || attr.startsWith("data:image/gif;ttu:"))) {
      tag.setAttribute(`data-ttu-${attributeName}`, attr);
      tag.removeAttribute(attributeName);
    }
  };
  Array.from(el.getElementsByTagName("image")).forEach((tag) => {
    clearTagBadImageAttribute(tag, "href");
  });
  Array.from(el.getElementsByTagName("img")).forEach((tag) => {
    clearTagBadImageAttribute(tag, "src");
  });
}

// src/lib/functions/file-loaders/utils/fix-xhtml-href.ts
function fixXHtmlHref(el) {
  Array.from(el.getElementsByTagName("image")).filter((tag) => !tag.getAttributeNames().some((x) => x === "href")).forEach((tag) => {
    const attr = Array.from(tag.attributes).find((a) => a.name.endsWith("href"));
    if (!attr) return;
    tag.setAttribute("href", attr.value);
  });
}

// src/lib/data/import-html-fix-mode.ts
var ImportHTMLFixMode = /* @__PURE__ */ ((ImportHTMLFixMode2) => {
  ImportHTMLFixMode2["OFF"] = "Off";
  ImportHTMLFixMode2["STANDARD"] = "Standard";
  ImportHTMLFixMode2["EXTENDED"] = "Extended";
  return ImportHTMLFixMode2;
})(ImportHTMLFixMode || {});

// src/lib/functions/is-element-gaiji.ts
function isElementGaiji(el) {
  return Array.from(el.classList).some((className) => className.includes("gaiji"));
}

// src/lib/functions/is-node-gaiji.ts
function isNodeGaiji(node) {
  if (!(node instanceof HTMLImageElement)) {
    return false;
  }
  return isElementGaiji(node);
}

// src/lib/functions/get-character-count.ts
function getCharacterCount(node) {
  return isNodeGaiji(node) ? 1 : getRawCharacterCount(node);
}
var isNotJapaneseRegex = /[^0-9A-Z○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー０-９Ａ-Ｚｦ-ﾝ\p{Radical}\p{Unified_Ideograph}]+/gimu;
function getRawCharacterCount(node) {
  if (!node.textContent) return 0;
  return countUnicodeCharacters(node.textContent.replace(isNotJapaneseRegex, ""));
}
function countUnicodeCharacters(s) {
  return Array.from(s).length;
}

// src/lib/components/book-reader/get-paragraph-nodes.ts
function getParagraphNodes(node) {
  return getTextNodeOrGaijiNodes(node, (n) => {
    if (n.nodeName === "RT") {
      return false;
    }
    const isHidden = n instanceof HTMLElement && (n.attributes.getNamedItem("aria-hidden") || n.attributes.getNamedItem("hidden"));
    if (isHidden) {
      return false;
    }
    return true;
  }).filter((n) => {
    if (isNodeGaiji(n)) {
      return true;
    }
    if (n.textContent?.replace(/\s/g, "").length) {
      return true;
    }
    return false;
  });
}
function getTextNodeOrGaijiNodes(node, filterFn) {
  if (!node.hasChildNodes() || !filterFn(node)) {
    return [];
  }
  return Array.from(node.childNodes).flatMap((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      return [n];
    }
    if (isNodeGaiji(n)) {
      return [n];
    }
    return getTextNodeOrGaijiNodes(n, filterFn);
  }).filter(filterFn);
}

// src/lib/functions/file-loaders/epub/generate-epub-html.ts
var import_path_browserify2 = __toESM(require_path_browserify(), 1);
var prependValue = "ttu-";
var controlCharactersRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gim;
var htmlHexEntitiesRegex = /&#x([0-9A-Fa-f]+);/gim;
var htmlDecEntitiesRegex = /&#(\d+);/gim;
var selfClosingTagsRegex = /><\/(meta|link)>/gim;
var selfClosingContentTags = [
  "a",
  "body",
  "code",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "ol",
  "ops:default",
  "p",
  "rb",
  "rt",
  "ruby",
  "script",
  "span",
  "td",
  "th",
  "title"
];
function generateEpubHtml(data, contents, document2, contentsDirectory, { importHTMLFixMode, restrictImportFixToAnchor }) {
  const fallbackData = /* @__PURE__ */ new Map();
  const applyImportFixes = importHTMLFixMode !== "Off" /* OFF */;
  const selfClosingContentTagsToFix = applyImportFixes && !restrictImportFixToAnchor ? selfClosingContentTags : [];
  let tocData = { type: 3, content: "" };
  let navKey = "";
  const itemIdToHtmlRef = (isOPFType(contents) ? contents["opf:package"]["opf:manifest"]["opf:item"] : contents.package.manifest.item).reduce((acc, item) => {
    if (item["@_fallback"]) {
      fallbackData.set(item["@_id"], item["@_fallback"]);
    }
    if (item["@_media-type"] === "application/xhtml+xml" || item["@_media-type"] === "text/html") {
      acc[item["@_id"]] = item["@_href"];
      if (item["@_properties"] === "nav") {
        navKey = item["@_href"];
      }
    }
    return acc;
  }, {});
  const blobLocations = Object.entries(data).reduce((acc, [key, value]) => {
    const isV2Toc = key.endsWith(".ncx") && !tocData.content;
    if (isV2Toc || navKey === key) {
      tocData = {
        type: isV2Toc ? 2 : 3,
        content: value
      };
    }
    if (value instanceof Blob) {
      acc.push(key);
    }
    return acc;
  }, []);
  const parser = new DOMParser();
  const spineItemRef = isOPFType(contents) ? contents["opf:package"]["opf:spine"]["opf:itemref"] : contents.package.spine.itemref;
  const itemRefs = Array.isArray(spineItemRef) ? spineItemRef : [spineItemRef];
  const sectionData = [];
  const result = document2.createElement("div");
  let mainChapters = [];
  let firstChapterMatchIndex = -1;
  if (applyImportFixes && restrictImportFixToAnchor) {
    selfClosingContentTagsToFix.push("a");
  }
  if (tocData.type && tocData.content) {
    let parsedToc = parser.parseFromString(tocData.content, "text/html");
    if (tocData.type === 3) {
      let navTocElement = parsedToc.querySelector('nav[epub\\:type="toc"],nav#toc');
      if (!navTocElement) {
        parsedToc = parser.parseFromString(tocData.content, "text/xml");
      }
      navTocElement = parsedToc.querySelector('nav[epub\\:type="toc"],nav#toc');
      if (navTocElement) {
        mainChapters = [...navTocElement.querySelectorAll("a")].map((elm) => {
          const anchor = elm;
          return { reference: anchor.href, charactersWeight: 1, label: anchor.innerText };
        });
      }
    } else {
      mainChapters = [...parsedToc.querySelectorAll("navPoint")].map((elm) => {
        const navLabel = elm.querySelector("navLabel text");
        const contentElm = elm.querySelector("content");
        return {
          reference: contentElm.getAttribute("src"),
          charactersWeight: 1,
          label: navLabel.innerText
        };
      });
    }
  }
  if (mainChapters.length) {
    firstChapterMatchIndex = itemRefs.findIndex(
      (ref) => mainChapters[0].reference.includes(itemIdToHtmlRef[ref["@_idref"].split("/").pop() || ""])
    );
    if (firstChapterMatchIndex !== 0) {
      const firstRef = itemRefs[0]["@_idref"];
      const firstHTMLRef = itemIdToHtmlRef[firstRef];
      const fallbackRef = fallbackData.get(firstRef);
      const reference = firstHTMLRef || (fallbackRef ? itemIdToHtmlRef[fallbackRef] : firstHTMLRef);
      mainChapters.unshift({
        reference,
        charactersWeight: 1,
        label: "Preface",
        startCharacter: 0
      });
    }
  }
  let currentMainChapter = mainChapters[0];
  let currentMainChapterId = currentMainChapter ? `${prependValue}${itemRefs[0]["@_idref"]}` : "";
  let currentMainChapterIndex = 0;
  let previousCharacterCount = 0;
  let currentCharCount = 0;
  itemRefs.forEach((item) => {
    let itemIdRef = item["@_idref"];
    let htmlHref = itemIdToHtmlRef[itemIdRef];
    if (!htmlHref && fallbackData.has(itemIdRef)) {
      itemIdRef = fallbackData.get(itemIdRef);
      htmlHref = itemIdToHtmlRef[itemIdRef];
    }
    let contentToParse = data[htmlHref] || "";
    for (const tagMatch of selfClosingContentTagsToFix) {
      const matches = contentToParse.match(new RegExp(`<${tagMatch}[^>]+?>`, "gim")) || [];
      for (const match of matches) {
        if (match.endsWith("/>")) {
          contentToParse = contentToParse.replace(match, `${match.slice(0, -2)}></${tagMatch}>`);
        }
      }
    }
    if (importHTMLFixMode === "Extended" /* EXTENDED */) {
      contentToParse = contentToParse.replace(controlCharactersRegex, "").replace(selfClosingTagsRegex, ">").replace(htmlHexEntitiesRegex, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(htmlDecEntitiesRegex, (_, dec) => String.fromCharCode(parseInt(dec, 10))).replace("<!DOCTYPE html []>", "<!DOCTYPE html>").trim();
    }
    let parsedContent = parser.parseFromString(contentToParse, "text/html");
    let body = parsedContent.body;
    if (!body?.childNodes?.length) {
      parsedContent = parser.parseFromString(contentToParse, "text/xml");
      body = parsedContent.querySelector("body");
      if (!body?.childNodes?.length) {
        throw new Error("Unable to find valid body content while parsing EPUB");
      }
    }
    const htmlClass = parsedContent.querySelector("html")?.className || "";
    const bodyId = body.id || "";
    const bodyClass = body.className || "";
    for (const elm of [...body.querySelectorAll("image,img")]) {
      const attributes = elm.tagName.toLowerCase() === "image" ? elm.getAttributeNames().filter((attr) => attr.endsWith("href")) : ["src"];
      for (const attr of attributes) {
        const value = elm.getAttribute(attr);
        if (value) {
          elm.setAttribute(attr, import_path_browserify2.default.join(import_path_browserify2.default.dirname(htmlHref), value));
        }
      }
    }
    let innerHtml = body.innerHTML || "";
    blobLocations.forEach((blobLocation) => {
      innerHtml = innerHtml.replaceAll(
        relative(contentsDirectory, blobLocation),
        buildDummyBookImage(blobLocation)
      );
    });
    const childBodyDiv = document2.createElement("div");
    childBodyDiv.className = `ttu-book-body-wrapper ${bodyClass}`;
    if (bodyId) {
      childBodyDiv.id = bodyId;
    }
    childBodyDiv.innerHTML = innerHtml;
    const childHtmlDiv = document2.createElement("div");
    childHtmlDiv.className = `ttu-book-html-wrapper ${htmlClass}`;
    childHtmlDiv.appendChild(childBodyDiv);
    const childWrapperDiv = document2.createElement("div");
    childWrapperDiv.id = `${prependValue}${itemIdRef}`;
    childWrapperDiv.appendChild(childHtmlDiv);
    result.appendChild(childWrapperDiv);
    const elementCharCount = countForElement(childWrapperDiv);
    currentCharCount += elementCharCount;
    if (!elementCharCount) {
      childHtmlDiv.classList.add("ttu-no-text");
      childBodyDiv.classList.add("ttu-no-text");
    }
    const mainChapterIndex = mainChapters.findIndex(
      (chapter) => chapter.reference.includes(htmlHref.split("/").pop() || "")
    );
    const mainChapter = mainChapterIndex > -1 ? mainChapters[mainChapterIndex] : void 0;
    const characters = currentCharCount - previousCharacterCount;
    if (mainChapter) {
      const oldMainChapterIndex = currentMainChapterIndex;
      currentMainChapter = mainChapter;
      currentMainChapterIndex = sectionData.length;
      currentMainChapterId = `${prependValue}${itemIdRef}`;
      sectionData.push({
        reference: currentMainChapterId,
        charactersWeight: characters || 1,
        label: currentMainChapter.label,
        startCharacter: currentMainChapterIndex ? sectionData[oldMainChapterIndex].startCharacter + sectionData[oldMainChapterIndex].characters : 0,
        characters
      });
    } else if (currentMainChapter) {
      sectionData[currentMainChapterIndex].characters += characters;
      sectionData.push({
        reference: `${prependValue}${itemIdRef}`,
        charactersWeight: characters || 1,
        parentChapter: currentMainChapterId
      });
    }
    previousCharacterCount = currentCharCount;
  });
  clearAllBadImageRef(result);
  fixXHtmlHref(result);
  flattenAnchorHref(result);
  return {
    element: result,
    characters: currentCharCount,
    sections: sectionData.filter((item) => item.reference.startsWith(prependValue))
  };
}
function countForElement(containerEl) {
  const paragraphs = getParagraphNodes(containerEl);
  let characterCount = 0;
  paragraphs.forEach((node) => {
    characterCount += getCharacterCount(node);
  });
  return characterCount;
}
function flattenAnchorHref(el) {
  Array.from(el.getElementsByTagName("a")).forEach((tag) => {
    const oldHref = tag.getAttribute("href");
    if (!oldHref) return;
    tag.setAttribute("href", `#${oldHref.replace(/.+#/, "")}`);
  });
}
function relative(fromPath, toPath) {
  const fromDirName = import_path_browserify2.default.dirname(fromPath);
  const toDirName = import_path_browserify2.default.dirname(toPath);
  const toFilename = import_path_browserify2.default.basename(toPath);
  if (fromDirName === toDirName) {
    return toFilename;
  }
  const fromParts = fromDirName === "." ? [] : fromDirName.split("/");
  const toParts = toDirName === "." ? [] : toDirName.split("/");
  if (fromParts.length >= toParts.length) {
    for (let i = 0; i < fromParts.length; i += 1) {
      if (fromParts[i] !== toParts[i]) {
        return import_path_browserify2.default.join(
          "../".repeat(fromParts.length - i) + toParts.slice(i).join("/"),
          toFilename
        );
      }
    }
  }
  for (let i = 0; i < fromParts.length; i += 1) {
    if (fromParts[i] !== toParts[i]) {
      return import_path_browserify2.default.join("../".repeat(fromParts.length - i) + toParts.slice(i).join("/"), toFilename);
    }
  }
  return import_path_browserify2.default.join(toParts.slice(fromParts.length - toParts.length).join("/"), toFilename);
}

// src/lib/functions/file-loaders/epub/count-epub.ts
var EPUB_COUNT_VERSION = 1;
async function countEpub(epub, document2, options, extractOptions = {}) {
  const { contents, result: data, contentsDirectory } = await extractEpub(epub, extractOptions);
  const result = generateEpubHtml(data, contents, document2, contentsDirectory, options);
  return {
    characters: result.characters,
    sections: result.sections,
    elementHtml: result.element.innerHTML
  };
}

// src/lib/server/epub/node-dom.ts
var import_jsdom = require("jsdom");

// src/lib/server/epub/prefixed-attribute-selectors.ts
var XHTML_NS = "http://www.w3.org/1999/xhtml";
function unescapeIdentifier(text) {
  return text.replace(
    /\\([0-9a-fA-F]{1,6})\s?|\\(.)/g,
    (_, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16)) : char
  );
}
function unquote(value) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return unescapeIdentifier(value);
}
function splitSelectorList(selector) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (char === "\\") {
      i += 1;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim());
}
var attributeRegex = /^\[\s*((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[-\w\u0080-￿])+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:\\.|[-\w\u0080-￿])+)\s*([iIsS])?\s*)?\]$/;
function prepareComplexSelector(selector) {
  const groups = [];
  let lastCombinatorEnd = 0;
  let parenDepth = 0;
  let quote = "";
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (char === "\\") {
      i += 1;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth -= 1;
    } else if (char === "[") {
      let end = i + 1;
      let innerQuote = "";
      for (; end < selector.length; end += 1) {
        const c = selector[end];
        if (c === "\\") end += 1;
        else if (innerQuote) {
          if (c === innerQuote) innerQuote = "";
        } else if (c === '"' || c === "'") innerQuote = c;
        else if (c === "]") break;
      }
      if (parenDepth === 0) {
        groups.push({ start: i, end: end + 1, text: selector.slice(i, end + 1) });
      }
      i = end;
    } else if (parenDepth === 0 && /[\s>+~]/.test(char)) {
      lastCombinatorEnd = i + 1;
    }
  }
  const prefixed = groups.filter((group) => {
    const match = group.text.match(attributeRegex);
    return match ? unescapeIdentifier(match[1]).includes(":") : /^\[[^=\]]*\\(:|0*3[aA])/.test(group.text);
  });
  if (!prefixed.length) {
    return void 0;
  }
  const conditions = [];
  let reduced = selector;
  for (const group of [...prefixed].reverse()) {
    const match = group.text.match(attributeRegex);
    if (!match || group.start < lastCombinatorEnd) {
      throw new Error(
        `Unsupported selector for the Node DOM (prefixed attribute must be on the selected element): ${selector}`
      );
    }
    conditions.unshift({
      name: unescapeIdentifier(match[1]),
      operator: match[2],
      value: match[3] === void 0 ? void 0 : unquote(match[3]),
      caseInsensitive: match[4]?.toLowerCase() === "i"
    });
    reduced = reduced.slice(0, group.start) + reduced.slice(group.end);
  }
  const lastCompound = reduced.slice(lastCombinatorEnd).trim();
  if (!lastCompound) {
    reduced = `${reduced}*`;
  }
  return { reduced: reduced.trim(), conditions };
}
function attributeMatches(element, condition) {
  const htmlRules = element.namespaceURI === XHTML_NS && element.ownerDocument.contentType === "text/html";
  const attribute = Array.from(element.attributes).find(
    (attr) => attr.namespaceURI === null && (htmlRules ? attr.localName.toLowerCase() === condition.name.toLowerCase() : attr.localName === condition.name)
  );
  if (!attribute) return false;
  if (!condition.operator) return true;
  const fold = (text) => condition.caseInsensitive ? text.toLowerCase() : text;
  const actual = fold(attribute.value);
  const expected = fold(condition.value ?? "");
  switch (condition.operator) {
    case "=":
      return actual === expected;
    case "~=":
      return !!expected && !/\s/.test(expected) && actual.split(/[ \t\n\f\r]+/).includes(expected);
    case "|=":
      return actual === expected || actual.startsWith(`${expected}-`);
    case "^=":
      return !!expected && actual.startsWith(expected);
    case "$=":
      return !!expected && actual.endsWith(expected);
    case "*=":
      return !!expected && actual.includes(expected);
    default:
      return false;
  }
}
function queryWithPrefixedAttributes(context, selector, originalQueryAll) {
  const prepared = splitSelectorList(selector).map((part) => ({
    part,
    prepared: prepareComplexSelector(part)
  }));
  if (prepared.every((entry) => !entry.prepared)) {
    return void 0;
  }
  const found = /* @__PURE__ */ new Set();
  for (const { part, prepared: entry } of prepared) {
    const candidates = originalQueryAll.call(context, entry ? entry.reduced : part);
    for (const element of Array.from(candidates)) {
      if (!entry || entry.conditions.every((condition) => attributeMatches(element, condition))) {
        found.add(element);
      }
    }
  }
  return Array.from(found).sort(
    (a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1
  );
}
function hasPrefixedAttributeBug(window2) {
  const container = window2.document.createElement("div");
  container.innerHTML = '<nav epub:type="toc"></nav>';
  return !container.querySelector('nav[epub\\:type="toc"]');
}
function installPrefixedAttributeSelectorFix(window2) {
  if (!hasPrefixedAttributeBug(window2)) {
    return false;
  }
  for (const prototype of [
    window2.Document.prototype,
    window2.DocumentFragment.prototype,
    window2.Element.prototype
  ]) {
    const originalQueryAll = prototype.querySelectorAll;
    const originalQuery = prototype.querySelector;
    Object.defineProperty(prototype, "querySelectorAll", {
      configurable: true,
      writable: true,
      value(selectors) {
        const result = queryWithPrefixedAttributes(this, String(selectors), originalQueryAll);
        if (!result) {
          return originalQueryAll.call(this, selectors);
        }
        return Object.assign(result, { item: (index) => result[index] ?? null });
      }
    });
    Object.defineProperty(prototype, "querySelector", {
      configurable: true,
      writable: true,
      value(selectors) {
        const result = queryWithPrefixedAttributes(this, String(selectors), originalQueryAll);
        return result ? result[0] ?? null : originalQuery.call(this, selectors);
      }
    });
  }
  return true;
}

// src/lib/server/epub/node-dom.ts
var domGlobals = ["DOMParser", "Node", "Element", "HTMLElement", "HTMLImageElement"];
var baseUrl = "http://localhost/manage";
var nodeWindow;
function installNodeDom() {
  return nodeWindow ? nodeWindow.document : createNodeWindow(void 0).document;
}
function renewNodeDom() {
  const previous = nodeWindow;
  const document2 = createNodeWindow(previous).document;
  previous?.close();
  return document2;
}
function createNodeWindow(previous) {
  const window2 = new import_jsdom.JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: baseUrl
  }).window;
  const target = globalThis;
  for (const key of domGlobals) {
    const current = target[key];
    if (current !== void 0 && current !== window2[key] && current !== previous?.[key]) {
      throw new Error(`Refusing to replace an existing global DOM implementation (${key})`);
    }
  }
  for (const key of domGlobals) {
    target[key] = window2[key];
  }
  if (!("innerText" in window2.HTMLElement.prototype)) {
    Object.defineProperty(window2.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent ?? "";
      }
    });
  }
  installPrefixedAttributeSelectorFix(window2);
  nodeWindow = window2;
  return window2;
}

// src/lib/server/epub/count-epub-node.ts
var defaultEpubImportOptions = {
  importHTMLFixMode: "Off" /* OFF */,
  restrictImportFixToAnchor: true
};
function prepareNode(fresh = false) {
  const document2 = fresh ? renewNodeDom() : installNodeDom();
  configure({ useWebWorkers: false });
  return document2;
}
async function countEpubBlob(epub, options = defaultEpubImportOptions, extractOptions = {}) {
  return countEpub(epub, prepareNode(true), options, extractOptions);
}

// src/lib/server/epub/server-counter.ts
async function countEpubForServer(epub, options = defaultEpubImportOptions) {
  const { characters, sections } = await countEpubBlob(epub, options, { imageData: false });
  return { characters, sections };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EPUB_COUNT_VERSION,
  ImportHTMLFixMode,
  countEpubForServer,
  defaultEpubImportOptions
});
/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */
