// Loading badges ("что крутится"). Every badge is inline SVG/HTML animated by CSS only
// (transform/opacity), so it keeps moving while the app's JS is busy loading.
// No SVG ids anywhere: the same markup is cloned into tiles, the mini preview and the
// real splash, and a duplicated id breaks as soon as its first copy is hidden.

const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i;

const SAKURA_PETAL = 'M32 32 C 23 25, 21 14, 27 9 C 29 8, 31 9.5, 32 12 C 33 9.5, 35 8, 37 9 C 43 14, 41 25, 32 32 Z';
const LEAF = '<path d="M10 1 C 16 5, 18 12, 10 19 C 2 12, 4 5, 10 1 Z" fill="FILL"/><path d="M10 3 L10 18" stroke="rgba(0,0,0,0.28)" stroke-width="1"/>';

/** Rune glyphs drawn around (0,0), roughly ±3 units. Shared with the runes VFX. */
export const RUNE_GLYPHS = [
    'M-1 -3V3M-1 -3L2 -1.5M-1 0L2 1.5',
    'M-2 3V-3L2 -1V3',
    'M0 -3V3M-2 -1L0 1L2 -1',
    'M-2 -3L2 3M2 -3L-2 3',
    'M-1.5 -3V3M-1.5 -3L1.5 0L-1.5 3',
    'M0 -3V3M-2 -3L2 3',
    'M-2 3L0 -3L2 3M-1 0.5H1',
    'M-2 -3V3M2 -3V3M-2 0L2 0',
];

const steam = (xs, y) => xs.map((x, i) =>
    `<path class="cs-steam" style="--d:${(i * 0.8).toFixed(1)}s" d="M${x} ${y} C ${x - 4} ${y - 6}, ${x + 4} ${y - 10}, ${x} ${y - 16}" stroke="rgba(255,255,255,0.45)" stroke-width="2.5" stroke-linecap="round" fill="none"/>`).join('');

const plumbobFace = `
    <svg viewBox="0 0 40 64">
      <polygon points="20,2 6,24 20,62" fill="var(--pb-l)"/>
      <polygon points="20,2 34,24 20,62" fill="var(--pb-d)"/>
      <polygon points="20,2 6,24 20,21" fill="var(--pb-h)" opacity="0.7"/>
      <polygon points="20,2 34,24 20,21" fill="var(--pb-l)" opacity="0.6"/>
      <polyline points="6,24 20,21 34,24" stroke="rgba(255,255,255,0.35)" stroke-width="0.6" fill="none"/>
    </svg>`;

const ART = {
    heart: () => `
        <svg class="cs-art cs-art-heart" viewBox="0 0 64 64">
          <path d="M32 56 C 12 42, 4 30, 4 20 C 4 11, 11 5, 19 5 C 25 5, 29.5 8.5, 32 13 C 34.5 8.5, 39 5, 45 5 C 53 5, 60 11, 60 20 C 60 30, 52 42, 32 56 Z" fill="#e8345a"/>
          <path d="M32 56 C 46 46, 56 36, 59 25 C 55 35, 45 44, 32 52 Z" fill="#b8173c" opacity="0.6"/>
          <path d="M14 14 C 11 16.5, 10 20, 10.5 23.5" stroke="rgba(255,255,255,0.6)" stroke-width="3" stroke-linecap="round" fill="none"/>
        </svg>`,

    flower: () => `
        <svg class="cs-art cs-art-flower" viewBox="0 0 64 64">
          ${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<ellipse cx="32" cy="15" rx="7" ry="13" fill="#fbe6f0" stroke="#efb1cb" stroke-width="1" transform="rotate(${a} 32 32)"/>`).join('')}
          <circle cx="32" cy="32" r="7.5" fill="#f5c542"/>
          <circle cx="32" cy="32" r="3.5" fill="#e0951d"/>
        </svg>`,

    sakura: () => `
        <svg class="cs-art cs-art-sakura" viewBox="0 0 64 64">
          ${[0, 72, 144, 216, 288].map(a => `<path d="${SAKURA_PETAL}" fill="#ffc9da" stroke="#f29bbb" stroke-width="0.8" transform="rotate(${a} 32 32)"/>`).join('')}
          <circle cx="32" cy="32" r="4" fill="#fff0f5"/>
          ${[0, 72, 144, 216, 288].map(a => `<circle cx="32" cy="25.5" r="1.3" fill="#e2557a" transform="rotate(${a + 36} 32 32)"/>`).join('')}
        </svg>
        ${[[-26, 220], [18, -260], [-8, 180], [30, -200], [-34, 300]].map(([x, r], i) =>
        `<span class="cs-petal" style="--px:${x}px;--pr:${r}deg;--d:${(i * 0.65).toFixed(2)}s"></span>`).join('')}`,

    leaves: () => [['#e8833a', 10], ['#d4552b', 62], ['#e9b949', 36], ['#9c6b3a', 88]].map(([c, x], i) =>
        `<span class="cs-leaf" style="--lx:${x}%;--d:${(i * 0.9).toFixed(2)}s"><svg viewBox="0 0 20 20">${LEAF.replace('FILL', c)}</svg></span>`).join(''),

    butterfly: () => {
        const wings = `
            <g class="cs-wing">
              <path d="M31 30 C 22 12, 6 12, 7 24 C 8 33, 20 34, 31 32 Z" fill="#8e6cff"/>
              <path d="M31 33 C 20 34, 11 42, 15 49 C 19 54, 28 45, 31 35 Z" fill="#c58cff"/>
              <circle cx="16" cy="23" r="2.6" fill="#fff" opacity="0.65"/>
              <circle cx="19" cy="44" r="1.8" fill="#fff" opacity="0.55"/>
            </g>`;
        return `
        <svg class="cs-art cs-art-butterfly" viewBox="0 0 64 64">
          ${wings}
          <g transform="matrix(-1 0 0 1 64 0)">${wings}</g>
          <ellipse cx="32" cy="33" rx="1.8" ry="10" fill="#2b2233"/>
          <path d="M31 24 C 29 18, 26 15, 24 14 M33 24 C 35 18, 38 15, 40 14" stroke="#2b2233" stroke-width="1" fill="none"/>
        </svg>`;
    },

    stars: () => {
        const pts = [[12, 40], [22, 22], [36, 30], [48, 14], [54, 38], [34, 50]];
        const lines = pts.slice(1).map((p, i) => `<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${p[0]}" y2="${p[1]}"/>`).join('');
        return `
        <svg class="cs-art cs-art-stars" viewBox="0 0 64 64">
          <g class="cs-const-lines" stroke="rgba(255,255,255,0.35)" stroke-width="0.8">${lines}</g>
          ${pts.map(([x, y], i) => `<g transform="translate(${x} ${y})"><path class="cs-twinkle" style="--d:${(i * 0.37).toFixed(2)}s" d="M0 -4.5 L1.1 -1.1 L4.5 0 L1.1 1.1 L0 4.5 L-1.1 1.1 L-4.5 0 L-1.1 -1.1 Z" fill="#fff7d6"/></g>`).join('')}
        </svg>`;
    },

    plumbob: s => `
        <span class="cs-pb cs-pb-${s.plumbobColor || 'green'}">
          <span class="cs-pb-spin">
            <span class="cs-pb-face cs-pb-a">${plumbobFace}</span>
            <span class="cs-pb-face cs-pb-b">${plumbobFace}</span>
          </span>
        </span>`,

    potion: () => `
        <svg class="cs-art cs-art-potion" viewBox="0 0 64 64">
          <circle class="cs-potion-glow" cx="32" cy="44" r="20" fill="#5be37d" opacity="0.18"/>
          <g class="cs-potion-liquid">
            <path d="M15.6 40 A16.5 16.5 0 1 0 48.4 40 Z" fill="#4fd673"/>
            <ellipse cx="32" cy="40" rx="16.4" ry="2.4" fill="#9dffb5"/>
          </g>
          ${[[27, 0], [35, 0.7], [31, 1.3], [38, 1.9]].map(([x, d]) => `<circle class="cs-bub" style="--d:${d}s" cx="${x}" cy="54" r="1.6" fill="#d8ffe2"/>`).join('')}
          <circle cx="32" cy="42" r="18" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="2"/>
          <rect x="26.5" y="8" width="11" height="17" rx="1" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.8)" stroke-width="2"/>
          <rect x="25" y="3" width="14" height="7" rx="1.5" fill="#a8743f"/>
          <path d="M20 34 A13 13 0 0 1 26 28" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round" fill="none"/>
        </svg>`,

    candle: () => `
        <svg class="cs-art cs-art-candle" viewBox="0 0 64 64">
          <circle class="cs-candle-glow" cx="32" cy="20" r="17" fill="#ffb347" opacity="0.2"/>
          <rect x="22" y="30" width="20" height="30" rx="3" fill="#f3ead6"/>
          <path d="M22 33 q2 7 4 0 M34 31 q2 9 4 0" fill="#f3ead6" stroke="#f3ead6" stroke-width="2"/>
          <ellipse cx="32" cy="30" rx="10" ry="2.5" fill="#fff7e6"/>
          <line x1="32" y1="30" x2="32" y2="25" stroke="#3a2b20" stroke-width="1.5"/>
          <g class="cs-flame">
            <path d="M32 7 C 37 14, 39 20, 36 24 C 34.5 26.5, 29.5 26.5, 28 24 C 25 20, 27 14, 32 7 Z" fill="#ffad2b"/>
            <path d="M32 14 C 34.5 18, 35.5 21, 34 23.5 C 33 25, 31 25, 30 23.5 C 28.5 21, 29.5 18, 32 14 Z" fill="#fff3c4"/>
          </g>
        </svg>`,

    runes: () => `
        <svg class="cs-art cs-art-runes" viewBox="0 0 64 64">
          <g class="cs-rune-outer" stroke="#e9c46a" fill="none">
            <circle cx="32" cy="32" r="29" stroke-width="1.2"/>
            <circle cx="32" cy="32" r="21" stroke-width="0.8" opacity="0.7"/>
            ${RUNE_GLYPHS.map((d, i) => `<path class="cs-rune-g" style="--d:${(i * 0.3).toFixed(1)}s" d="${d}" stroke-width="1.1" stroke-linecap="round" transform="rotate(${i * 45} 32 32) translate(32 7)"/>`).join('')}
          </g>
          <g class="cs-rune-inner" stroke="#f3d98b" stroke-width="0.9" fill="none" opacity="0.85">
            <polygon points="32,15 46.7,40.5 17.3,40.5"/>
            <polygon points="32,49 17.3,23.5 46.7,23.5"/>
            <circle cx="32" cy="32" r="6"/>
          </g>
        </svg>`,

    crystal: () => `
        <svg class="cs-art cs-art-crystal" viewBox="0 0 64 64">
          <path d="M20 55 L44 55 L40 46 L24 46 Z" fill="#6b4a2b"/>
          <rect x="16" y="54" width="32" height="5" rx="2" fill="#4a321c"/>
          <circle cx="32" cy="27" r="20" fill="rgba(120,140,255,0.2)"/>
          <g class="cs-mist-a">
            <ellipse cx="28" cy="25" rx="10" ry="5" fill="#b18cff" opacity="0.45"/>
            <ellipse cx="37" cy="31" rx="8" ry="4" fill="#6fd3ff" opacity="0.4"/>
          </g>
          <g class="cs-mist-b">
            <ellipse cx="32" cy="24" rx="6" ry="9" fill="#ff9de2" opacity="0.3"/>
          </g>
          <circle class="cs-crystal-core" cx="32" cy="27" r="5" fill="#fff" opacity="0.3"/>
          <circle cx="32" cy="27" r="20" fill="none" stroke="rgba(210,220,255,0.75)" stroke-width="1.2"/>
          <ellipse cx="24" cy="18" rx="5" ry="2.8" fill="#fff" opacity="0.5" transform="rotate(-35 24 18)"/>
        </svg>`,

    quill: () => `
        <svg class="cs-art cs-art-quill" viewBox="0 0 64 64">
          <path class="cs-ink" pathLength="100" d="M8 50 Q 14 42, 20 50 T 32 50 T 44 50 T 56 50" stroke="#f2ece0" stroke-width="2" stroke-linecap="round" fill="none"/>
          <g class="cs-quill">
            <path d="M0 0 L4 -6 C 10 -16, 20 -26, 30 -36 C 26 -24, 18 -12, 6 -4 Z" fill="#f2ece0"/>
            <path d="M2 -3 L28 -34" stroke="#b9ab8f" stroke-width="0.8"/>
          </g>
        </svg>`,

    cauldron: () => `
        <svg class="cs-art cs-art-cauldron" viewBox="0 0 64 64">
          ${steam([24, 32, 40], 26)}
          <g class="cs-flame cs-flame-sm" style="--fx:24px"><path d="M24 52 C 27 56, 27 60, 24 62 C 21 60, 21 56, 24 52 Z" fill="#ff9a2b"/></g>
          <g class="cs-flame cs-flame-sm" style="--fx:40px"><path d="M40 52 C 43 56, 43 60, 40 62 C 37 60, 37 56, 40 52 Z" fill="#ff9a2b"/></g>
          <path d="M12 30 H52 C 52 45, 46 55, 32 55 C 18 55, 12 45, 12 30 Z" fill="#2a2a30" stroke="#4a4a52" stroke-width="1"/>
          <ellipse cx="9" cy="35" rx="3" ry="4" fill="none" stroke="#4a4a52" stroke-width="2"/>
          <ellipse cx="55" cy="35" rx="3" ry="4" fill="none" stroke="#4a4a52" stroke-width="2"/>
          <ellipse cx="32" cy="30" rx="21" ry="4.2" fill="#3a3a42"/>
          <ellipse cx="32" cy="30" rx="18" ry="3" fill="#4fd673"/>
          ${[[24, 0], [35, 0.6], [41, 1.2]].map(([x, d]) => `<circle class="cs-pop" style="--d:${d}s" cx="${x}" cy="29.5" r="2" fill="#9dffb5"/>`).join('')}
        </svg>`,

    moon: () => `
        <span class="cs-moon"><span class="cs-moon-shadow"></span></span>`,

    cassette: () => `
        <svg class="cs-art cs-art-cassette" viewBox="0 0 96 64">
          <rect x="4" y="6" width="88" height="52" rx="5" fill="#26262b" stroke="#3a3a40"/>
          <rect x="12" y="11" width="72" height="26" rx="2" fill="#e9dfc6"/>
          <rect x="12" y="14" width="72" height="3" fill="#d1453b"/>
          <rect x="12" y="18.5" width="72" height="2" fill="#e8a33a"/>
          <rect x="27" y="23" width="42" height="13" rx="6.5" fill="#141416"/>
          <ellipse cx="38" cy="29.5" rx="8" ry="5.5" fill="#3b2a20"/>
          <ellipse cx="58" cy="29.5" rx="5" ry="4" fill="#3b2a20"/>
          ${[38, 58].map(x => `
          <g class="cs-reel">
            <circle cx="${x}" cy="29.5" r="4.6" fill="#e6e6e6"/>
            <circle cx="${x}" cy="29.5" r="1.6" fill="#141416"/>
            <path d="M${x} 25.4 V27.2 M${x - 3.5} 31.5 L${x - 2} 30.6 M${x + 3.5} 31.5 L${x + 2} 30.6" stroke="#141416" stroke-width="1.4"/>
          </g>`).join('')}
          <path d="M24 58 L28 47 H68 L72 58" fill="#1d1d22"/>
          <circle cx="10" cy="52" r="1.6" fill="#55555c"/><circle cx="86" cy="52" r="1.6" fill="#55555c"/>
        </svg>`,

    rec: () => `
        <span class="cs-rec"><span class="cs-rec-dot"></span><span class="cs-rec-t">REC</span><span class="cs-rec-tc"></span></span>`,

    nosignal: () => {
        const colors = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
        const w = 76 / 7;
        return `
        <svg class="cs-art cs-art-nosignal" viewBox="0 0 96 64">
          <rect x="4" y="4" width="88" height="56" rx="6" fill="#1b1b1f"/>
          <g class="cs-ns-screen">
            ${colors.map((c, i) => `<rect x="${(10 + i * w).toFixed(2)}" y="10" width="${(w + 0.2).toFixed(2)}" height="34" fill="${c}"/>`).join('')}
            ${colors.slice().reverse().map((c, i) => `<rect x="${(10 + i * w).toFixed(2)}" y="44" width="${(w + 0.2).toFixed(2)}" height="10" fill="${i % 2 ? '#111' : c}"/>`).join('')}
            <rect class="cs-ns-roll" x="10" y="10" width="76" height="6" fill="#fff" opacity="0.22"/>
          </g>
          <rect x="30" y="25" width="36" height="10" fill="#000" opacity="0.75"/>
          <text class="cs-ns-text" x="48" y="32.5" text-anchor="middle" font-family="monospace" font-size="6.5" fill="#fff">NO SIGNAL</text>
        </svg>`;
    },

    cup: () => `
        <svg class="cs-art cs-art-cup" viewBox="0 0 64 64">
          ${steam([22, 29, 36], 20)}
          <path d="M44 31 C 54 31, 54 46, 44 46" stroke="#c96f53" stroke-width="4" fill="none"/>
          <path d="M14 26 H44 V44 C 44 52, 38 56, 29 56 C 20 56, 14 52, 14 44 Z" fill="#c96f53"/>
          <path d="M18 30 V44 C 18 48, 20 50, 23 51" stroke="rgba(255,255,255,0.35)" stroke-width="2.5" stroke-linecap="round" fill="none"/>
          <ellipse cx="29" cy="26" rx="15" ry="3.2" fill="#4a2c1d" stroke="#e08a6c" stroke-width="1"/>
          <ellipse cx="30" cy="58" rx="20" ry="2.6" fill="rgba(255,255,255,0.18)"/>
        </svg>`,

    hourglass: () => `
        <svg class="cs-art cs-art-hourglass" viewBox="0 0 64 64">
          <g class="cs-hg">
            <path d="M21 10 C 21 22, 30 28, 30 32 C 30 36, 21 42, 21 54 H43 C 43 42, 34 36, 34 32 C 34 28, 43 22, 43 10 Z" fill="rgba(200,220,255,0.12)"/>
            <polygon class="cs-sand-top" points="23,12 41,12 32,28" fill="#e9c46a"/>
            <polygon class="cs-sand-bot" points="23,52 41,52 32,36" fill="#e9c46a"/>
            <line class="cs-sand-stream" x1="32" y1="28" x2="32" y2="52" stroke="#e9c46a" stroke-width="1"/>
            <path d="M21 10 C 21 22, 30 28, 30 32 C 30 36, 21 42, 21 54 H43 C 43 42, 34 36, 34 32 C 34 28, 43 22, 43 10 Z" fill="none" stroke="rgba(220,235,255,0.65)" stroke-width="1.2"/>
            <rect x="15" y="6" width="34" height="4" rx="1" fill="#8a5a2b"/>
            <rect x="15" y="54" width="34" height="4" rx="1" fill="#8a5a2b"/>
            <line x1="17" y1="10" x2="17" y2="54" stroke="#8a5a2b" stroke-width="2"/>
            <line x1="47" y1="10" x2="47" y2="54" stroke="#8a5a2b" stroke-width="2"/>
          </g>
        </svg>`,

    custom: s => {
        const url = s.spinnerUrl;
        if (!url) return '<span class="cs-custom-empty"><i class="fa-solid fa-image"></i></span>';
        const anim = `cs-cust-${s.spinnerAnim || 'spin'}`;
        return VIDEO_RE.test(url)
            ? `<video class="cs-art-img ${anim}" src="${url}" autoplay muted loop playsinline></video>`
            : `<img class="cs-art-img ${anim}" src="${url}" alt="">`;
    },
};

/** [[value, label], …] — order is the order of tiles in the picker. */
export const SPINNERS = [
    ['ring', 'Кольцо'], ['gear', 'Шестерёнка'], ['none', 'Ничего'],
    ['heart', 'Сердце'], ['flower', 'Цветок'], ['sakura', 'Сакура'], ['leaves', 'Листья'], ['butterfly', 'Бабочка'], ['stars', 'Созвездие'],
    ['plumbob', 'Пламбоб'],
    ['potion', 'Зелье'], ['candle', 'Свеча'], ['runes', 'Руны'], ['crystal', 'Шар'], ['quill', 'Перо'], ['cauldron', 'Котёл'], ['moon', 'Луна'],
    ['cassette', 'Кассета'], ['rec', 'REC'], ['nosignal', 'Нет сигнала'],
    ['cup', 'Чашка'], ['hourglass', 'Часы'],
    ['custom', 'Своя картинка'],
];

/** The badge actually drawn: a custom badge without a file falls back to the ring. */
export function effectiveSpinner(s) {
    return s.spinner === 'custom' && !s.spinnerUrl ? 'ring' : s.spinner;
}

/**
 * Turns a spinner element into the chosen badge. Keeps the element itself: core reads
 * the transition of #load-spinner to time the splash fade-out.
 * @param {HTMLElement} spin
 * @param {string} kind
 * @param {object} s settings (plumbob colour, custom file and animation)
 */
export function applySpinner(spin, kind, s = {}) {
    if (!spin) return;
    spin.classList.add('cs-spin');
    spin.classList.remove(...[...spin.classList].filter(c => c === 'cs-spin-art' || c.startsWith('cs-art-k-')));
    const art = ART[kind];
    if (!art) return;
    spin.classList.add('cs-spin-art', `cs-art-k-${kind}`);
    spin.innerHTML = art(s);
    spin.querySelectorAll('video').forEach(v => { v.muted = true; v.play?.().catch(() => {}); });
}
