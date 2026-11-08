/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Node-only workaround for a jsdom selector bug.
 *
 * jsdom 28 (selector engine @asamuzakjp/dom-selector 6.8.1) never matches attribute
 * selectors whose name contains an escaped colon, such as the EPUB loader's
 * `nav[epub\:type="toc"]`. Browsers do: in HTML-parsed documents `epub:type` is a plain
 * attribute with that literal name. Without this, books whose TOC nav is marked only by
 * `epub:type="toc"` get no chapter sections in Node.
 *
 * The patch only touches querySelector/querySelectorAll calls whose selector has such an
 * attribute selector. The rest of the selector is still run by jsdom; the prefixed
 * attribute conditions are then checked here, following the Selectors spec as browsers
 * apply it (verified against Chromium in node-dom.test.ts):
 * - an attribute selector without a namespace component only matches attributes with
 *   no namespace (so prefixed attributes in XML-parsed documents never match);
 * - attribute names are ASCII case-insensitive for HTML elements in HTML documents;
 * - values are case-sensitive unless the `i` flag is given.
 * Supported only in the last compound of each selector (the element being selected);
 * other placements throw instead of silently giving a different answer.
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

interface AttributeCondition {
  name: string;
  operator?: string;
  value?: string;
  caseInsensitive: boolean;
}

interface PreparedSelector {
  reduced: string;
  conditions: AttributeCondition[];
}

function unescapeIdentifier(text: string) {
  return text.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string, char: string) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : char
  );
}

function unquote(value: string) {
  const quote = value[0];

  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }

  return unescapeIdentifier(value);
}

/** Splits a selector list on top-level commas. */
function splitSelectorList(selector: string) {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;

  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];

    if (char === '\\') {
      i += 1;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(selector.slice(start));

  return parts.map((part) => part.trim());
}

const attributeRegex =
  /^\[\s*((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[-\w\u0080-￿])+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:\\.|[-\w\u0080-￿])+)\s*([iIsS])?\s*)?\]$/;

/**
 * Returns undefined when the selector has no prefixed attribute selector (so jsdom can
 * handle it), otherwise the selector without them plus the conditions to check.
 */
function prepareComplexSelector(selector: string): PreparedSelector | undefined {
  const groups: Array<{ start: number; end: number; text: string }> = [];
  let lastCombinatorEnd = 0;
  let parenDepth = 0;
  let quote = '';

  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];

    if (char === '\\') {
      i += 1;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth -= 1;
    } else if (char === '[') {
      let end = i + 1;
      let innerQuote = '';

      for (; end < selector.length; end += 1) {
        const c = selector[end];

        if (c === '\\') end += 1;
        else if (innerQuote) {
          if (c === innerQuote) innerQuote = '';
        } else if (c === '"' || c === "'") innerQuote = c;
        else if (c === ']') break;
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

    return match
      ? unescapeIdentifier(match[1]).includes(':')
      : /^\[[^=\]]*\\(:|0*3[aA])/.test(group.text);
  });

  if (!prefixed.length) {
    return undefined;
  }

  const conditions: AttributeCondition[] = [];
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
      value: match[3] === undefined ? undefined : unquote(match[3]),
      caseInsensitive: match[4]?.toLowerCase() === 'i'
    });
    reduced = reduced.slice(0, group.start) + reduced.slice(group.end);
  }

  const lastCompound = reduced.slice(lastCombinatorEnd).trim();

  if (!lastCompound) {
    reduced = `${reduced}*`;
  }

  return { reduced: reduced.trim(), conditions };
}

function attributeMatches(element: Element, condition: AttributeCondition) {
  const htmlRules =
    element.namespaceURI === XHTML_NS &&
    (element.ownerDocument as Document & { contentType?: string }).contentType === 'text/html';
  const attribute = Array.from(element.attributes).find(
    (attr) =>
      attr.namespaceURI === null &&
      (htmlRules
        ? attr.localName.toLowerCase() === condition.name.toLowerCase()
        : attr.localName === condition.name)
  );

  if (!attribute) return false;
  if (!condition.operator) return true;

  const fold = (text: string) => (condition.caseInsensitive ? text.toLowerCase() : text);
  const actual = fold(attribute.value);
  const expected = fold(condition.value ?? '');

  switch (condition.operator) {
    case '=':
      return actual === expected;
    case '~=':
      return !!expected && !/\s/.test(expected) && actual.split(/[ \t\n\f\r]+/).includes(expected);
    case '|=':
      return actual === expected || actual.startsWith(`${expected}-`);
    case '^=':
      return !!expected && actual.startsWith(expected);
    case '$=':
      return !!expected && actual.endsWith(expected);
    case '*=':
      return !!expected && actual.includes(expected);
    default:
      return false;
  }
}

type QueryAll = (this: ParentNode, selectors: string) => NodeListOf<Element>;

function queryWithPrefixedAttributes(
  context: ParentNode,
  selector: string,
  originalQueryAll: QueryAll
): Element[] | undefined {
  const prepared = splitSelectorList(selector).map((part) => ({
    part,
    prepared: prepareComplexSelector(part)
  }));

  if (prepared.every((entry) => !entry.prepared)) {
    return undefined;
  }

  const found = new Set<Element>();

  for (const { part, prepared: entry } of prepared) {
    const candidates = originalQueryAll.call(context, entry ? entry.reduced : part);

    for (const element of Array.from(candidates)) {
      if (!entry || entry.conditions.every((condition) => attributeMatches(element, condition))) {
        found.add(element);
      }
    }
  }

  return Array.from(found).sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & 4 /* FOLLOWING */ ? -1 : 1
  );
}

function hasPrefixedAttributeBug(window: Window & typeof globalThis) {
  const container = window.document.createElement('div');

  container.innerHTML = '<nav epub:type="toc"></nav>';

  return !container.querySelector('nav[epub\\:type="toc"]');
}

/**
 * Installs the workaround on a jsdom window if (and only if) that jsdom has the bug.
 * Returns whether it was installed.
 */
export function installPrefixedAttributeSelectorFix(window: Window & typeof globalThis) {
  if (!hasPrefixedAttributeBug(window)) {
    return false;
  }

  for (const prototype of [
    window.Document.prototype,
    window.DocumentFragment.prototype,
    window.Element.prototype
  ]) {
    const originalQueryAll = prototype.querySelectorAll as unknown as QueryAll;
    const originalQuery = prototype.querySelector;

    Object.defineProperty(prototype, 'querySelectorAll', {
      configurable: true,
      writable: true,
      value(this: ParentNode, selectors: string) {
        const result = queryWithPrefixedAttributes(this, String(selectors), originalQueryAll);

        if (!result) {
          return originalQueryAll.call(this, selectors);
        }

        return Object.assign(result, { item: (index: number) => result[index] ?? null });
      }
    });

    Object.defineProperty(prototype, 'querySelector', {
      configurable: true,
      writable: true,
      value(this: ParentNode, selectors: string) {
        const result = queryWithPrefixedAttributes(this, String(selectors), originalQueryAll);

        return result ? (result[0] ?? null) : originalQuery.call(this, selectors);
      }
    });
  }

  return true;
}
