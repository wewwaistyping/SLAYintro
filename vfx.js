// Full-screen effects layered between the background and the splash content.
// Pure CSS animations on transform/opacity, so they stay smooth while the app's JS loads.
// Particle effects scale their count with the strength slider; overlay effects
// (fog, film, light) scale their opacity through --amt.

import { RUNE_GLYPHS } from './spinners.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];

/**
 * Adds one particle: <span.cs-p><i><b></b></i></span>. Three levels let an effect
 * combine fall / sway / spin, each on its own element so transforms don't fight.
 */
function particle(layer, vars, html = '') {
    const p = document.createElement('span');
    p.className = 'cs-p';
    p.innerHTML = `<i><b>${html}</b></i>`;
    p.style.cssText = Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';');
    layer.appendChild(p);
    return p;
}

const fix = (n, d = 2) => n.toFixed(d);
const negDelay = dur => `${fix(-Math.random() * dur)}s`;

function snow(layer, n) {
    for (let i = 0; i < n; i++) {
        // Depth: near flakes are bigger, faster and brighter.
        const z = Math.random();
        const dur = rand(16, 9) - z * 4;
        particle(layer, {
            x: `${fix(rand(-5, 100))}%`, size: `${fix(2.5 + z * 6, 1)}px`, dur: `${fix(dur)}s`, delay: negDelay(dur),
            o: fix(0.55 + z * 0.45), sway: `${Math.round(rand(15, 45))}px`, 'sway-dur': `${fix(rand(3, 6))}s`,
            drift: `${Math.round(rand(-60, 60))}px`, ...(z > 0.85 ? { blur: '1.5px' } : {}),
        });
    }
}

function blizzard(layer, n) {
    for (let i = 0; i < n; i++) {
        const dur = rand(1.1, 2.4);
        particle(layer, {
            x: `${fix(rand(0, 170))}%`, size: `${fix(rand(1.5, 4.5), 1)}px`, dur: `${fix(dur)}s`, delay: negDelay(dur),
            o: fix(rand(0.5, 0.95)), sway: `${Math.round(rand(6, 20))}px`, 'sway-dur': `${fix(rand(0.4, 0.9))}s`,
            drift: `calc(var(--w) * -${fix(rand(0.45, 0.75))})`, ...(Math.random() < 0.3 ? { blur: '1px' } : {}),
        });
    }
}

function rain(layer, n, { heavy = false } = {}) {
    for (let i = 0; i < n; i++) {
        const dur = heavy ? rand(0.35, 0.6) : rand(0.45, 0.85);
        particle(layer, {
            x: `${fix(rand(-10, 125))}%`, size: `${Math.round(rand(16, heavy ? 40 : 34))}px`, dur: `${fix(dur)}s`,
            delay: negDelay(dur), o: fix(rand(0.3, heavy ? 0.75 : 0.65)),
        });
    }
}

function flutter(layer, n, shape) {
    for (let i = 0; i < n; i++) {
        const dur = rand(8, 15);
        const v = {
            x: `${fix(rand(-5, 105))}%`, dur: `${fix(dur)}s`, delay: negDelay(dur),
            drift: `${Math.round(rand(-160, 160))}px`, sway: `${Math.round(rand(30, 80))}px`, 'sway-dur': `${fix(rand(2, 4))}s`,
            'spin-dur': `${fix(rand(2, 4.5))}s`, rx: fix(rand(0.3, 1)), ry: fix(rand(0.3, 1)),
        };
        if (shape === 'sakura') {
            Object.assign(v, { pw: `${fix(rand(9, 15), 1)}px`, ph: `${fix(rand(7, 11), 1)}px`, c: pick(['#ffc9da', '#ffd6e3', '#ffb8cf', '#fff0f5']) });
        } else {
            const s = rand(13, 24);
            Object.assign(v, { pw: `${fix(s, 1)}px`, ph: `${fix(s * 0.7, 1)}px`, c: pick(['#e8833a', '#d4552b', '#e9b949', '#b5652d', '#c9a227', '#9c6b3a']) });
        }
        particle(layer, v);
    }
}

function wanderers(layer, n, kind) {
    for (let i = 0; i < n; i++) {
        const far = kind === 'fireflies' ? 70 : 35;
        particle(layer, {
            x: `${fix(rand(0, 100))}%`, y: `${fix(rand(kind === 'fireflies' ? 25 : 0, 98))}%`,
            dur: `${fix(rand(10, 20))}s`, delay: `${fix(-rand(0, 20))}s`,
            ax: `${Math.round(rand(-far, far))}px`, ay: `${Math.round(rand(-far, far / 2))}px`,
            bx: `${Math.round(rand(-far, far))}px`, by: `${Math.round(rand(-far * 1.5, 0))}px`,
            size: `${fix(kind === 'fireflies' ? rand(3, 5.5) : rand(1.5, 3.5), 1)}px`,
            'pulse-dur': `${fix(rand(2, 5))}s`, 'pulse-delay': `${fix(-rand(0, 5))}s`, o: fix(rand(0.4, 1)),
        });
    }
}

function risers(layer, n, kind) {
    for (let i = 0; i < n; i++) {
        let v;
        if (kind === 'embers') {
            const dur = rand(5, 11);
            v = { x: `${fix(rand(0, 100))}%`, size: `${fix(rand(2.5, 7), 1)}px`, dur: `${fix(dur)}s`, delay: negDelay(dur), o: fix(rand(0.75, 1)), sway: `${Math.round(rand(20, 60))}px`, 'sway-dur': `${fix(rand(1.6, 3.5))}s`, drift: `${Math.round(rand(-80, 80))}px`, rise: Math.round(rand(45, 100)) };
        } else if (kind === 'bubbles') {
            const dur = rand(6, 13);
            v = { x: `${fix(rand(0, 100))}%`, size: `${fix(rand(5, 20), 1)}px`, dur: `${fix(dur)}s`, delay: negDelay(dur), o: fix(rand(0.5, 0.95)), sway: `${Math.round(rand(10, 30))}px`, 'sway-dur': `${fix(rand(1.5, 3))}s`, drift: `${Math.round(rand(-40, 40))}px`, rise: Math.round(rand(80, 110)) };
        } else {
            // smoke
            const dur = rand(10, 18);
            v = { x: `${fix(rand(-10, 95))}%`, size: `${Math.round(rand(140, 300))}px`, dur: `${fix(dur)}s`, delay: negDelay(dur), o: fix(rand(0.35, 0.7)), drift: `${Math.round(rand(-120, 120))}px`, rise: Math.round(rand(50, 85)) };
        }
        particle(layer, v);
    }
}

function sparkles(layer, n) {
    for (let i = 0; i < n; i++) {
        const dur = rand(1.6, 3.4);
        particle(layer, {
            x: `${fix(rand(0, 100))}%`, y: `${fix(rand(0, 100))}%`, size: `${Math.round(rand(8, 22))}px`,
            dur: `${fix(dur)}s`, delay: `${fix(rand(0, dur * 2))}s`,
            c: pick(['#ffffff', '#ffe9a8', '#a8e9ff', '#ffc8f0', '#d6c2ff']),
        });
    }
}

function runes(layer, n) {
    for (let i = 0; i < n; i++) {
        const dur = rand(4, 7.5);
        const d = pick(RUNE_GLYPHS);
        particle(layer, {
            x: `${fix(rand(3, 95))}%`, y: `${fix(rand(5, 92))}%`, size: `${Math.round(rand(22, 46))}px`,
            dur: `${fix(dur)}s`, delay: `${fix(rand(0, dur * 1.5))}s`, rot: `${Math.round(rand(-25, 25))}deg`,
        }, `<svg viewBox="-5 -5 10 10"><path d="${d}" fill="none" stroke="#f0cf7a" stroke-width="0.7" stroke-linecap="round"/></svg>`);
    }
}

function starfall(layer, n) {
    for (let i = 0; i < n; i++) {
        const dur = rand(4.5, 11);
        particle(layer, {
            x: `${fix(rand(25, 115))}%`, y: `${fix(rand(-5, 40))}%`, len: `${Math.round(rand(110, 230))}px`,
            dur: `${fix(dur)}s`, delay: `${fix(rand(0, dur))}s`,
        });
    }
}

function glass(layer, n) {
    for (let i = 0; i < n; i++) {
        const dur = rand(6, 14);
        const s = rand(5, 17);
        particle(layer, {
            x: `${fix(rand(0, 100))}%`, y: `${fix(rand(-5, 85))}%`, pw: `${fix(s, 1)}px`, ph: `${fix(s * 1.18, 1)}px`,
            dur: `${fix(dur)}s`, delay: negDelay(dur),
            slide: `${Math.round(Math.random() < 0.5 ? rand(80, 260) : rand(2, 10))}px`,
        });
    }
}

function pieces(layer, html) {
    layer.insertAdjacentHTML('beforeend', html);
}

function fog(layer) {
    pieces(layer, Array.from({ length: 5 }, () => {
        const v = `--fw:${fix(rand(70, 115))}%;--fh:${fix(rand(30, 50))}%;--fx:${fix(rand(-30, 45))}%;--fy:${fix(rand(62, 95))}%;--dur:${fix(rand(26, 46))}s;--delay:${fix(-rand(0, 40))}s`;
        return `<span class="cs-fog" style="${v}"></span>`;
    }).join(''));
}

function rays(layer) {
    pieces(layer, Array.from({ length: 5 }, (_, i) => {
        const v = `--rx:${fix(8 + i * 14 + rand(-4, 4))}%;--rw:${fix(rand(7, 15))}%;--rr:${fix(rand(22, 34))}deg;--dur:${fix(rand(7, 13))}s;--delay:${fix(-rand(0, 10))}s`;
        return `<span class="cs-ray" style="${v}"></span>`;
    }).join(''));
}

/** Registry: label, group, particle max at 100% (0 = overlay effect), builder. */
export const VFX = {
    snow: { label: 'Снег', group: 'Погода', max: 160, build: snow },
    blizzard: { label: 'Метель', group: 'Погода', max: 240, build: blizzard },
    rain: { label: 'Дождь', group: 'Погода', max: 200, build: (l, n) => rain(l, n) },
    storm: { label: 'Гроза', group: 'Погода', max: 240, build: (l, n) => rain(l, n, { heavy: true }) },
    fog: { label: 'Туман', group: 'Погода', max: 0, build: fog },

    sakura: { label: 'Сакура', group: 'Природа', max: 80, build: (l, n) => flutter(l, n, 'sakura') },
    leaves: { label: 'Листья', group: 'Природа', max: 60, build: (l, n) => flutter(l, n, 'leaves') },
    fireflies: { label: 'Светлячки', group: 'Природа', max: 45, build: (l, n) => wanderers(l, n, 'fireflies') },
    dust: { label: 'Пылинки', group: 'Природа', max: 130, build: (l, n) => wanderers(l, n, 'dust') },
    bubbles: { label: 'Пузыри', group: 'Природа', max: 60, build: (l, n) => risers(l, n, 'bubbles') },

    embers: { label: 'Искры', group: 'Магия', max: 90, build: (l, n) => risers(l, n, 'embers') },
    sparkles: { label: 'Волшебство', group: 'Магия', max: 60, build: sparkles },
    runes: { label: 'Руны', group: 'Магия', max: 20, build: runes },
    starfall: { label: 'Звездопад', group: 'Магия', max: 12, build: starfall },
    smoke: { label: 'Дым', group: 'Магия', max: 16, build: (l, n) => risers(l, n, 'smoke') },

    vhs: { label: 'VHS', group: 'Плёнка', max: 0, build: l => pieces(l, '<span class="cs-scan"></span><span class="cs-grain"></span><span class="cs-track"></span><span class="cs-osd">PLAY ▶</span>') },
    oldfilm: { label: 'Старое кино', group: 'Плёнка', max: 0, build: l => pieces(l, '<span class="cs-grain"></span><span class="cs-sepia"></span><span class="cs-flick"></span><span class="cs-scratch" style="--sx:23%;--d:0s"></span><span class="cs-scratch" style="--sx:71%;--d:1.3s"></span><span class="cs-scratch" style="--sx:48%;--d:2.1s"></span><span class="cs-specks"></span>') },
    glass: { label: 'Капли на стекле', group: 'Плёнка', max: 55, build: glass },

    vignette: { label: 'Виньетка', group: 'Свет', max: 0, build: l => pieces(l, '<span class="cs-vig"></span>') },
    rays: { label: 'Лучи', group: 'Свет', max: 0, build: rays },
};

export const VFX_GROUPS = [...new Set(Object.values(VFX).map(v => v.group))];

/**
 * @param {string} kind key of VFX
 * @param {number} amount 0..100
 * @param {number} [density=1] particle count multiplier (small tiles use less)
 * @returns {HTMLElement|null}
 */
export function buildVfx(kind, amount, density = 1) {
    const def = VFX[kind];
    if (!def) return null;
    const amt = Math.min(100, Math.max(0, Number(amount) || 0)) / 100;
    if (!amt) return null;

    const layer = document.createElement('div');
    layer.className = `cs-vfx cs-vfx-${kind}`;
    layer.style.setProperty('--amt', fix(amt));
    const n = def.max ? Math.max(3, Math.round(def.max * amt * density)) : 0;
    def.build(layer, n);
    return layer;
}
