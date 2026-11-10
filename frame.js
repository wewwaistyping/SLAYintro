// The frame dialog. Backgrounds fill the screen with object-fit: cover, so a real crop made
// for a phone would ruin the same picture on a computer. A background therefore keeps its
// file and remembers one frame per device; a logo or badge gets a real crop into a new file.

/** Screen shapes the frames are drawn for. The phone is an iPhone with the browser bars on. */
export const FRAME_DEVICES = {
    desk: { w: 1280, h: 720, label: 'Компьютер', icon: 'fa-desktop' },
    phone: { w: 393, h: 710, label: 'Телефон', icon: 'fa-mobile-screen-button' },
};

/**
 * The screen this page is on: a tablet held sideways wants the wide frame. A media query,
 * because reading innerHeight on a phone forces a layout of the whole page.
 */
export const screenDevice = () => (window.matchMedia('(orientation: portrait)').matches ? 'phone' : 'desk');

const NARROW = 560;
const MAX_ZOOM = 4;
/** Below this many source pixels across, the frame is upscaled enough to look soft. */
const SOFT_WIDTH = { desk: 800, phone: 300 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = v => Math.round(v * 10000) / 10000;

/**
 * A frame as CSS numbers: nothing to measure when the splash starts, and it fits pictures
 * and videos alike. With object-fit: cover, object-position p and a scale z around that
 * same point, the visible window starts at p * (1 - w), so p = x / (1 - w).
 */
function toCss(r, mediaAspect, dev) {
    const coverW = mediaAspect > dev.w / dev.h ? dev.w / dev.h / mediaAspect : 1;
    return {
        px: round(r.w >= 0.9999 ? 50 : r.x / (1 - r.w) * 100),
        py: round(r.h >= 0.9999 ? 50 : r.y / (1 - r.h) * 100),
        z: round(coverW / r.w),
    };
}

/**
 * Puts a frame on a background. The scale sits on the wrapper because the image animations
 * own the transform of the media inside it.
 * @param {HTMLElement} wrap .cs-frame around the media
 * @param {{px: number, py: number, z: number}} f
 */
export function applyFrame(wrap, f) {
    wrap.style.transformOrigin = `${f.px}% ${f.py}%`;
    wrap.style.transform = `scale(${f.z})`;
    for (const media of wrap.children) media.style.objectPosition = `${f.px}% ${f.py}%`;
}

function dialogHtml(logo) {
    const tabs = logo
        ? `<button type="button" data-a="0" class="cs-on">Свободно</button>
           <button type="button" data-a="1">1:1</button>
           <button type="button" data-a="1.778">16:9</button>`
        : Object.entries(FRAME_DEVICES).map(([key, d]) => `
           <button type="button" data-d="${key}"><i class="fa-solid ${d.icon}"></i>${d.label}<span class="cs-fr-dot"></span></button>`).join('');
    return `
    <div class="cs-fr-box" role="dialog" aria-label="${logo ? 'Обрезка' : 'Кадр'}">
      <div class="cs-fr-head">
        <div>
          <div class="cs-fr-title">${logo ? 'Обрезать картинку' : 'Что видно на экране'}</div>
          <div class="cs-fr-sub">${logo ? 'Сохранится новым файлом.' : 'Файл не меняется, запоминается только кадр.'}</div>
        </div>
        <button class="cs-fr-x" type="button" aria-label="Отмена"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="cs-fr-tabs">${tabs}</div>
      <div class="cs-fr-main">
        <div class="cs-fr-stage${logo ? ' cs-fr-checker' : ''}">
          <div class="cs-fr-rect">
            <span class="cs-fr-h cs-nw" data-h="nw"></span><span class="cs-fr-h cs-ne" data-h="ne"></span>
            <span class="cs-fr-h cs-sw" data-h="sw"></span><span class="cs-fr-h cs-se" data-h="se"></span>
          </div>
        </div>
        <div class="cs-fr-side"></div>
      </div>
      ${logo ? '' : `<label class="cs-fr-zoom"><i class="fa-solid fa-magnifying-glass-minus"></i>
        <input type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" aria-label="Приближение">
        <i class="fa-solid fa-magnifying-glass-plus"></i></label>`}
      <div class="cs-fr-info"><span class="cs-fr-size"></span><span class="cs-fr-note"></span></div>
      <div class="cs-fr-btns">
        <button class="cs-fr-b cs-fr-primary" type="button" data-act="save">${logo ? 'Обрезать' : 'Сохранить'}</button>
        <button class="cs-fr-b" type="button" data-act="plain">${logo ? 'Взять целиком' : 'Без кадра'}</button>
        <button class="cs-fr-b cs-fr-ghost" type="button" data-act="reset" title="Сбросить рамку"><i class="fa-solid fa-rotate-left"></i></button>
      </div>
    </div>`;
}

/**
 * @param {string} url
 * @param {object} o
 * @param {boolean} [o.video]
 * @param {boolean} [o.logo] real crop instead of per-device frames
 * @param {object} [o.frames] frames this background already has
 * @param {string} [o.device] tab to open on
 * @param {(host: HTMLElement, device: string) => {wrap: HTMLElement, release: Function}} [o.preview]
 * @returns {Promise<object|Blob|null|undefined>} frames or a cropped Blob; null for
 * "no frame" / "whole file"; undefined when backed out
 */
export function frameDialog(url, { video = false, logo = false, frames = {}, device = screenDevice(), preview } = {}) {
    return new Promise(resolve => {
        const ov = document.createElement('div');
        ov.className = 'cs-fr-ov';
        ov.innerHTML = dialogHtml(logo);
        const find = sel => ov.querySelector(sel);
        const stage = find('.cs-fr-stage');
        const rect = find('.cs-fr-rect');
        const side = find('.cs-fr-side');
        const zoom = find('.cs-fr-zoom input');

        const media = document.createElement(video ? 'video' : 'img');
        media.className = 'cs-fr-media';
        if (video) Object.assign(media, { muted: true, loop: true, autoplay: true, playsInline: true });
        media.src = url;
        stage.prepend(media);

        let dev = device;
        let aspect = 0;                     // crop shape, 0 = free
        let cropRect = null;
        const rects = {};                   // fractions of the picture, per device
        for (const key of Object.keys(FRAME_DEVICES)) if (frames?.[key]) rects[key] = frames[key].rect;
        let b = { x: 0, y: 0, w: 0, h: 0 }; // stage px
        let shown = null;
        let canvas = null;

        const natural = () => [media.naturalWidth || media.videoWidth || 0, media.naturalHeight || media.videoHeight || 0];
        const imgBox = () => {
            const s = stage.getBoundingClientRect();
            const m = media.getBoundingClientRect();
            return { x: m.left - s.left, y: m.top - s.top, w: m.width, h: m.height };
        };
        const wantAspect = () => (logo ? aspect : FRAME_DEVICES[dev].w / FRAME_DEVICES[dev].h);
        const maxSize = box => {
            const a = wantAspect();
            if (!a) return { w: box.w, h: box.h };
            return box.w / box.h > a ? { w: box.h * a, h: box.h } : { w: box.w, h: box.w / a };
        };

        function buildSide() {
            shown?.release();
            shown = null;
            side.replaceChildren();
            if (logo) {
                canvas = document.createElement('canvas');
                canvas.className = 'cs-fr-crop-prev';
                side.append(canvas);
                return;
            }
            const d = FRAME_DEVICES[dev];
            const narrow = window.innerWidth <= NARROW;
            const w = dev === 'phone' ? (narrow ? 84 : 150) : (narrow ? 180 : 210);
            const host = document.createElement('div');
            host.className = 'cs-fr-prev' + (dev === 'phone' ? ' cs-is-phone' : '');
            host.style.width = `${w}px`;
            host.style.height = `${Math.round(w * d.h / d.w)}px`;
            side.append(host);
            shown = preview?.(host, dev) ?? null;
        }

        // On a phone the picture takes the full width and the stage is only as tall as it needs.
        function sizeStage() {
            stage.style.height = '';
            const [nw, nh] = natural();
            if (window.innerWidth > NARROW || window.innerHeight <= 560 || !nw) return;
            const pad = parseFloat(getComputedStyle(stage).paddingTop) * 2;
            stage.style.height = `${Math.min(stage.clientHeight, (stage.clientWidth - pad) * nh / nw + pad)}px`;
        }

        function fit() {
            const box = imgBox();
            if (!box.w) return;
            const m = maxSize(box);
            b = { x: box.x + (box.w - m.w) / 2, y: box.y + (box.h - m.h) / 2, w: m.w, h: m.h };
        }
        function restore() {
            const r = !logo && rects[dev];
            const box = imgBox();
            if (r) b = { x: box.x + r.x * box.w, y: box.y + r.y * box.h, w: r.w * box.w, h: r.h * box.h };
            else fit();
        }
        function draw(touched = true) {
            const box = imgBox();
            if (!box.w) return;
            const a = wantAspect();
            const m = maxSize(box);
            const min = Math.min(m.w, m.h) * 0.2;
            b.w = clamp(b.w, min, m.w);
            b.h = a ? b.w / a : clamp(b.h, min, m.h);
            b.x = clamp(b.x, box.x, box.x + box.w - b.w);
            b.y = clamp(b.y, box.y, box.y + box.h - b.h);
            Object.assign(rect.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
            const r = { x: (b.x - box.x) / box.w, y: (b.y - box.y) / box.h, w: b.w / box.w, h: b.h / box.h };
            const [nw, nh] = natural();
            const srcW = Math.round(r.w * nw);
            find('.cs-fr-size').textContent = `${srcW} × ${Math.round(r.h * nh)}`;
            if (logo) {
                cropRect = r;
                find('.cs-fr-note').textContent = `отброшено ${Math.round((1 - r.w * r.h) * 100)}%`;
                const k = Math.min(150 / (r.w * nw), 150 / (r.h * nh));
                canvas.width = Math.max(1, r.w * nw * k);
                canvas.height = Math.max(1, r.h * nh * k);
                canvas.getContext('2d').drawImage(media, r.x * nw, r.y * nh, r.w * nw, r.h * nh, 0, 0, canvas.width, canvas.height);
                return;
            }
            find('.cs-fr-note').textContent = srcW < SOFT_WIDTH[dev] ? 'мелковато, будет мылить' : '';
            if (touched) rects[dev] = r;
            if (shown) applyFrame(shown.wrap, toCss(r, nw / nh, FRAME_DEVICES[dev]));
            zoom.value = String(m.w / b.w);
            ov.querySelectorAll('[data-d]').forEach(el => {
                el.classList.toggle('cs-on', el.dataset.d === dev);
                el.classList.toggle('cs-set', Boolean(rects[el.dataset.d]));
            });
        }
        function showDevice(key) {
            dev = key;
            buildSide();
            sizeStage();
            restore();
            draw(false);
        }

        // One path for mouse and finger; two fingers on the picture zoom the frame.
        const fingers = new Map();
        let drag = null;
        let pinch = null;
        stage.addEventListener('pointerdown', e => {
            fingers.set(e.pointerId, [e.clientX, e.clientY]);
            if (fingers.size === 2 && !logo) {
                const [p, q] = [...fingers.values()];
                pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]), w: b.w, cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
                drag = null;
                return;
            }
            const handle = e.target.closest('.cs-fr-h');
            if (!handle && !rect.contains(e.target)) return;
            try { stage.setPointerCapture(e.pointerId); } catch { /* the finger already left */ }
            drag = { h: handle?.dataset.h, sx: e.clientX, sy: e.clientY, o: { ...b } };
            e.preventDefault();
        });
        stage.addEventListener('pointermove', e => {
            if (fingers.has(e.pointerId)) fingers.set(e.pointerId, [e.clientX, e.clientY]);
            if (pinch && fingers.size === 2) {
                const [p, q] = [...fingers.values()];
                const w = pinch.w * pinch.d / Math.hypot(p[0] - q[0], p[1] - q[1]);
                const a = wantAspect();
                b = { x: pinch.cx - w / 2, y: pinch.cy - w / a / 2, w, h: w / a };
                draw();
                return;
            }
            if (!drag) return;
            const dx = e.clientX - drag.sx;
            const dy = e.clientY - drag.sy;
            const o = drag.o;
            if (!drag.h) {
                b.x = o.x + dx;
                b.y = o.y + dy;
                draw();
                return;
            }
            // Resize from a corner: the opposite corner stays pinned, the frame stays on the picture.
            const box = imgBox();
            const a = wantAspect();
            const left = drag.h.includes('w');
            const top = drag.h.includes('n');
            const ax = left ? o.x + o.w : o.x;
            const ay = top ? o.y + o.h : o.y;
            let w = o.w + (left ? -dx : dx);
            let h = a ? w / a : o.h + (top ? -dy : dy);
            const roomW = left ? ax - box.x : box.x + box.w - ax;
            const roomH = top ? ay - box.y : box.y + box.h - ay;
            const min = Math.min(box.w, box.h) * 0.12;
            if (a) {
                w = clamp(w, min, Math.min(roomW, roomH * a));
                h = w / a;
            } else {
                w = clamp(w, min, roomW);
                h = clamp(h, min, roomH);
            }
            b = { x: left ? ax - w : ax, y: top ? ay - h : ay, w, h };
            draw();
        });
        const endDrag = e => {
            fingers.delete(e.pointerId);
            if (fingers.size < 2) pinch = null;
            drag = null;
        };
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);

        function setZoom(z) {
            const m = maxSize(imgBox());
            const k = clamp(z, 1, MAX_ZOOM);
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h / 2;
            b = { x: cx - m.w / k / 2, y: cy - m.h / k / 2, w: m.w / k, h: m.h / k };
            draw();
        }
        stage.addEventListener('wheel', e => {
            e.preventDefault();
            if (!logo) setZoom(Number(zoom.value) * (e.deltaY < 0 ? 1.08 : 0.92));
        }, { passive: false });
        zoom?.addEventListener('input', () => setZoom(Number(zoom.value)));

        ov.querySelectorAll('[data-d]').forEach(el => el.addEventListener('click', () => showDevice(el.dataset.d)));
        ov.querySelectorAll('[data-a]').forEach(el => el.addEventListener('click', () => {
            aspect = Number(el.dataset.a);
            ov.querySelectorAll('[data-a]').forEach(x => x.classList.toggle('cs-on', x === el));
            fit();
            draw();
        }));

        const finish = value => {
            shown?.release();
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onResize);
            media.pause?.();
            ov.remove();
            resolve(value);
        };
        function save() {
            const [nw, nh] = natural();
            if (!nw) return;
            if (logo) {
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(cropRect.w * nw));
                c.height = Math.max(1, Math.round(cropRect.h * nh));
                c.getContext('2d').drawImage(media, cropRect.x * nw, cropRect.y * nh, c.width, c.height, 0, 0, c.width, c.height);
                try {
                    c.toBlob(blob => finish(blob ?? undefined), 'image/webp', 0.92);
                } catch (e) {
                    // A picture from another site without CORS can be shown but not read back.
                    console.warn('[SLAYintro] crop failed', e);
                    toastr.error('Эту картинку нельзя обрезать: она лежит на другом сайте. Загрузи её файлом.');
                }
                return;
            }
            const out = {};
            for (const key of Object.keys(FRAME_DEVICES)) {
                if (!rects[key]) continue;
                const r = Object.fromEntries(Object.entries(rects[key]).map(([k, v]) => [k, round(v)]));
                out[key] = { rect: r, ...toCss(rects[key], nw / nh, FRAME_DEVICES[key]) };
            }
            finish(Object.keys(out).length ? out : null);
        }
        const onKey = e => {
            if (e.key !== 'Escape' && e.key !== 'Enter') return;
            e.stopPropagation();
            e.preventDefault();
            if (e.key === 'Escape') finish(undefined);
            else save();
        };
        const onResize = () => {
            if (logo) {
                sizeStage();
                fit();
                draw();
            } else {
                showDevice(dev);
            }
        };
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onResize);
        find('.cs-fr-x').addEventListener('click', () => finish(undefined));
        find('[data-act=save]').addEventListener('click', save);
        find('[data-act=plain]').addEventListener('click', () => finish(null));
        find('[data-act=reset]').addEventListener('click', () => {
            delete rects[dev];
            fit();
            draw(false);
        });

        // Tavern closes its drawers on any click outside them, and this overlay is outside.
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) {
            ov.addEventListener(type, e => e.stopPropagation());
        }

        document.body.append(ov);
        const ready = () => {
            if (!ov.isConnected) return;
            if (logo) {
                buildSide();
                sizeStage();
                fit();
                draw();
            } else {
                showDevice(dev);
            }
        };
        media.addEventListener('error', () => {
            toastr.error('Не удалось открыть файл');
            finish(undefined);
        }, { once: true });
        if (video) media.addEventListener('loadedmetadata', () => requestAnimationFrame(ready), { once: true });
        else if (media.complete && media.naturalWidth) requestAnimationFrame(ready);
        else media.addEventListener('load', () => requestAnimationFrame(ready), { once: true });
    });
}
