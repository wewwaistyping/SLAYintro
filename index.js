import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { loader } from '../../../action-loader.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { SPINNERS, applySpinner, effectiveSpinner } from './spinners.js';
import { VFX, VFX_GROUPS, buildVfx } from './vfx.js';
import { FRAME_DEVICES, applyFrame, frameDialog, screenDevice } from './frame.js';

const MODULE = 'customSplash';
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i;
const GIF_RE = /\.gif(\?.*)?$/i;
const SLIDE_FADE_MS = 1500;

/** Phones, tablets and data-saver: lighter video, fewer particles. */
const SAVE_DATA = Boolean(navigator.connection?.saveData);
const LITE = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches || SAVE_DATA;
const LITE_VFX_DENSITY = 0.45;
/** Up to this many effects run at full density; past it each one thins out. */
const VFX_FULL_LAYERS = 2;

/** Uploaded pictures are downscaled to this longest side (backgrounds / logos and badges). */
const MAX_SIDE_BG = 1920;
const MAX_SIDE_ICON = 1024;
const BIG_VIDEO_MB = 25;
const BIG_GIF_MB = 8;
/** A file is held in memory several times on its way up, which a phone tab may not survive. */
const PHONE_UPLOAD_MAX_MB = 100;
/** Longest side of the light copy shown in tiles and while a background loads. */
const THUMB_SIDE = 320;

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
    themeKeep: false, // leave a theme's own decorations on the splash alone
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
const PRESET_KEYS = Object.keys(defaults).filter(k => !['enabled', 'skipCrop', 'themeKeep'].includes(k));

function snapshot(src) {
    return structuredClone(Object.fromEntries(PRESET_KEYS.map(k => [k, src[k]])));
}

/** A look as a string, to tell whether two looks differ. */
const lookKey = src => JSON.stringify(PRESET_KEYS.map(k => src[k]));

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
const isMoving = url => isVideo(url) || GIF_RE.test(url);

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
        if (still) el.loading = 'lazy';
        else el.fetchPriority = 'high';
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
 * otherwise, for a heavy video or GIF, a still frame cut from it (see ensurePoster).
 */
function bgVideoUrl(s, small = false) {
    // The settings mini preview is ~250px wide: the light video is plenty there.
    if (!LITE) return small && s.bgUrlMobile ? s.bgUrlMobile : s.bgUrl;
    const poster = s.posters?.[s.bgUrl];
    if (SAVE_DATA && poster?.url) return poster.url;
    if (s.bgUrlMobile) return s.bgUrlMobile;
    return poster?.url && poster.mb > LITE_VIDEO_MAX_MB ? poster.url : s.bgUrl;
}

/** WebP where the browser can write it (Safari cannot), otherwise JPEG unless transparency matters. */
async function encodeCanvas(canvas, quality, { alpha = false } = {}) {
    const encode = type => new Promise(resolve => canvas.toBlob(resolve, type, quality));
    const webp = await encode('image/webp');
    return webp?.type === 'image/webp' || alpha ? webp : encode('image/jpeg');
}

const blobExt = blob => ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' })[blob.type] ?? 'bin';

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            const url = String(r.result);
            resolve(url.slice(url.indexOf(',') + 1));
        };
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

/** Something a canvas can draw: a picture, or a video a third of the way in. */
async function loadStill(src, video) {
    if (!video) {
        const img = new Image();
        img.src = src;
        await img.decode();
        return { el: img, w: img.naturalWidth, h: img.naturalHeight, done() {} };
    }
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.src = src;
    const done = () => {
        el.removeAttribute('src');
        el.load();
    };
    try {
        await new Promise((resolve, reject) => {
            el.onloadeddata = resolve;
            el.onerror = reject;
            setTimeout(() => reject(new Error('poster timeout')), 30000);
        });
        // Intros tend to open dark; a third in usually shows the actual scene.
        el.currentTime = (el.duration || 3) * 0.3;
        await new Promise((resolve, reject) => {
            el.onseeked = resolve;
            setTimeout(() => reject(new Error('seek timeout')), 15000);
        });
    } catch (e) {
        done();
        throw e;
    }
    return { el, w: el.videoWidth, h: el.videoHeight, done };
}

async function uploadStill({ el, w, h }, name, side, quality) {
    const scale = Math.min(1, side / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
    const blob = await encodeCanvas(canvas, quality);
    return uploadData(`${name}.${blobExt(blob)}`, await blobToBase64(blob));
}

/** Files we uploaded ourselves: the only ones the clean-up button may ever delete. */
function rememberUpload(s, url) {
    s.uploads ??= [];
    if (url && !s.uploads.includes(url)) s.uploads.push(url);
}

const sameSite = url => {
    try {
        return new URL(url, location.href).origin === location.origin;
    } catch {
        return false;
    }
};

const posterJobs = new Map();
/** URLs that could not be processed this session: no point asking again on every edit. */
const posterSkip = new Set();
/** One at a time: these jobs read whole files and must not fight the app for the network. */
let posterQueue = Promise.resolve();

/**
 * Prepares what stands in for a background: a light copy for tiles and for the moment it
 * loads, plus, for videos and GIFs, a full-size still that phones use instead of heavy files.
 * Runs once per file, in the background.
 * @param {object} s
 * @param {string} url the background
 * @param {object} [o]
 * @param {File} [o.file] the file just uploaded: nothing has to be fetched back
 * @param {string} [o.light] the light video, a much cheaper source than the main one
 */
function ensurePoster(s, url, { file = null, light = '' } = {}) {
    const known = s.posters?.[url];
    if (!url || !sameSite(url) || known?.thumb || posterJobs.has(url) || posterSkip.has(url)) return;
    // Cutting a still out of a server video costs a phone real traffic: a computer will do it.
    if (LITE && !file && !known?.url && isVideo(light || url)) return;
    const work = async () => {
        const entry = { mb: known?.mb ?? 0, url: known?.url ?? '', thumb: '' };
        if (file) {
            entry.mb = Math.round(file.size / 1024 / 1024 * 10) / 10;
        } else if (isMoving(url) && !entry.mb) {
            const head = await fetch(url, { method: 'HEAD' });
            const length = head.ok ? head.headers.get('content-length') : null;
            // A missing file (a URL still being typed) or a server that hides the size: nothing to record.
            if (!length) throw new Error(`no size (${head.status})`);
            entry.mb = Math.round(Number(length) / 1024 / 1024 * 10) / 10;
        }
        const local = file ? URL.createObjectURL(file) : '';
        try {
            const source = local || entry.url || light || url;
            const still = await loadStill(source, file ? file.type.startsWith('video/') : isVideo(source));
            try {
                const base = url.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '');
                if (isMoving(url) && !entry.url) entry.url = await uploadStill(still, `${base}-poster`, MAX_SIDE_BG, 0.85);
                entry.thumb = await uploadStill(still, `${base}-thumb`, THUMB_SIDE, 0.7);
            } finally {
                still.done();
            }
        } finally {
            if (local) URL.revokeObjectURL(local);
        }
        s.posters ??= {};
        s.posters[url] = entry;
        rememberUpload(s, entry.url);
        rememberUpload(s, entry.thumb);
        // A background job, not a user edit: patch only this entry into the settings file.
        // A full save() from a tab opened earlier would stamp its stale builds as newest.
        saveSettingsDebounced();
        await patchStore(stored => {
            stored.posters ??= {};
            stored.posters[url] = entry;
            stored.uploads = s.uploads;
        });
    };
    const job = posterQueue.then(work).catch(e => {
        posterSkip.add(url);
        console.warn('[SLAYintro] stand-in not prepared for', url, e);
    }).finally(() => posterJobs.delete(url));
    posterQueue = job;
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
    const standIn = standInFor(s, frameKey, url, media);
    if (!frame && !standIn) return media;
    const wrap = document.createElement('div');
    wrap.className = 'cs-frame';
    wrap.append(media);
    if (standIn) wrap.append(standIn);
    if (frame) applyFrame(wrap, frame);
    return wrap;
}

/**
 * Covers a background until it is on screen, then fades out. If a video never starts
 * (iPhone in Low Power Mode blocks autoplay) the still simply stays.
 */
function standInFor(s, key, url, media) {
    const known = s.posters?.[key];
    const src = known?.url || known?.thumb;
    if (!src || src === url) return null;
    const img = document.createElement('img');
    img.className = 'cs-still' + (known.url ? '' : ' cs-still-soft');
    img.alt = '';
    img.src = src;
    media.addEventListener(isVideo(url) ? 'playing' : 'load', () => {
        img.classList.add('cs-still-out');
        setTimeout(() => img.remove(), 700);
    }, { once: true });
    return img;
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
        const stillForVideo = isMoving(s.bgUrl) && !isMoving(url);
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
    // Only the slide on screen plays: a video waiting its turn or already gone stays paused.
    const hold = slide => slide.querySelector('video')?.pause();
    load(els[0]);
    els[0].classList.add('cs-on');

    if (els.length > 1) {
        load(els[1]);
        hold(els[1]);
        let i = 0;
        life.interval(() => {
            if (!bg.isConnected) return life.release();
            const prev = els[i];
            i = (i + 1) % els.length;
            prev.classList.remove('cs-on');
            prev.classList.add('cs-leaving');
            life.timeout(() => {
                prev.classList.remove('cs-leaving');
                if (!prev.classList.contains('cs-on')) hold(prev);
            }, SLIDE_FADE_MS);
            els[i].classList.add('cs-on');
            els[i].querySelector('video')?.play?.().catch(() => {});
            const next = els[(i + 1) % els.length];
            load(next);
            if (next !== prev) hold(next);
        }, seconds * 1000);
    }
    return bg;
}

function tipList(s) {
    return s.tips.split('\n').map(x => x.trim()).filter(Boolean);
}

/** The numbers a stage reads from CSS, so sliders can change them on a live preview. */
function stageVars(el, s) {
    el.style.setProperty('--cs-dim', String(s.bgDim / 100));
    el.style.setProperty('--cs-icon-size', `${s.iconSize}px`);
    el.style.setProperty('--cs-spin-scale', String((Number(s.spinnerScale) || 100) / 100));
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
    if (s.themeKeep) el.classList.add('cs-theme-keep');
    stageVars(el, s);

    const bg = buildBackground(s, life, small, device);
    if (bg) {
        el.prepend(bg);
        el.classList.add('cs-has-bg');
    }

    // Effect layers keep the order they were picked in: the first one sits lowest.
    let anchor = bg;
    const density = (LITE ? LITE_VFX_DENSITY : 1) * Math.min(1, VFX_FULL_LAYERS / s.vfxList.length);
    for (const kind of s.vfxList) {
        const layer = buildVfx(kind, s.vfxAmt[kind] ?? VFX_DEFAULT_AMT, density);
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
        // Two identical animations in turn: a new name restarts it without forcing a layout.
        let flip = false;
        const show = () => {
            tip.textContent = tips[i++ % tips.length];
            flip = !flip;
            tip.classList.toggle('cs-tip-in', flip);
            tip.classList.toggle('cs-tip-in2', !flip);
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
/** How long the splash waits for the settings file before going with what it has. */
const STORE_WAIT_MS = 500;
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
 * Downscales a still picture to maxSide and re-encodes it, as WebP where the browser can.
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
    const blob = await encodeCanvas(canvas, 0.86, { alpha: file.type !== 'image/jpeg' });
    return blob && blob.size < file.size ? blob : null;
}

async function uploadFile(file, maxSide = MAX_SIDE_BG) {
    let blob = file;
    let ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const shrunk = await shrinkImage(file, maxSide).catch(() => null);
    if (shrunk) {
        blob = shrunk;
        ext = blobExt(shrunk);
    }
    const mb = Math.round(file.size / 1024 / 1024);
    if (file.type.startsWith('video/') && mb > BIG_VIDEO_MB) {
        toastr.warning(`Видео весит ${mb} МБ — на телефонах экран загрузки будет тормозить. Лучше сжать до 1080p или указать лёгкую версию для телефона.`, '', { timeOut: 10000 });
    }
    if (file.type === 'image/gif' && mb > BIG_GIF_MB) {
        toastr.warning(`GIF весит ${mb} МБ. Такие файлы тяжелее видео: лучше перегнать его в mp4.`, '', { timeOut: 10000 });
    }
    if (LITE && mb > PHONE_UPLOAD_MAX_MB) {
        toastr.warning(`Файл на ${mb} МБ может не загрузиться с телефона: вкладке не хватит памяти. Надёжнее загрузить его с компьютера.`, '', { timeOut: 10000 });
    }
    const name = `splash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const url = await uploadData(name, await blobToBase64(blob));
    rememberUpload(settings(), url);
    return url;
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
        <button type="button" class="menu_button cs-icon-btn" id="cs_preset_new" title="Новая сборка из текущего вида"><i class="fa-solid fa-plus"></i></button>
        <button type="button" class="menu_button cs-icon-btn" id="cs_preset_save"><i class="fa-solid fa-floppy-disk"></i></button>
        <button type="button" class="menu_button cs-icon-btn" id="cs_preset_delete" title="Удалить сборку"><i class="fa-solid fa-trash-can"></i></button>
      </div>
      <div class="cs-hint" id="cs_preset_hint" hidden></div>

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

      <label class="checkbox_label cs-theme-keep-opt"><input type="checkbox" data-cs-key="themeKeep"><span>Не трогать оформление темы на экране загрузки</span></label>
      <div class="cs-hint">Некоторые темы рисуют свою картинку на значке загрузки. По умолчанию расширение её убирает, с галочкой оставит.</div>
      <div class="cs-hint cs-foot">Первые мгновения после запуска таверна показывает свой экран, потом подменяется на твой.</div>
      <button type="button" class="menu_button cs-clean" id="cs_cleanup"><i class="fa-solid fa-broom"></i><span>Убрать неиспользуемые файлы</span></button>
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
    // Badge tiles are drawn on the first visit to their tab. Plumbob and custom depend on
    // settings, so they are redrawn on change. A video badge stays on its first frame here:
    // a tile would otherwise keep decoding it unseen for the whole session.
    let spinTilesBuilt = false;
    const renderSpinTiles = (only = null) => {
        if (!spinTilesBuilt) return;
        root.querySelectorAll('.cs-spinpick .cs-spin').forEach(el => {
            if (only && !only.includes(el.dataset.kind)) return;
            applySpinner(el, el.dataset.kind, s);
            el.querySelectorAll('video').forEach(v => {
                v.removeAttribute('autoplay');
                v.pause();
            });
        });
    };
    const buildSpinTiles = () => {
        if (spinTilesBuilt) return;
        spinTilesBuilt = true;
        renderSpinTiles();
    };

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

    // ---- generic bindings ----
    // Edits change the current look, which is what the splash shows. A build only changes
    // when the floppy is pressed. These keys are plain CSS numbers: no need to rebuild.
    const LIVE_KEYS = ['bgDim', 'iconSize', 'spinnerScale'];
    const TILE_KEYS = ['plumbobColor', 'spinnerUrl', 'spinnerAnim'];
    let stillTimer = null;
    const stillsFor = look => {
        ensurePoster(s, look.bgUrl, { light: look.bgUrlMobile });
        (look.slides ?? []).forEach(url => ensurePoster(s, url));
    };
    const changed = key => {
        sync();
        renderFrameState();
        if (!key || TILE_KEYS.includes(key)) renderSpinTiles(['plumbob', 'custom']);
        if (LIVE_KEYS.includes(key) && !miniDirty && mini.firstElementChild) stageVars(mini.firstElementChild, s);
        else scheduleMini();
        renderDirty();
        save();
        // Waits for the typing to stop: a half-typed URL is not a file.
        clearTimeout(stillTimer);
        stillTimer = setTimeout(() => stillsFor(s), 1500);
    };

    const refreshers = [];
    root.querySelectorAll('input[data-cs-key], textarea[data-cs-key], select[data-cs-key]').forEach(el => {
        const key = el.dataset.csKey;
        const prop = el.type === 'checkbox' ? 'checked' : 'value';
        const num = 'num' in el.dataset;
        const refresh = () => { el[prop] = s[key]; };
        refresh();
        refreshers.push(refresh);
        // Text fields update the preview while typing, not only on blur.
        const live = el.type === 'range' || el.type === 'text' || el.tagName === 'TEXTAREA';
        el.addEventListener(live ? 'input' : 'change', () => {
            s[key] = num ? Number(el[prop]) : el[prop];
            changed(key);
        });
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
            changed(key);
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
        if (tab === 'badge') buildSpinTiles();
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
                renderDirty();
                save();
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
            ...s, bgMode: 'custom', bgUrl: url, bgUrlMobile: '', bgAnim: 'none', vfxList: [], tips: '', posters: {},
            frames: { [url]: { [device]: { px: 50, py: 50, z: 1 } } },
        };
        const life = decorate(stage, look, { force: true, small: true, device });
        // The dialog already plays this file big: a second moving copy only costs a decoder.
        stage.querySelectorAll('video').forEach(v => v.addEventListener('playing', () => v.pause(), { once: true }));
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
    let panelOpened = false;
    const renderSlides = () => {
        // Hidden tiles still download their pictures, so nothing is drawn until the panel is seen.
        if (!panelOpened) return;
        slidesBox.replaceChildren();
        s.slides.forEach((url, i) => {
            const tile = document.createElement('div');
            tile.className = 'cs-slide-tile';
            tile.title = url;
            const media = mediaElement(s.posters?.[url]?.thumb || url, 'cs-slide-thumb', { still: true });
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
            if (['bgUrl', 'slides'].includes(target)) urls.forEach((url, i) => ensurePoster(s, url, { file: files[i] }));
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
    const activeBuild = () => (s.presets[s.activePreset] ? s.activePreset : '');
    /** A build as the look it gives once applied: older builds lack newer keys. */
    const buildKey = name => {
        const look = { ...snapshot(defaults), ...structuredClone(s.presets[name]) };
        migrateVfx(look);
        return lookKey(look);
    };
    // The look nothing needs saving for: the selected build, or the look as it was left.
    let savedKey = activeBuild() ? buildKey(activeBuild()) : lookKey(s);
    const isDirty = () => lookKey(s) !== savedKey;

    const saveButton = root.querySelector('#cs_preset_save');
    const presetHint = root.querySelector('#cs_preset_hint');
    function renderDirty() {
        const active = activeBuild();
        const dirty = isDirty();
        saveButton.classList.toggle('cs-dirty', dirty);
        saveButton.title = active ? `Сохранить в «${active}»` : 'Сохранить как новую сборку';
        presetHint.hidden = !dirty;
        presetHint.textContent = active
            ? `Правки не сохранены в «${active}». Заставка уже такая, сборка пока нет.`
            : 'Этот вид не сохранён в сборку.';
    }

    const renderPresets = () => {
        const $sel = $('#cs_preset').empty();
        $sel.append($('<option>').val('').text('— без сборки —'));
        for (const name of Object.keys(s.presets).sort((a, b) => a.localeCompare(b))) {
            $sel.append($('<option>').val(name).text(name));
        }
        $sel.val(activeBuild());
        renderDirty();
    };
    renderPresets();

    const storeBuild = name => {
        pruneFrames();
        s.presets[name] = snapshot(s);
        s.activePreset = name;
        savedKey = lookKey(s);
        renderPresets();
        save();
        toastr.success(`Сборка «${name}» сохранена`);
    };

    /** @returns {Promise<boolean>} whether a build was made */
    const saveAsNew = async () => {
        // Cancel gives false, the X gives null: only a typed string is a name.
        const typed = await callGenericPopup('Название новой сборки:', POPUP_TYPE.INPUT, '');
        const name = typeof typed === 'string' ? typed.trim() : '';
        if (!name) return false;
        if (s.presets[name] && name !== s.activePreset) {
            const ok = await callGenericPopup(`Сборка «${name}» уже есть. Перезаписать?`, POPUP_TYPE.CONFIRM);
            if (!ok) return false;
        }
        storeBuild(name);
        return true;
    };

    $('#cs_preset').on('change', async function () {
        const name = String($(this).val());
        const from = activeBuild();
        if (name === from) return;
        if (isDirty()) {
            const answer = await callGenericPopup(
                from ? `В сборке «${from}» есть несохранённые правки. Сохранить их?` : 'Этот вид не сохранён в сборку. Сохранить?',
                POPUP_TYPE.CONFIRM, '', { okButton: 'Сохранить', cancelButton: 'Не сохранять' },
            );
            const stay = () => $('#cs_preset').val(from);
            if (answer === POPUP_RESULT.CANCELLED) return stay();
            if (answer === POPUP_RESULT.AFFIRMATIVE) {
                if (from) storeBuild(from);
                else if (!await saveAsNew()) return stay();
            }
        }
        s.activePreset = name;
        if (name) {
            // Older builds may lack newer keys: start from defaults so nothing leaks from the previous look.
            Object.assign(s, snapshot(defaults), structuredClone(s.presets[name]));
            migrateVfx(s);
            refreshers.forEach(fn => fn());
            renderSlides();
            renderVfx();
        }
        savedKey = lookKey(s);
        renderPresets();
        changed();
    });

    $('#cs_preset_new').on('click', saveAsNew);
    $(saveButton).on('click', () => {
        const active = activeBuild();
        if (active) storeBuild(active);
        else saveAsNew();
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
        savedKey = lookKey(s);
        renderPresets();
        save();
        toastr.success(`Сборка «${name}» удалена`);
    });

    // ---- clean-up: only files this extension uploaded, and nothing any look still uses ----
    root.querySelector('#cs_cleanup').addEventListener('click', async () => {
        const sources = new Set();
        for (const look of [s, ...Object.values(s.presets)]) {
            [look.bgUrl, look.bgUrlMobile, look.iconUrl, look.spinnerUrl, ...(look.slides ?? [])].forEach(url => url && sources.add(url));
        }
        const used = new Set(sources);
        for (const url of sources) [s.posters?.[url]?.url, s.posters?.[url]?.thumb].forEach(file => file && used.add(file));
        const spare = (s.uploads ?? []).filter(url => !used.has(url));
        if (!spare.length) return toastr.info('Лишних файлов нет');
        const ok = await callGenericPopup(`Удалить файлов: ${spare.length}? Их нет ни в текущем виде, ни в сборках. Вернуть их будет нельзя.`, POPUP_TYPE.CONFIRM);
        if (!ok) return;
        const gone = [];
        for (const url of spare) {
            const res = await fetch('/api/files/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ path: url.replace(/^\/+/, '') }),
            }).catch(() => null);
            if (res?.ok || res?.status === 404) gone.push(url);
        }
        s.uploads = s.uploads.filter(url => !gone.includes(url));
        for (const url of gone) delete s.posters?.[url];
        save();
        toastr.success(`Удалено файлов: ${gone.length}`);
    });

    // Tiles, thumbnails and stand-ins wait until someone actually opens the panel.
    new IntersectionObserver((entries, seen) => {
        if (!entries.some(e => e.isIntersecting)) return;
        seen.disconnect();
        panelOpened = true;
        renderSlides();
        [s, ...Object.values(s.presets)].forEach(stillsFor);
    }).observe(root.querySelector('.cs-body'));

    root.querySelector('#cs_preview').addEventListener('click', preview);
    sync();
}

// The newest settings decide the look, but a slow server must not cost the splash its moment.
const storeRead = loadStore();
await Promise.race([storeRead, new Promise(resolve => setTimeout(resolve, STORE_WAIT_MS))]);
hookStartup();
// The settings panel is not needed to show the splash: build it once the app is ready so it
// doesn't compete with startup. #preloader exists only until the first splash closes.
const startPanel = () => storeRead.then(bindSettings);
if (document.getElementById('preloader')) {
    eventSource.once(event_types.APP_READY, startPanel);
} else {
    jQuery(startPanel);
}
