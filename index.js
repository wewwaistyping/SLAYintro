import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { loader } from '../../../action-loader.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SPINNERS, applySpinner, effectiveSpinner } from './spinners.js';
import { VFX, VFX_GROUPS, buildVfx } from './vfx.js';
import { FRAME_DEVICES, applyFrame, frameDialog, screenDevice } from './frame.js';

const MODULE = 'customSplash';
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i;
const SLIDE_FADE_MS = 1500;

/** Phones, tablets and data-saver: lighter video, fewer particles. */
const LITE = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches
    || Boolean(navigator.connection?.saveData);
const LITE_VFX_DENSITY = 0.45;

/** Uploaded pictures are downscaled to this longest side (backgrounds / logos and badges). */
const MAX_SIDE_BG = 1920;
const MAX_SIDE_ICON = 1024;
const BIG_VIDEO_MB = 25;

const defaults = {
    enabled: true,
    iconMode: 'default', // default | custom | none
    iconUrl: '',
    iconSize: 150,
    iconAnim: 'none', // none | float | pulse | glow
    bgMode: 'default', // default | custom | slideshow
    bgUrl: '',
    bgUrlMobile: '', // optional lighter video for phones
    frames: {}, // what each device shows of a background: url -> { desk, phone }
    slides: [],
    slideSeconds: 6,
    slideShuffle: true,
    bgAnim: 'none', // none | kenburns | drift | breathe
    bgDim: 45,
    vfxList: [], // several effects can run at once, in this order
    vfxAmt: {}, // per-effect strength 0..100
    text: '',
    tips: '',
    tipSeconds: 4,
    spinner: 'ring', // see SPINNERS
    spinnerScale: 100,
    plumbobColor: 'green',
    spinnerUrl: '',
    spinnerAnim: 'spin', // spin | pulse | sway | float | blink | flip | bounce | none
    skipCrop: false,
};

const VFX_DEFAULT_AMT = 50;

/** Builds made before multi-VFX stored a single `vfx` + `vfxAmount`. */
function migrateVfx(s) {
    if (!Array.isArray(s.vfxList)) s.vfxList = [];
    if (!s.vfxAmt || typeof s.vfxAmt !== 'object') s.vfxAmt = {};
    if (typeof s.vfx === 'string') {
        if (s.vfx !== 'none' && !s.vfxList.includes(s.vfx)) {
            s.vfxList.push(s.vfx);
            s.vfxAmt[s.vfx] = s.vfxAmount ?? VFX_DEFAULT_AMT;
        }
        delete s.vfx;
        delete s.vfxAmount;
    }
    s.vfxList = s.vfxList.filter(k => VFX[k]);
}

/** Everything that defines a look; the switches below are global, not part of a build. */
const PRESET_KEYS = Object.keys(defaults).filter(k => !['enabled', 'skipCrop'].includes(k));

function snapshot(src) {
    return structuredClone(Object.fromEntries(PRESET_KEYS.map(k => [k, src[k]])));
}

function settings() {
    extension_settings[MODULE] ??= {};
    const s = extension_settings[MODULE];
    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in s)) s[k] = structuredClone(v);
    }
    migrateVfx(s);
    // Leftovers of the removed user.css boot splash.
    delete s.bootCssHash;
    delete s.bootPoster;
    if (!s.presets) {
        // First run with presets: keep the current look as the first saved build.
        s.presets = { 'Моя сборка': snapshot(s) };
        s.activePreset = 'Моя сборка';
    }
    return s;
}

const isVideo = url => VIDEO_RE.test(url);

function mediaElement(url, className, { still = false } = {}) {
    const video = isVideo(url);
    const el = document.createElement(video ? 'video' : 'img');
    el.className = className;
    el.src = url;
    if (video && still) {
        // A thumbnail: first frame only, nothing decoding in the background.
        Object.assign(el, { muted: true, playsInline: true, preload: 'metadata' });
    } else if (video) {
        Object.assign(el, { autoplay: true, muted: true, loop: true, playsInline: true });
        el.setAttribute('muted', '');
        el.play?.().catch(() => {});
    } else {
        el.alt = '';
        el.decoding = 'async';
    }
    return el;
}

/**
 * Everything a decorated splash keeps alive (timers, videos), so it can be released
 * the moment the splash leaves the page instead of waiting for garbage collection.
 */
function createLife(root) {
    const timers = new Set();
    let released = false;
    return {
        interval(fn, ms) {
            const id = setInterval(fn, ms);
            timers.add(() => clearInterval(id));
        },
        timeout(fn, ms) {
            const id = setTimeout(fn, ms);
            timers.add(() => clearTimeout(id));
        },
        release() {
            if (released) return;
            released = true;
            timers.forEach(stop => stop());
            timers.clear();
            // Drop decoders and buffers right away; a detached <video> otherwise holds them.
            root.querySelectorAll('video').forEach(v => {
                v.pause();
                v.removeAttribute('src');
                v.load();
            });
        },
    };
}

/**
 * Releases a stage the moment it leaves the page. Core removes #loader itself, but the
 * splash lives in a popup <dialog> that may also be dropped from <body> whole, so watch
 * <body> too (direct children only, nothing deeper).
 */
function releaseOnDetach(el, life) {
    const parent = el.parentNode;
    if (!parent) return;
    const mo = new MutationObserver(() => {
        if (el.isConnected) return;
        mo.disconnect();
        life.release();
    });
    mo.observe(parent, { childList: true });
    mo.observe(document.body, { childList: true });
}

/** Above this size a background video is too heavy for phones without a light version. */
const LITE_VIDEO_MAX_MB = 15;

/**
 * What a phone shows instead of the main background: the light video if the user gave one,
 * otherwise, for a heavy video, a still frame cut from it (see ensurePoster).
 */
function bgVideoUrl(s, small = false) {
    // The settings mini preview is ~250px wide: the light video is plenty there.
    if (!LITE) return small && s.bgUrlMobile ? s.bgUrlMobile : s.bgUrl;
    if (s.bgUrlMobile) return s.bgUrlMobile;
    const poster = s.posters?.[s.bgUrl];
    return poster?.url && poster.mb > LITE_VIDEO_MAX_MB ? poster.url : s.bgUrl;
}

/** A still from the video, uploaded next to it. */
async function videoPoster(url) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    try {
        await new Promise((resolve, reject) => {
            video.onloadeddata = resolve;
            video.onerror = reject;
            setTimeout(() => reject(new Error('poster timeout')), 30000);
        });
        // Intros tend to open dark; a third in usually shows the actual scene.
        video.currentTime = (video.duration || 3) * 0.3;
        await new Promise((resolve, reject) => {
            video.onseeked = resolve;
            setTimeout(() => reject(new Error('seek timeout')), 15000);
        });
        const scale = Math.min(1, MAX_SIDE_BG / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/webp', 0.85).split(',')[1];
        const base = url.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '');
        return await uploadData(`${base}-poster.webp`, data);
    } finally {
        video.removeAttribute('src');
        video.load();
    }
}

const posterJobs = new Map();
/** URLs whose size could not be read this session: no point asking again on every edit. */
const posterSkip = new Set();

/**
 * Remembers how heavy each background video is and, for heavy ones, prepares a still frame
 * for phones. Runs once per video, in the background, from the settings panel.
 */
function ensurePoster(s, url) {
    if (!url || !isVideo(url) || s.posters?.[url] || posterJobs.has(url) || posterSkip.has(url)) return;
    const job = (async () => {
        const head = await fetch(url, { method: 'HEAD' });
        const length = head.ok ? head.headers.get('content-length') : null;
        // A missing file (a URL still being typed) or a server that hides the size: nothing to record.
        if (!length) throw new Error(`no size (${head.status})`);
        const mb = Number(length) / 1024 / 1024;
        const entry = { mb: Math.round(mb * 10) / 10, url: '' };
        if (mb > LITE_VIDEO_MAX_MB) entry.url = await videoPoster(url);
        s.posters ??= {};
        s.posters[url] = entry;
        // A background job, not a user edit: patch only this entry into the settings file.
        // A full save() from a tab opened earlier would stamp its stale builds as newest.
        saveSettingsDebounced();
        await patchStore(stored => {
            stored.posters ??= {};
            stored.posters[url] = entry;
        });
    })().catch(e => {
        posterSkip.add(url);
        console.warn('[SLAYintro] phone fallback not prepared for', url, e);
    }).finally(() => posterJobs.delete(url));
    posterJobs.set(url, job);
}

function shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** Image animation applies to still pictures only; videos already move. */
function animClass(s, url) {
    return s.bgAnim !== 'none' && !isVideo(url) ? ` cs-anim-${s.bgAnim}` : '';
}

/** A background file, inside the frame chosen for this device if it has one. */
function framedMedia(s, url, frameKey, className, device) {
    const media = mediaElement(url, className);
    const frame = s.frames?.[frameKey]?.[device];
    if (!frame) return media;
    const wrap = document.createElement('div');
    wrap.className = 'cs-frame';
    wrap.append(media);
    applyFrame(wrap, frame);
    return wrap;
}

/**
 * @returns {HTMLElement|null} the background layer, or null for the theme's default blur
 */
function buildBackground(s, life, small = false, device = screenDevice()) {
    const bg = document.createElement('div');
    bg.className = 'cs-bg';

    if (s.bgMode === 'custom' && s.bgUrl) {
        const url = bgVideoUrl(s, small);
        // A still standing in for a video gets a slow zoom so the screen doesn't feel frozen.
        const stillForVideo = isVideo(s.bgUrl) && !isVideo(url);
        const anim = stillForVideo && s.bgAnim === 'none' ? ' cs-anim-kenburns' : animClass(s, url);
        bg.classList.add('cs-bg-single');
        bg.appendChild(framedMedia(s, url, s.bgUrl, 'cs-bg-media' + anim, device));
        return bg;
    }

    const slides = s.bgMode === 'slideshow' ? s.slides.filter(Boolean) : [];
    if (!slides.length) return null;

    const order = s.slideShuffle ? shuffled(slides) : slides;
    const seconds = Math.max(2, Number(s.slideSeconds) || 6);
    bg.style.setProperty('--cs-slide-dur', `${seconds + SLIDE_FADE_MS / 1000}s`);
    bg.style.setProperty('--cs-fade', `${SLIDE_FADE_MS}ms`);

    // Slides get their picture only when they are next up: a 10-slide show costs two images, not ten.
    const els = order.map((url, i) => {
        const slide = document.createElement('div');
        slide.className = 'cs-slide' + (i % 2 ? ' cs-alt' : '');
        slide.dataset.url = url;
        bg.appendChild(slide);
        return slide;
    });
    const load = slide => {
        if (slide.firstChild) return;
        const url = slide.dataset.url;
        slide.appendChild(framedMedia(s, url, url, 'cs-bg-media' + animClass(s, url), device));
    };
    load(els[0]);
    els[0].classList.add('cs-on');

    if (els.length > 1) {
        load(els[1]);
        let i = 0;
        life.interval(() => {
            if (!bg.isConnected) return life.release();
            const prev = els[i];
            i = (i + 1) % els.length;
            prev.classList.remove('cs-on');
            prev.classList.add('cs-leaving');
            life.timeout(() => prev.classList.remove('cs-leaving'), SLIDE_FADE_MS);
            els[i].classList.add('cs-on');
            load(els[(i + 1) % els.length]);
        }, seconds * 1000);
    }
    return bg;
}

function tipList(s) {
    return s.tips.split('\n').map(x => x.trim()).filter(Boolean);
}

/**
 * Restyles a splash element in place: background, icon, text, spinner, tips.
 * Used for the real init overlay, the full-screen preview and the mini preview.
 * @param {HTMLElement} el element shaped like core's splash: .splash-logo, spinner, .splash-message
 * @returns {ReturnType<typeof createLife>|null} call .release() when the splash is gone
 */
function decorate(el, s = settings(), { force = false, small = false, device = screenDevice() } = {}) {
    if (!el || el.classList.contains('cs-stage')) return null;
    if (!force && !s.enabled) return null;

    const life = createLife(el);
    const spinner = effectiveSpinner(s);
    el.classList.add('cs-stage', `cs-spinner-${spinner}`);
    el.style.setProperty('--cs-dim', String(s.bgDim / 100));
    el.style.setProperty('--cs-icon-size', `${s.iconSize}px`);
    el.style.setProperty('--cs-spin-scale', String((Number(s.spinnerScale) || 100) / 100));

    const bg = buildBackground(s, life, small, device);
    if (bg) {
        el.prepend(bg);
        el.classList.add('cs-has-bg');
    }

    // Effect layers keep the order they were picked in: the first one sits lowest.
    let anchor = bg;
    for (const kind of s.vfxList) {
        const layer = buildVfx(kind, s.vfxAmt[kind] ?? VFX_DEFAULT_AMT, LITE ? LITE_VFX_DENSITY : 1);
        if (!layer) continue;
        anchor ? anchor.after(layer) : el.prepend(layer);
        anchor = layer;
    }

    applySpinner(el.querySelector('#load-spinner') ?? el.querySelector('.cs-spin'), spinner, s);

    const nativeLogo = el.querySelector('.splash-logo');
    if (s.iconMode === 'none') {
        nativeLogo?.remove();
    } else {
        let icon = nativeLogo;
        if (s.iconMode === 'custom' && s.iconUrl) {
            icon = mediaElement(s.iconUrl, 'cs-icon');
            nativeLogo ? nativeLogo.replaceWith(icon) : el.querySelector('.cs-spin')?.before(icon);
        }
        if (icon && s.iconAnim !== 'none') icon.classList.add(`cs-icon-${s.iconAnim}`);
    }

    const message = el.querySelector('.splash-message');
    if (message && s.text.trim()) {
        message.textContent = s.text.trim();
        delete message.dataset.i18n;
    }

    const tips = tipList(s);
    if (message && tips.length) {
        const tip = document.createElement('div');
        tip.className = 'cs-tip';
        message.after(tip);
        let i = Math.floor(Math.random() * tips.length);
        const show = () => {
            tip.classList.remove('cs-tip-in');
            void tip.offsetWidth;
            tip.textContent = tips[i++ % tips.length];
            tip.classList.add('cs-tip-in');
        };
        show();
        life.interval(() => {
            if (!tip.isConnected) return life.release();
            show();
        }, Math.max(1, s.tipSeconds) * 1000);
    }
    return life;
}

/** Builds the same markup core uses for its init splash. */
function splashSkeleton(base) {
    base.classList.add('splash-screen');
    const logo = document.createElement('img');
    logo.src = '/img/logo.png';
    logo.alt = '';
    logo.className = 'splash-logo';
    const msg = document.createElement('h2');
    msg.className = 'splash-message';
    msg.textContent = 'Initializing…';
    base.prepend(logo);
    base.appendChild(msg);
    return base;
}

/** Startup: the init splash is already on screen when extensions activate. */
function hookStartup() {
    const take = el => {
        const life = decorate(el);
        if (life) releaseOnDetach(el, life);
    };
    const current = document.querySelector('#loader.splash-screen');
    if (current) {
        take(current);
        return;
    }
    // Fallback in case we got here before the overlay was created.
    const mo = new MutationObserver(() => {
        const el = document.querySelector('#loader.splash-screen');
        if (el) {
            mo.disconnect();
            take(el);
        }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 30000);
}

/** Shows the splash full-screen for a few seconds, the same way startup does. */
function preview() {
    const overlay = splashSkeleton(loader.createOverlay());
    const life = decorate(overlay, settings(), { force: true });
    const handle = loader.show({ slug: 'custom-splash-preview', toastMode: loader.ToastMode.NONE, overlayContent: overlay });
    if (life) releaseOnDetach(overlay, life);
    const close = () => handle.isActive && handle.hide();
    overlay.addEventListener('click', close);
    setTimeout(close, 8000);
}

async function uploadData(name, data) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, data }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { path } = await res.json();
    return '/' + String(path).replace(/^\/+/, '');
}

// ---- Own settings file ----
// ST saves settings.json wholesale from whichever tab saves last, so a tab opened earlier
// (phone + PC, a second window) silently rolls our builds back. We also keep a copy in a
// file of our own with a timestamp; on startup the newer of the two wins.

const STORE_NAME = 'slayintro-settings.json';
const STORE_URL = `/user/files/${STORE_NAME}`;
const STORE_DEBOUNCE_MS = 800;
let storeTimer = null;
/** Store writes run one after another: two read-modify-writes at once would drop one's change. */
let storeQueue = Promise.resolve();
const queueStore = task => (storeQueue = storeQueue.then(task, task));

const toBase64 = text => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
};

function writeStore() {
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => queueStore(() =>
        uploadData(STORE_NAME, toBase64(JSON.stringify(settings())))
            .catch(e => console.warn('[SLAYintro] settings file not written', e)),
    ), STORE_DEBOUNCE_MS);
}

/** Changes one part of the settings file in place, keeping its `rev` and everything else. */
function patchStore(mutate) {
    return queueStore(async () => {
        const res = await fetch(STORE_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const stored = await res.json();
        mutate(stored);
        await uploadData(STORE_NAME, toBase64(JSON.stringify(stored)));
    });
}

/** Saves both copies after a user edit; `rev` tells them apart. */
function save() {
    settings().rev = Date.now();
    saveSettingsDebounced();
    writeStore();
}

async function loadStore() {
    const s = settings();
    try {
        const res = await fetch(STORE_URL, { cache: 'no-store' });
        if (!res.ok) {
            writeStore();
            return;
        }
        const stored = await res.json();
        if ((stored.rev || 0) > (s.rev || 0)) {
            Object.assign(s, stored);
            migrateVfx(s);
            saveSettingsDebounced();
        } else if ((s.rev || 0) > (stored.rev || 0)) {
            writeStore();
        }
    } catch (e) {
        console.warn('[SLAYintro] settings file not read', e);
    }
}

const SHRINKABLE = /^image\/(jpeg|png|webp|bmp)$/;

/**
 * Downscales a still picture to maxSide and re-encodes it as WebP (keeps transparency).
 * GIFs are left alone: a canvas would freeze them on the first frame.
 * @returns {Promise<Blob|null>} null when the original is already fine
 */
async function shrinkImage(file, maxSide) {
    if (!SHRINKABLE.test(file.type)) return null;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
        bmp.close();
        return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.86));
    return blob && blob.size < file.size ? blob : null;
}

async function uploadFile(file, maxSide = MAX_SIDE_BG) {
    let blob = file;
    let ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const shrunk = await shrinkImage(file, maxSide).catch(() => null);
    if (shrunk) {
        blob = shrunk;
        ext = 'webp';
    }
    if (file.type.startsWith('video/') && file.size > BIG_VIDEO_MB * 1024 * 1024) {
        toastr.warning(`Видео весит ${Math.round(file.size / 1024 / 1024)} МБ — на телефонах экран загрузки будет тормозить. Лучше сжать до 1080p или указать лёгкую версию для телефона.`, '', { timeOut: 10000 });
    }
    const name = `splash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
    return uploadData(name, data);
}

const seg = (key, options) => `
    <div class="cs-seg" data-cs-key="${key}">
      ${options.map(([v, label, icon]) => `<button type="button" data-value="${v}">${icon ? `<i class="fa-solid ${icon}"></i>` : ''}<span>${label}</span></button>`).join('')}
    </div>`;

const range = (key, label, min, max, step, unit) => `
    <label class="cs-field">
      <span class="cs-field-head"><span>${label}</span><span class="cs-val"><span data-cs-label="${key}"></span>${unit}</span></span>
      <input type="range" data-cs-key="${key}" data-num min="${min}" max="${max}" step="${step}">
    </label>`;

const urlRow = (key, uploadId, cropId) => `
    <div class="cs-url">
      <input type="text" class="text_pole" data-cs-key="${key}" placeholder="/user/files/… или https://…">
      ${cropId ? `<button type="button" class="menu_button cs-icon-btn" id="${cropId}" title="Кадр и обрезка"><i class="fa-solid fa-crop-simple"></i></button>` : ''}
      <button type="button" class="menu_button cs-icon-btn" id="${uploadId}" title="Загрузить файл"><i class="fa-solid fa-upload"></i></button>
    </div>`;

function settingsHtml() {
    return `
<div class="cs-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>SLAYintro</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
     <div class="cs-body">
      <div class="cs-top">
        <label class="cs-switch">
          <input type="checkbox" data-cs-key="enabled">
          <span class="cs-switch-track"><span class="cs-switch-thumb"></span></span>
          <span>Включено</span>
        </label>
        <button type="button" class="menu_button cs-play" id="cs_preview" title="Показать на весь экран"><i class="fa-solid fa-expand"></i><span>На весь экран</span></button>
      </div>

      <div class="cs-mini-wrap">
        <div class="cs-mini" id="cs_mini" title="Живое превью. Клик — на весь экран"></div>
        <div class="cs-dev-switch" role="group" aria-label="Предпросмотр">
          ${Object.entries(FRAME_DEVICES).map(([key, d]) => `<button type="button" data-dev="${key}" title="${d.label}"><i class="fa-solid ${d.icon}"></i></button>`).join('')}
        </div>
      </div>

      <div class="cs-builds">
        <i class="fa-solid fa-layer-group cs-builds-ico" title="Сборки"></i>
        <select id="cs_preset" class="text_pole"></select>
        <button type="button" class="menu_button cs-icon-btn" id="cs_preset_save" title="Новая сборка из текущего вида"><i class="fa-solid fa-floppy-disk"></i></button>
        <button type="button" class="menu_button cs-icon-btn" id="cs_preset_delete" title="Удалить сборку"><i class="fa-solid fa-trash-can"></i></button>
      </div>
      <div class="cs-hint" id="cs_preset_hint"></div>

      <div class="cs-tabs">
        <button type="button" data-tab="bg" title="Фон"><i class="fa-solid fa-image"></i><span>Фон</span></button>
        <button type="button" data-tab="icon" title="Логотип"><i class="fa-solid fa-star"></i><span>Лого</span></button>
        <button type="button" data-tab="badge" title="Значок загрузки"><i class="fa-solid fa-spinner"></i><span>Значок</span></button>
        <button type="button" data-tab="text" title="Текст"><i class="fa-solid fa-font"></i><span>Текст</span></button>
        <button type="button" data-tab="vfx" title="Эффекты"><i class="fa-solid fa-snowflake"></i><span>VFX</span></button>
      </div>

      <div class="cs-pane" data-pane="bg">
        ${seg('bgMode', [['default', 'Тема'], ['custom', 'Файл'], ['slideshow', 'Слайдшоу']])}

        <div data-cs-show="bgMode=custom">
          ${urlRow('bgUrl', 'cs_bg_upload', 'cs_bg_crop')}
          <div class="cs-hint" id="cs_frame_state"></div>
          <div class="cs-hint">Картинка, GIF или видео (mp4/webm). Видео играет без звука по кругу.</div>
          <div class="cs-label">Лёгкое видео для телефона <span class="cs-dim">— необязательно</span></div>
          ${urlRow('bgUrlMobile', 'cs_bg_mobile_upload')}
          <div class="cs-hint">Если указано, телефоны и планшеты возьмут его вместо основного: меньше трафика и нагрузки.</div>
        </div>

        <div data-cs-show="bgMode=slideshow">
          <div class="cs-slides" id="cs_slides"></div>
          <div class="cs-url">
            <input type="text" class="text_pole" id="cs_slide_url" placeholder="Добавить по ссылке…">
            <button type="button" class="menu_button cs-icon-btn" id="cs_slide_add_url" title="Добавить"><i class="fa-solid fa-plus"></i></button>
          </div>
          ${range('slideSeconds', 'Каждый слайд', 2, 20, 1, ' с')}
          <label class="checkbox_label"><input type="checkbox" data-cs-key="slideShuffle"><span>Перемешивать</span></label>
        </div>

        <div data-cs-show="bgMode=custom|slideshow">
          <div class="cs-label">Анимация картинки</div>
          ${seg('bgAnim', [['none', 'Нет'], ['kenburns', 'Наезд'], ['drift', 'Дрейф'], ['breathe', 'Дыхание']])}
          ${range('bgDim', 'Затемнение', 0, 90, 5, '%')}
          <label class="checkbox_label"><input type="checkbox" data-cs-key="skipCrop"><span>Не предлагать кадр и обрезку при загрузке</span></label>
        </div>
      </div>

      <div class="cs-pane" data-pane="icon">
        ${seg('iconMode', [['default', 'Таверна'], ['custom', 'Своя'], ['none', 'Без иконки']])}
        <div data-cs-show="iconMode=custom">
          ${urlRow('iconUrl', 'cs_icon_upload', 'cs_icon_crop')}
          <div class="cs-hint">PNG с прозрачностью, GIF или видео.</div>
        </div>
        <div data-cs-show="iconMode=default|custom">
          ${range('iconSize', 'Размер', 60, 900, 10, ' px')}
          <div class="cs-label">Анимация</div>
          ${seg('iconAnim', [['none', 'Нет'], ['float', 'Парит'], ['pulse', 'Пульс'], ['glow', 'Сияние']])}
        </div>
      </div>

      <div class="cs-pane" data-pane="text">
        <div class="cs-label">Надпись</div>
        <input type="text" class="text_pole" data-cs-key="text" placeholder="Пусто = «Initializing…»">
        <div class="cs-label">Подсказки <span class="cs-dim">— по одной на строку</span></div>
        <textarea class="text_pole" data-cs-key="tips" rows="4" placeholder="Первая подсказка…&#10;Вторая подсказка…"></textarea>
        <div data-cs-show-tips>
          ${range('tipSeconds', 'Менять каждые', 1, 15, 1, ' с')}
        </div>
      </div>

      <div class="cs-pane" data-pane="badge">
        <div class="cs-seg cs-spinpick" data-cs-key="spinner">
          ${SPINNERS.map(([v, label]) => `
          <button type="button" data-value="${v}" title="${label}">
            <span class="cs-stage cs-spinner-${v} cs-tilebox"><span class="cs-spin fa-solid fa-gear fa-spin" data-kind="${v}"></span></span>
            <span class="cs-pick-label">${label}</span>
          </button>`).join('')}
        </div>
        <div data-cs-show="spinner=plumbob">
          <div class="cs-label">Цвет пламбоба</div>
          ${seg('plumbobColor', [['green', 'Зелёный'], ['yellow', 'Жёлтый'], ['orange', 'Оранж.'], ['red', 'Красный'], ['blue', 'Синий'], ['pink', 'Розовый']])}
        </div>
        <div data-cs-show="spinner=custom">
          ${urlRow('spinnerUrl', 'cs_spinner_upload', 'cs_spinner_crop')}
          <div class="cs-hint">PNG с прозрачностью, GIF, WebP или короткое видео.</div>
          <div class="cs-label">Что с ней делать</div>
          ${seg('spinnerAnim', [['spin', 'Крутить'], ['pulse', 'Пульс'], ['sway', 'Качать'], ['float', 'Парить'], ['blink', 'Мерцать'], ['flip', 'Монетка'], ['bounce', 'Прыгать'], ['none', 'Стоять']])}
        </div>
        <div data-cs-hide="spinner=none">
          ${range('spinnerScale', 'Размер значка', 50, 250, 10, '%')}
        </div>
      </div>

      <div class="cs-pane" data-pane="vfx">
        <div class="cs-hint">Нажимай на плитки — можно включить сразу несколько. Слои ложатся между фоном и логотипом.</div>
        <div class="cs-vpick" id="cs_vpick">
          ${VFX_GROUPS.map(group => `
          <div class="cs-pick-group">${group}</div>
          ${Object.entries(VFX).filter(([, d]) => d.group === group).map(([k, d]) => `
          <button type="button" class="cs-vbtn" data-vfx="${k}" title="${d.label}">
            <span class="cs-vtile"></span>
            <span class="cs-pick-label">${d.label}</span>
            <i class="fa-solid fa-check cs-vcheck"></i>
          </button>`).join('')}`).join('')}
        </div>
        <div class="cs-vsel" id="cs_vsel"></div>
      </div>

      <div class="cs-hint cs-foot">Первые мгновения после запуска таверна показывает свой экран, потом подменяется на твой.</div>
      <input type="file" id="cs_file" accept="image/*,video/*" hidden>
     </div>
    </div>
  </div>
</div>`;
}

let currentTab = 'bg';

function bindSettings() {
    const s = settings();
    const $root = $(settingsHtml());
    $('#extensions_settings2').append($root);
    const root = $root[0];
    // Badge tiles: plumbob and custom depend on settings, so they are redrawn on change.
    const renderSpinTiles = (only = null) => {
        root.querySelectorAll('.cs-spinpick .cs-spin').forEach(el => {
            if (!only || only.includes(el.dataset.kind)) applySpinner(el, el.dataset.kind, s);
        });
    };
    renderSpinTiles();

    // ---- live mini preview ----
    const mini = root.querySelector('#cs_mini');
    let miniVisible = false;
    let miniDirty = true;
    let miniTimer = null;
    let miniLife = null;
    let miniDevice = screenDevice();

    const fitMini = () => mini.style.setProperty('--k', String(mini.clientWidth / FRAME_DEVICES[miniDevice].w));
    const clearMini = () => {
        miniLife?.release();
        miniLife = null;
        mini.replaceChildren();
    };
    const renderMini = () => {
        miniDirty = false;
        clearMini();
        const stage = document.createElement('div');
        const spin = document.createElement('div');
        spin.className = 'fa-solid fa-gear fa-spin fa-3x cs-spin';
        stage.appendChild(spin);
        splashSkeleton(stage);
        miniLife = decorate(stage, s, { force: true, small: true, device: miniDevice });
        mini.appendChild(stage);
        fitMini();
    };
    const scheduleMini = () => {
        miniDirty = true;
        clearTimeout(miniTimer);
        if (miniVisible) miniTimer = setTimeout(renderMini, 250);
    };
    new ResizeObserver(fitMini).observe(mini);
    // Out of sight (panel closed or scrolled away) the preview is torn down completely:
    // no video decoding, no slideshow timers, no particles. It is rebuilt when seen again.
    new IntersectionObserver(([entry]) => {
        miniVisible = entry.isIntersecting;
        if (miniVisible) {
            if (miniDirty || !miniLife) renderMini();
        } else {
            clearTimeout(miniTimer);
            clearMini();
            miniDirty = true;
        }
    }).observe(mini);
    mini.addEventListener('click', preview);

    const devButtons = [...root.querySelectorAll('.cs-dev-switch button')];
    const showMiniDevice = key => {
        miniDevice = key;
        mini.classList.toggle('cs-is-phone', key === 'phone');
        mini.style.setProperty('--cs-stage-w', `${FRAME_DEVICES[key].w}px`);
        mini.style.setProperty('--cs-stage-h', `${FRAME_DEVICES[key].h}px`);
        devButtons.forEach(b => b.classList.toggle('cs-on', b.dataset.dev === key));
        if (miniVisible) renderMini();
    };
    devButtons.forEach(b => b.addEventListener('click', () => showMiniDevice(b.dataset.dev)));
    showMiniDevice(miniDevice);

    // Edits go straight into the selected build: otherwise switching builds and back
    // silently threw the edits away while the dropdown still showed the build's name.
    const persist = () => {
        if (s.activePreset && s.presets[s.activePreset]) s.presets[s.activePreset] = snapshot(s);
        save();
    };

    // ---- generic bindings ----
    const changed = () => {
        sync();
        pruneFrames();
        renderFrameState();
        renderSpinTiles(['plumbob', 'custom']);
        scheduleMini();
        persist();
        ensurePoster(s, s.bgUrl);
    };

    // Backgrounds chosen before this existed get their phone fallback too.
    [s.bgUrl, ...Object.values(s.presets).map(p => p.bgUrl)].forEach(url => ensurePoster(s, url));

    const refreshers = [];
    root.querySelectorAll('input[data-cs-key], textarea[data-cs-key], select[data-cs-key]').forEach(el => {
        const key = el.dataset.csKey;
        const prop = el.type === 'checkbox' ? 'checked' : 'value';
        const num = 'num' in el.dataset;
        const refresh = () => { el[prop] = s[key]; };
        refresh();
        refreshers.push(refresh);
        el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
            s[key] = num ? Number(el[prop]) : el[prop];
            changed();
        });
        // Text fields: update the preview while typing, not only on blur.
        if (el.type === 'text' || el.tagName === 'TEXTAREA') {
            el.addEventListener('input', () => {
                s[key] = el.value;
                changed();
            });
        }
    });

    root.querySelectorAll('.cs-seg').forEach(group => {
        const key = group.dataset.csKey;
        const refresh = () => group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === s[key]));
        refresh();
        refreshers.push(refresh);
        group.addEventListener('click', e => {
            const btn = e.target.closest('button[data-value]');
            if (!btn) return;
            s[key] = btn.dataset.value;
            refresh();
            changed();
        });
    });

    function sync() {
        root.querySelectorAll('[data-cs-label]').forEach(el => { el.textContent = s[el.dataset.csLabel]; });
        root.querySelectorAll('[data-cs-show], [data-cs-hide]').forEach(el => {
            const show = 'csShow' in el.dataset;
            const [key, vals] = (show ? el.dataset.csShow : el.dataset.csHide).split('=');
            const match = vals.split('|').includes(String(s[key]));
            el.hidden = show ? !match : match;
        });
        root.querySelector('[data-cs-show-tips]').hidden = !tipList(s).length;
        root.querySelector('.cs-body').classList.toggle('cs-off', !s.enabled);
    }

    // ---- tabs ----
    const showTab = tab => {
        currentTab = tab;
        root.querySelectorAll('.cs-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        root.querySelectorAll('.cs-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
        if (tab === 'vfx') fillVfxTiles();
    };

    // ---- VFX picker: live tiles, multi-select, per-effect strength ----
    const vpick = root.querySelector('#cs_vpick');
    const vsel = root.querySelector('#cs_vsel');
    const VTILE_W = 320;

    // Frozen tiles show one frame. These effects wait out a delay at opacity 0, so without
    // this they would freeze blank: start each particle inside its visible part of the cycle.
    const TILE_VISIBLE_PHASE = { sparkles: [0.35, 0.65], runes: [0.3, 0.7], starfall: [0.02, 0.08] };
    function showFrozenFrame(layer, kind) {
        const phase = TILE_VISIBLE_PHASE[kind];
        if (!phase) return;
        layer.querySelectorAll('.cs-p').forEach(p => {
            const dur = parseFloat(p.style.getPropertyValue('--dur'));
            const at = phase[0] + Math.random() * (phase[1] - phase[0]);
            p.style.setProperty('--delay', `${(-dur * at).toFixed(2)}s`);
        });
    }

    // Tiles are built on first visit to the tab: ~20 live effects are not free.
    function fillVfxTiles() {
        vpick.querySelectorAll('.cs-vbtn').forEach(btn => {
            const box = btn.querySelector('.cs-vtile');
            if (box.childElementCount) return;
            const stage = document.createElement('div');
            stage.className = 'cs-stage cs-vtile-stage';
            const layer = buildVfx(btn.dataset.vfx, 70, 0.22);
            if (layer) {
                showFrozenFrame(layer, btn.dataset.vfx);
                stage.appendChild(layer);
            }
            box.appendChild(stage);
        });
        requestAnimationFrame(() => {
            const t = vpick.querySelector('.cs-vtile');
            if (t?.clientWidth) vpick.style.setProperty('--vk', String(t.clientWidth / VTILE_W));
        });
    }
    new ResizeObserver(() => {
        const t = vpick.querySelector('.cs-vtile');
        if (t?.clientWidth) vpick.style.setProperty('--vk', String(t.clientWidth / VTILE_W));
    }).observe(vpick);

    const renderVfx = () => {
        vpick.querySelectorAll('.cs-vbtn').forEach(b => b.classList.toggle('active', s.vfxList.includes(b.dataset.vfx)));
        vsel.replaceChildren();
        if (!s.vfxList.length) {
            vsel.innerHTML = '<div class="cs-hint">Эффекты выключены.</div>';
            return;
        }
        for (const kind of s.vfxList) {
            const amt = s.vfxAmt[kind] ?? VFX_DEFAULT_AMT;
            const row = document.createElement('div');
            row.className = 'cs-vrow';
            row.innerHTML = `
                <span class="cs-vrow-name">${VFX[kind].label}</span>
                <input type="range" min="5" max="100" step="5" value="${amt}">
                <span class="cs-val">${amt}%</span>
                <button type="button" class="cs-vrow-del" title="Убрать"><i class="fa-solid fa-xmark"></i></button>`;
            const input = row.querySelector('input');
            const val = row.querySelector('.cs-val');
            input.addEventListener('input', () => {
                s.vfxAmt[kind] = Number(input.value);
                val.textContent = `${input.value}%`;
                scheduleMini();
                persist();
            });
            row.querySelector('.cs-vrow-del').addEventListener('click', () => {
                s.vfxList = s.vfxList.filter(k => k !== kind);
                renderVfx();
                changed();
            });
            vsel.appendChild(row);
        }
    };
    vpick.addEventListener('click', e => {
        const btn = e.target.closest('.cs-vbtn');
        if (!btn) return;
        const kind = btn.dataset.vfx;
        s.vfxList = s.vfxList.includes(kind) ? s.vfxList.filter(k => k !== kind) : [...s.vfxList, kind];
        renderVfx();
        changed();
    });
    renderVfx();
    root.querySelector('.cs-tabs').addEventListener('click', e => {
        const btn = e.target.closest('button[data-tab]');
        if (btn) showTab(btn.dataset.tab);
    });
    showTab(currentTab);

    // ---- frames and crops ----
    const pruneFrames = () => {
        const used = new Set([s.bgUrl, ...s.slides]);
        for (const url of Object.keys(s.frames)) if (!used.has(url)) delete s.frames[url];
    };
    const frameState = root.querySelector('#cs_frame_state');
    const renderFrameState = () => {
        const set = Object.keys(FRAME_DEVICES).filter(k => s.frames[s.bgUrl]?.[k]).map(k => FRAME_DEVICES[k].label.toLowerCase());
        frameState.textContent = set.length ? `Кадр настроен: ${set.join(', ')}.` : '';
        frameState.hidden = !set.length;
    };
    renderFrameState();

    /** The real splash for one background, small, with a frame the dialog can move. */
    const framePreview = url => (host, device) => {
        const stage = document.createElement('div');
        const spin = document.createElement('div');
        spin.className = 'fa-solid fa-gear fa-spin fa-3x cs-spin';
        stage.appendChild(spin);
        splashSkeleton(stage);
        const look = {
            ...s, bgMode: 'custom', bgUrl: url, bgUrlMobile: '', bgAnim: 'none', vfxList: [], tips: '',
            frames: { [url]: { [device]: { px: 50, py: 50, z: 1 } } },
        };
        const life = decorate(stage, look, { force: true, small: true, device });
        host.style.setProperty('--cs-stage-w', `${FRAME_DEVICES[device].w}px`);
        host.style.setProperty('--cs-stage-h', `${FRAME_DEVICES[device].h}px`);
        host.style.setProperty('--k', String(host.clientWidth / FRAME_DEVICES[device].w));
        host.appendChild(stage);
        return { wrap: stage.querySelector('.cs-frame'), release: () => life?.release() };
    };
    const editFrames = async url => {
        const picked = await frameDialog(url, {
            video: isVideo(url), frames: s.frames[url], device: miniDevice, preview: framePreview(url),
        });
        if (picked === undefined) return;
        if (picked) s.frames[url] = picked;
        else delete s.frames[url];
        renderSlides();
        changed();
    };
    root.querySelector('#cs_bg_crop').addEventListener('click', () => {
        if (s.bgUrl) editFrames(s.bgUrl);
        else toastr.info('Сначала выбери файл');
    });

    /** GIFs and videos would lose their motion on a canvas. */
    const croppable = url => !isVideo(url) && !/\.gif(\?.*)?$/i.test(url);
    const croppedFile = (blob, name) => new File([blob], `${name}.${blob.type === 'image/webp' ? 'webp' : 'png'}`, { type: blob.type });
    const editCrop = async key => {
        const url = s[key];
        if (!url) return toastr.info('Сначала выбери файл');
        if (!croppable(url)) return toastr.info('GIF и видео не обрезаются');
        const blob = await frameDialog(url, { logo: true });
        if (!blob) return;
        try {
            s[key] = await uploadFile(croppedFile(blob, 'crop'), MAX_SIDE_ICON);
            refreshers.forEach(fn => fn());
            changed();
            toastr.success('Обрезано');
        } catch (e) {
            console.error('[SLAYintro] crop upload failed', e);
            toastr.error('Не удалось сохранить обрезку');
        }
    };
    root.querySelector('#cs_icon_crop').addEventListener('click', () => editCrop('iconUrl'));
    root.querySelector('#cs_spinner_crop').addEventListener('click', () => editCrop('spinnerUrl'));

    // ---- slideshow list ----
    const slidesBox = root.querySelector('#cs_slides');
    const renderSlides = () => {
        slidesBox.replaceChildren();
        s.slides.forEach((url, i) => {
            const tile = document.createElement('div');
            tile.className = 'cs-slide-tile';
            tile.title = url;
            const media = mediaElement(url, 'cs-slide-thumb', { still: true });
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'cs-slide-del';
            del.title = 'Убрать из слайдшоу';
            del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            del.addEventListener('click', () => {
                s.slides.splice(i, 1);
                renderSlides();
                changed();
            });
            const num = document.createElement('span');
            num.className = 'cs-slide-num';
            num.textContent = String(i + 1);
            const crop = document.createElement('button');
            crop.type = 'button';
            crop.className = 'cs-slide-crop' + (s.frames[url] ? ' cs-on' : '');
            crop.title = 'Кадр';
            crop.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
            crop.addEventListener('click', () => editFrames(url));
            tile.append(media, num, crop, del);
            slidesBox.appendChild(tile);
        });
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'cs-slide-tile cs-slide-add';
        add.title = 'Добавить картинки';
        add.innerHTML = '<i class="fa-solid fa-plus"></i><span>Добавить</span>';
        add.addEventListener('click', () => pick('slides', true));
        slidesBox.appendChild(add);
    };
    renderSlides();

    root.querySelector('#cs_slide_add_url').addEventListener('click', () => {
        const input = root.querySelector('#cs_slide_url');
        const url = input.value.trim();
        if (!url) return;
        s.slides.push(url);
        input.value = '';
        renderSlides();
        changed();
    });

    // ---- uploads ----
    const fileInput = root.querySelector('#cs_file');
    let target = null;
    function pick(t, multiple = false) {
        target = t;
        fileInput.multiple = multiple;
        fileInput.value = '';
        fileInput.click();
    }
    root.querySelector('#cs_icon_upload').addEventListener('click', () => pick('iconUrl'));
    root.querySelector('#cs_bg_upload').addEventListener('click', () => pick('bgUrl'));
    root.querySelector('#cs_bg_mobile_upload').addEventListener('click', () => pick('bgUrlMobile'));
    root.querySelector('#cs_spinner_upload').addEventListener('click', () => pick('spinnerUrl'));
    fileInput.addEventListener('change', async () => {
        const files = [...(fileInput.files ?? [])];
        if (!files.length || !target) return;
        try {
            const icon = ['iconUrl', 'spinnerUrl'].includes(target);
            // Asked before the upload, so backing out leaves nothing behind in user/files.
            let frames = null;
            if (!s.skipCrop && (target === 'bgUrl' || (icon && SHRINKABLE.test(files[0].type)))) {
                const local = URL.createObjectURL(files[0]);
                try {
                    const video = files[0].type.startsWith('video/');
                    // The fragment only tells mediaElement that this blob is a video.
                    const picked = icon
                        ? await frameDialog(local, { logo: true })
                        : await frameDialog(local, { video, device: miniDevice, preview: framePreview(video ? `${local}#.mp4` : local) });
                    if (picked === undefined) return;
                    if (icon && picked) files[0] = croppedFile(picked, 'crop');
                    if (!icon) frames = picked;
                } finally {
                    URL.revokeObjectURL(local);
                }
            }
            const urls = [];
            const maxSide = icon ? MAX_SIDE_ICON : MAX_SIDE_BG;
            for (const file of files) urls.push(await uploadFile(file, maxSide));
            if (frames) s.frames[urls[0]] = frames;
            if (target === 'slides') {
                s.slides.push(...urls);
                renderSlides();
            } else {
                s[target] = urls[0];
                refreshers.forEach(fn => fn());
            }
            changed();
            toastr.success(urls.length > 1 ? `Загружено файлов: ${urls.length}` : 'Файл загружен');
        } catch (e) {
            console.error('[SLAYintro] upload failed', e);
            toastr.error('Не удалось загрузить файл');
        }
    });

    // ---- builds ----
    const renderPresets = () => {
        const $sel = $('#cs_preset').empty();
        $sel.append($('<option>').val('').text('— без сборки —'));
        for (const name of Object.keys(s.presets).sort((a, b) => a.localeCompare(b))) {
            $sel.append($('<option>').val(name).text(name));
        }
        const active = s.presets[s.activePreset] ? s.activePreset : '';
        $sel.val(active);
        root.querySelector('#cs_preset_hint').textContent = active
            ? `Правки сразу пишутся в «${active}». Для новой сборки сначала нажми дискету.`
            : 'Сборка не выбрана: правки останутся только в текущем виде.';
    };
    renderPresets();

    // How the selected build looked when it was picked. Edits land in it right away, so
    // "save as new" after editing would leave two identical builds without this.
    let baseline;
    const rememberBaseline = () => { baseline = { name: s.activePreset, look: snapshot(s) }; };
    rememberBaseline();

    $('#cs_preset').on('change', function () {
        const name = String($(this).val());
        s.activePreset = name;
        if (name && s.presets[name]) {
            // Older builds may lack newer keys: start from defaults so nothing leaks from the previous look.
            Object.assign(s, snapshot(defaults), structuredClone(s.presets[name]));
            migrateVfx(s);
            refreshers.forEach(fn => fn());
            renderSlides();
            renderVfx();
        }
        rememberBaseline();
        renderPresets();
        changed();
    });

    $('#cs_preset_save').on('click', async () => {
        // Cancel gives false, the X gives null: only a typed string is a name.
        const typed = await callGenericPopup('Сохранить как новую сборку. Название:', POPUP_TYPE.INPUT, '');
        const name = typeof typed === 'string' ? typed.trim() : '';
        if (!name) return;
        if (s.presets[name] && name !== s.activePreset) {
            const ok = await callGenericPopup(`Сборка «${name}» уже есть. Перезаписать?`, POPUP_TYPE.CONFIRM);
            if (!ok) return;
        }
        const before = baseline;
        const edited = before.name !== name && s.presets[before.name]
            && JSON.stringify(snapshot(s)) !== JSON.stringify(before.look);
        s.presets[name] = snapshot(s);
        s.activePreset = name;
        rememberBaseline();
        renderPresets();
        save();
        toastr.success(`Сборка «${name}» сохранена`);
        if (edited) {
            const undo = await callGenericPopup(`Правки успели записаться и в сборку «${before.name}». Вернуть её к прежнему виду?`, POPUP_TYPE.CONFIRM);
            if (undo) {
                s.presets[before.name] = before.look;
                save();
            }
        }
    });

    $('#cs_preset_delete').on('click', async () => {
        const name = s.activePreset;
        if (!name || !s.presets[name]) {
            toastr.info('Выбери сборку, которую удалить');
            return;
        }
        const ok = await callGenericPopup(`Удалить сборку «${name}»?`, POPUP_TYPE.CONFIRM);
        if (!ok) return;
        delete s.presets[name];
        s.activePreset = '';
        rememberBaseline();
        renderPresets();
        save();
        toastr.success(`Сборка «${name}» удалена`);
    });

    root.querySelector('#cs_preview').addEventListener('click', preview);
    sync();
}

// ST waits for this module (top-level await included) before going on with startup.
await loadStore();
hookStartup();
// The settings panel (~600 nodes, live tiles) is not needed to show the splash:
// build it once the app is ready so it doesn't compete with startup.
// #preloader exists only until the first splash closes, i.e. while the app is starting.
if (document.getElementById('preloader')) {
    eventSource.once(event_types.APP_READY, () => bindSettings());
} else {
    jQuery(() => bindSettings());
}
