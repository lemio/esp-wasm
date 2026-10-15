/**
 * Update a DOM tree in place to match a freshly built one, instead of replacing it: text that
 * didn't change keeps its nodes (so a selection in it survives an update), the scroll position
 * stays, a focused input keeps what's being typed, and layout doesn't jump. Event handlers set
 * as properties (el.onclick = …) are carried over; listeners added with addEventListener aren't.
 */
const HANDLERS = ["onclick", "oninput", "onchange", "onkeydown", "onmouseenter", "onmouseleave", "onpointerdown"] as const;

const same = (a: Node, b: Node) =>
  a.nodeType === b.nodeType && (a.nodeType !== Node.ELEMENT_NODE || ((a as Element).tagName === (b as Element).tagName && (a as Element).namespaceURI === (b as Element).namespaceURI));

function morphNode(old: Node, next: Node): void {
  if (old.nodeType !== Node.ELEMENT_NODE) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  const o = old as HTMLElement, n = next as HTMLElement;
  for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
  for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
  for (const h of HANDLERS) (o as unknown as Record<string, unknown>)[h] = (n as unknown as Record<string, unknown>)[h];
  if (o instanceof HTMLInputElement && n instanceof HTMLInputElement) {
    if (document.activeElement !== o && o.value !== n.value) o.value = n.value;
    if (o.checked !== n.checked) o.checked = n.checked;
    o.disabled = n.disabled;
  } else if (o instanceof HTMLButtonElement && n instanceof HTMLButtonElement) {
    o.disabled = n.disabled;
  }
  if (o instanceof HTMLSelectElement && n instanceof HTMLSelectElement) {
    morphChildren(o, [...n.childNodes]);
    if (document.activeElement !== o) o.value = n.value;
    return;
  }
  morphChildren(o, [...n.childNodes]);
}

/** Make `parent`'s children look like `next`. */
export function morphChildren(parent: Node, next: Node[]): void {
  const old = [...parent.childNodes];
  next.forEach((n, i) => {
    const o = old[i];
    if (!o) parent.appendChild(n);
    else if (same(o, n)) morphNode(o, n);
    else parent.replaceChild(n, o);
  });
  for (let i = next.length; i < old.length; i++) old[i].remove();
}
