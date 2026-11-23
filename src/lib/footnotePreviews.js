// Enhance the compiler's existing footnotes; leave their links and definitions intact
// so navigation still works when scripting is unavailable.
export function initFootnotePreviews(root = document) {
  const section = root.querySelector('.bk-content section[data-footnotes]');
  if (!section) return;

  for (const reference of root.querySelectorAll('.bk-content a[data-footnote-ref]')) {
    const href = reference.getAttribute('href');
    const sup = reference.parentElement;
    if (!href || !sup || sup.tagName !== 'SUP' || sup.classList.contains('bk-footnote-tooltip')) continue;

    // Generated footnote references point to a fragment of this document.
    if (!href.startsWith('#')) continue;
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      continue;
    }
    const note = document.getElementById(id);
    if (!note || !section.contains(note)) continue;

    const panel = document.createElement('span');
    panel.className = 'bk-tooltip-panel bk-footnote-panel';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', `Footnote ${reference.textContent?.trim() || ''} preview`);
    for (const child of note.childNodes) panel.append(child.cloneNode(true));
    for (const backref of panel.querySelectorAll('[data-footnote-backref]')) backref.remove();
    // Definitions remain the only owners of their anchors, including IDs authored
    // inside a footnote. Preview links still resolve to those original anchors.
    for (const copy of panel.querySelectorAll('[id]')) copy.removeAttribute('id');
    if (!panel.textContent?.trim()) continue;

    let panelId = `bk-footnote-preview-${reference.id || id}`;
    let suffix = 2;
    while (document.getElementById(panelId)) panelId = `bk-footnote-preview-${reference.id || id}-${suffix++}`;
    panel.id = panelId;
    reference.setAttribute('aria-details', panelId);
    sup.classList.add('bk-footnote-tooltip');
    sup.append(panel);

    const position = () => {
      panel.style.left = '0px';
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(12 - bounds.left, Math.min(0, window.innerWidth - 12 - bounds.right))}px`;
    };
    sup.addEventListener('mouseenter', position);
    sup.addEventListener('focusin', () => {
      sup.classList.remove('bk-footnote-dismissed');
      position();
    });
    sup.addEventListener('mouseleave', () => sup.classList.remove('bk-footnote-dismissed'));
    sup.addEventListener('focusout', (event) => {
      if (!sup.contains(event.relatedTarget)) sup.classList.remove('bk-footnote-dismissed');
    });
    reference.addEventListener('click', (event) => {
      // A first touch opens the preview; a second touch follows the original link.
      if (lastPointerType !== 'touch' || sup.classList.contains('bk-footnote-open')) return;
      event.preventDefault();
      closeTouchPreviews();
      sup.classList.add('bk-footnote-open');
      position();
    });
    sup.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      sup.classList.remove('bk-footnote-open');
      reference.focus();
      sup.classList.add('bk-footnote-dismissed');
    });
  }
}

let lastPointerType = '';
function closeTouchPreviews() {
  document.querySelectorAll('.bk-footnote-open').forEach((node) => node.classList.remove('bk-footnote-open'));
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (event) => {
    lastPointerType = event.pointerType;
    if (!(event.target).closest('.bk-footnote-tooltip')) closeTouchPreviews();
  });
  document.addEventListener('keydown', () => { lastPointerType = ''; });
  initFootnotePreviews();
}
