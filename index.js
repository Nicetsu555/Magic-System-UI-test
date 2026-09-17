function init() {

    console.log('[Dashboard] Initializing...');

    // Prevent duplicate initialization
    if (document.getElementById('dashboard-menu-item')) {
        return;
    }

    // =====================================================
    // WAIT FOR SILLYTAVERN CHAT OPTIONS
    // =====================================================

    const waitForOptions = setInterval(() => {

        const optionsMenu = document.querySelector('#options');

        if (!optionsMenu) {
            return;
        }

        // SillyTavern keeps its actual menu rows inside
        // "#options > .options-content". Appending straight to
        // "#options" dropped the row OUTSIDE that list, which is why
        // "Dashboard" looked detached from everything above it.
        const optionsList =
            optionsMenu.querySelector('.options-content') || optionsMenu;

        clearInterval(waitForOptions);

        createDashboard(optionsList);

    }, 500);
}


// =========================================================
// SILLYTAVERN USER HELPERS
// =========================================================

// Namespace used to persist everything the dashboard saves.
const DASHBOARD_EXT_KEY = 'dashboardWidget';

// =========================================================
// PER-CHAT / PER-CHARACTER STORAGE
// =========================================================
// Nothing is global, and nothing lives inside the chat itself any
// more either. Everything the dashboard saves is kept in
// SillyTavern's own extensionSettings (a separate part of
// settings.json, entirely apart from any chat file), organized by
// chat id so each chat still gets its own clean dashboard:
//
//   extensionSettings.dashboardWidget = {
//       "<chat id>": {
//           profiles: {
//               "Yuki.png": { quote, quoteEn, status },
//               "Ren.png":  { quote, quoteEn, status }
//           },
//           threads: { ... }
//       }
//   }
//
// Starting a new chat still gives you a clean dashboard, and
// deleting a chat still takes its dashboard slot with it — it's
// just stored next to the chat instead of inside it. Inside one
// chat you can still flip between any character in your library
// from the select screen — each one keeps its own card.

// Whoever's dashboard is on screen right now.
// { id, name, avatar } — id is the avatar filename (unique per card).
let dashboardActiveProfile = null;

// Avatar URLs that have successfully loaded at least once this
// session. Rebuilding the picker grid (every open, every keystroke
// in search) used to throw away the old <img> tags and start every
// fetch/decode from zero, so previously-loaded pictures would flash
// back to a broken-image glyph for a frame before popping back in.
// Anything in this set is applied straight away, no loading gap.
const dashboardLoadedAvatars = new Set();

// Only used if SillyTavern doesn't hand us chat metadata for some
// reason. Keyed by chat id so it still behaves per-chat in memory.
const dashboardMemoryStore = {};

function getCurrentChatId() {

    const context = getDashboardContext();

    if (!context) {
        return '__nochat__';
    }

    try {

        if (typeof context.getCurrentChatId === 'function') {

            const id = context.getCurrentChatId();

            if (id) {
                return String(id);
            }

        }

    } catch (error) {
        // Fall through to the plain property lookups below.
    }

    return String(
        context.chatId ||
        context.groupId ||
        context.characterId ||
        '__nochat__'
    );

}

function getChatMetadata() {

    const context = getDashboardContext();

    if (!context) {
        return null;
    }

    // Property name differs slightly between SillyTavern versions.
    return context.chatMetadata || context.chat_metadata || null;

}

// =========================================================
// WHERE THE DASHBOARD'S OWN DATA ACTUALLY LIVES
// =========================================================
// Everything the dashboard saves (profile cards, phone threads,
// quotes) used to be written into chatMetadata[DASHBOARD_EXT_KEY] —
// which is the SAME object SillyTavern saves as part of the chat
// itself. That meant the dashboard's own data was physically mixed
// into your chat's data.
//
// It now lives in SillyTavern's extensionSettings instead — a
// completely separate store (its own section of settings.json,
// saved with saveSettingsDebounced()), not the chat file at all.
// It's still organized per-chat (each chat id gets its own slot),
// so switching chats/characters still shows the right card — it's
// just filed in a different drawer now, one that has nothing to do
// with the chat log itself.
function getExtensionSettingsRoot() {

    const context = getDashboardContext();

    if (!context) {
        return null;
    }

    // Property name differs slightly between SillyTavern versions.
    const settings = context.extensionSettings || context.extension_settings;

    if (!settings) {
        return null;
    }

    if (!settings[DASHBOARD_EXT_KEY] || typeof settings[DASHBOARD_EXT_KEY] !== 'object') {
        settings[DASHBOARD_EXT_KEY] = {};
    }

    return settings[DASHBOARD_EXT_KEY];

}

// One-time move for anyone upgrading from the old version: if this
// chat already has a dashboard card sitting in the old spot
// (chatMetadata) and nothing yet in the new spot, copy it over and
// remove it from the chat's own metadata so the two stop overlapping
// going forward. Safe to call every time — it's a no-op once a chat
// has already been migrated.
function migrateLegacyChatMetadataStore(chatId, settingsRoot) {

    const metadata = getChatMetadata();

    if (!metadata || !metadata[DASHBOARD_EXT_KEY]) {
        return;
    }

    if (!settingsRoot[chatId]) {

        settingsRoot[chatId] = metadata[DASHBOARD_EXT_KEY];

        console.log(
            '[Dashboard] Moved this chat\'s dashboard data out of the chat file and into extension settings.'
        );

    }

    delete metadata[DASHBOARD_EXT_KEY];

    const context = getDashboardContext();

    try {

        if (context && typeof context.saveMetadataDebounced === 'function') {
            context.saveMetadataDebounced();
        } else if (context && typeof context.saveMetadata === 'function') {
            context.saveMetadata();
        }

    } catch (error) {
        console.log('[Dashboard] Could not clean up the old chat-metadata copy', error);
    }

}

// The dashboard blob belonging to the chat that's open right now.
function getDashboardStore() {

    const chatId = getCurrentChatId();
    const settingsRoot = getExtensionSettingsRoot();

    if (settingsRoot) {

        migrateLegacyChatMetadataStore(chatId, settingsRoot);

        if (!settingsRoot[chatId] || typeof settingsRoot[chatId] !== 'object') {
            settingsRoot[chatId] = {};
        }

        const store = settingsRoot[chatId];

        if (!store.profiles) {
            store.profiles = {};
        }

        return store;

    }

    if (!dashboardMemoryStore[chatId]) {
        dashboardMemoryStore[chatId] = { profiles: {} };
    }

    return dashboardMemoryStore[chatId];

}

function getActiveProfileId() {

    if (dashboardActiveProfile && dashboardActiveProfile.id) {
        return dashboardActiveProfile.id;
    }

    return '__unassigned__';

}

function setActiveProfile(profile) {

    dashboardActiveProfile = profile || null;

}

function getActiveProfileName() {

    if (dashboardActiveProfile && dashboardActiveProfile.name) {
        return dashboardActiveProfile.name;
    }

    const context = getDashboardContext();

    return (context && context.name2) || 'Character';

}

// True once a character has been opened and saved at least once in
// THIS chat — the select screen uses it to mark visited profiles.
function hasProfileData(profileId) {

    const store = getDashboardStore();

    return Boolean(store.profiles && store.profiles[profileId]);

}

// =========================================================
// WELCOME / BOOT SCREEN — paste your hosted image links here
// =========================================================
// Paste a direct image link (e.g. from an image host) between the
// quotes. Leave empty ('') to fall back to a plain gradient / a
// plain star glyph until you have links ready.
const DASHBOARD_WELCOME_BACKGROUND_URL = 'https://files.catbox.moe/bjknck.png';
const DASHBOARD_WELCOME_STAR_URL = 'https://files.catbox.moe/9xwggq.png';

// Same idea, but for sound: paste a direct link to an audio file
// (mp3/ogg) between the quotes to use a real recording instead.
// Leave empty ('') and the welcome screen instead plays sound
// that's generated on the fly (see "GENERATED SOUND" below) — no
// files needed.
//   DASHBOARD_WELCOME_MUSIC_URL     -> background music, loops
//                                      while the welcome screen is open
//   DASHBOARD_BOOT_BUTTON_SOUND_URL -> short "tap" sound played once
//                                      when "TAP TO CONTINUE" is pressed
const DASHBOARD_WELCOME_MUSIC_URL = 'https://files.catbox.moe/rw39b9.mp3';
const DASHBOARD_BOOT_BUTTON_SOUND_URL = '';

// How loud the background music plays, from 0 (silent) to 1 (full).
// Applies to the generated pad and, if used, the hosted file.
// Kept low by default so it stays "คลอ" (in the background) rather
// than competing with anything else.
const DASHBOARD_WELCOME_MUSIC_VOLUME = 0.35;

// =========================================================
// GENERATED SOUND — WELCOME SCREEN
// =========================================================
// No audio files are required for the welcome screen: both the
// soft background pad and the "tap" sound below are synthesized
// live with the Web Audio API. If DASHBOARD_WELCOME_MUSIC_URL /
// DASHBOARD_BOOT_BUTTON_SOUND_URL above are ever filled in with
// a real hosted file instead, that file is used and the
// generated version underneath is skipped for that one.

// Shared across every open of the dashboard so we don't spin up
// a fresh audio context (and hit the browser's context limit)
// every time the welcome screen appears.
let dashboardAudioCtx = null;

// stop() handle for the ring heard while an outgoing call is
// still waiting to be answered.
let dashboardDialToneStop = null;

function getDashboardAudioContext() {

    try {

        if (!dashboardAudioCtx) {

            dashboardAudioCtx = new (
                window.AudioContext || window.webkitAudioContext
            )();

        }

        // Browsers start a fresh context "suspended" until a user
        // gesture resumes it — every call site below is already
        // inside a click handler, so this should succeed.
        if (dashboardAudioCtx.state === 'suspended') {
            dashboardAudioCtx.resume();
        }

        return dashboardAudioCtx;

    } catch (error) {

        console.log('[Dashboard] Web Audio unavailable', error);
        return null;

    }

}

// Two quick sine notes, the second a fifth above the first, each
// with a fast pluck-style envelope — a small "confirm" chime for
// the "TAP TO CONTINUE" button.
function playGeneratedTapSound() {

    const ctx = getDashboardAudioContext();

    if (!ctx) {
        return;
    }

    const now = ctx.currentTime;

    const notes = [
        { freq: 660, start: 0, length: 0.16 },
        { freq: 990, start: 0.07, length: 0.22 }
    ];

    notes.forEach((note) => {

        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = note.freq;

        gain.gain.setValueAtTime(0, now + note.start);

        gain.gain.linearRampToValueAtTime(
            0.18,
            now + note.start + 0.015
        );

        gain.gain.exponentialRampToValueAtTime(
            0.0001,
            now + note.start + note.length
        );

        oscillator.connect(gain);
        gain.connect(ctx.destination);

        oscillator.start(now + note.start);
        oscillator.stop(now + note.start + note.length + 0.05);

    });

}

// Outgoing-call "dialing" tone: a short two-tone beep pair that
// repeats a few times, like a handset ringing on the other end.
// Returns a stop() function so the ring can be cut the moment the
// other side picks up (or the call is cancelled).
function stopDashboardDialTone() {

    if (typeof dashboardDialToneStop === 'function') {

        dashboardDialToneStop();

    }

    dashboardDialToneStop = null;

}

function startGeneratedDialTone(isIncoming) {

    const ctx = getDashboardAudioContext();

    if (!ctx) {
        return function stopGeneratedDialTone() {};
    }

    const master = ctx.createGain();

    master.gain.value = 1;

    // A gentle low-pass takes the hard edge off the tone so it
    // reads as a soft chime rather than a telephone buzzer.
    const filter = ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.6;

    filter.connect(master);
    master.connect(ctx.destination);

    // Outgoing: a calm two-note fall. Incoming: the same notes
    // rising, so the two are easy to tell apart by ear.
    const notes = isIncoming
        ? [
            { freq: 587.33, start: 0, length: 0.75 },
            { freq: 783.99, start: 0.34, length: 0.95 }
        ]
        : [
            { freq: 523.25, start: 0, length: 0.8 },
            { freq: 392.0, start: 0.36, length: 1.0 }
        ];

    const peak = isIncoming ? 0.075 : 0.06;

    let stopped = false;
    let timer = null;

    const ringOnce = () => {

        if (stopped) {
            return;
        }

        const now = ctx.currentTime;

        notes.forEach((note) => {

            // Sine fundamental plus a very quiet fifth above gives
            // the chime a little warmth without any harshness.
            [
                { ratio: 1, level: 1 },
                { ratio: 1.5, level: 0.22 }
            ].forEach((layer) => {

                const oscillator = ctx.createOscillator();
                const gain = ctx.createGain();

                oscillator.type = 'sine';
                oscillator.frequency.value = note.freq * layer.ratio;

                const at = now + note.start;

                gain.gain.setValueAtTime(0, at);

                // Slow attack, long tail — nothing clicks on or off.
                gain.gain.linearRampToValueAtTime(
                    peak * layer.level,
                    at + 0.16
                );

                gain.gain.exponentialRampToValueAtTime(
                    0.0001,
                    at + note.length
                );

                oscillator.connect(gain);
                gain.connect(filter);

                oscillator.start(at);
                oscillator.stop(at + note.length + 0.1);

            });

        });

    };

    ringOnce();

    timer = setInterval(ringOnce, isIncoming ? 3400 : 3800);

    return function stopGeneratedDialTone() {

        if (stopped) {
            return;
        }

        stopped = true;

        if (timer) {
            clearInterval(timer);
            timer = null;
        }

        try {

            master.gain.cancelScheduledValues(ctx.currentTime);

            master.gain.setValueAtTime(
                master.gain.value,
                ctx.currentTime
            );

            master.gain.exponentialRampToValueAtTime(
                0.0001,
                ctx.currentTime + 0.25
            );

            setTimeout(() => master.disconnect(), 500);

        } catch (error) {

            console.log('[Dashboard] Dial tone stop failed', error);

        }

    };

}

// A soft, slowly breathing pad chord plus the occasional high
// "sparkle" note, meant to sit quietly under the pastel welcome
// art. Returns a stop() function that fades everything out and
// releases the nodes — call it once, when leaving the screen.
function startGeneratedBootMusic() {

    const ctx = getDashboardAudioContext();

    if (!ctx) {
        return function stopGeneratedBootMusic() {};
    }

    const master = ctx.createGain();

    master.gain.setValueAtTime(0, ctx.currentTime);

    master.gain.linearRampToValueAtTime(
        DASHBOARD_WELCOME_MUSIC_VOLUME,
        ctx.currentTime + 1.5
    );

    master.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.connect(master);

    // A soft, slightly open chord (A3 D4 E4 A4).
    const padFrequencies = [220, 293.66, 329.63, 440];
    const padOscillators = [];

    padFrequencies.forEach((freq, index) => {

        const oscillator = ctx.createOscillator();
        const oscGain = ctx.createGain();

        oscillator.type = 'triangle';
        oscillator.frequency.value = freq;
        oscillator.detune.value = (index % 2 === 0) ? -4 : 4;

        oscGain.gain.value = 0.18;

        oscillator.connect(oscGain);
        oscGain.connect(filter);
        oscillator.start();

        padOscillators.push(oscillator);

    });

    // Slow LFO breathing the filter open and closed so the pad
    // doesn't sit static.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();

    lfo.frequency.value = 0.08;
    lfoGain.gain.value = 300;

    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    // Occasional high sparkle notes from a pentatonic scale, at
    // loosely randomised intervals.
    const sparkleScale = [880, 987.77, 1174.66, 1318.51, 1567.98];

    let sparkleTimeoutId = null;
    let stopped = false;

    function scheduleSparkle() {

        if (stopped) {
            return;
        }

        const delay = 2200 + Math.random() * 3200;

        sparkleTimeoutId = setTimeout(() => {

            if (stopped) {
                return;
            }

            const freq = sparkleScale[
                Math.floor(Math.random() * sparkleScale.length)
            ];

            const now = ctx.currentTime;

            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();

            oscillator.type = 'sine';
            oscillator.frequency.value = freq;

            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.05, now + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);

            oscillator.connect(gain);
            gain.connect(master);

            oscillator.start(now);
            oscillator.stop(now + 1.5);

            scheduleSparkle();

        }, delay);

    }

    scheduleSparkle();

    return function stopGeneratedBootMusic() {

        stopped = true;

        if (sparkleTimeoutId) {
            clearTimeout(sparkleTimeoutId);
        }

        const now = ctx.currentTime;

        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0, now + 0.6);

        setTimeout(() => {

            padOscillators.forEach((oscillator) => {
                try {
                    oscillator.stop();
                } catch (error) {
                    // Already stopped — ignore.
                }
            });

            try {
                lfo.stop();
            } catch (error) {
                // Already stopped — ignore.
            }

        }, 700);

    };

}

function getDashboardContext() {

    try {

        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {

            return SillyTavern.getContext();

        }

    } catch (error) {

        console.log('[Dashboard] Could not get SillyTavern context', error);

    }

    return null;

}

// Gets the saved card for whoever is currently selected, inside the
// chat that's currently open. Creates defaults on first view.
function getDashboardSettings() {

    const profileId = getActiveProfileId();

    // Before anyone has been picked on the select screen, hand back a
    // throwaway card so the first paint never writes junk into the
    // chat file.
    if (profileId === '__unassigned__') {

        return {
            quote: 'ใช้ชีวิตในแบบที่ต้องการ',
            quoteEn: 'Live the life you want.',
            status: 'online'
        };

    }

    const store = getDashboardStore();

    if (!store.profiles[profileId]) {
        store.profiles[profileId] = {};
    }

    const settings = store.profiles[profileId];

    if (settings.quote === undefined) {
        settings.quote = 'ใช้ชีวิตในแบบที่ต้องการ';
    }

    if (settings.quoteEn === undefined) {
        settings.quoteEn = 'Live the life you want.';
    }

    if (settings.status === undefined) {
        settings.status = 'online';
    }

    return settings;

}

// =========================================================
// ONLINE / OFFLINE STATUS
// =========================================================

function getStatus() {

    const settings = getDashboardSettings();

    return settings.status === 'offline' ? 'offline' : 'online';

}

function setStatus(status) {

    const settings = getDashboardSettings();

    settings.status = status === 'offline' ? 'offline' : 'online';

    saveDashboardSettings();

}

function getStatusLabel(status) {

    return status === 'offline'
        ? '● ออฟไลน์'
        : '● ออนไลน์';

}

// Updates every status text and every online-dot in the dashboard
// to match the currently saved status.
function refreshStatusDisplays(dashboard) {

    const status = getStatus();

    dashboard
        .querySelectorAll('[data-status-text]')
        .forEach((element) => {

            element.textContent = getStatusLabel(status);

            element.classList.toggle(
                'is-offline',
                status === 'offline'
            );

        });

    dashboard
        .querySelectorAll('.online-dot')
        .forEach((dot) => {

            dot.classList.toggle(
                'offline',
                status === 'offline'
            );

        });

}

function saveDashboardSettings() {

    const context = getDashboardContext();

    if (!context) {
        return;
    }

    try {

        // The dashboard's data now lives in extensionSettings, not
        // the chat itself — saveSettingsDebounced() is what actually
        // persists that (writes to settings.json, not the chat
        // file). saveMetadata()/saveChat() are kept as fallbacks
        // only for very old builds that don't expose
        // saveSettingsDebounced at all.
        if (typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
            return;
        }

        if (typeof context.saveMetadata === 'function') {
            context.saveMetadata();
            return;
        }

        if (typeof context.saveMetadataDebounced === 'function') {
            context.saveMetadataDebounced();
            return;
        }

        if (typeof context.saveChat === 'function') {
            context.saveChat();
        }

    } catch (error) {

        console.log('[Dashboard] Could not save settings', error);

    }

}

// Gets {{user}}'s current persona name. Falls back to "Player".
function getUserName() {

    const context = getDashboardContext();

    if (context && context.name1) {
        return context.name1;
    }

    return 'Player';

}

// Gets {{user}}'s current persona avatar URL, or null if unavailable.
// Different SillyTavern versions expose the avatar filename under
// slightly different property names, so a few are tried in order.
function getUserAvatarUrl() {

    const context = getDashboardContext();

    if (!context) {
        return null;
    }

    const avatarFile =
        context.userAvatar ||
        context.user_avatar ||
        context?.powerUserSettings?.default_persona ||
        context?.power_user?.default_persona;

    if (avatarFile) {
        return `/User Avatars/${avatarFile}`;
    }

    return null;

}

// Fills an avatar container with the user's real picture, falling back
// to the initial-letter placeholder if no persona image is available
// (or if it fails to load).
function renderUserAvatar(container, size) {

    if (!container) {
        return;
    }

    const userName = getUserName();
    const initial = userName ? userName.charAt(0).toUpperCase() : 'P';
    const avatarUrl = getUserAvatarUrl();

    container.innerHTML = '';

    // The picture/placeholder lives in its own circular, clipped
    // wrapper so the online-dot (a sibling) never gets cut off by
    // the image's rounded corners.
    const visual = document.createElement('div');

    visual.className = 'avatar-visual';

    if (avatarUrl) {

        const img = document.createElement('img');

        img.src = avatarUrl;
        img.alt = userName;
        img.className = 'avatar-image';

        img.addEventListener('error', () => {

            visual.innerHTML = `<div class="avatar-placeholder">${initial}</div>`;

        });

        visual.appendChild(img);

    } else {

        const placeholder = document.createElement('div');

        placeholder.className = 'avatar-placeholder';
        placeholder.textContent = initial;

        visual.appendChild(placeholder);

    }

    container.appendChild(visual);

    if (size === 'small') {

        const dot = document.createElement('span');

        dot.className = 'online-dot';

        dot.classList.toggle(
            'offline',
            getStatus() === 'offline'
        );

        container.appendChild(dot);

    }

}

// Refreshes every place {{user}}'s name/avatar is shown in the dashboard.
function refreshUserInfo(dashboard) {

    const userName = getUserName();

    dashboard
        .querySelectorAll('[data-user-name]')
        .forEach((element) => {
            element.textContent = userName;
        });

    dashboard
        .querySelectorAll('[data-user-avatar="small"]')
        .forEach((element) => {
            renderUserAvatar(element, 'small');
        });

    dashboard
        .querySelectorAll('[data-user-avatar="large"]')
        .forEach((element) => {
            renderUserAvatar(element, 'large');
        });

}


// =========================================================
// CREATE DASHBOARD
// =========================================================

function createDashboard(optionsMenu) {

    // =====================================================
    // MENU ITEM
    // =====================================================

    // Mirror SillyTavern's own row markup (<a class="interactable">
    // with an fa-lg icon) so the item inherits the exact same
    // padding, hover state and icon alignment as "Continue",
    // "Regenerate", etc. instead of styling itself.
    const menuItem = document.createElement('a');

    menuItem.id = 'dashboard-menu-item';

    menuItem.className = 'interactable';

    menuItem.tabIndex = 0;

    menuItem.innerHTML = `
        <i class="fa-lg fa-solid fa-chart-pie"></i>
        <span>Dashboard</span>
    `;

    optionsMenu.appendChild(menuItem);


    // =====================================================
    // DASHBOARD OVERLAY
    // =====================================================

    const dashboard = document.createElement('div');

    dashboard.id = 'dashboard-overlay';

    // Placeholder text for the very first paint only. The real values
    // are loaded per character by refreshQuoteDisplay() once a profile
    // has been picked on the select screen.
    const quoteSettings = {
        quote: 'ใช้ชีวิตในแบบที่ต้องการ',
        quoteEn: 'Live the life you want.'
    };

    dashboard.innerHTML = `

        <div class="dashboard-app">

            <!-- =========================================
                 WELCOME / BOOT SCREEN
                 ========================================= -->

            <div class="dashboard-boot" id="dashboard-boot-screen">

                <div
                    class="dashboard-boot-bg"
                    id="dashboard-boot-bg"
                ></div>

                <div class="dashboard-boot-scrim"></div>

                <!-- Hidden audio elements: sources are filled in
                     from DASHBOARD_WELCOME_MUSIC_URL /
                     DASHBOARD_BOOT_BUTTON_SOUND_URL further down,
                     right where the background image link is
                     applied. Nothing plays if those links are
                     left empty. -->
                <audio
                    id="dashboard-boot-music"
                    loop
                    preload="auto"
                ></audio>

                <audio
                    id="dashboard-boot-click-sound"
                    preload="auto"
                ></audio>

                <div class="dashboard-boot-corner dashboard-boot-corner-tr">
                    GOOD THINGS<br>AHEAD
                    <span class="dashboard-boot-corner-line"></span>
                </div>

                <div class="dashboard-boot-corner dashboard-boot-corner-bl">
                    SIMPLE<br>SAFE<br>FOR A BRIGHTER YOU
                    <span class="dashboard-boot-corner-line"></span>
                </div>

                <div class="dashboard-boot-corner dashboard-boot-corner-br">
                    YOUR WORLD<br>YOUR CONTROL
                    <span class="dashboard-boot-corner-line"></span>
                </div>

                <div class="dashboard-boot-content">

                    <div
                        class="dashboard-boot-star"
                        id="dashboard-boot-star"
                    >✦</div>

                    <h1 class="dashboard-boot-title">
                        Dashboard System
                    </h1>

                    <div class="dashboard-boot-subtitle">
                        WELCOME
                    </div>

                    <div class="dashboard-boot-divider">
                        <span></span>
                        <i>✦</i>
                        <span></span>
                    </div>

                    <div class="dashboard-boot-caption">
                        A MORE ORGANIZED TOMORROW
                    </div>

                    <button
                        type="button"
                        class="dashboard-boot-button"
                        id="dashboard-boot-continue"
                    >
                        <span class="dashboard-boot-button-label">
                            TAP TO CONTINUE
                        </span>
                        <span class="dashboard-boot-button-icon">
                            <i class="fa-solid fa-arrow-right"></i>
                        </span>
                    </button>

                </div>

            </div>


            <!-- =========================================
                 CHARACTER SELECT SCREEN
                 Sits between the welcome screen and the dashboard.
                 Lists every character in the library; whichever one
                 you pick becomes the profile the dashboard reads
                 and writes for this chat.
                 ========================================= -->

            <div class="dashboard-picker" id="dashboard-picker-screen">

                <div
                    class="dashboard-picker-bg"
                    id="dashboard-picker-bg"
                ></div>

                <div class="dashboard-picker-scrim"></div>

                <div class="dashboard-picker-inner">

                    <div class="dashboard-picker-head">

                        <div class="dashboard-picker-eyebrow">
                            SELECT A PROFILE
                        </div>

                        <h2 class="dashboard-picker-title">
                            กำลังดูแดชบอร์ดของใคร
                        </h2>

                        <div
                            class="dashboard-picker-scope"
                            id="dashboard-picker-scope"
                        ></div>

                    </div>

                    <div class="dashboard-picker-search">

                        <i class="fa-solid fa-magnifying-glass"></i>

                        <input
                            type="text"
                            id="dashboard-picker-search-input"
                            placeholder="ค้นหาตัวละคร..."
                            autocomplete="off"
                            spellcheck="false"
                        >

                    </div>

                    <div
                        class="dashboard-picker-grid"
                        id="dashboard-picker-grid"
                    ></div>

                    <div
                        class="dashboard-picker-empty"
                        id="dashboard-picker-empty"
                    >
                        ไม่พบตัวละครที่ตรงกับคำค้น
                    </div>

                </div>

            </div>


            <!-- =========================================
                 TOP BAR
                 ========================================= -->

            <header class="dashboard-topbar">

                <button
                    type="button"
                    class="dashboard-brand"
                    id="dashboard-brand-button"
                    title="เปลี่ยนตัวละคร"
                >

                    <div class="dashboard-logo">
                        ✦
                    </div>

                    <div>

                        <div
                            class="dashboard-title"
                            data-profile-name
                        >
                            DASHBOARD
                        </div>

                        <div class="dashboard-subtitle">
                            แตะเพื่อเปลี่ยนตัวละคร
                        </div>

                    </div>

                </button>


                <!-- PAGE SELECT -->

                <div class="dashboard-selector">

                    <button
                        id="dashboard-selector-button"
                        class="dashboard-selector-button"
                        type="button"
                    >

                        <span
                            id="dashboard-current-icon"
                            class="dashboard-current-icon"
                        >
                            <i class="fa-solid fa-house"></i>
                        </span>

                        <span>

                            <strong id="dashboard-current-title">
                                หน้าหลัก
                            </strong>

                            <small id="dashboard-current-subtitle">
                                Home
                            </small>

                        </span>

                        <i class="fa-solid fa-chevron-down"></i>

                    </button>


                    <div
                        id="dashboard-selector-menu"
                        class="dashboard-selector-menu"
                    >

                        <button
                            data-page="home"
                            data-title="หน้าหลัก"
                            data-subtitle="Home"
                            data-icon="fa-house"
                            class="dashboard-select-item active"
                        >
                            <i class="fa-solid fa-house"></i>
                            <span>
                                หน้าหลัก
                                <small>Home</small>
                            </span>
                        </button>


                        <button
                            data-page="account"
                            data-title="ACCOUNT"
                            data-subtitle="Account"
                            data-icon="fa-user"
                            class="dashboard-select-item"
                        >
                            <i class="fa-solid fa-user"></i>
                            <span>
                                ACCOUNT
                                <small>Account</small>
                            </span>
                        </button>


                        <button
                            data-page="bank"
                            data-title="ธนาคาร"
                            data-subtitle="Bank"
                            data-icon="fa-wallet"
                            class="dashboard-select-item"
                        >
                            <i class="fa-solid fa-wallet"></i>
                            <span>
                                ธนาคาร
                                <small>Bank</small>
                            </span>
                        </button>


                        <button
                            data-page="messages"
                            data-title="ข้อความ"
                            data-subtitle="Messages"
                            data-icon="fa-message"
                            class="dashboard-select-item"
                        >
                            <i class="fa-solid fa-message"></i>
                            <span>
                                ข้อความ
                                <small>Messages</small>
                            </span>
                        </button>


                        <button
                            data-page="schedule"
                            data-title="ตารางงาน"
                            data-subtitle="Schedule"
                            data-icon="fa-calendar"
                            class="dashboard-select-item"
                        >
                            <i class="fa-solid fa-calendar"></i>
                            <span>
                                ตารางงาน
                                <small>Schedule</small>
                            </span>
                        </button>


                        <button
                            data-page="notes"
                            data-title="บันทึก"
                            data-subtitle="Notes"
                            data-icon="fa-note-sticky"
                            class="dashboard-select-item"
                        >
                            <i class="fa-solid fa-note-sticky"></i>
                            <span>
                                บันทึก
                                <small>Notes</small>
                            </span>
                        </button>


                        <button
                            data-page="files"
                            data-title="ไฟล์ส่วนตัว"
                            data-subtitle="Files"
                            data-icon="fa-folder"
                            class="dashboard-select-item"
                        >
                            <i class="fa-solid fa-folder"></i>
                            <span>
                                ไฟล์ส่วนตัว
                                <small>Files</small>
                            </span>
                        </button>


                        <button
                            data-page="settings"
                            data-title="ตั้งค่า"
                            data-subtitle="Settings"
                            data-icon="fa-gear"
                            class="dashboard-select-item"
                        >
                            <i class="fa-solid fa-gear"></i>
                            <span>
                                ตั้งค่า
                                <small>Settings</small>
                            </span>
                        </button>

                    </div>

                </div>


                <!-- RIGHT SIDE -->

                <div class="dashboard-top-actions">

                    <button
                        class="dashboard-icon-button"
                        title="Notifications"
                    >
                        <i class="fa-solid fa-bell"></i>
                        <span class="notification-dot"></span>
                    </button>

                    <div class="dashboard-time">
                        <small id="dashboard-date">
                            14 Sep 2026
                        </small>

                        <strong id="dashboard-clock">
                            03:07
                        </strong>
                    </div>

                    <button
                        id="dashboard-close"
                        class="dashboard-close"
                        type="button"
                    >
                        ×
                    </button>

                </div>

            </header>


            <!-- =========================================
                 PAGE AREA
                 ========================================= -->

            <main
                id="dashboard-pages"
                class="dashboard-pages"
            >


                <!-- =====================================
                     HOME
                     ===================================== -->

                <section
                    class="dashboard-page active"
                    data-page-content="home"
                >

                    <div class="dashboard-welcome">

                        <div>

                            <span>
                                Good morning,
                            </span>

                            <h1 data-user-name>
                                Player
                            </h1>

                            <p>
                                ขอให้วันนี้เป็นวันที่ดีนะ
                            </p>

                        </div>

                        <div class="dashboard-sparkle">
                            ✦
                        </div>

                    </div>


                    <div class="dashboard-grid home-grid">

                        <!-- ACCOUNT CARD -->

                        <div class="dashboard-card account-card">

                            <div class="card-header">

                                <div>
                                    <h2>
                                        ACCOUNT
                                    </h2>
                                </div>

                                <button class="card-more">
                                    <i class="fa-solid fa-ellipsis"></i>
                                </button>

                            </div>


                            <div class="account-main">

                                <div
                                    class="profile-avatar"
                                    data-user-avatar="small"
                                >

                                    <div class="avatar-placeholder">
                                        P
                                    </div>

                                    <span class="online-dot"></span>

                                </div>


                                <div class="account-info">

                                    <h2 data-user-name>
                                        Player
                                    </h2>

                                    <p>
                                        #0001-9987
                                    </p>

                                    <span
                                        class="status-toggle"
                                        data-status-text
                                        title="แตะเพื่อสลับสถานะ"
                                    >
                                        ● ออนไลน์
                                    </span>

                                </div>

                            </div>


                            <div class="account-quote">

                                <span
                                    id="dashboard-quote-text"
                                    class="quote-text"
                                    contenteditable="false"
                                >"${quoteSettings.quote}"</span>

                                <button
                                    id="dashboard-quote-edit"
                                    class="quote-edit-btn"
                                    type="button"
                                    title="แก้ไข"
                                >
                                    <i class="fa-solid fa-pen"></i>
                                </button>

                                <small id="dashboard-quote-sub">
                                    ${quoteSettings.quoteEn}
                                </small>

                            </div>

                        </div>


                        <!-- BANK CARD -->

                        <div class="dashboard-card bank-card">

                            <div class="card-header">

                                <div>
                                    <span class="card-label">
                                        BANK
                                    </span>

                                    <h2>
                                        บัญชีหลัก
                                    </h2>
                                </div>

                                <i class="fa-solid fa-building-columns card-icon"></i>

                            </div>


                            <div class="bank-balance">

                                <small>
                                    ยอดเงินคงเหลือ
                                </small>

                                <strong>
                                    ฿ 12,450.00
                                </strong>

                                <span>
                                    •••• •••• •••• 9987
                                </span>

                            </div>


                            <div class="bank-actions">

                                <button>
                                    <i class="fa-solid fa-arrow-up"></i>
                                    <span>โอนเงิน</span>
                                </button>

                                <button>
                                    <i class="fa-solid fa-arrow-down"></i>
                                    <span>รับเงิน</span>
                                </button>

                                <button>
                                    <i class="fa-solid fa-receipt"></i>
                                    <span>ประวัติ</span>
                                </button>

                                <button>
                                    <i class="fa-solid fa-credit-card"></i>
                                    <span>บัตร</span>
                                </button>

                            </div>

                        </div>


                        <!-- CALENDAR -->

                        <div class="dashboard-card calendar-card">

                            <div class="card-header">

                                <h2>
                                    กันยายน 2026
                                </h2>

                                <div class="calendar-arrows">
                                    ‹ &nbsp; ›
                                </div>

                            </div>


                            <div class="calendar-week">

                                <span>อา.</span>
                                <span>จ.</span>
                                <span>อ.</span>
                                <span>พ.</span>
                                <span>พฤ.</span>
                                <span>ศ.</span>
                                <span>ส.</span>

                            </div>


                            <div class="calendar-days">

                                ${generateCalendar()}

                            </div>

                        </div>


                        <!-- MESSAGES -->

                        <div class="dashboard-card messages-card">

                            <div class="card-header">

                                <div>

                                    <span class="card-label">
                                        MESSAGES
                                    </span>

                                    <h2>
                                        ข้อความล่าสุด
                                    </h2>

                                </div>

                                <span class="view-all">
                                    ดูทั้งหมด ›
                                </span>

                            </div>


                            <div class="message-list">

                                <div class="message-item">

                                    <div class="message-avatar">
                                        C
                                    </div>

                                    <div class="message-text">

                                        <strong>
                                            เชส
                                        </strong>

                                        <span>
                                            แล้วพรุ่งนี้เจอกันนะ :)
                                        </span>

                                    </div>

                                    <time>
                                        02:12
                                    </time>

                                </div>


                                <div class="message-item">

                                    <div class="message-avatar">
                                        T
                                    </div>

                                    <div class="message-text">

                                        <strong>
                                            พี่เตชิน
                                        </strong>

                                        <span>
                                            อย่าลืมกินข้าวด้วย
                                        </span>

                                    </div>

                                    <time>
                                        00:48
                                    </time>

                                </div>


                                <div class="message-item">

                                    <div class="message-avatar system-avatar">
                                        ⚙
                                    </div>

                                    <div class="message-text">

                                        <strong>
                                            ระบบ
                                        </strong>

                                        <span>
                                            อัปเดตข้อมูลเรียบร้อยแล้ว
                                        </span>

                                    </div>

                                    <time>
                                        เมื่อวาน
                                    </time>

                                </div>

                            </div>

                        </div>


                        <!-- TASKS -->

                        <div class="dashboard-card tasks-card">

                            <div class="card-header">

                                <div>

                                    <span class="card-label">
                                        TASKS
                                    </span>

                                    <h2>
                                        ภารกิจวันนี้
                                    </h2>

                                </div>

                                <span class="task-progress">
                                    2 / 5
                                </span>

                            </div>


                            <div class="task-progress-bar">

                                <div></div>

                            </div>


                            <div class="task-list">

                                <label class="task-item done">

                                    <input
                                        type="checkbox"
                                        checked
                                    >

                                    <span>
                                        ตรวจสอบยอดเงินบัญชี
                                    </span>

                                </label>


                                <label class="task-item done">

                                    <input
                                        type="checkbox"
                                        checked
                                    >

                                    <span>
                                        ส่งรายงานโปรเจกต์
                                    </span>

                                </label>


                                <label class="task-item">

                                    <input
                                        type="checkbox"
                                    >

                                    <span>
                                        ตอบข้อความที่ค้าง
                                    </span>

                                </label>


                                <label class="task-item">

                                    <input
                                        type="checkbox"
                                    >

                                    <span>
                                        อ่านเอกสารสำหรับพรุ่งนี้
                                    </span>

                                </label>

                            </div>

                        </div>


                        <!-- NOTES -->

                        <div class="dashboard-card notes-card">

                            <div class="card-header">

                                <div>

                                    <span class="card-label">
                                        QUICK NOTE
                                    </span>

                                    <h2>
                                        บันทึกสั้น ๆ
                                    </h2>

                                </div>

                                <button class="add-note">
                                    +
                                </button>

                            </div>


                            <div class="note-content">

                                “อย่าลืมว่า...

                                <br>

                                คุณเก่งมากแล้วในแบบของคุณ” ✨

                            </div>

                        </div>


                    </div>

                </section>


                <!-- =====================================
                     GENERIC PAGES
                     ===================================== -->

                <section
                    class="dashboard-page"
                    data-page-content="account"
                >

                    <div class="page-heading">

                        <span>
                            ACCOUNT
                        </span>

                        <h1>
                            ACCOUNT
                        </h1>

                        <p>
                            จัดการข้อมูลและรายละเอียดของบัญชี
                        </p>

                    </div>


                    <div class="large-info-card">

                        <div
                            class="large-avatar"
                            data-user-avatar="large"
                        >
                            P
                        </div>

                        <div>

                            <h2 data-user-name>
                                Player
                            </h2>

                            <p>
                                #0001-9987
                            </p>

                            <span
                                class="status-badge status-toggle"
                                data-status-text
                                title="แตะเพื่อสลับสถานะ"
                            >
                                ● ออนไลน์
                            </span>

                        </div>

                    </div>

                </section>


                <section
                    class="dashboard-page"
                    data-page-content="bank"
                >

                    <div class="page-heading bank-heading">

                        <div class="bank-heading-decor">

                            <div class="bank-hero-script">
                                Banking for a better tomorrow
                            </div>

                            <div class="bank-hero-illustration">
                                <i class="fa-solid fa-star sparkle-one"></i>
                                <i class="fa-solid fa-star sparkle-two"></i>
                                <i class="fa-solid fa-leaf leaf-one"></i>
                                <i class="fa-solid fa-leaf leaf-two"></i>
                                <i class="fa-solid fa-building-columns"></i>
                            </div>

                        </div>

                        <span>
                            BANK
                        </span>

                        <h1>
                            ธนาคาร
                        </h1>

                        <p>
                            บัญชีและรายการทางการเงิน
                        </p>

                        <div class="bank-heading-caption">
                            SAFE &bull; SIMPLE &bull; ALWAYS WITH YOU
                        </div>

                    </div>


                    <div class="bank-page-layout">

                        <!-- HERO BALANCE CARD -->
                        <div class="large-bank-card">

                            <div class="large-bank-sparkle sparkle-a">
                                <i class="fa-solid fa-star"></i>
                            </div>

                            <div class="large-bank-sparkle sparkle-b">
                                <i class="fa-solid fa-star"></i>
                            </div>

                            <div class="large-bank-top">

                                <div>

                                    <small>
                                        ยอดเงินคงเหลือ
                                    </small>

                                    <strong>
                                        ฿ 12,450.00
                                    </strong>

                                    <span class="large-bank-number">
                                        •••• •••• •••• 9987
                                        <button
                                            class="bank-copy-btn"
                                            id="bank-copy-btn"
                                            type="button"
                                            aria-label="คัดลอกเลขบัญชี"
                                        >
                                            <i class="fa-solid fa-copy"></i>
                                        </button>
                                    </span>

                                </div>

                                <div class="large-bank-icon-wrap">

                                    <i class="fa-solid fa-building-columns large-bank-icon"></i>

                                    <div class="large-bank-icon-caption">
                                        <strong>MY ACCOUNT</strong>
                                        <span>YOUR FUTURE<br>IN GOOD HANDS.</span>
                                    </div>

                                </div>

                            </div>


                            <div class="large-bank-actions">

                                <button>
                                    <i class="fa-solid fa-arrow-up"></i>
                                    <span>โอนเงิน</span>
                                </button>

                                <button>
                                    <i class="fa-solid fa-arrow-down"></i>
                                    <span>รับเงิน</span>
                                </button>

                                <button>
                                    <i class="fa-solid fa-receipt"></i>
                                    <span>ประวัติ</span>
                                </button>

                                <button>
                                    <i class="fa-solid fa-credit-card"></i>
                                    <span>บัตร</span>
                                </button>

                            </div>

                        </div>


                        <!-- QUICK STATS -->
                        <div class="bank-stats">

                            <div class="bank-stat-card income">

                                <div class="bank-stat-row">

                                    <div class="bank-stat-icon">
                                        <i class="fa-solid fa-arrow-down-long"></i>
                                    </div>

                                    <div class="bank-stat-text">
                                        <small>เงินเข้าเดือนนี้</small>
                                        <strong>+ ฿ 8,200</strong>
                                    </div>

                                    <i class="fa-solid fa-chart-simple bank-stat-trend-icon"></i>

                                </div>

                                <svg
                                    class="bank-stat-graph"
                                    viewBox="0 0 120 28"
                                    preserveAspectRatio="none"
                                >
                                    <path d="M0,24 C20,23 30,15 45,15 C65,15 72,4 120,2" />
                                </svg>

                            </div>

                            <div class="bank-stat-card expense">

                                <div class="bank-stat-row">

                                    <div class="bank-stat-icon">
                                        <i class="fa-solid fa-arrow-up-long"></i>
                                    </div>

                                    <div class="bank-stat-text">
                                        <small>เงินออกเดือนนี้</small>
                                        <strong>− ฿ 3,150</strong>
                                    </div>

                                    <i class="fa-solid fa-chart-simple bank-stat-trend-icon"></i>

                                </div>

                                <svg
                                    class="bank-stat-graph"
                                    viewBox="0 0 120 28"
                                    preserveAspectRatio="none"
                                >
                                    <path d="M0,20 C20,22 30,26 45,20 C65,14 72,6 120,4" />
                                </svg>

                            </div>

                        </div>


                        <!-- TRANSACTIONS -->
                        <div class="bank-transactions">

                            <div class="bank-transactions-header">
                                <h2>รายการล่าสุด</h2>
                                <span class="view-all">ดูทั้งหมด ›</span>
                            </div>

                            <div class="transaction-item">

                                <div class="transaction-icon in">
                                    <i class="fa-solid fa-arrow-down"></i>
                                </div>

                                <div class="transaction-text">
                                    <strong>เงินเดือนเข้า</strong>
                                    <span>วันนี้ • 09:24</span>
                                </div>

                                <div class="transaction-amount in">
                                    + ฿ 8,200.00
                                </div>

                            </div>

                            <div class="transaction-item">

                                <div class="transaction-icon out">
                                    <i class="fa-solid fa-cart-shopping"></i>
                                </div>

                                <div class="transaction-text">
                                    <strong>ซื้อของออนไลน์</strong>
                                    <span>เมื่อวาน • 21:10</span>
                                </div>

                                <div class="transaction-amount out">
                                    − ฿ 1,290.00
                                </div>

                            </div>

                            <div class="transaction-item">

                                <div class="transaction-icon out">
                                    <i class="fa-solid fa-bolt"></i>
                                </div>

                                <div class="transaction-text">
                                    <strong>ค่าไฟฟ้า</strong>
                                    <span>12 ก.ย. • 14:02</span>
                                </div>

                                <div class="transaction-amount out">
                                    − ฿ 860.00
                                </div>

                            </div>

                            <div class="transaction-item">

                                <div class="transaction-icon out">
                                    <i class="fa-solid fa-mug-hot"></i>
                                </div>

                                <div class="transaction-text">
                                    <strong>ร้านกาแฟ</strong>
                                    <span>10 ก.ย. • 08:15</span>
                                </div>

                                <div class="transaction-amount out">
                                    − ฿ 120.00
                                </div>

                            </div>

                        </div>

                    </div>

                </section>


                <section
                    class="dashboard-page"
                    data-page-content="messages"
                >

                    <div class="messages-hero">

                        <div class="messages-hero-decor">
                            <i class="fa-solid fa-comment"></i>
                            <i class="fa-solid fa-comment-dots"></i>
                        </div>

                        <div class="messages-hero-top">

                            <div class="messages-hero-icon">
                                <i class="fa-solid fa-comment-dots"></i>
                            </div>

                            <div class="messages-hero-heading">

                                <span>
                                    MESSAGES
                                </span>

                                <h1>
                                    ข้อความ
                                </h1>

                            </div>

                        </div>

                        <div class="messages-hero-script">
                            Keep in touch
                        </div>

                        <div class="messages-hero-caption">
                            GOOD CONVERSATIONS<br>
                            BRIGHTEN YOUR DAY ✦
                        </div>

                    </div>


                    <div class="full-list-card" id="full-list-card">

                        <div
                            class="full-message"
                            id="system-message-row"
                            data-chat-name="ระบบ"
                            data-chat-initial="⚙"
                            data-chat-system="true"
                            data-chat-time="เมื่อวาน"
                        >
                            <div class="full-message-avatar system-avatar">⚙</div>
                            <div class="full-message-text">
                                <b>ระบบ</b>
                                <span>อัปเดตข้อมูลเรียบร้อยแล้ว</span>
                            </div>
                            <div class="full-message-meta">
                                <time>เมื่อวาน</time>
                                <i class="fa-solid fa-chevron-right"></i>
                            </div>
                        </div>

                    </div>

                </section>


                <section
                    class="dashboard-page"
                    data-page-content="schedule"
                >

                    <div class="page-heading">

                        <span>
                            SCHEDULE
                        </span>

                        <h1>
                            ตารางงาน
                        </h1>

                        <p>
                            ตารางและกิจกรรมของคุณ
                        </p>

                    </div>

                    <div class="empty-page-card">
                        <i class="fa-solid fa-calendar"></i>
                        <h2>ไม่มีรายการเพิ่มเติม</h2>
                        <p>ตารางงานของคุณจะแสดงที่นี่</p>
                    </div>

                </section>


                <section
                    class="dashboard-page"
                    data-page-content="notes"
                >

                    <div class="page-heading">

                        <span>
                            NOTES
                        </span>

                        <h1>
                            บันทึก
                        </h1>

                        <p>
                            เก็บข้อความและความคิดของคุณ
                        </p>

                    </div>

                    <div class="empty-page-card">
                        <i class="fa-solid fa-note-sticky"></i>
                        <h2>ยังไม่มีบันทึก</h2>
                        <p>เริ่มสร้างบันทึกแรกของคุณ</p>
                    </div>

                </section>


                <section
                    class="dashboard-page"
                    data-page-content="files"
                >

                    <div class="page-heading">

                        <span>
                            FILES
                        </span>

                        <h1>
                            ไฟล์ส่วนตัว
                        </h1>

                        <p>
                            เอกสารและไฟล์ล่าสุด
                        </p>

                    </div>

                    <div class="file-list-card">

                        <div>
                            <i class="fa-solid fa-file-word"></i>
                            <span>เอกสารสรุป.docx</span>
                            <small>2.4 MB</small>
                        </div>

                        <div>
                            <i class="fa-solid fa-file-image"></i>
                            <span>รูปภาพ.png</span>
                            <small>1.8 MB</small>
                        </div>

                        <div>
                            <i class="fa-solid fa-file-excel"></i>
                            <span>รายการค่าใช้จ่าย.xlsx</span>
                            <small>980 KB</small>
                        </div>

                    </div>

                </section>


                <section
                    class="dashboard-page"
                    data-page-content="settings"
                >

                    <div class="page-heading">

                        <span>
                            SETTINGS
                        </span>

                        <h1>
                            ตั้งค่า
                        </h1>

                        <p>
                            ปรับแต่ง Dashboard ของคุณ
                        </p>

                    </div>


                    <div class="settings-list">

                        <button>
                            <i class="fa-solid fa-palette"></i>
                            <span>การแสดงผล</span>
                            <i class="fa-solid fa-chevron-right"></i>
                        </button>

                        <button>
                            <i class="fa-solid fa-language"></i>
                            <span>ภาษา</span>
                            <i class="fa-solid fa-chevron-right"></i>
                        </button>

                        <button>
                            <i class="fa-solid fa-bell"></i>
                            <span>การแจ้งเตือน</span>
                            <i class="fa-solid fa-chevron-right"></i>
                        </button>

                        <button>
                            <i class="fa-solid fa-lock"></i>
                            <span>ความเป็นส่วนตัว</span>
                            <i class="fa-solid fa-chevron-right"></i>
                        </button>

                    </div>

                </section>


            </main>


            <!-- =========================================
                 CHAT THREAD (messages detail overlay)
                 ========================================= -->

            <div
                class="chat-thread"
                id="chat-thread"
            >

                <div class="chat-thread-header">

                    <button
                        class="chat-thread-back"
                        id="chat-thread-back"
                        type="button"
                    >
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>

                    <div
                        class="chat-thread-avatar"
                        id="chat-thread-avatar"
                    ></div>

                    <div class="chat-thread-name">
                        <strong id="chat-thread-name"></strong>
                        <span class="chat-thread-status-line">
                            <span
                                class="chat-thread-status-dot"
                                id="chat-thread-status-dot"
                            ></span>
                            <span id="chat-thread-status"></span>
                        </span>
                    </div>

                    <div class="chat-thread-header-actions">

                        <button
                            class="chat-thread-icon-button"
                            id="chat-thread-call-button"
                            type="button"
                            title="โทร"
                        >
                            <i class="fa-solid fa-phone"></i>
                        </button>

                        <button
                            class="chat-thread-icon-button"
                            id="chat-thread-video-button"
                            type="button"
                            title="วิดีโอคอล"
                        >
                            <i class="fa-solid fa-video"></i>
                        </button>

                        <span class="chat-thread-header-divider"></span>

                        <div class="chat-thread-more-wrap">

                            <button
                                class="chat-thread-icon-button"
                                id="chat-thread-more-button"
                                type="button"
                                title="เพิ่มเติม"
                            >
                                <i class="fa-solid fa-ellipsis"></i>
                            </button>

                            <div
                                class="chat-thread-more-menu"
                                id="chat-thread-more-menu"
                            >

                                <button
                                    class="chat-thread-more-item"
                                    id="chat-thread-search-toggle"
                                    type="button"
                                >
                                    <i class="fa-solid fa-magnifying-glass"></i>
                                    <span>ค้นหาในแชท</span>
                                </button>

                                <button
                                    class="chat-thread-more-item"
                                    id="chat-thread-mute"
                                    type="button"
                                >
                                    <i class="fa-solid fa-bell-slash"></i>
                                    <span>ปิดการแจ้งเตือน</span>
                                </button>

                                <button
                                    class="chat-thread-more-item"
                                    id="chat-thread-pin"
                                    type="button"
                                >
                                    <i class="fa-solid fa-thumbtack"></i>
                                    <span>ปักหมุดแชท</span>
                                </button>

                                <span class="chat-thread-more-divider"></span>

                                <button
                                    class="chat-thread-more-item"
                                    id="chat-thread-theme"
                                    type="button"
                                >
                                    <i class="fa-solid fa-palette"></i>
                                    <span>วอลเปเปอร์ / สีฟองข้อความ</span>
                                </button>

                                <button
                                    class="chat-thread-more-item"
                                    id="chat-thread-call-log"
                                    type="button"
                                >
                                    <i class="fa-solid fa-clock-rotate-left"></i>
                                    <span>ประวัติการโทร</span>
                                </button>

                                <button
                                    class="chat-thread-more-item"
                                    id="chat-thread-export"
                                    type="button"
                                >
                                    <i class="fa-solid fa-file-arrow-down"></i>
                                    <span>ส่งออกประวัติการแชท</span>
                                </button>

                                <span class="chat-thread-more-divider"></span>

                                <button
                                    class="chat-thread-more-item"
                                    id="chat-thread-undo-last"
                                    type="button"
                                >
                                    <i class="fa-solid fa-rotate-left"></i>
                                    <span>ล้างข้อความล่าสุด</span>
                                </button>

                                <button
                                    class="chat-thread-more-item is-danger"
                                    id="chat-thread-block"
                                    type="button"
                                >
                                    <i class="fa-solid fa-ban"></i>
                                    <span>บล็อกผู้ติดต่อ</span>
                                </button>

                                <button
                                    class="chat-thread-more-item is-danger"
                                    id="chat-thread-clear-history"
                                    type="button"
                                >
                                    <i class="fa-solid fa-trash-can"></i>
                                    <span>ลบประวัติการแชท</span>
                                </button>

                            </div>

                        </div>

                    </div>

                </div>

                <div
                    class="chat-thread-search"
                    id="chat-thread-search"
                >

                    <i class="fa-solid fa-magnifying-glass"></i>

                    <input
                        type="text"
                        class="chat-thread-search-input"
                        id="chat-thread-search-input"
                        placeholder="ค้นหาในแชท..."
                    >

                    <span
                        class="chat-thread-search-count"
                        id="chat-thread-search-count"
                    ></span>

                    <button
                        class="chat-thread-search-close"
                        id="chat-thread-search-close"
                        type="button"
                    >
                        <i class="fa-solid fa-xmark"></i>
                    </button>

                </div>

                <div
                    class="chat-thread-blocked-banner"
                    id="chat-thread-blocked-banner"
                >
                    <i class="fa-solid fa-ban"></i>
                    <span>คุณบล็อกผู้ติดต่อนี้อยู่ — ส่งและรับข้อความกันไม่ได้</span>
                </div>

                <div
                    class="chat-thread-body"
                    id="chat-thread-body"
                ></div>

                <div
                    class="chat-sheet"
                    id="chat-sheet"
                >

                    <div class="chat-sheet-panel">

                        <div class="chat-sheet-header">

                            <strong id="chat-sheet-title"></strong>

                            <button
                                class="chat-sheet-close"
                                id="chat-sheet-close"
                                type="button"
                            >
                                <i class="fa-solid fa-xmark"></i>
                            </button>

                        </div>

                        <div
                            class="chat-sheet-body"
                            id="chat-sheet-body"
                        ></div>

                    </div>

                </div>

                <div class="chat-thread-composer">

                    <div class="chat-thread-composer-pill">

                        <button
                            class="chat-thread-composer-icon"
                            type="button"
                            title="แนบไฟล์"
                        >
                            <i class="fa-solid fa-plus"></i>
                        </button>

                        <input
                            type="text"
                            class="chat-thread-input"
                            id="chat-thread-input"
                            placeholder="พิมพ์ข้อความ..."
                            autocomplete="off"
                        />

                        <button
                            class="chat-thread-composer-icon"
                            type="button"
                            title="อีโมจิ"
                        >
                            <i class="fa-regular fa-face-smile"></i>
                        </button>

                    </div>

                    <button
                        class="chat-thread-send"
                        id="chat-thread-send"
                        type="button"
                    >
                        <i class="fa-solid fa-paper-plane"></i>
                    </button>

                </div>

            </div>


            <!-- =========================================
                 CALL SCREEN (voice call overlay)
                 ========================================= -->

            <div
                class="call-screen"
                id="call-screen"
            >

                <!-- =========================================
                     VIDEO CALL STAGE
                     Only visible while the call screen carries
                     "is-video": a blurred copy of the contact's
                     card as the room behind them, the same picture
                     framed sharply as the camera feed, and a small
                     self-view tile in the corner.
                     ========================================= -->

                <div class="call-video-stage" id="call-video-stage">

                    <div
                        class="call-video-backdrop"
                        id="call-video-backdrop"
                    ></div>

                    <div
                        class="call-video-frame"
                        id="call-video-frame"
                    ></div>

                    <span class="call-video-badge">
                        <i class="fa-solid fa-video"></i>
                        <span id="call-video-badge-text">วิดีโอคอล</span>
                    </span>

                    <div
                        class="call-video-self"
                        id="call-video-self"
                    ></div>

                </div>

                <div class="call-screen-top">

                    <div class="call-screen-avatar-wrap">

                        <span class="call-screen-ring call-screen-ring-1"></span>
                        <span class="call-screen-ring call-screen-ring-2"></span>

                        <div
                            class="call-screen-avatar"
                            id="call-screen-avatar"
                        ></div>

                    </div>

                    <strong
                        class="call-screen-name"
                        id="call-screen-name"
                    ></strong>

                    <span
                        class="call-screen-status"
                        id="call-screen-status"
                    >กำลังโทรออก...</span>

                </div>

                <div
                    class="call-screen-captions"
                    id="call-screen-captions"
                ></div>

                <!-- =========================================
                     INCOMING CALL ACTIONS (accept / decline)
                     Only shown while an auto-triggered [CALL]
                     is still ringing and hasn't been answered.
                     ========================================= -->

                <div
                    class="call-screen-incoming-actions"
                    id="call-screen-incoming-actions"
                >

                    <div class="call-screen-incoming-option">

                        <button
                            class="call-screen-decline"
                            id="call-screen-decline"
                            type="button"
                            title="ปฏิเสธสาย"
                        >
                            <i class="fa-solid fa-phone-slash"></i>
                        </button>

                        <span>ปฏิเสธ</span>

                    </div>

                    <div class="call-screen-incoming-option">

                        <button
                            class="call-screen-accept"
                            id="call-screen-accept"
                            type="button"
                            title="รับสาย"
                        >
                            <i class="fa-solid fa-phone"></i>
                        </button>

                        <span>รับสาย</span>

                    </div>

                </div>

                <div class="call-screen-bottom">

                    <div class="call-screen-composer">

                        <input
                            type="text"
                            class="call-screen-input"
                            id="call-screen-input"
                            placeholder="พูดว่า..."
                            autocomplete="off"
                        />

                        <button
                            class="call-screen-send"
                            id="call-screen-send"
                            type="button"
                        >
                            <i class="fa-solid fa-paper-plane"></i>
                        </button>

                    </div>

                    <div class="call-screen-controls">

                        <button
                            class="call-screen-tool"
                            id="call-screen-mute"
                            type="button"
                            title="ปิดไมค์"
                        >
                            <i class="fa-solid fa-microphone"></i>
                        </button>

                        <button
                            class="call-screen-hangup"
                            id="call-screen-hangup"
                            type="button"
                            title="วางสาย"
                        >
                            <i class="fa-solid fa-phone-slash"></i>
                        </button>

                        <button
                            class="call-screen-tool call-screen-camera"
                            id="call-screen-camera"
                            type="button"
                            title="ปิดกล้อง"
                        >
                            <i class="fa-solid fa-video"></i>
                        </button>

                        <button
                            class="call-screen-tool"
                            id="call-screen-speaker"
                            type="button"
                            title="ลำโพง"
                        >
                            <i class="fa-solid fa-volume-high"></i>
                        </button>

                    </div>

                </div>

            </div>


            <!-- =========================================
                 FOOTER
                 ========================================= -->

            <footer class="dashboard-footer">

                <span>
                    Good things take time.
                </span>

                <div>

                    <span>
                        DASHBOARD v2.0
                    </span>

                    <span>
                        ●
                    </span>

                </div>

            </footer>


            <!-- =========================================
                 CONFIRM MODAL
                 In-app stand-in for window.confirm(). A
                 native browser dialog (confirm/alert/prompt)
                 forces the page out of fullscreen the instant
                 it opens — this stays inside the page instead,
                 so answering it doesn't kick you out of the
                 app.
                 ========================================= -->

            <div class="dashboard-confirm" id="dashboard-confirm">

                <div class="dashboard-confirm-card">

                    <p
                        class="dashboard-confirm-message"
                        id="dashboard-confirm-message"
                    ></p>

                    <div class="dashboard-confirm-actions">

                        <button
                            type="button"
                            class="dashboard-confirm-cancel"
                            id="dashboard-confirm-cancel"
                        >
                            ยกเลิก
                        </button>

                        <button
                            type="button"
                            class="dashboard-confirm-ok"
                            id="dashboard-confirm-ok"
                        >
                            ยืนยัน
                        </button>

                    </div>

                </div>

            </div>

        </div>
    `;


    document.body.appendChild(dashboard);


    // =====================================================
    // ELEMENTS
    // =====================================================

    const selectorButton =
        dashboard.querySelector(
            '#dashboard-selector-button'
        );

    const selectorMenu =
        dashboard.querySelector(
            '#dashboard-selector-menu'
        );

    const closeButton =
        dashboard.querySelector(
            '#dashboard-close'
        );


    // =====================================================
    // FILL IN {{user}}'S NAME / AVATAR
    // =====================================================

    refreshUserInfo(dashboard);
    refreshStatusDisplays(dashboard);

    dashboard
        .querySelectorAll('.status-toggle')
        .forEach((element) => {

            element.addEventListener(
                'click',
                () => {

                    const nextStatus =
                        getStatus() === 'online'
                            ? 'offline'
                            : 'online';

                    setStatus(nextStatus);

                    refreshStatusDisplays(dashboard);

                }
            );

        });


    // =====================================================
    // EDITABLE QUOTE
    // =====================================================

    const quoteText =
        dashboard.querySelector(
            '#dashboard-quote-text'
        );

    const quoteEditBtn =
        dashboard.querySelector(
            '#dashboard-quote-edit'
        );

    const quoteSub =
        dashboard.querySelector(
            '#dashboard-quote-sub'
        );

    // Pulls the quote belonging to whoever is selected right now.
    // Called on every profile switch, since each character keeps
    // their own line inside this chat.
    function refreshQuoteDisplay() {

        const settings = getDashboardSettings();

        if (quoteText) {

            quoteText.textContent = `"${settings.quote}"`;

            quoteText.setAttribute('contenteditable', 'false');
            quoteText.classList.remove('editing');

        }

        if (quoteSub) {
            quoteSub.textContent = settings.quoteEn;
        }

        if (quoteEditBtn) {
            quoteEditBtn.innerHTML =
                '<i class="fa-solid fa-pen"></i>';
        }

    }

    function saveQuote() {

        // Always re-read, so the edit lands on the character that's
        // currently on screen rather than a stale reference.
        const settings = getDashboardSettings();

        const rawValue =
            quoteText.textContent
                .replace(/^"|"$/g, '')
                .trim();

        const finalValue =
            rawValue.length > 0
                ? rawValue
                : settings.quote;

        settings.quote = finalValue;

        saveDashboardSettings();

        quoteText.textContent = `"${finalValue}"`;

        quoteText.setAttribute(
            'contenteditable',
            'false'
        );

        quoteText.classList.remove('editing');

        quoteEditBtn.innerHTML =
            '<i class="fa-solid fa-pen"></i>';

    }

    quoteEditBtn.addEventListener(
        'click',
        () => {

            const isEditing =
                quoteText.getAttribute(
                    'contenteditable'
                ) === 'true';

            if (!isEditing) {

                quoteText.setAttribute(
                    'contenteditable',
                    'true'
                );

                quoteText.classList.add('editing');

                quoteText.focus();

                // Place the caret at the end of the text.
                const range = document.createRange();
                const selection = window.getSelection();

                range.selectNodeContents(quoteText);
                range.collapse(false);

                selection.removeAllRanges();
                selection.addRange(range);

                quoteEditBtn.innerHTML =
                    '<i class="fa-solid fa-check"></i>';

            } else {

                saveQuote();

            }

        }
    );

    quoteText.addEventListener(
        'keydown',
        (event) => {

            if (event.key === 'Enter') {

                event.preventDefault();
                saveQuote();

            }

        }
    );


    // =====================================================
    // SELECTOR OPEN / CLOSE
    // =====================================================

    selectorButton.addEventListener(
        'click',
        (event) => {

            event.stopPropagation();

            selectorMenu.classList.toggle('open');

        }
    );


    document.addEventListener(
        'click',
        (event) => {

            if (
                !selectorButton.contains(event.target) &&
                !selectorMenu.contains(event.target)
            ) {

                selectorMenu.classList.remove(
                    'open'
                );

            }

        }
    );


    // =====================================================
    // PAGE SELECTION
    // =====================================================

    dashboard
        .querySelectorAll(
            '.dashboard-select-item'
        )
        .forEach((item) => {

            item.addEventListener(
                'click',
                () => {

                    const page =
                        item.dataset.page;

                    const title =
                        item.dataset.title;

                    const subtitle =
                        item.dataset.subtitle;

                    const icon =
                        item.dataset.icon;


                    // Update selector
                    dashboard.querySelector(
                        '#dashboard-current-title'
                    ).textContent = title;

                    dashboard.querySelector(
                        '#dashboard-current-subtitle'
                    ).textContent = subtitle;

                    dashboard.querySelector(
                        '#dashboard-current-icon'
                    ).innerHTML =
                        `<i class="fa-solid ${icon}"></i>`;


                    // Active selector
                    dashboard
                        .querySelectorAll(
                            '.dashboard-select-item'
                        )
                        .forEach(
                            (button) => {
                                button.classList.remove(
                                    'active'
                                );
                            }
                        );

                    item.classList.add('active');


                    // Change page
                    dashboard
                        .querySelectorAll(
                            '.dashboard-page'
                        )
                        .forEach(
                            (pageElement) => {

                                pageElement.classList.remove(
                                    'active'
                                );

                            }
                        );


                    const targetPage =
                        dashboard.querySelector(
                            `[data-page-content="${page}"]`
                        );

                    if (targetPage) {

                        targetPage.classList.add(
                            'active'
                        );

                    }


                    selectorMenu.classList.remove(
                        'open'
                    );


                    // Leaving the messages page should reset any
                    // open chat thread so it isn't still showing
                    // next time the page is visited.
                    if (page !== 'messages') {

                        const openThread =
                            dashboard.querySelector('#chat-thread.open');

                        if (openThread) {
                            openThread.classList.remove('open');
                        }

                        // A call in progress shouldn't keep running
                        // (and logging its own hang-up line later)
                        // once the person has already navigated away.
                        if (callState) {
                            hangUpCall(true);
                        }

                    }

                }
            );

        });


    // =====================================================
    // MESSAGES / CHAT THREAD
    // =====================================================

    // Conversation history, keyed by contact name. Real story
    // contacts start empty (their thread seeds itself from the last
    // actual chat line — see openChatThread) and fill up from there
    // as generateQuietPrompt replies come in. "ระบบ" is the one
    // fixed, non-story entry, so it keeps its scripted notices.
    const chatConversations = {

        'ระบบ': [
            { from: 'in', text: 'ระบบได้ทำการสำรองข้อมูลของคุณเรียบร้อยแล้ว', time: 'เมื่อวาน' },
            { from: 'in', text: 'อัปเดตข้อมูลเรียบร้อยแล้ว', time: 'เมื่อวาน' }
        ]

    };

    const chatThread =
        dashboard.querySelector('#chat-thread');

    const chatThreadBack =
        dashboard.querySelector('#chat-thread-back');

    const chatThreadAvatar =
        dashboard.querySelector('#chat-thread-avatar');

    const chatThreadName =
        dashboard.querySelector('#chat-thread-name');

    const chatThreadStatus =
        dashboard.querySelector('#chat-thread-status');

    const chatThreadStatusDot =
        dashboard.querySelector('#chat-thread-status-dot');

    const chatThreadBody =
        dashboard.querySelector('#chat-thread-body');

    const chatThreadInput =
        dashboard.querySelector('#chat-thread-input');

    const chatThreadSend =
        dashboard.querySelector('#chat-thread-send');

    const callButton =
        dashboard.querySelector('#chat-thread-call-button');

    const videoCallButton =
        dashboard.querySelector('#chat-thread-video-button');

    const chatThreadMoreButton =
        dashboard.querySelector('#chat-thread-more-button');

    const chatThreadMoreMenu =
        dashboard.querySelector('#chat-thread-more-menu');

    const chatThreadClearHistoryButton =
        dashboard.querySelector('#chat-thread-clear-history');

    // Name of whichever contact's thread is currently open, so the
    // composer knows which conversation to read from / write into.
    let activeChatName = null;
    let activeChatInitial = '?';
    let activeChatIsSystem = false;

    // Adds a brief pressed-state class for touch/click feedback,
    // since :active alone can be unreliable on some mobile browsers.
    function addPressEffect(element) {

        if (!element) {
            return;
        }

        const press = () => element.classList.add('is-pressed');
        const release = () => element.classList.remove('is-pressed');

        element.addEventListener('mousedown', press);
        element.addEventListener('touchstart', press, { passive: true });

        element.addEventListener('mouseup', release);
        element.addEventListener('mouseleave', release);
        element.addEventListener('touchend', release);
        element.addEventListener('touchcancel', release);

    }

    function isThreadOpenFor(name) {

        return !!(
            chatThread &&
            chatThread.classList.contains('open') &&
            activeChatName === name
        );

    }

    function openChatThread(item) {

        if (!chatThread) {
            return;
        }

        const name = item.dataset.chatName || '';
        const initial = item.dataset.chatInitial || '?';
        const isSystem = item.dataset.chatSystem === 'true';

        activeChatName = name;

        // "ระบบ" (system) notifications aren't a real contact —
        // there's no one to reply, so hide the composer for it.
        if (chatThreadInput && chatThreadSend) {

            const canReply = !isSystem;

            chatThreadInput.disabled = !canReply;
            chatThreadSend.disabled = !canReply;

            const composer =
                dashboard.querySelector('.chat-thread-composer');

            if (composer) {
                composer.classList.toggle('is-hidden', isSystem);
            }

        }

        if (videoCallButton) {

            videoCallButton.disabled = isSystem;

            videoCallButton.classList.toggle('is-disabled', isSystem);

        }

        if (callButton) {

            callButton.disabled = isSystem;

            callButton.classList.toggle(
                'is-disabled',
                isSystem
            );

        }

        chatThreadName.textContent = name;
        chatThreadStatus.textContent =
            isSystem ? 'การแจ้งเตือนอัตโนมัติ' : 'ออนไลน์';

        if (chatThreadStatusDot) {
            chatThreadStatusDot.classList.toggle('is-system', isSystem);
        }

        // Use the character card's real picture in the chat header
        // too, falling back to the initial-letter circle.
        if (isSystem) {
            chatThreadAvatar.textContent = initial;
        } else {
            renderContactAvatarInto(
                chatThreadAvatar,
                getStoryCharacterAvatar(name),
                initial
            );
        }

        chatThreadAvatar.classList.toggle('system-avatar', isSystem);

        // Reused for every message row's little avatar too, so the
        // thread doesn't need to re-derive it per line.
        activeChatInitial = initial;
        activeChatIsSystem = isSystem;

        resetChatSearch(false);

        renderChatBody(
            isSystem
                ? (chatConversations[name] || [])
                : getChatDisplayHistory(name)
        );

        applyContactPrefsToThread(name, isSystem);

        chatThread.classList.add('open');

    }

    function closeChatThread() {

        if (chatThread) {
            chatThread.classList.remove('open');
        }

        closeChatSheet();
        closeThreadMoreMenu();
        resetChatSearch(false);

        activeChatName = null;

    }

    // Escapes text before it goes into innerHTML, since chat lines
    // come straight from the real story and may contain stray
    // <, >, or & characters.
    function escapeHtml(text) {

        const div = document.createElement('div');

        div.textContent = text == null ? '' : String(text);

        return div.innerHTML;

    }

    // Wipes and rebuilds the whole thread body from a list of
    // {from, text, time} bubbles. Used both for the first open and
    // for every live refresh, so the panel always matches the real
    // chat exactly rather than drifting from it.
    // Whatever the thread is currently showing, kept so the search
    // box can re-filter the same list without asking the store for
    // it again on every keystroke.
    let lastRenderedHistory = [];
    let chatSearchTerm = '';
    let chatSearchMatchCount = 0;

    function escapeRegExp(text) {

        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    }

    // Escapes the line first, then wraps every occurrence of the
    // search term in <mark> — so searching for "<b>" highlights the
    // literal text instead of injecting markup.
    function highlightSearchHtml(line) {

        const safe = escapeHtml(line);

        const term = chatSearchTerm.trim();

        if (!term) {
            return safe;
        }

        try {

            return safe.replace(
                new RegExp(escapeRegExp(escapeHtml(term)), 'gi'),
                (match) => `<mark class="chat-search-hit">${match}</mark>`
            );

        } catch (error) {
            return safe;
        }

    }

    function renderChatBody(history) {

        if (!chatThreadBody) {
            return;
        }

        lastRenderedHistory = Array.isArray(history) ? history : [];

        const term = chatSearchTerm.trim().toLowerCase();

        const visible = term
            ? lastRenderedHistory.filter(
                (message) =>
                    String(message.text || '')
                        .toLowerCase()
                        .includes(term)
            )
            : lastRenderedHistory;

        chatSearchMatchCount = term ? visible.length : 0;

        if (term && !visible.length) {

            chatThreadBody.innerHTML =
                '<div class="chat-search-empty">ไม่พบข้อความที่ตรงกับคำค้นหา</div>';

        } else {

            chatThreadBody.innerHTML = visible
                .map((message) => buildChatRowHtml(message))
                .join('');

        }

        updateChatSearchCount();

        chatThreadBody.scrollTop = term
            ? 0
            : chatThreadBody.scrollHeight;

    }

    // The one line a call leaves behind in the chat thread once it
    // ends: a centered pill with a phone icon and how long it ran —
    // "การโทร • 5:32" — instead of replaying anything that was said.
    function buildCallSummaryRowHtml(message) {

        return `
            <div class="chat-row chat-row-call-summary">
                <div class="chat-call-summary-pill">
                    <i class="fa-solid fa-phone"></i>
                    <span>การโทร • ${escapeHtml(message.text)}</span>
                </div>
            </div>
        `;

    }

    // Turns one {from, text, time} entry into a full row: an avatar
    // beside the bubble for incoming lines (matching the reference
    // layout), right-aligned bubble-only for outgoing ones. The text
    // is split into one <p> per line so a long narrated turn reads
    // as a few short paragraphs instead of one dense wall of text.
    // A call-summary entry skips all of that and renders as its own
    // centered pill instead of a left/right chat bubble.
    function buildChatRowHtml(message) {

        if (message.kind === 'call-summary') {
            return buildCallSummaryRowHtml(message);
        }

        const paragraphs = (message.text || '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => `<p>${highlightSearchHtml(line)}</p>`)
            .join('');

        const bubbleHtml = `
            <div class="chat-bubble ${message.from}">
                ${paragraphs || '<p>&nbsp;</p>'}
            </div>
        `;

        if (message.from !== 'in') {

            return `
                <div class="chat-row chat-row-out">
                    <div class="chat-row-body">
                        ${bubbleHtml}
                        <time class="chat-row-time">${escapeHtml(message.time)}</time>
                    </div>
                </div>
            `;

        }

        const avatarLabel =
            activeChatIsSystem ? '⚙' : activeChatInitial;

        return `
            <div class="chat-row chat-row-in">
                <div class="chat-row-avatar${activeChatIsSystem ? ' system-avatar' : ''}">
                    ${escapeHtml(avatarLabel)}
                </div>
                <div class="chat-row-body">
                    ${bubbleHtml}
                    <time class="chat-row-time">${escapeHtml(message.time)}</time>
                </div>
            </div>
        `;

    }

    // Small "..." bubble shown while the bot is generating a reply.
    function showTypingBubble() {

        if (!chatThreadBody) {
            return null;
        }

        const row = document.createElement('div');

        row.className = 'chat-row chat-row-in';

        const avatarLabel =
            activeChatIsSystem ? '⚙' : activeChatInitial;

        row.innerHTML = `
            <div class="chat-row-avatar${activeChatIsSystem ? ' system-avatar' : ''}">
                ${escapeHtml(avatarLabel)}
            </div>
            <div class="chat-row-body">
                <div class="chat-bubble in chat-bubble-typing">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                </div>
            </div>
        `;

        chatThreadBody.appendChild(row);

        chatThreadBody.scrollTop =
            chatThreadBody.scrollHeight;

        return row;

    }

    // =====================================================
    // PHONE EVENT TAGS
    // =====================================================
    // {{char}}'s own reply can carry one of these two tags to tell
    // the dashboard "this turn is a phone call, not a text" — see
    // installPhoneTagInstruction() below for how the model is taught
    // to use them, and checkForPhoneEvents() for where they're acted
    // on. Both an English and a Thai spelling are accepted since
    // either might end up in a character's writing style.
    const DASHBOARD_CALL_START_TAG = /\[\s*(?:call|โทร)\s*\]/i;
    const DASHBOARD_VIDEO_CALL_START_TAG =
        /\[\s*(?:vcall|video[ _-]?call|วิดีโอคอล)\s*\]/i;
    const DASHBOARD_CALL_END_TAG = /\[\s*(?:hangup|end ?call|วางสาย)\s*\]/i;

    // Removes the tags themselves from anything that actually gets
    // displayed (chat bubbles AND call captions both go through
    // cleanBotReply below) — the story should react to them, the
    // person reading shouldn't ever see the literal brackets.
    function stripPhoneEventTags(text) {

        return text
            .replace(DASHBOARD_CALL_START_TAG, '')
            .replace(DASHBOARD_VIDEO_CALL_START_TAG, '')
            .replace(DASHBOARD_CALL_END_TAG, '');

    }

    // Strips the kind of formatting a roleplay LLM tends to add
    // (asterisked actions, surrounding quotes) so a story line reads
    // like a plain text message rather than prose. Line breaks are
    // now kept (not flattened to spaces) so each beat becomes its
    // own short paragraph once rendered — that's what turns a long
    // narrated turn into a readable stack of paragraphs instead of
    // one dense block of text.
    function cleanBotReply(text) {

        if (!text) {
            return '';
        }

        return stripPhoneEventTags(text)
            .replace(/\*[^*]*\*/g, '')
            .split(/\r?\n+/)
            .map((line) => (
                line
                    .replace(/^["'“”]+|["'“”]+$/g, '')
                    .trim()
            ))
            .filter((line) => line.length > 0)
            .join('\n');

    }

    function formatEntryTime(entry) {

        if (!entry || !entry.send_date) {
            return '';
        }

        const parsed = new Date(entry.send_date);

        if (Number.isNaN(parsed.getTime())) {
            return '';
        }

        return parsed.toLocaleTimeString(
            'th-TH',
            { hour: '2-digit', minute: '2-digit' }
        );

    }

    // =====================================================
    // THE PHONE'S OWN MESSAGE LOG
    // =====================================================
    // Messages sent on this phone are NOT SillyTavern's main chat
    // log. They live in the chat file's own dashboard blob, one
    // thread per contact, so the phone reads like a real messaging
    // app: short spoken lines only, no narration, nothing pushed
    // into the story's own message list.
    //
    // They're still tied to the story: every reply is generated
    // with the main chat as context (see buildPhoneReplyPrompt),
    // so if the story is at the graduation ceremony, the texts are
    // about the graduation ceremony.

    function getPhoneThreadStore() {

        const store = getDashboardStore();

        if (!store.threads || typeof store.threads !== 'object') {
            store.threads = {};
        }

        return store.threads;

    }

    // The saved thread for one contact, created empty on first use.
    function getPhoneThread(characterName) {

        const threads = getPhoneThreadStore();

        if (!Array.isArray(threads[characterName])) {
            threads[characterName] = [];
        }

        return threads[characterName];

    }

    function getPhoneThreadLength(characterName) {

        return getPhoneThread(characterName).length;

    }

    // =====================================================
    // PER-CONTACT PREFERENCES + CALL HISTORY
    // =====================================================
    // Filed in the same per-chat store the threads live in, so
    // muting / pinning / blocking a contact, the wallpaper picked
    // for their room and their call log all travel with the chat
    // and never touch the story log itself.

    function getContactPrefsStore() {

        const store = getDashboardStore();

        if (!store.contactPrefs || typeof store.contactPrefs !== 'object') {
            store.contactPrefs = {};
        }

        return store.contactPrefs;

    }

    function getContactPrefs(characterName) {

        const all = getContactPrefsStore();

        if (!all[characterName] || typeof all[characterName] !== 'object') {
            all[characterName] = {};
        }

        const prefs = all[characterName];

        if (typeof prefs.muted !== 'boolean') {
            prefs.muted = false;
        }

        if (typeof prefs.pinned !== 'boolean') {
            prefs.pinned = false;
        }

        if (typeof prefs.blocked !== 'boolean') {
            prefs.blocked = false;
        }

        if (typeof prefs.wallpaper !== 'string') {
            prefs.wallpaper = 'default';
        }

        if (typeof prefs.bubble !== 'string') {
            prefs.bubble = 'default';
        }

        return prefs;

    }

    function setContactPref(characterName, key, value) {

        if (!characterName) {
            return;
        }

        getContactPrefs(characterName)[key] = value;

        saveDashboardSettings();

    }

    function isContactMuted(characterName) {

        return !!(characterName && getContactPrefs(characterName).muted);

    }

    function isContactPinned(characterName) {

        return !!(characterName && getContactPrefs(characterName).pinned);

    }

    function isContactBlocked(characterName) {

        return !!(characterName && getContactPrefs(characterName).blocked);

    }

    function getCallLogStore() {

        const store = getDashboardStore();

        if (!store.callLogs || typeof store.callLogs !== 'object') {
            store.callLogs = {};
        }

        return store.callLogs;

    }

    function getCallLogs(characterName) {

        const logs = getCallLogStore();

        if (!Array.isArray(logs[characterName])) {
            logs[characterName] = [];
        }

        return logs[characterName];

    }

    // One entry per finished call: when it happened, who started
    // it, how long it ran, and every line that was actually said
    // while it was connected. The chat thread still only shows the
    // short "การโทร • 5:32" pill, but the whole conversation can be
    // re-read later from the call-history sheet.
    function recordCallLogEntry(characterName, connectedAt, wasIncoming, startIndex, wasVideo) {

        if (!characterName || !connectedAt) {
            return;
        }

        const seconds = Math.max(
            1,
            Math.round((Date.now() - connectedAt) / 1000)
        );

        const lines = getMirroredHistory(characterName)
            .slice(startIndex || 0)
            .filter(
                (entry) =>
                    entry.kind === 'call' ||
                    entry.kind === 'call-ambient'
            )
            .map((entry) => ({
                from: entry.from,
                text: entry.text,
                time: entry.time || '',
                kind: entry.kind
            }));

        getCallLogs(characterName).push({
            at: Date.now(),
            direction: wasIncoming ? 'in' : 'out',
            status: 'answered',
            video: !!wasVideo,
            seconds,
            lines
        });

        saveDashboardSettings();

    }

    // A call that never connected still belongs in the log — as a
    // missed or declined entry with no transcript.
    function recordMissedCallLog(characterName, reason) {

        if (!characterName) {
            return;
        }

        getCallLogs(characterName).push({
            at: Date.now(),
            direction: 'in',
            status: reason === 'declined' ? 'declined' : 'missed',
            seconds: 0,
            lines: []
        });

        saveDashboardSettings();

    }

    function nowClockLabel() {

        return new Date().toLocaleTimeString(
            'th-TH',
            { hour: '2-digit', minute: '2-digit' }
        );

    }

    // Adds one line to a contact's thread and persists it with the
    // rest of the dashboard's per-chat data. `kind` marks what the
    // line actually is: 'text' (a normal chat message — the
    // default), 'call' (something said out loud during a live call,
    // kept only for the call captions to read back), or
    // 'call-summary' (the little "call lasted X" log line dropped
    // into the thread once a call ends). Keeping this on the entry
    // is what lets the chat thread and the call captions both read
    // from the same underlying store while showing different things.
    function appendPhoneMessage(characterName, from, text, kind) {

        const clean = (text || '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join('\n');

        if (!characterName || !clean) {
            return null;
        }

        // A blocked contact's texts never arrive at all. Call lines
        // and call summaries are left alone so a call already in
        // progress can still finish and be logged.
        if (
            from === 'in' &&
            (kind || 'text') === 'text' &&
            isContactBlocked(characterName)
        ) {
            return null;
        }

        const entry = {
            from: from === 'in' ? 'in' : 'out',
            text: clean,
            time: nowClockLabel(),
            kind: kind || 'text'
        };

        getPhoneThread(characterName).push(entry);

        saveDashboardSettings();

        return entry;

    }

    // Full thread, every kind of entry included ('text', 'call', and
    // 'call-summary'). This is what the call captions panel reads
    // from — mid-call it needs the raw spoken lines, tag and all.
    function getMirroredHistory(characterName) {

        return getPhoneThread(characterName).map((entry) => ({
            from: entry.from,
            text: entry.text,
            time: entry.time || '',
            kind: entry.kind || 'text'
        }));

    }

    // What the CHAT PANEL actually renders. Live call dialogue
    // ('kind: call') is deliberately left out here — it stays inside
    // the thread for the call captions to read, but it never shows
    // up as a chat bubble. All the reader sees in the thread once a
    // call happened is the one summary line ('call-summary') logged
    // when it ended, the same way a real messaging app keeps voice
    // calls out of the text history and only logs "Call • 5:32".
    function getChatDisplayHistory(characterName) {

        return getMirroredHistory(characterName)
            .filter((entry) => entry.kind !== 'call' && entry.kind !== 'call-ambient');

    }

    // =====================================================
    // GENERATING PHONE REPLIES (without touching the story log)
    // =====================================================
    // Phone replies are now fully independent of the main story:
    // no main chat messages are read or sent to the model at all.
    // The model only sees the character's own card info (built in
    // buildPhoneCharacterBrief below) plus this phone thread's own
    // transcript — nothing is appended to the story chat either.

    // How many past phone lines are shown back to the model so the
    // texting conversation keeps its own thread of thought.
    const PHONE_TRANSCRIPT_LINES = 14;

    // Above this many characters a "reply" almost certainly isn't a
    // text/call line anymore — it's the model slipping back into
    // novel-style narration.
    const PHONE_NARRATION_LENGTH_LIMIT = 200;

    // Pulls spoken dialogue out of a chunk of text: whatever sits
    // inside quote marks (straight or curly), as an array in the
    // order they appeared. A narrated paragraph that quotes several
    // different people usually puts the actual line worth keeping
    // last, so callers that want ONE line should take the last
    // entry rather than stitching every quote together — joining
    // them produces the kind of disjointed, unrelated-looking reply
    // this was breaking on.
    function extractQuotedSpans(text) {

        if (!text) {
            return [];
        }

        const quoted = String(text).match(/["“][^"”]{1,300}["”]/g);

        if (!quoted || !quoted.length) {
            return [];
        }

        return quoted
            .map((part) => part.replace(/^["“]|["”]$/g, '').trim())
            .filter((part) => part.length > 0);

    }

    // Used only to pull an opening line out of a STORY message that
    // carried [CALL] — that text is written in full narrated style
    // by design, so quote-extraction (with a plain-strip fallback)
    // is the right tool there specifically.
    function extractSpokenLines(text) {

        const spans = extractQuotedSpans(text);

        if (spans.length) {
            return spans[spans.length - 1];
        }

        return sanitizePhoneText(text);

    }

    // =====================================================
    // CALL AMBIENT / BACKGROUND SOUND CUES
    // =====================================================
    // A call reply is allowed exactly one optional extra: a short
    // [SFX: ...] tag describing a background sound genuinely part of
    // the scene {{char}} is in right now — rain outside a window, a
    // bird outside, traffic passing — never a description of {{char}}
    // themselves (no gestures, expressions, or actions belong here,
    // only ambient audio). Pulled out before the rest of the phone
    // sanitizer runs so it survives being treated like ordinary
    // narration and stripped. Texting mode never gets this tag at
    // all — see buildPhoneReplyPrompt below.
    const DASHBOARD_CALL_AMBIENT_TAG =
        /\[\s*(?:sfx|act|cam)\s*:\s*([^\]]{1,400})\]/gi;

    // How many spoken call lines to skip after one ambient cue gets
    // used, so the background never narrates on every single line —
    // "a little, now and then" rather than constant scene-setting.
    const CALL_AMBIENT_COOLDOWN_TURNS = 1;

    // The call screen is allowed a little narration — one short
    // [ACT: ...] beat, roughly a single sentence — so a call feels
    // like a scene instead of bare dialogue. Deliberately much
    // tighter than main-story narration: no paragraphs, no inner
    // monologue, no describing {{user}}.
    function CALL_ACTION_BEAT_RULE(characterName) {

        return (
            'กติกาคำบรรยายสั้นเผื่อนอึดเฉพาะตอนโทร (ห้ามใช้ตอนพิมพ์แชท): นอกจากเสียงพื้นหลัง ' +
            'ใส่คำบรรยายสั้น ๆ ได้อีกอย่างมากหนึ่งอย่างต่อข้อความ ผ่านแท็ก ' +
            '[ACT: สิ่งที่ ' + characterName + ' ทำอยู่ตอนนี้ สั้น ๆ] ไว้ที่ต้นข้อความ ก่อนคำพูด โดยมีเงื่อนไขเคร่งครัดว่า ' +
            '(1) สั้นมาก ไม่เกินหนึ่งประโยคสั้น ๆ ห้ามเขียนยาวเป็นย่อหน้าเหมือนเนื้อเรื่องหลัก ' +
            '(2) เป็นกิริยาหรือน้ำเสียงที่ {{user}} รับรู้ได้ผ่านสายเท่านั้น ' +
            '(3) ห้ามบรรยาย {{user}} ห้ามบรรยายความคิดในใจตัวละคร ห้ามเดินเรื่องแทนการคุย ' +
            '(4) ไม่ต้องใส่ทุกข้อความ ใส่เพียงเป็นจังหวะที่มีอะไรน่าเล่าจริง ๆ เท่านั้น'
        );

    }

    // A video call is the one place narration belongs: {{char}}
    // can be seen, and the room behind them can be seen. The beat is
    // still capped well below main-story length (2–3 sentences) so
    // the call screen never turns into a wall of prose.
    function CALL_VIDEO_RULES(characterName) {

        const cameraOff =
            typeof callState === 'object' &&
            callState &&
            callState.video &&
            callState.cameraOff;

        const rules = [
            'กติกาเฉพาะตอนวิดีโอคอล (ต่างจากสายเสียงถรรมดา): คราวนี้มองเห็นกันได้ จึงบรรยายสิ่งที่กล้องเห็นได้ ' +
                'โดยใส่ไว้ในแท็ก [CAM: ...] ที่ต้นข้อความ ก่อนคำพูด ยาว 2-3 ประโยค ห้ามยาวเป็นย่อหน้าเหมือนเนื้อเรื่องหลัก',
            '- [CAM: ...] ใส่ได้เกือบทุกตาของวิดีโอคอล เขียนเฉพาะสิ่งที่ "เห็นผ่านกล้อง" เท่านั้น — สีหน้า ท่าทาง เสื้อผ้า ห้องที่อยู่ แสงไฟ สิ่งที่อยู่ข้างหลัง',
            '- ห้ามเขียนความคิดในใจตัวละคร ห้ามเดินเรื่องแทนการคุย และห้ามบรรยายการกระทำของ {{user}} แทนผู้เล่น',
            '- ห้ามใส่ดอกจัน *...* หรือบรรยายนอกแท็ก [CAM: ...] ทุกกรณี — นอกแท็กต้องเป็นคำพูดล้วน ๆ',
            'ตัวอย่างที่ถูก: [CAM: เขานั่งอยู่ริมเตียงห้องที่เปิดไฟดวงเดียว ของบนโต๊ะมีเอกสารกองอยู่หลายกอง เขาเอี้ยกล้องให้ตรงหน้าขึ้นอีกนิด] "เห็นหรือเปล่า งานยังไม่เสร็จเลย"'
        ];

        if (cameraOff) {

            rules.push(
                '- ตอนนี้ {{user}} ปิดกล้องของตัวเองอยู่ ' + characterName + ' จึงมองหน้า {{user}} ไม่เห็น ได้ยินแต่เสียงเท่านั้น ให้เล่นตามนี้'
            );

        } else {

            rules.push(
                '- ตอนนี้กล้องของ {{user}} เปิดอยู่ ' + characterName + ' จึงเห็นหน้า {{user}} ได้ตามปกติ'
            );

        }

        return rules.join('\n');

    }

    function extractCallAmbientCue(text) {

        if (!text) {
            return { cue: '', rest: text || '' };
        }

        // The regex is global so a reply carrying both an [SFX: ...]
        // and an [ACT: ...] beat keeps both; lastIndex is reset each
        // time because a global regex is stateful between calls.
        DASHBOARD_CALL_AMBIENT_TAG.lastIndex = 0;

        const raw = String(text);
        const cues = [];
        let match;

        while ((match = DASHBOARD_CALL_AMBIENT_TAG.exec(raw)) !== null) {

            const cue = match[1]
                .replace(/["'“”*]+/g, '')
                .trim();

            if (cue) {
                cues.push(cue);
            }

        }

        if (!cues.length) {
            return { cue: '', rest: text };
        }

        DASHBOARD_CALL_AMBIENT_TAG.lastIndex = 0;

        return {
            cue: cues.join(' '),
            rest: raw.replace(DASHBOARD_CALL_AMBIENT_TAG, ' ')
        };

    }

    // Actually logs an ambient cue into the phone thread as its own
    // 'call-ambient' entry, gated by the cooldown above. A no-op
    // outside a live call for this same character (e.g. the call was
    // hung up while the reply was still generating).
    function logCallAmbientCue(characterName, cue) {

        if (
            !cue ||
            !callState ||
            callState.name !== characterName ||
            !isCallOpen()
        ) {
            return;
        }

        // On a video call the visual beat IS the point, so it is
        // never rate-limited — unlike the occasional ambient cue on a
        // voice call.
        if (!callState.video && (callState.ambientCooldown || 0) > 0) {
            callState.ambientCooldown -= 1;
            return;
        }

        appendPhoneMessage(characterName, 'in', cue, 'call-ambient');

        callState.ambientCooldown = CALL_AMBIENT_COOLDOWN_TURNS;

    }

    // Strips markup noise a roleplay model tends to add: paired
    // pseudo-XML/HTML tags AND their contents (e.g. <clock>...
    // </clock>, <planning>...</planning> blocks some character
    // formatting styles inject), any tag left over on its own,
    // asterisked stage directions, bracketed notes, and any leftover
    // line built entirely around a clock/hourglass glyph (a
    // scene-timestamp header, never something a person texts).
    function stripPhoneMarkup(text) {

        let cleaned = String(text || '');

        // Paired tags + their content, repeated until none remain
        // (handles tags left nested or side-by-side).
        let previous;

        do {

            previous = cleaned;

            cleaned = cleaned.replace(
                /<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g,
                ' '
            );

        } while (cleaned !== previous);

        return cleaned
            .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
            .replace(/\*[^*]*\*/g, ' ')
            .replace(/\[[^\]]*\]/g, ' ')
            .split(/\r?\n/)
            .filter((line) => !/[⌛⏳🕐-🕧]/u.test(line))
            .join('\n');

    }

    // Full sanitizer for a generated phone/call line: strips markup
    // noise, prefers the LAST bit of actual quoted speech if the
    // model wrote any (the punchline of a narrated paragraph, not
    // every quote stitched together), otherwise falls back to the
    // plain leftover text — always capped to a handful of short
    // lines, never a narrated block.
    function sanitizePhoneText(text, characterName) {

        if (!text) {
            return '';
        }

        const stripped = stripPhoneMarkup(text);
        const spans = extractQuotedSpans(stripped);

        const namePattern = characterName
            ? new RegExp(
                `^\\s*(?:${characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|{{char}}|{{user}}|คุณ)\\s*[:：]\\s*`,
                'i'
            )
            : /^\s*(?:{{char}}|{{user}})\s*[:：]\s*/i;

        const source = spans.length ? spans[spans.length - 1] : stripped;

        return source
            .split(/\r?\n+/)
            .map((line) => (
                line
                    .replace(namePattern, '')
                    .replace(/^\s*[-–—•>]+\s*/, '')
                    .replace(/^["'“”]+|["'“”]+$/g, '')
                    .trim()
            ))
            .filter((line) => line.length > 0)
            .slice(0, 4)
            .join('\n');

    }

    // True when a generated line — BEFORE sanitizing — still reads
    // like narration rather than something typed into a phone: too
    // long, several separate quoted speakers stitched into one
    // block, ellipsis-heavy fragments (a narrated paragraph's
    // rhythm, not how someone texts), a blank-line paragraph break,
    // or the character talking about themselves in third person.
    function looksLikeNarration(rawText, sanitizedText, characterName) {

        if (!sanitizedText) {
            return true;
        }

        if (sanitizedText.length > PHONE_NARRATION_LENGTH_LIMIT) {
            return true;
        }

        if (/\n\s*\n/.test(sanitizedText)) {
            return true;
        }

        if ((sanitizedText.match(/\.\.\.|…/g) || []).length >= 2) {
            return true;
        }

        if (extractQuotedSpans(rawText).length > 1) {
            return true;
        }

        if (
            characterName &&
            new RegExp(
                characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                'i'
            ).test(sanitizedText)
        ) {
            return true;
        }

        return false;

    }

    // The recent back-and-forth on the phone, written out for the
    // model so its next text follows this conversation and not just
    // the main story.
    function buildPhoneTranscript(characterName) {

        const thread = getPhoneThread(characterName)
            .slice(-PHONE_TRANSCRIPT_LINES);

        if (!thread.length) {
            return '(ยังไม่เคยคุยกันในแอปนี้มาก่อน)';
        }

        return thread
            .map((entry) => (
                `${entry.from === 'in' ? characterName : '{{user}}'}: ${entry.text}`
            ))
            .join('\n');

    }

    // The last thing {{user}} actually typed on the phone, so the
    // prompt can point straight at it instead of trusting the model
    // to notice it inside the transcript block.
    function getLastOutgoingPhoneLine(characterName) {

        const thread = getPhoneThread(characterName);

        for (let i = thread.length - 1; i >= 0; i--) {

            if (thread[i] && thread[i].from === 'out' && thread[i].text) {
                return thread[i].text;
            }

        }

        return '';

    }

    // One instruction block for whichever surface is asking: the
    // texting thread or the live call. Both demand spoken words
    // only, both are told to answer what {{user}} actually just
    // said rather than drifting into scene-setting, and both are
    // told to stay consistent with the main story happening right
    // now. `strict` tightens the wording for a retry, after a first
    // attempt came back narrated anyway.
    function buildPhoneReplyPrompt(characterName, mode, strict) {

        const isVideo = mode === 'video';
        const isCall = mode === 'call' || isVideo;

        const situation = isVideo
            ? `ตอนนี้ {{user}} กับ ${characterName} กำลังวิดีโอคอลกันอยู่ มองเห็นกันได้ทั้งสองฝ่าย เขียนสิ่งที่ ${characterName} พูด พร้อมคำบรรยายสิ่งที่กล้องเห็นสั้น ๆ ตามกติกาด้านล่าง`
            : isCall
            ? `ตอนนี้ {{user}} กับ ${characterName} กำลังคุยโทรศัพท์กันอยู่ เขียนเฉพาะ "สิ่งที่ ${characterName} พูดออกมาในสาย" เท่านั้น`
            : `ตอนนี้ {{user}} กำลังส่งข้อความหา ${characterName} ในแอปแชทของโทรศัพท์ เขียนเฉพาะ "ข้อความที่ ${characterName} พิมพ์ตอบกลับ" เท่านั้น`;

        const lastLine = getLastOutgoingPhoneLine(characterName);

        const lines = [
            '[OOC — ระบบโทรศัพท์: นี่คือแอปแชท/โทรศัพท์ ไม่ใช่เนื้อเรื่องหลัก อ่านเพื่อทราบบริบทเท่านั้น ห้ามเขียนต่อเนื้อเรื่องหลักในคำตอบนี้]',
            situation,
            '',
            'กติกาที่ต้องทำตามอย่างเคร่งครัด:',
            `- ต้องตอบสิ่งที่ {{user}} เพิ่งพิมพ์/พูดมาล่าสุดโดยตรงก่อนเสมอ อย่าเปลี่ยนเรื่องหรือเล่าฉากอื่นแทนการตอบ`,
            '- ผลลัพธ์ทั้งหมดคือสิ่งที่พิมพ์ลงแอปแชทหรือพูดในสายเท่านั้น ห้ามมีคำบรรยายเจือปนแม้แต่ประโยคเดียว' +
                (isCall ? ' (ยกเว้นแท็ก [SFX: ...] และ [ACT: ...] ตามกติกาพิเศษด้านล่างเท่านั้น)' : ''),
            '- ห้ามบรรยายฉาก ท่าทาง สีหน้า ความรู้สึก อากาศ เวลา หรือสิ่งแวดล้อมใด ๆ ทั้งสิ้น ไม่ว่าจะมีเครื่องหมาย *ดอกจัน* หรือไม่ก็ตาม' +
                (isCall
                    ? ' ข้อยกเว้นเดียวคือแท็ก [SFX: ...] กับ [ACT: ...] ตามกติกาพิเศษเท่านั้น ห้ามบรรยายนอกแท็กเด็ดขาด'
                    : ' ห้ามบรรยายเสียงด้วยเช่นกัน'),
            '- ห้ามเขียนถึงตัวเองในมุมมองบุคคลที่สาม (เช่นห้ามพิมพ์ชื่อตัวเองแล้วบรรยายว่าทำอะไร)',
            '- ห้ามใส่ป้ายเวลา วันที่ หรือสัญลักษณ์นาฬิกา/ทรายไหลใด ๆ',
            '- ห้ามใส่ชื่อผู้พูดนำหน้า เครื่องหมายคำพูดครอบทั้งข้อความ แท็ก หรือคำอธิบายใด ๆ' +
                (isCall ? ' (นอกจาก [SFX: ...] กับ [ACT: ...] ที่ขึ้นต้นได้ตามกติกาด้านล่าง)' : ''),
            '- ห้ามยกคำพูดของคนอื่นในเรื่องหลักมาแทรก ตอบเป็นคำพูดของ ' + characterName + ' เองเพียงคนเดียว หนึ่งข้อความ ไม่ใช่หลายประโยคที่ตัดปะมาจากคนละที่',
            `- สั้น กระชับ 1-3 ประโยคสั้น ๆ เหมือนคนจริงพิมพ์แชท ในน้ำเสียงและนิสัยของ ${characterName}`,
            '- ต้องต่อเนื่องกับบทสนทนาในโทรศัพท์ด้านล่าง และตอบในน้ำเสียง/บุคลิกของตัวละครตามข้อมูลที่ให้ไว้',
            '- ห้ามเปลี่ยนไปคุยเรื่องอื่นที่ไม่เกี่ยวกับสิ่งที่ {{user}} เพิ่งพิมพ์มา',
            '',
            'ตัวอย่างคำตอบที่ถูกต้อง (คำถาม "อยู่ไหนแล้ว" ตอบว่า): "อยู่หน้าลานจอดรถแล้วนะ เดี๋ยวรอตรงนี้เลย"',
            'ตัวอย่างคำตอบที่ผิด (ห้ามทำแบบนี้เด็ดขาด): เขายิ้มมุมปากก่อนเอื้อมมือหยิบโทรศัพท์ขึ้นมาพิมพ์ตอบกลับด้วยแววตาอ่อนโยนว่า "อยู่หน้าลานจอดรถแล้วนะ"'
        ];

        // Calls (never texting) get one narrow, optional exception to
        // "no narration": a single [SFX: ...] background-sound tag,
        // used sparingly, for genuine ambient audio only — never for
        // what {{char}} is doing, feeling, or looking like.
        if (isVideo) {

            lines.push(
                '',
                CALL_VIDEO_RULES(characterName)
            );

        } else if (isCall) {

            lines.push(
                '',
                'กติกาพิเศษเฉพาะตอนโทร (ห้ามใช้ตอนพิมพ์แชท): ถ้าฉากรอบตัว ' +
                    characterName +
                    ' ตอนนี้มีเสียงพื้นหลังที่สมจริงและน่าจะได้ยินผ่านสาย เช่น เสียงฝนตกเบา ๆ เสียงนกร้อง เสียงรถวิ่งผ่าน เสียงลมพัด เสียงคนพลุกพล่าน — และนาน ๆ ครั้งเท่านั้น ไม่ใช่ทุกข้อความ — ให้ใส่แท็ก [SFX: คำอธิบายเสียงสั้น ๆ ไม่เกินหนึ่งประโยค] ไว้ที่ต้นข้อความ ก่อนคำพูดของ ' +
                    characterName +
                    ' แท็กนี้ต้องอธิบายเสียงแวดล้อมล้วน ๆ เท่านั้น ห้ามใส่ท่าทาง สีหน้า ��รือการกระทำของ ' +
                    characterName +
                    ' ลงในแท็กนี้เด็ดขาด และถ้าฉากไม่มีเสียงพื้นหลังอะไรน่าสนใจ ก็ไม่ต้องใส่แท็กนี้เลย',
                'ตัวอย่างที่ถูกต้อง: [SFX: เสียงฝนตกปรอย ๆ แว่วมาจากนอกหน้าต่าง] "เดี๋ยวนี้ฝนตกอยู่เลย รอสักครู่นะ"',
                'ตัวอย่างที่ผิด (ห้ามทำ): [SFX: เขายิ้มแล้วเอนหลังพิงเก้าอี้] "ว่าไง"',
                CALL_ACTION_BEAT_RULE(characterName),
                'ตัวอย่างที่ถูก: [ACT: เขาเอนหลังกับขอบหน้าต่าง เปลี่ยนมือถือหูฟังอีกข้าง] "เหนื่อยหรือเปล่า"',
                'ตัวอย่างที่ผิด (ยาวเกินไปห้ามทำ): [ACT: เขาเงียบฟังเสียงนั้นอยู่นิ่ง ๆ นิ้วมือเคาะขอบโต๊ะเบา ๆ หัวใจเต้นแรงเมื่อได้ยินเสียงนั้น เขาหลุบตาลงนิ่ง ๆ ก่อนจะตอบ]'
            );

        }

        if (strict) {

            lines.push(
                '',
                'คำตอบก่อนหน้านี้ยังผิดกติกา (มีคำบรรยายปน หรือไม่ได้ตอบสิ่งที่ {{user}} เพิ่งพิมพ์มา หรือเอาคำพูดของคนอื่นมาปน) เขียนใหม่อีกครั้ง: ตอบตรงประเด็นสิ่งที่ {{user}} เพิ่งพิมพ์มาล่าสุดเท่านั้น เป็นคำพูดของ ' + characterName + ' คนเดียว สั้น ๆ ล้วน ๆ ห้ามมีคำบรรยายใด ๆ แม้แต่คำเดียว'
            );

        }

        lines.push(
            '',
            'บทสนทนาในโทรศัพท์ที่ผ่านมา:',
            buildPhoneTranscript(characterName)
        );

        if (lastLine) {

            lines.push(
                '',
                `ข้อความล่าสุดที่ {{user}} เพิ่งพิมพ์มาคือ: "${lastLine}" — ตอบข้อความนี้ตรง ๆ`
            );

        }

        lines.push(
            '',
            isCall
                ? `${characterName} พูดว่า:`
                : `${characterName} พิมพ์ตอบว่า:`
        );

        return lines.join('\n');

    }

    // The one-off "call just connected" opening line for a call that
    // {{user}} asked for directly in the texting thread. {{char}}
    // already answered that request over text a few seconds earlier
    // (see sendChatMessage), so unlike buildPhoneReplyPrompt this
    // deliberately does NOT tell the model to answer {{user}}'s last
    // line — that's exactly what made the call's opening line echo
    // the text reply almost word for word. This only ever needs a
    // short, natural "the call just picked up" beat.
    function buildCallConnectPrompt(characterName, userDialed, isVideo) {

        const lines = [
            '[OOC — ระบบโทรศัพท์: นี่คือแอปแชท/โทรศัพท์ ไม่ใช่เนื้อเรื่องหลัก อ่านเพื่อทราบบริบทเท่านั้น ห้ามเขียนต่อเนื้อเรื่องหลักในคำตอบนี้]',
            userDialed
                ? `ตอนนี้ {{user}} กด${isVideo ? 'วิดีโอคอลหา' : 'โทรหา'} ${characterName} ในแอปโทรศัพท์ และ ${characterName} เพิ่งกดรับสายเมื่อกี้วินาทีนี้เอง คนที่ต้องพูดคนแรกคือคนที่รับสาย คือ ${characterName}`
                : `ตอนนี้ {{user}} เพิ่งขอให้ ${characterName} โทรหาในแอปแชท และ ${characterName} เพิ่งพิมพ์ตอบรับไปแล้วก่อนหน้านี้ว่าจะโทร ตอนนี้สายต่อติดแล้วจริง ๆ`,
            '',
            'กติกาที่ต้องทำตามอย่างเคร่งครัด:',
            `- เขียนเฉพาะประโยคสั้น ๆ ที่ ${characterName} พูดตอนสายเพิ่งต่อเท่านั้น เช่นคำทักทายธรรมดา (1 ประโยคสั้น ๆ)`,
            '- ห้ามตอบคำถามหรือพูดซ้ำเนื้อหาที่เพิ่งพิมพ์ตอบไปแล้วก่อนหน้านี้ในแชทอีกรอบเด็ดขาด นี่คือประโยคเปิดสายใหม่ ไม่ใช่การพิมพ์ตอบซ้ำ',
            '- ผลลัพธ์คือสิ่งที่พูดในสาย บวกกับแท็ก [SFX: ...] / [ACT: ...] เท่านั้น ห้ามบรรยายนอกแท็กเหล่านี้เด็ดขาด',
            '- ห้ามใส่ชื่อผู้พูดนำหน้า เครื่องหมายคำพูดครอบทั้งข้อความ หรือคำอธิบายใด ๆ',
            '- ห้ามคัดลอกหรือพูดซ้ำข้อความล่าสุดในแชทโดยเด็ดขาด ต้องเป็นประโยคใหม่ที่เหมาะกับการเพิ่งรับสายเท่านั้น',
            '- สั้น กระชับ ในน้ำเสียงและนิสัยของ ' + characterName,
            '',
            isVideo
                ? CALL_VIDEO_RULES(characterName)
                : CALL_ACTION_BEAT_RULE(characterName),
            isVideo
                ? 'ตัวอย่างที่ถูก: [CAM: กล้องสั่นเล็กน้อยก่อนจะนิ่ง เห็นหน้าเขาในห้องที่เปิดไฟอยู่ดวงเดียว] "ฮัลโล รอเดี๋ยว"นะ"'
                : 'ตัวอย่างที่ถูก: [ACT: เขากดรับสายตอนกำลังเอนหลังกับขอบหน้าต่าง] "ฮัลโล"',
            '',
            'บทสนทนาในโทรศัพท์ที่ผ่านมา:',
            buildPhoneTranscript(characterName),
            '',
            `${characterName} พูดว่า:`
        ];

        return lines.join('\n');

    }

    // Runs one generateQuietPrompt call. SillyTavern changed its
    // signature between versions (positional arguments in older
    // builds, one options object in newer ones), so the shape is
    // picked from the function's own arity instead of guessing.
    // skipWIAN is true: the heavier per-character formatting rules
    // some cards inject through World Info / Author's Note are what
    // usually drags a quiet phone reply back into full narration, so
    // the phone deliberately generates without them.
    // Looks up the actual character card (as loaded in SillyTavern's
    // character list) for whoever this phone thread is with, by
    // name. This is where the bot's own description/personality
    // comes from now that the phone no longer piggybacks on the
    // main story's chat log for context.
    function findPhoneCharacterCard(characterName) {

        const context = getDashboardContext();

        if (!context || !Array.isArray(context.characters) || !characterName) {
            return null;
        }

        return context.characters.find(
            (entry) => entry && entry.name === characterName
        ) || null;

    }

    // Builds the "who this character is" block from their own card
    // — description, personality, scenario — completely independent
    // of the main story's chat log. This is the ONLY place character
    // identity comes from for phone replies now: no main-story
    // messages are read or sent to the model at all any more.
    function buildPhoneCharacterBrief(characterName) {

        const card = findPhoneCharacterCard(characterName);

        const lines = [
            `คุณกำลังเล่นเป็นตัวละครชื่อ "${characterName}" กำลังคุยผ่านแอปข้อความ/โทรศัพท์กับ {{user}} เท่านั้น (ไม่ใช่เรื่องหลัก)`
        ];

        if (card) {

            if (card.description) {
                lines.push('', 'ข้อมูลตัวละคร:', card.description);
            }

            if (card.personality) {
                lines.push('', 'นิสัย/บุคลิก:', card.personality);
            }

            if (card.scenario) {
                lines.push('', 'ฉาก/สถานการณ์ทั่วไปของตัวละครนี้:', card.scenario);
            }

        }

        return lines.join('\n');

    }

    // Runs one generation for the phone/call reply. This used to
    // call generateQuietPrompt(), which pulls in the ENTIRE main
    // story chat log as context every single time — slow on a long
    // roleplay, and (as of the last revision) actively unsafe: an
    // earlier attempt to shorten that shared chat array in place
    // caused replies to hang and never come back, because
    // SillyTavern's own generation pipeline can still be reading
    // that exact array while the phone is mid-request.
    //
    // Instead this now calls generateRaw() when available, which
    // does NOT touch the main chat at all — the only context the
    // model gets is the character brief built above plus the
    // phone-only transcript already baked into `prompt`. Nothing
    // about the main story is read or sent, so this is both fully
    // decoupled AND much lighter/faster than before.
    async function runQuietPhonePrompt(context, prompt, characterName) {

        const systemPrompt = buildPhoneCharacterBrief(characterName);

        if (typeof context.generateRaw === 'function') {

            try {

                const rawResult = (context.generateRaw.length <= 1)
                    ? await context.generateRaw({
                        prompt,
                        quietToLoud: false,
                        systemPrompt
                    })
                    : await context.generateRaw(
                        prompt,
                        null,
                        false,
                        false,
                        systemPrompt
                    );

                // Different SillyTavern builds return either a plain
                // string, or an object with the text on a .text /
                // .message / .content property. Normalizing here
                // means the sanitizer downstream always gets a real
                // string instead of "[object Object]" turning into
                // stray-looking punctuation after cleanup.
                const normalized = (typeof rawResult === 'string')
                    ? rawResult
                    : (rawResult && (rawResult.text || rawResult.message || rawResult.content)) || '';

                console.log(
                    '[Dashboard] generateRaw() returned:',
                    rawResult,
                    '→ normalized:',
                    normalized
                );

                if (normalized) {
                    return normalized;
                }

                console.log(
                    '[Dashboard] generateRaw() returned nothing usable, falling back to generateQuietPrompt'
                );

            } catch (error) {

                console.log(
                    '[Dashboard] generateRaw failed, falling back to generateQuietPrompt',
                    error
                );

            }

        }

        // Fallback for older SillyTavern builds without generateRaw.
        // This still uses generateQuietPrompt (so it will be a bit
        // slower and technically main-chat-aware again on those
        // older builds only), but never mutates the shared chat
        // array — that's the part that caused replies to hang.
        const fallbackPrompt = `${systemPrompt}\n\n${prompt}`;

        if (context.generateQuietPrompt.length <= 1) {

            return context.generateQuietPrompt({
                quietPrompt: fallbackPrompt,
                quietToLoud: false,
                skipWIAN: true,
                quietName: characterName
            });

        }

        return context.generateQuietPrompt(
            fallbackPrompt,
            false,
            true,
            null,
            characterName
        );

    }

    // A sanitized line only counts as "usable" if it actually has
    // some letters/numbers left in it. Guards against the case where
    // the model wrapped its whole reply in narration/asterisks and
    // the quote-stripping above leaves nothing behind but stray
    // punctuation like ")" or "*" — that used to get treated as a
    // valid one-word reply and shown to the user as-is.
    function hasReadableContent(text) {
        return !!text && /[\p{L}\p{N}]/u.test(text);
    }

    // Generates one phone/call line: asks once, sanitizes it, and —
    // only if the raw or sanitized result still looks narrated —
    // asks exactly once more with a stricter reminder. Whichever
    // pass comes back clean wins; if neither does, the shorter of
    // the two is used, hard-capped so it can never balloon into a
    // wall of text on screen. For a call, any [SFX: ...] tag riding
    // along on whichever pass is actually used gets pulled out first
    // and logged as its own ambient thread entry (cooldown-gated —
    // see logCallAmbientCue) — never part of the returned dialogue
    // line itself.
    async function requestPhoneGeneration(characterName, mode) {

        const context = getDashboardContext();

        if (!context || typeof context.generateQuietPrompt !== 'function') {

            throw new Error(
                'SillyTavern build นี้ไม่มี generateQuietPrompt — อัปเดต SillyTavern แล้วลองใหม่'
            );

        }

        const isCall =
            mode === 'call' ||
            mode === 'call-connect' ||
            mode === 'call-answer' ||
            mode === 'video' ||
            mode === 'video-connect' ||
            mode === 'video-answer';

        const isVideoMode =
            mode === 'video' ||
            mode === 'video-connect' ||
            mode === 'video-answer';

        // 'call-connect'  → the character called us
        // 'call-answer'   → we dialed and they just picked up
        const isConnectLine =
            mode === 'call-connect' ||
            mode === 'call-answer' ||
            mode === 'video-connect' ||
            mode === 'video-answer';
        let ambientCue = '';

        let firstRaw;

        try {

            firstRaw = await runQuietPhonePrompt(
                context,
                isConnectLine
                    ? buildCallConnectPrompt(
                        characterName,
                        mode === 'call-answer' || mode === 'video-answer',
                        isVideoMode
                    )
                    : buildPhoneReplyPrompt(characterName, mode, false),
                characterName
            );

        } catch (error) {

            console.log(
                '[Dashboard] First-pass phone generation threw an error:',
                error
            );

            throw error;

        }

        console.log('[Dashboard] Phone raw reply (1st pass):', firstRaw);

        if (isCall) {

            const extracted = extractCallAmbientCue(firstRaw);

            if (extracted.cue) {
                ambientCue = extracted.cue;
            }

            firstRaw = extracted.rest;

        }

        const firstClean = sanitizePhoneText(firstRaw, characterName);

        if (
            hasReadableContent(firstClean) &&
            !looksLikeNarration(firstRaw, firstClean, characterName)
        ) {

            if (isCall) {
                logCallAmbientCue(characterName, ambientCue);
            }

            return firstClean;

        }

        try {

            let retryRaw = await runQuietPhonePrompt(
                context,
                isConnectLine
                    ? buildCallConnectPrompt(
                        characterName,
                        mode === 'call-answer' || mode === 'video-answer',
                        isVideoMode
                    )
                    : buildPhoneReplyPrompt(characterName, mode, true),
                characterName
            );

            console.log('[Dashboard] Phone raw reply (retry pass):', retryRaw);

            if (isCall) {

                const extractedRetry = extractCallAmbientCue(retryRaw);

                // The retry is the version that actually gets used
                // from here on, so its own cue (if any) is what
                // counts — a cue caught on the first pass but not
                // repeated on the retry shouldn't still be logged.
                ambientCue = extractedRetry.cue;

                retryRaw = extractedRetry.rest;

            }

            const retryClean = sanitizePhoneText(retryRaw, characterName);

            if (
                hasReadableContent(retryClean) &&
                !looksLikeNarration(retryRaw, retryClean, characterName)
            ) {

                if (isCall) {
                    logCallAmbientCue(characterName, ambientCue);
                }

                return retryClean;

            }

            // Neither pass came back clean — keep whichever is
            // shorter (closer to an actual chat line) and hard-cap
            // it so the UI never has to render a narrated wall. If
            // NEITHER has any actual readable content (both are just
            // leftover punctuation), don't show that at all — show a
            // clear "didn't come through" bubble instead so it's
            // obvious something needs looking at, rather than a
            // cryptic ")" or "*".
            const best = (
                hasReadableContent(retryClean) &&
                (!hasReadableContent(firstClean) || retryClean.length < firstClean.length)
            ) ? retryClean : firstClean;

            if (!hasReadableContent(best)) {
                return '[ข้อความที่ได้ไม่สมบูรณ์ ลองส่งใหม่อีกครั้ง]';
            }

            if (isCall) {
                logCallAmbientCue(characterName, ambientCue);
            }

            return best.length > PHONE_NARRATION_LENGTH_LIMIT
                ? `${best.slice(0, PHONE_NARRATION_LENGTH_LIMIT).trim()}…`
                : best;

        } catch (error) {

            console.log(
                '[Dashboard] Retry generation failed, using first pass',
                error
            );

            if (!hasReadableContent(firstClean)) {
                return '[ข้อความที่ได้ไม่สมบูรณ์ ลองส่งใหม่อีกครั้ง]';
            }

            if (isCall) {
                logCallAmbientCue(characterName, ambientCue);
            }

            return firstClean.length > PHONE_NARRATION_LENGTH_LIMIT
                ? `${firstClean.slice(0, PHONE_NARRATION_LENGTH_LIMIT).trim()}…`
                : firstClean;

        }

    }

    // =====================================================
    // SPONTANEOUS CALLS (the bot decides to call on its own)
    // =====================================================
    // Separate from the [CALL] story tag below — this doesn't wait
    // for the main story to produce a line at all. On a timer, while
    // the dashboard is open and no call is already happening, it
    // quietly asks the model "would this character call {{user}}
    // right now, unprompted?" the same independent way a text reply
    // is asked for — nothing added to the main story either way.

    // How often the watcher even considers checking.
    const SPONTANEOUS_CALL_CHECK_INTERVAL_MS = 120000; // 2 minutes

    // Of each check, how often it actually asks the model at all —
    // keeps this from generating on every single tick, and keeps the
    // eventual call feeling occasional rather than scheduled.
    const SPONTANEOUS_CALL_CHANCE = 0.2;

    // Quiet period after ANY call ends before the watcher will ask
    // again, so a call that just wrapped up doesn't get followed
    // immediately by another one.
    const SPONTANEOUS_CALL_MIN_GAP_MS = 5 * 60000; // 5 minutes

    let spontaneousCallTimer = null;
    let spontaneousCallCheckInFlight = false;

    // Whichever character the dashboard is currently "with" — the
    // contact thread open right now if there is one, otherwise
    // whoever's profile is on screen. Only returns a name that
    // actually matches a loaded character card, so a placeholder
    // like the default "Character" label never triggers a call.
    function pickSpontaneousCallCandidate() {

        const candidate = (activeChatName && activeChatName !== 'ระบบ')
            ? activeChatName
            : getActiveProfileName();

        if (!candidate || !findPhoneCharacterCard(candidate)) {
            return null;
        }

        return candidate;

    }

    // Asks the model to decide, in the character's own voice, using
    // only the phone thread as context (same independence as texting
    // and regular calls). A clean "no" comes back as the literal
    // token NOCALL; a "yes" comes back as the opening line to speak
    // once {{user}} answers.
    function buildSpontaneousCallPrompt(characterName) {

        const lines = [
            '[OOC — ระบบโทรศัพท์: นี่คือการเช็คเบื้องหลังว่า ' +
                characterName +
                ' จะโทรหา {{user}} เองตอนนี้หรือไม่ ไม่ใช่เนื้อเรื่องหลัก อ่านเพื่อทราบบริบทเท่านั้น ห้ามเขียนต่อเนื้อเรื่องหลักในคำตอบนี้]',
            'พิจารณานิสัยของ ' +
                characterName +
                ' และบทสนทนาทางโทรศัพท์/แชทที่ผ่านมาด้านล่าง แล้วตัดสินใจว่าตอนนี้ ' +
                characterName +
                ' จะอยากหยิบโทรศัพท์ขึ้นมาโทรหา {{user}} เอง โดยไม่มีใครชวนหรือพิมพ์ชวนมาก่อนหรือไม่',
            'เป็นเรื่องปกติมากที่คนจะโทรหากันโดยไม่มีเหตุผลใหญ่โต เช่น คิดถึง อยากทักทาย อยากเล่าเรื่องเล็ก ๆ น้อย ๆ หรือแค่ว่างพอดี ไม่จำเป็นต้องมีเหตุการณ์สำคัญหรือดราม่าใด ๆ ก่อนโทร',
            '',
            'ถ้า "ใช่ จะโทร": ให้เขียนเฉพาะประโยคแรกที่ ' +
                characterName +
                ' จะพูดทันทีที่ {{user}} รับสาย สั้น ๆ 1-2 ประโยค เหมือนคนจริงเปิดปากพูดตอนโทรหากัน ห้ามมีคำบรรยายฉาก ท่าทาง หรือคำอธิบายใด ๆ ปนอยู่ทั้งสิ้น',
            'ถ้า "ไม่ ยังไม่โทรตอนนี้": ให้ตอบกลับมาเพียงคำเดียวเป๊ะ ๆ คือ NOCALL ห้ามมีคำอื่น เครื่องหมาย หรือช่องว่างอื่นใดเจือปนแม้แต่ตัวเดียว',
            '',
            'บทสนทนาในโทรศัพท์ที่ผ่านมา:',
            buildPhoneTranscript(characterName)
        ];

        return lines.join('\n');

    }

    async function requestSpontaneousCallLine(characterName) {

        const context = getDashboardContext();

        if (!context || typeof context.generateQuietPrompt !== 'function') {
            return '';
        }

        let raw;

        try {

            raw = await runQuietPhonePrompt(
                context,
                buildSpontaneousCallPrompt(characterName),
                characterName
            );

        } catch (error) {

            console.log(
                '[Dashboard] Spontaneous call decision failed',
                error
            );

            return '';

        }

        const trimmed = (raw || '').trim();

        if (
            !trimmed ||
            /^no ?call\.?$/i.test(trimmed.replace(/["'*.]/g, ''))
        ) {
            return '';
        }

        const clean = sanitizePhoneText(raw, characterName);

        if (
            !hasReadableContent(clean) ||
            looksLikeNarration(raw, clean, characterName)
        ) {
            return '';
        }

        return clean;

    }

    // The actual timer tick. Every guard here is a reason to do
    // nothing quietly rather than force a call — this should never
    // feel forced or interrupt something already happening.
    async function maybeTriggerSpontaneousCall() {

        if (spontaneousCallCheckInFlight) {
            return;
        }

        if (!dashboard.classList.contains('open')) {
            return;
        }

        if (isCallOpen()) {
            return;
        }

        if (
            Date.now() - dashboardLastCallEndedAt <
                SPONTANEOUS_CALL_MIN_GAP_MS
        ) {
            return;
        }

        const characterName = pickSpontaneousCallCandidate();

        if (!characterName) {
            return;
        }

        if (Math.random() > SPONTANEOUS_CALL_CHANCE) {
            return;
        }

        spontaneousCallCheckInFlight = true;

        try {

            const opening = await requestSpontaneousCallLine(characterName);

            if (
                opening &&
                !isCallOpen() &&
                dashboard.classList.contains('open')
            ) {
                openIncomingCallScreen(characterName, opening);
            }

        } catch (error) {

            console.log(
                '[Dashboard] Spontaneous call check threw',
                error
            );

        } finally {
            spontaneousCallCheckInFlight = false;
        }

    }

    function startSpontaneousCallWatcher() {

        const context = getDashboardContext();

        if (!context || typeof context.generateQuietPrompt !== 'function') {
            return;
        }

        if (spontaneousCallTimer) {
            return;
        }

        spontaneousCallTimer = setInterval(
            maybeTriggerSpontaneousCall,
            SPONTANEOUS_CALL_CHECK_INTERVAL_MS
        );

    }

    // A lightweight PRE-FILTER only — not the decision itself. It
    // just checks whether a call is even a plausible topic in what
    // {{user}} typed, so the judgment call below (an extra
    // generation) only runs when it's worth asking. The actual
    // decision is left entirely to requestCallIntentDecision(), which
    // asks the model in character: a request to call doesn't have to
    // be honored (the character might be upset, mid-breakup, busy —
    // context {{char}} themselves would weigh), and a request NOT to
    // call doesn't have to be honored either (a stubborn or worried
    // character might call anyway). No fixed keyword rule can capture
    // that, so this file doesn't try to.
    const PHONE_CALL_MENTION_PATTERN = /โทร|call/i;

    function mentionsCall(text) {
        return PHONE_CALL_MENTION_PATTERN.test(text);
    }

    // Asks, in character, whether {{char}} actually calls {{user}}
    // right now — based on the phone conversation so far and
    // {{char}}'s own personality/situation (via buildPhoneCharacterBrief
    // inside runQuietPhonePrompt), not a hardcoded yes/no rule. Expects
    // exactly two lines back: YES or NO, then — only on YES — the
    // opening line {{char}} says once the call connects.
    async function requestCallIntentDecision(characterName) {

        const context = getDashboardContext();

        if (!context) {
            return { willCall: false, line: '' };
        }

        const prompt = [
            '[OOC — ระบบโทรศัพท์: นี่คือคำถามเบื้องหลัง ไม่ใช่เนื้อเรื่อง ห้ามเขียนเนื้อเรื่องหลักหรือคำอธิบายใด ๆ ในคำตอบนี้]',
            `บทสนทนาในแอปแชท/โทรศัพท์ระหว่าง {{user}} กับ ${characterName} ล่าสุดคือ:`,
            buildPhoneTranscript(characterName),
            '',
            `พิจารณาจากนิสัย บุคลิก และสถานการณ์ปัจจุบันของ ${characterName} เอง ไม่ใช่กฎตายตัว ว่า ${characterName} จะ "โทรหา {{user}} จริง ๆ ตอนนี้" หรือไม่ — ต่อให้ {{user}} เพิ่งพิมพ์ขอให้โทร ${characterName} ก็มีสิทธิ์เลือกไม่โทรได้ถ้าไม่อยากคุย โกรธ เพิ่งเลิกกัน หรือยุ่งอยู่ และต่อให้ {{user}} เพิ่งพิมพ์บอกว่าไม่ต้องโทร ${characterName} ก็มีสิทธิ์เลือกจะโทรอยู่ดีถ้านิสัยเป็นแบบนั้น (เช่น ดื้อ เป็นห่วงมาก ไม่ยอมปล่อยเรื่องค้างคาไว้) ให้ตัดสินใจตามตัวละครจริง ๆ`,
            '',
            'ตอบเป็น 2 บรรทัดเท่านั้น ห้ามมีอย่างอื่นปนเด็ดขาด:',
            'บรรทัดแรก: คำเดียว YES ถ้าจะโทรจริงตอนนี้ หรือ NO ถ้าจะไม่โทร',
            `บรรทัดสอง (ใส่เฉพาะกรณี YES เท่านั้น ไม่งั้นเว้นว่างไว้): ประโยคสั้น ๆ ที่ ${characterName} จะพูดตอนสายเพิ่งต่อ ห้ามพูดซ้ำสิ่งที่เพิ่งพิมพ์ตอบไปแล้วในแชท`
        ].join('\n');

        let raw = '';

        try {

            raw = await runQuietPhonePrompt(context, prompt, characterName);

        } catch (error) {

            console.log(
                '[Dashboard] Could not evaluate whether the character would actually call',
                error
            );

            return { willCall: false, line: '' };

        }

        const lines = (raw || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        const willCall = (lines[0] || '').toUpperCase().startsWith('YES');

        if (!willCall) {
            return { willCall: false, line: '' };
        }

        const rawLine = lines.slice(1).join(' ').trim();
        const cleanLine = rawLine ? sanitizePhoneText(rawLine, characterName) : '';

        return {
            willCall: true,
            line: hasReadableContent(cleanLine) ? cleanLine : ''
        };

    }

    // How long after the decision to call before the phone actually
    // starts ringing. Long enough that it doesn't read as the text
    // reply and the ring happening in the same instant.
    const PHONE_CALL_REQUEST_RING_DELAY_MS = 3000;
    const PHONE_CALL_REQUEST_RING_DELAY_JITTER_MS = 2500;

    // Posts the typed line into this contact's phone thread, then
    // asks for a reply that knows what's going on in the main story
    // — all without adding a single entry to that story's log.
    async function sendChatMessage() {

        if (!chatThreadInput || !activeChatName || activeChatName === 'ระบบ') {
            return;
        }

        const name = activeChatName;
        const text = chatThreadInput.value.trim();

        if (!text) {
            return;
        }

        if (isContactBlocked(name)) {
            return;
        }

        chatThreadInput.value = '';
        chatThreadInput.disabled = true;

        if (chatThreadSend) {
            chatThreadSend.disabled = true;
        }

        appendPhoneMessage(name, 'out', text);

        if (isThreadOpenFor(name)) {
            renderChatBody(getChatDisplayHistory(name));
            showTypingBubble();
        }

        renderStoryContacts();

        // Whether a call is even worth asking the model about — the
        // model itself decides whether one actually happens.
        const mightCall = mentionsCall(text) && !isCallOpen();

        try {

            const reply = await requestPhoneGeneration(name, 'text');

            if (reply) {
                appendPhoneMessage(name, 'in', reply);
            }

        } catch (error) {

            console.log(
                '[Dashboard] Could not generate a phone reply',
                error
            );

            appendPhoneMessage(
                name,
                'in',
                '[ไม่สามารถติดต่อได้ในตอนนี้ ลองส่งใหม่อีกครั้ง]'
            );

        }

        if (isThreadOpenFor(name)) {
            renderChatBody(getChatDisplayHistory(name));
        }

        renderStoryContacts();

        if (isThreadOpenFor(name) && chatThreadInput && chatThreadSend) {

            chatThreadInput.disabled = false;
            chatThreadSend.disabled = false;

        }

        if (!mightCall) {
            return;
        }

        let decision = { willCall: false, line: '' };

        try {

            decision = await requestCallIntentDecision(name);

        } catch (error) {

            console.log(
                '[Dashboard] Could not decide whether the character would call back',
                error
            );

        }

        if (!decision.willCall) {
            return;
        }

        const delay =
            PHONE_CALL_REQUEST_RING_DELAY_MS +
            Math.floor(Math.random() * PHONE_CALL_REQUEST_RING_DELAY_JITTER_MS);

        setTimeout(
            async () => {

                if (
                    !isCallOpen() &&
                    dashboard.classList.contains('open')
                ) {

                    // A dedicated prompt for this one moment (used
                    // only if the decision above didn't already come
                    // with an opening line) — not the usual "answer
                    // {{user}}'s last line" call prompt, which was
                    // what produced a call-opening line that just
                    // repeated the text reply already sent a few
                    // seconds earlier.
                    let openingLine = decision.line;

                    if (!openingLine) {

                        try {

                            openingLine = await requestPhoneGeneration(
                                name,
                                'call-connect'
                            );

                        } catch (error) {

                            console.log(
                                '[Dashboard] Could not build a call-connect opening line',
                                error
                            );

                        }

                    }

                    if (
                        !isCallOpen() &&
                        dashboard.classList.contains('open')
                    ) {
                        openIncomingCallScreen(name, openingLine);
                    }

                }

            },
            delay
        );

    }

    // =====================================================
    // LIVE SYNC WITH THE REAL CHAT
    // =====================================================

    // The phone keeps its own log now, so a new line in the main
    // story doesn't rewrite any thread — it just refreshes the
    // contact list (a new NPC may have walked into the story).
    function handleLiveChatChange() {

        renderStoryContacts();

    }

    function handleMessageSent() {

        handleLiveChatChange();

    }

    // The only thing a character's story line can still do to the
    // phone is start or end a call by carrying a [CALL] / [HANGUP]
    // tag.
    function handleMessageReceived() {

        checkForPhoneEvents();

        handleLiveChatChange();

    }

    // =====================================================
    // TEACHING {{char}} THE CALL TAGS
    // =====================================================
    // checkForPhoneEvents() only works if the model actually knows to
    // write [CALL] / [HANGUP]. This drops one short, quiet system
    // instruction into the prompt via SillyTavern's own
    // extension-prompt system, so nobody has to paste it into every
    // character card by hand.
    //
    // NOTE ON COMPATIBILITY: setExtensionPrompt's exact argument order
    // (position/depth/role) has shifted a little across SillyTavern
    // versions. This uses the signature that's been standard for a
    // long time, reading the position/role enums off the context
    // object where possible instead of hardcoding numbers. If a given
    // build's API doesn't line up, this fails quietly (logs to
    // console, changes nothing else) — the tags still work fine if
    // added by hand to a character's example dialogue instead.
    const DASHBOARD_PHONE_TAG_PROMPT_KEY = 'dashboardPhoneTags';

    function installPhoneTagInstruction() {

        const context = getDashboardContext();

        if (!context || typeof context.setExtensionPrompt !== 'function') {

            console.log(
                '[Dashboard] setExtensionPrompt not available — [CALL]/[HANGUP] won\'t be taught automatically. Add them to the character\'s example dialogue instead if you want auto-calls.'
            );

            return;

        }

        const instruction =
            'System note (คำสั่งระบบโทรศัพท์ — เงียบ ไม่ต้องพูดถึงในเนื้อเรื่อง): ' +
            '{{user}} มีโทรศัพท์ติดตัวอยู่เสมอ และ {{char}} สามารถโทรหา ' +
            '{{user}} ได้จริงทุกเมื่อที่รู้สึกอยากคุย ไม่จำเป็นต้องมีเหตุผล ' +
            'หนักแน่นหรือเหตุการณ์สำคัญมาก่อน — แค่คิดถึง อยากทักทาย ' +
            'อยากเล่าเรื่องเล็ก ๆ น้อย ๆ หรือว่างพอดีก็พอแล้ว ถ้าในจังหวะนี้ ' +
            '{{char}} น่าจะหยิบโทรศัพท์ขึ้นมาโทรจริง ๆ ให้เริ่มข้อความนั้นด้วย ' +
            'แท็ก [CALL] ทันที แล้วตามด้วยสิ่งที่ {{char}} พูดออกมาตอนสายต่อ ' +
            'ในข้อความเดียวกันเลย (ห้ามส่ง [CALL] เปล่า ๆ โดยไม่มีคำพูดต่อท้าย) ' +
            'และถ้า {{user}} พิมพ์ขอให้ {{char}} โทรหาตรง ๆ ไม่ว่าจะใช้คำว่าอะไรก็ตาม ' +
            '(เช่น "โทรหาหน่อย", "โทรมาได้ไหม", "อยากคุยโทรศัพท์ด้วย") ' +
            'ให้ {{char}} โทรจริงในข้อความถัดไปทันทีเสมอ โดยเริ่มข้อความนั้นด้วยแท็ก ' +
            '[CALL] แล้วตามด้วยคำพูดตอนสายต่อในข้อความเดียวกัน ห้ามตอบเป็นคำบรรยาย ' +
            'หรือคำสัญญาเฉย ๆ ว่าจะโทร (เช่น "เดี๋ยวโทรไปนะ" หรือ "โอเค รอสายด้วยนะ") ' +
            'โดยไม่ใส่แท็ก [CALL] จริงเด็ดขาด เพราะแอปโทรศัพท์จะไม่เปิดสายให้ถ้าไม่มีแท็กนี้ ' +
            'พอบทสนทนาจบลงตามธรรมชาติ ให้ปิดท้ายบรรทัดสุดท้ายของ {{char}} ' +
            'ในสายนั้นด้วยแท็ก [HANGUP] ห้ามใช้สองแท็กนี้เพื่ออย่างอื่นนอกจาก ' +
            'การเริ่ม/จบสายโทรศัพท์จริง ๆ เด็ดขาด และห้ามพิมพ์ข้อความแชท ' +
            'ธรรมดาลงในเนื้อเรื่องหลักเอง เพราะแอปโทรศัพท์จัดการส่วนนั้นเองอยู่แล้ว ' +
            'สำคัญมาก: สายโทรเป็นการคุยสดในแอปจริง {{user}} จะพูดตอบในสายเอง ' +
            'ดังนั้นข้อความที่มีแท็ก [CALL] ต้องมีแค่ประโยคเปิดสายสั้น ๆ 1-2 ประโยคแล้วหยุดทันที ' +
            'ห้ามเขียนบทสนทนาทั้งสายรวดเดียวล่วงหน้า ห้ามแต่งคำพูดของ {{user}} เอง ' +
            'และห้ามใส่ [HANGUP] ในข้อความเดียวกับ [CALL] เพราะสายเพิ่งเริ่มต้น ' +
            'เมื่อสายจบ ระบบจะส่งบันทึกการสนทนาจริงทั้งหมดเข้ามาให้เอง ให้เล่าเรื่องต่อจากนั้น ' +
            'นอกจากนี้ยังมีวิดีโอคอลด้วย: ถ้า {{char}} อยากเห็นหน้า {{user}} หรืออยากให้ดูอะไรผ่านกล้อง ' +
            '(หรือ {{user}} ขอให้วิดีโอคอล) ให้ขึ้นต้นข้อความนั้นด้วยแท็ก [VCALL] แทน [CALL] ' +
            'แล้วตามด้วยประโยคเปิดสายสั้น ๆ เหมือนกัน แอปจะเปิดหน้าจอวิดีโอคอลให้เอง และในสายวิดีโอคอลสามารถบรรยายสิ่งที่กล้องเห็นได้';

        try {

            const positions = context.extension_prompt_types || {};
            const roles = context.extension_prompt_roles || {};

            context.setExtensionPrompt(
                DASHBOARD_PHONE_TAG_PROMPT_KEY,
                instruction,
                positions.IN_CHAT ?? 1,
                1,
                false,
                roles.SYSTEM ?? 0
            );

        } catch (error) {

            console.log(
                '[Dashboard] Could not install the [CALL]/[HANGUP] instruction',
                error
            );

        }

    }

    (function wireLiveChatEvents() {

        const context = getDashboardContext();

        if (!context || !context.eventSource || !context.event_types) {

            console.log(
                '[Dashboard] No eventSource available — phone chat won\'t live-update.'
            );

            return;

        }

        const events = context.event_types;

        if (events.MESSAGE_SENT) {
            context.eventSource.on(events.MESSAGE_SENT, handleMessageSent);
        }

        if (events.MESSAGE_RECEIVED) {
            context.eventSource.on(events.MESSAGE_RECEIVED, handleMessageReceived);
        }

        [
            events.MESSAGE_SWIPED,
            events.MESSAGE_EDITED,
            events.MESSAGE_DELETED,
            events.CHAT_CHANGED
        ]
            .filter(Boolean)
            .forEach((eventName) => {
                context.eventSource.on(eventName, handleLiveChatChange);
            });

    })();

    installPhoneTagInstruction();
    startSpontaneousCallWatcher();


    // =====================================================
    // CALL SCREEN (voice call overlay)
    // =====================================================
    // A call is the same conversation as the texting thread, just
    // shown differently: it reads from and writes to that same
    // phone thread, and its replies are generated with the main
    // story as context (requestPhoneGeneration) without ever being
    // written into the story's own log. All this screen adds is a
    // ringing state and a paged caption bubble instead of a
    // scrolling list of chat bubbles.

    const callScreen =
        dashboard.querySelector('#call-screen');

    const callScreenAvatar =
        dashboard.querySelector('#call-screen-avatar');

    const callScreenName =
        dashboard.querySelector('#call-screen-name');

    const callScreenStatus =
        dashboard.querySelector('#call-screen-status');

    const callScreenCaptions =
        dashboard.querySelector('#call-screen-captions');

    const callScreenInput =
        dashboard.querySelector('#call-screen-input');

    const callScreenSend =
        dashboard.querySelector('#call-screen-send');

    const callScreenHangup =
        dashboard.querySelector('#call-screen-hangup');

    const callScreenIncomingActions =
        dashboard.querySelector('#call-screen-incoming-actions');

    const callScreenDecline =
        dashboard.querySelector('#call-screen-decline');

    const callScreenAccept =
        dashboard.querySelector('#call-screen-accept');

    const callScreenMute =
        dashboard.querySelector('#call-screen-mute');

    const callScreenSpeaker =
        dashboard.querySelector('#call-screen-speaker');

    // Everything about the call currently on screen, or null when
    // there isn't one. Kept in one object so hangUpCall() always has
    // a single, complete picture to tear down — no matter whether it
    // fires mid-ring or mid-conversation.
    let callState = null;

    // Index (in the REAL chat log) of the last entry that was already
    // checked for a [CALL]/[HANGUP] tag, so re-renders and unrelated
    // chat events never re-fire the same call open/close twice.
    let dashboardLastPhoneEventIndex = -1;

    // When the most recent call of ANY kind (button-pressed, story
    // [CALL] tag, or the spontaneous watcher below) last ended. The
    // spontaneous watcher stays quiet for a while after this so a
    // call that just wrapped up doesn't get immediately followed by
    // another one.
    let dashboardLastCallEndedAt = 0;

    // How long an auto-triggered [CALL] keeps ringing before it
    // counts as missed if nobody taps Accept or Decline.
    const INCOMING_CALL_AUTO_MISS_MS = 25000;

    function isCallOpen() {

        return !!(
            callScreen &&
            callScreen.classList.contains('open')
        );

    }

    // How many lines this contact's phone thread holds right now.
    // Used as a watermark: only lines added after this point were
    // "said during the call" and belong in the captions panel.
    function getCallWatermark(characterName) {

        return getPhoneThreadLength(characterName);

    }

    // How many characters fit comfortably on one page of the call
    // bubble before it starts to feel like a wall of text. Anything
    // longer is split across several pages the reader can step
    // through with the ย้อนกลับ / ถัดไป buttons.
    const CALL_PAGE_MAX_CHARS = 260;

    // Cuts one spoken line into bite-sized pages: paragraph breaks
    // first (they're the author's own pauses), then sentence
    // endings, and only as a last resort a hard slice mid-sentence.
    function splitIntoCallPages(text) {

        const pages = [];

        const paragraphs = text
            .split(/\n{2,}/)
            .map((part) => part.trim())
            .filter((part) => part.length > 0);

        const source = paragraphs.length ? paragraphs : [text];

        source.forEach((paragraph) => {

            if (paragraph.length <= CALL_PAGE_MAX_CHARS) {
                pages.push(paragraph);
                return;
            }

            // Keeps the punctuation attached to the sentence it
            // belongs to instead of stranding it on the next page.
            const sentences = paragraph
                .split(/(?<=[.!?…。！？]|\n)\s+/)
                .map((part) => part.trim())
                .filter((part) => part.length > 0);

            let buffer = '';

            const flush = () => {

                if (buffer.trim()) {
                    pages.push(buffer.trim());
                }

                buffer = '';

            };

            sentences.forEach((sentence) => {

                // A single sentence longer than a whole page has to
                // be chopped by length — rare, but it shouldn't
                // silently overflow when it happens.
                while (sentence.length > CALL_PAGE_MAX_CHARS) {

                    flush();

                    pages.push(
                        sentence.slice(0, CALL_PAGE_MAX_CHARS).trim()
                    );

                    sentence = sentence.slice(CALL_PAGE_MAX_CHARS);

                }

                if (
                    buffer &&
                    (buffer.length + sentence.length + 1) >
                        CALL_PAGE_MAX_CHARS
                ) {
                    flush();
                }

                buffer = buffer
                    ? `${buffer} ${sentence}`
                    : sentence;

            });

            flush();

        });

        return pages.length ? pages : [text];

    }

    // Everything said since the call connected, already broken into
    // pages — one entry per screenful, tagged with who said it.
    // Everything said (or ambient-cued) since the call connected,
    // already broken into pages — one entry per screenful, tagged
    // with who said it AND whether it's actual speech or just an
    // ambient background cue (the latter never gets paginated by
    // length — it's always one short line, shown as its own page).
    function buildCallPages() {

        const fullHistory = getMirroredHistory(callState.name);
        const duringCall = fullHistory.slice(callState.startIndex);

        const pages = [];

        duringCall.forEach((entry) => {

            const text = (entry.text || '')
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .join('\n');

            if (!text) {
                return;
            }

            if (entry.kind === 'call-ambient') {

                pages.push({
                    from: entry.from,
                    text,
                    kind: 'ambient'
                });

                return;

            }

            splitIntoCallPages(text).forEach((chunk) => {

                pages.push({
                    from: entry.from,
                    text: chunk,
                    kind: 'speech'
                });

            });

        });

        return pages;

    }

    // Builds the bubble shell once per call and wires its two
    // navigation buttons. Re-rendering pages afterwards only swaps
    // the text inside, so the buttons never lose their listeners.
    function ensureCallBubble() {

        if (
            !callScreenCaptions ||
            callScreenCaptions.querySelector('.call-bubble')
        ) {
            return;
        }

        callScreenCaptions.innerHTML = `
            <div class="call-bubble">

                <div class="call-bubble-head">
                    <span class="call-bubble-speaker"></span>
                    <span class="call-bubble-count"></span>
                </div>

                <div class="call-bubble-body">
                    <span class="subtitle-text"></span><span class="subtitle-cursor"></span>
                </div>

                <div class="call-bubble-nav">

                    <button
                        class="call-bubble-step call-bubble-prev"
                        type="button"
                    >
                        <i class="fa-solid fa-chevron-left"></i>
                        <span>ย้อนกลับ</span>
                    </button>

                    <button
                        class="call-bubble-step call-bubble-next"
                        type="button"
                    >
                        <span>ถัดไป</span>
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>

                </div>

            </div>
        `;

        const prevButton =
            callScreenCaptions.querySelector('.call-bubble-prev');

        const nextButton =
            callScreenCaptions.querySelector('.call-bubble-next');

        if (prevButton) {

            prevButton.addEventListener('click', () => {
                stepCallPage(-1);
            });

        }

        if (nextButton) {

            nextButton.addEventListener('click', () => {
                stepCallPage(1);
            });

        }

    }

    // Moves one page back or forward. Stepping is always instant —
    // the typewriter effect belongs to a line arriving live, not to
    // scrolling back over something already heard.
    function stepCallPage(direction) {

        if (!callState || !Array.isArray(callState.pages)) {
            return;
        }

        showCallPage(callState.pageIndex + direction, false);

    }

    // Paints one page into the bubble. `animate` types {{char}}'s
    // words out letter by letter, the way a line lands while the
    // call is live.
    function showCallPage(index, animate) {

        if (
            !callScreenCaptions ||
            !callState ||
            !Array.isArray(callState.pages) ||
            !callState.pages.length
        ) {
            return;
        }

        const pages = callState.pages;

        const safeIndex = Math.min(
            Math.max(index, 0),
            pages.length - 1
        );

        callState.pageIndex = safeIndex;

        const page = pages[safeIndex];

        const bubble =
            callScreenCaptions.querySelector('.call-bubble');

        const speaker =
            callScreenCaptions.querySelector('.call-bubble-speaker');

        const counter =
            callScreenCaptions.querySelector('.call-bubble-count');

        const body =
            callScreenCaptions.querySelector('.call-bubble-body');

        const subtitleText =
            callScreenCaptions.querySelector('.subtitle-text');

        const cursor =
            callScreenCaptions.querySelector('.subtitle-cursor');

        const prevButton =
            callScreenCaptions.querySelector('.call-bubble-prev');

        const nextButton =
            callScreenCaptions.querySelector('.call-bubble-next');

        if (!bubble || !subtitleText) {
            return;
        }

        const isAmbient = page.kind === 'ambient';

        bubble.classList.toggle('in', page.from === 'in' && !isAmbient);
        bubble.classList.toggle('out', page.from !== 'in' && !isAmbient);
        bubble.classList.toggle('ambient', isAmbient);

        if (speaker) {

            speaker.textContent = isAmbient
                ? '🎐 บรรยากาศ'
                : (page.from === 'in' ? callState.name : 'คุณ');

        }

        if (counter) {
            counter.textContent = `${safeIndex + 1} / ${pages.length}`;
        }

        if (prevButton) {
            prevButton.disabled = safeIndex <= 0;
        }

        if (nextButton) {
            nextButton.disabled = safeIndex >= pages.length - 1;
        }

        if (callState.captionTimer) {
            clearInterval(callState.captionTimer);
            callState.captionTimer = null;
        }

        if (body) {
            body.scrollTop = 0;
        }

        const shouldType = animate && page.from === 'in' && !isAmbient;

        if (!shouldType) {

            subtitleText.textContent = page.text;

            if (cursor) {
                cursor.classList.add('is-hidden');
            }

            return;

        }

        if (cursor) {
            cursor.classList.remove('is-hidden');
        }

        subtitleText.textContent = '';

        let shown = 0;

        callState.captionTimer = setInterval(
            () => {

                shown += 1;

                subtitleText.textContent = page.text.slice(0, shown);

                if (shown >= page.text.length) {

                    clearInterval(callState.captionTimer);
                    callState.captionTimer = null;

                    if (cursor) {
                        cursor.classList.add('is-hidden');
                    }

                }

            },
            28
        );

    }

    // Keeps the bubble in sync with what's been said. Only a genuinely
    // new set of pages rebuilds anything — a re-render caused by
    // something else never yanks the reader off the page they're on.
    function renderCallCaptions() {

        if (!callScreenCaptions || !callState) {
            return;
        }

        const pages = buildCallPages();

        if (!pages.length) {

            if (callState.captionTimer) {
                clearInterval(callState.captionTimer);
                callState.captionTimer = null;
            }

            callScreenCaptions.innerHTML = '';
            callState.pages = [];
            callState.pageIndex = 0;
            callState.lastCaptionKey = null;

            return;

        }

        const captionKey = pages
            .map((page) => `${page.from}:${page.text}`)
            .join('||');

        if (captionKey === callState.lastCaptionKey) {
            return;
        }

        callState.lastCaptionKey = captionKey;
        callState.pages = pages;

        ensureCallBubble();

        // A new line always jumps the reader to the newest page —
        // that's the part being said right now.
        showCallPage(pages.length - 1, true);

    }

    // Small helper so the class list above stays on one readable line.
    function message_class(from) {
        return from === 'in' ? 'in' : 'out';
    }

    // While the character's line is still generating there is
    // nothing to show yet — the subtitle stays silent until the real
    // text lands, then renderCallCaptions() types it out above.
    function showCallSpeakingBubble() {
        return null;
    }

    // Once the call is answered the status line simply says the call
    // is live — no running clock, which only pulled the eye away
    // from what's being said.
    function setCallConnectedStatus() {

        if (!callState || !callScreenStatus) {
            return;
        }

        callScreenStatus.textContent = 'กำลังสนทนา';

    }

    // Opens the call screen for whichever contact's thread is
    // currently active and starts the ringing state. The ring itself
    // is purely presentational (random 6–10s) — nothing is generated
    // until the call actually connects.
    const callVideoStage =
        dashboard.querySelector('#call-video-stage');

    const callVideoBackdrop =
        dashboard.querySelector('#call-video-backdrop');

    const callVideoFrame =
        dashboard.querySelector('#call-video-frame');

    const callVideoSelf =
        dashboard.querySelector('#call-video-self');

    const callVideoBadgeText =
        dashboard.querySelector('#call-video-badge-text');

    const callScreenCamera =
        dashboard.querySelector('#call-screen-camera');

    // The "camera feed" is the contact's own card picture: sharp in
    // the frame, blurred and enlarged behind it so the screen reads
    // as a room rather than a floating portrait.
    function renderVideoStage(characterName, initial) {

        if (!callVideoStage) {
            return;
        }

        const avatarFile = getStoryCharacterAvatar(characterName);

        const url = avatarFile
            ? `/characters/${encodeURIComponent(avatarFile)}`
            : '';

        if (callVideoBackdrop) {

            callVideoBackdrop.style.backgroundImage = url
                ? `url("${url}")`
                : 'none';

        }

        if (callVideoFrame) {

            callVideoFrame.style.backgroundImage = url
                ? `url("${url}")`
                : 'none';

            callVideoFrame.textContent = url
                ? ''
                : (initial || '?');

            callVideoFrame.classList.toggle('is-placeholder', !url);

        }

        renderVideoSelfView();

    }

    // The little self-view tile. Camera off leaves a dark tile with a
    // label, the same as a real call.
    function renderVideoSelfView() {

        if (!callVideoSelf) {
            return;
        }

        const cameraOff = !!(callState && callState.cameraOff);

        callVideoSelf.classList.toggle('is-off', cameraOff);
        callVideoSelf.innerHTML = '';
        callVideoSelf.style.backgroundImage = 'none';

        if (cameraOff) {

            const label = document.createElement('span');

            label.textContent = 'กล้องปิด';

            callVideoSelf.appendChild(label);

            return;

        }

        const userAvatar = getUserAvatarUrl();

        if (userAvatar) {

            callVideoSelf.style.backgroundImage = `url("${userAvatar}")`;

            return;

        }

        const label = document.createElement('span');

        label.textContent = getUserName().charAt(0).toUpperCase();

        callVideoSelf.appendChild(label);

    }

    function toggleCallCamera() {

        if (!callState || !callState.video) {
            return;
        }

        callState.cameraOff = !callState.cameraOff;

        if (callScreenCamera) {

            callScreenCamera.classList.toggle(
                'is-active',
                callState.cameraOff
            );

            callScreenCamera.innerHTML = callState.cameraOff
                ? '<i class="fa-solid fa-video-slash"></i>'
                : '<i class="fa-solid fa-video"></i>';

            callScreenCamera.title = callState.cameraOff
                ? 'เปิดกล้อง'
                : 'ปิดกล้อง';

        }

        if (callVideoBadgeText) {

            callVideoBadgeText.textContent = callState.cameraOff
                ? 'วิดีโอคอล • กล้องคุณปิดอยู่'
                : 'วิดีโอคอล';

        }

        renderVideoSelfView();

    }

    if (callScreenCamera) {

        addPressEffect(callScreenCamera);

        callScreenCamera.addEventListener('click', toggleCallCamera);

    }

    // Puts the call screen into (or out of) video mode and resets the
    // camera toggle to "camera on" for the new call.
    function applyCallVideoMode(isVideo) {

        if (!callScreen) {
            return;
        }

        callScreen.classList.toggle('is-video', !!isVideo);

        if (callScreenCamera) {

            callScreenCamera.classList.remove('is-active');
            callScreenCamera.innerHTML =
                '<i class="fa-solid fa-video"></i>';
            callScreenCamera.title = 'ปิดกล้อง';

        }

        if (callVideoBadgeText) {
            callVideoBadgeText.textContent = 'วิดีโอคอล';
        }

    }

    function openVideoCallScreen() {

        openCallScreen({ video: true });

    }

    function openCallScreen(options) {

        if (
            !callScreen ||
            !activeChatName ||
            activeChatName === 'ระบบ' ||
            isCallOpen()
        ) {
            return;
        }

        const isVideo = !!(options && options.video);

        callState = {
            name: activeChatName,
            startIndex: getCallWatermark(activeChatName),
            connectedAt: null,
            ringTimeout: null,
            captionTimer: null,
            lastCaptionKey: null,
            pages: [],
            pageIndex: 0,
            ambientCooldown: 0,
            video: isVideo,
            cameraOff: false
        };

        applyCallVideoMode(isVideo);

        if (isVideo) {
            renderVideoStage(activeChatName, activeChatInitial);
        }

        stopDashboardDialTone();

        dashboardDialToneStop = startGeneratedDialTone();

        if (callScreenAvatar) {

            renderContactAvatarInto(
                callScreenAvatar,
                getStoryCharacterAvatar(activeChatName),
                activeChatInitial
            );

        }

        if (callScreenName) {
            callScreenName.textContent = activeChatName;
        }

        if (callScreenStatus) {

            callScreenStatus.textContent = isVideo
                ? 'กำลังวิดีโอคอล...'
                : 'กำลังโทรออก...';

        }

        if (callScreenCaptions) {
            callScreenCaptions.innerHTML = '';
        }

        if (callScreenInput) {
            callScreenInput.value = '';
            callScreenInput.disabled = true;
        }

        if (callScreenSend) {
            callScreenSend.disabled = true;
        }

        callScreen.classList.remove('state-connected');
        callScreen.classList.add('open', 'state-ringing');

        // Random 6–10s ring, same spirit as a real outgoing call.
        const ringDelay = 6000 + Math.floor(Math.random() * 4000);

        callState.ringTimeout = setTimeout(connectCall, ringDelay);

    }

    // Ringing is over — the call is "answered". The opening line is
    // generated with the main story as context but lands only in
    // this contact's phone thread, so the call carries on from the
    // texting conversation without writing into the story log.
    async function connectCall() {

        if (!callState || !isCallOpen()) {
            return;
        }

        const name = callState.name;

        stopDashboardDialTone();

        callState.connectedAt = Date.now();
        callState.startIndex = getCallWatermark(name);

        callScreen.classList.remove('state-ringing');
        callScreen.classList.add('state-connected');

        setCallConnectedStatus();

        try {

            const line = await requestPhoneGeneration(
                name,
                callState.video ? 'video-answer' : 'call-answer'
            );

            if (!callState || callState.name !== name) {
                return;
            }

            if (line) {
                appendPhoneMessage(name, 'in', line, 'call');
            }

            renderCallCaptions();

            if (callScreenInput && callScreenSend) {
                callScreenInput.disabled = false;
                callScreenSend.disabled = false;
            }

            renderStoryContacts();

        } catch (error) {

            console.log(
                '[Dashboard] Could not start the call',
                error
            );

            if (callScreenCaptions) {

                callScreenCaptions.innerHTML = `
                    <p class="call-screen-subtitle in">[ไม่สามารถเชื่อมต่อเสียงได้ ลองพิมพ์ข้อความแทนได้เลย]</p>
                `;

            }

            if (callScreenInput && callScreenSend) {
                callScreenInput.disabled = false;
                callScreenSend.disabled = false;
            }

        }

    }

    // Speaking into the call: the line goes into the same phone
    // thread the texting uses, then the character answers out loud.
    async function sendCallMessage() {

        if (
            !callScreenInput ||
            !callState ||
            !callState.connectedAt
        ) {
            return;
        }

        const name = callState.name;
        const text = callScreenInput.value.trim();

        if (!text) {
            return;
        }

        callScreenInput.value = '';
        callScreenInput.disabled = true;

        if (callScreenSend) {
            callScreenSend.disabled = true;
        }

        appendPhoneMessage(name, 'out', text, 'call');
        renderCallCaptions();

        try {

            const line = await requestPhoneGeneration(
                name,
                callState && callState.video ? 'video' : 'call'
            );

            if (!callState || callState.name !== name) {
                return;
            }

            if (line) {
                appendPhoneMessage(name, 'in', line, 'call');
            }

            renderCallCaptions();
            renderStoryContacts();

        } catch (error) {

            console.log(
                '[Dashboard] Failed to get a reply during the call',
                error
            );

            appendPhoneMessage(
                name,
                'in',
                '[สัญญาณขัดข้อง ลองพูดอีกครั้ง]',
                'call'
            );

            renderCallCaptions();

        }

        if (callScreenInput && callScreenSend) {

            callScreenInput.disabled = false;
            callScreenSend.disabled = false;

        }

    }

    // Turns a duration in seconds into the "m:ss" label shown on the
    // call-summary line once a call ends — e.g. 332 -> "5:32".
    function formatCallDuration(totalSeconds) {

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        return `${minutes}:${String(seconds).padStart(2, '0')}`;

    }

    // Drops the one line a call actually leaves behind in the chat
    // thread: "การโทร • 5:32", the same kind of summary a real
    // messaging app logs once a call ends, instead of replaying
    // everything that was said. Nothing is logged for a call that
    // was hung up while still ringing — it never connected, so
    // there's no duration to report.
    function logCallSummary(characterName, connectedAt, wasIncoming) {

        if (!characterName || !connectedAt) {
            return;
        }

        const seconds = Math.max(
            1,
            Math.round((Date.now() - connectedAt) / 1000)
        );

        appendPhoneMessage(
            characterName,
            wasIncoming ? 'in' : 'out',
            formatCallDuration(seconds),
            'call-summary'
        );

    }

    // Ends the call and tears down its timers. Nothing is written
    // into the main story — what was said stays in the phone's own
    // thread (kept out of the chat panel itself), where the texting
    // conversation can pick it back up. The only trace left in the
    // chat is the one call-summary line logged just below.
    // Pushes a compact transcript of the call that just ended into
    // the real SillyTavern chat. Without this the main story only
    // ever sees {{char}}'s side (whatever the [CALL] message said),
    // so anything {{user}} answered inside the phone app was
    // invisible to the next reply — which is what made the story
    // drift out of sync with the call.
    function writeCallTranscriptToStory(characterName, lines, wasIncoming, wasVideo) {

        const context = getDashboardContext();

        if (!context || !Array.isArray(context.chat)) {
            return;
        }

        const spoken = (Array.isArray(lines) ? lines : [])
            .filter((line) => line && line.text);

        if (!spoken.length) {
            return;
        }

        const userName = getUserName();

        const body = spoken.map((line) => {

            const text = String(line.text).replace(/\s+/g, ' ').trim();

            if (line.kind === 'call-ambient') {
                return `(${text})`;
            }

            return `${line.from === 'in' ? characterName : userName}: "${text}"`;

        });

        const label = wasVideo ? 'วิดีโอคอล' : 'สายโทรศัพท์';

        const header = wasIncoming
            ? `[${label} — ${characterName} ติดต่อมาที่ ${userName} และคุยกันจนจบสาย]`
            : `[${label} — ${userName} ติดต่อไปหา ${characterName} และคุยกันจนจบสาย]`;

        const message = {
            name: userName,
            is_user: true,
            is_system: false,
            send_date: Date.now(),
            mes: [header, ...body].join('\n'),
            extra: { dashboardPhoneCall: true }
        };

        try {

            context.chat.push(message);

            if (typeof context.addOneMessage === 'function') {
                context.addOneMessage(message);
            }

            if (typeof context.saveChat === 'function') {
                context.saveChat();
            }

            // The transcript is a new last line in the story log;
            // don't let the [CALL]/[HANGUP] watcher treat it as a
            // fresh character reply.
            dashboardLastPhoneEventIndex = context.chat.length - 1;

        } catch (error) {

            console.log(
                '[Dashboard] Could not write the call transcript into the story',
                error
            );

        }

    }

    function hangUpCall(triggeredByUser) {

        if (!callState) {
            return;
        }

        if (callState.ringTimeout) {
            clearTimeout(callState.ringTimeout);
        }

        if (callState.captionTimer) {
            clearInterval(callState.captionTimer);
        }

        const name = callState.name;
        const connectedAt = callState.connectedAt;
        const wasIncoming = !!callState.auto;
        const wasVideo = !!callState.video;
        const wasConnected = !!connectedAt;
        const callStartIndex = callState.startIndex || 0;

        stopDashboardDialTone();

        callState = null;
        dashboardLastCallEndedAt = Date.now();

        if (callScreen) {

            callScreen.classList.remove(
                'open',
                'state-ringing',
                'state-connected',
                'is-incoming'
            );

        }

        recordCallLogEntry(
            name,
            connectedAt,
            wasIncoming,
            callStartIndex,
            wasVideo
        );

        if (wasConnected) {

            writeCallTranscriptToStory(
                name,
                getMirroredHistory(name)
                    .slice(callStartIndex)
                    .filter((entry) => {

                        const kind = (entry && entry.kind) || 'text';

                        return kind === 'call' || kind === 'call-ambient';

                    }),
                wasIncoming,
                wasVideo
            );

        }

        logCallSummary(name, connectedAt, wasIncoming);

        if (isThreadOpenFor(name)) {
            renderChatBody(getChatDisplayHistory(name));
        }

        renderStoryContacts();

        // A hang-up the STORY itself asked for (via [HANGUP]) is
        // {{char}} ending things on their own terms — nothing to
        // react to there. It's specifically {{user}} cutting a live
        // call short that deserves a beat, in-character reply, and
        // only once the call had actually connected (hanging up
        // while it was still ringing already leaves no trace at all,
        // same as before).
        if (triggeredByUser !== false && wasConnected) {

            scheduleHangupReaction(
                name,
                wasIncoming ? 'hangup_incoming' : 'hangup_outgoing'
            );

        }

    }

    // =====================================================
    // AUTO-TRIGGERED CALLS (driven by the story, not a tap)
    // =====================================================
    // {{char}} can start or end a phone call from inside the story
    // itself by writing a [CALL] / [HANGUP] tag (see
    // DASHBOARD_CALL_START_TAG / DASHBOARD_CALL_END_TAG, and
    // installPhoneTagInstruction() which teaches the model to use
    // them). These are the auto equivalents of openCallScreen() /
    // hangUpCall(): same call-screen state, same real chat log — the
    // difference is WHAT triggers them (a tag in the story instead of
    // the call button) and that the opening line already exists, so
    // there's nothing to wait on or generate.

    // Opens the call screen as an INCOMING call for whichever
    // character's line just carried [CALL], with that very line (the
    // one carrying the tag) becoming the first thing said once it
    // connects.
    function openIncomingCallScreen(characterName, openingLine, isVideo) {

        if (!callScreen || isCallOpen()) {
            return;
        }

        // Notifications off (or the contact blocked outright) means
        // no ringing screen at all — the call is quietly filed as a
        // missed one instead, the way a silenced phone behaves.
        if (
            isContactMuted(characterName) ||
            isContactBlocked(characterName)
        ) {

            recordMissedCallLog(characterName, 'missed');

            renderStoryContacts();

            return;

        }

        // {{char}} can send [CALL] at any point in the story — including
        // while the phone app itself is closed and the user is just
        // looking at the regular chat window. #dashboard-overlay is
        // "display: none" until it has the "open" class, so without
        // this, everything below still ran (ringing state, timers,
        // the eventual call-summary line) completely invisibly: the
        // call screen was toggling classes on an element nobody could
        // see. Forcing the app open here is what actually surfaces the
        // incoming call. The boot/welcome and character-select screens
        // sit on top of everything else (z-index 500 / 480 vs. the call
        // screen's 35), so they're dismissed too or they'd hide the
        // ringing screen behind themselves.
        if (dashboard && !dashboard.classList.contains('open')) {
            dashboard.classList.add('open');
        }

        if (dashboardBootScreen) {
            dashboardBootScreen.classList.add('is-dismissed');
        }

        if (dashboardPickerScreen) {
            dashboardPickerScreen.classList.add('is-dismissed');
        }

        // Best-effort — browsers only grant fullscreen from inside a
        // user gesture, and an incoming call is triggered by a network
        // response, not a click, so this will often just quietly fail.
        // That's fine: it's a nice-to-have, not what makes the call
        // screen visible.
        try {

            if (!document.fullscreenElement) {

                document.documentElement
                    .requestFullscreen()
                    .catch(() => {});

            }

        } catch (error) {
            // Ignored — see comment above.
        }

        callState = {
            name: characterName,
            startIndex: getCallWatermark(characterName),
            connectedAt: null,
            ringTimeout: null,
            captionTimer: null,
            lastCaptionKey: null,
            pages: [],
            pageIndex: 0,
            ambientCooldown: 0,
            auto: true,
            // Whatever the tagged story line already said, held here
            // until Accept is actually pressed — nothing is generated
            // or connected before that happens any more.
            pendingOpeningLine: (openingLine || '').trim()
        };

        stopDashboardDialTone();

        dashboardDialToneStop = startGeneratedDialTone(true);

        const avatarFile = getStoryCharacterAvatar(characterName);
        const initial = characterName.charAt(0).toUpperCase();

        if (callScreenAvatar) {
            renderContactAvatarInto(callScreenAvatar, avatarFile, initial);
        }

        if (callScreenName) {
            callScreenName.textContent = characterName;
        }

        if (callScreenStatus) {
            callScreenStatus.textContent = 'สายเรียกเข้า...';
        }

        if (callScreenCaptions) {
            callScreenCaptions.innerHTML = '';
        }

        if (callScreenInput) {
            callScreenInput.value = '';
            callScreenInput.disabled = true;
        }

        if (callScreenSend) {
            callScreenSend.disabled = true;
        }

        applyCallVideoMode(isVideo);

        if (isVideo) {
            renderVideoStage(characterName, (characterName || '?').charAt(0));
        }

        callScreen.classList.remove('state-connected');
        callScreen.classList.add('open', 'state-ringing', 'is-incoming');

        // No more auto-answering on a timer: the ring now genuinely
        // waits on the Accept/Decline buttons below. Left alone too
        // long, it's a missed call rather than an endless ring.
        callState.ringTimeout = setTimeout(
            () => {

                if (!callState || callState.connectedAt || !isCallOpen()) {
                    return;
                }

                declineIncomingCall('missed');

            },
            INCOMING_CALL_AUTO_MISS_MS
        );

    }

    // Answers the call the instant Accept is pressed — no artificial
    // ring-out delay any more. If the tagged story line already had
    // something spoken in it, that becomes the opening line right
    // away; otherwise one is generated the same way an outgoing call
    // is.
    async function connectIncomingCall() {

        if (!callState || callState.connectedAt || !isCallOpen()) {
            return;
        }

        if (callState.ringTimeout) {
            clearTimeout(callState.ringTimeout);
            callState.ringTimeout = null;
        }

        const characterName = callState.name;

        stopDashboardDialTone();

        callState.connectedAt = Date.now();
        callState.startIndex = getCallWatermark(characterName);

        callScreen.classList.remove('state-ringing');
        callScreen.classList.add('state-connected');

        setCallConnectedStatus();

        let spoken = callState.pendingOpeningLine || '';

        if (!spoken) {

            try {

                spoken = await requestPhoneGeneration(
                    characterName,
                    callState && callState.video
                        ? 'video-connect'
                        : 'call-connect'
                );

            } catch (error) {

                console.log(
                    '[Dashboard] [CALL] arrived with no dialogue attached, and asking for an opening line also failed',
                    error
                );

            }

        }

        if (!callState || callState.name !== characterName) {
            return;
        }

        if (spoken) {
            appendPhoneMessage(characterName, 'in', spoken, 'call');
        }

        renderCallCaptions();
        renderStoryContacts();

        if (callScreenInput && callScreenSend) {
            callScreenInput.disabled = false;
            callScreenSend.disabled = false;
        }

    }

    // Rejects an incoming call while it's still ringing — either
    // {{user}} actively tapped decline, or it simply rang out
    // unanswered ('missed'). Either way nothing ever connected, so
    // (same rule as before) no "การโทร • m:ss" line gets logged —
    // just a short in-character text a beat later reacting to it.
    function declineIncomingCall(reason) {

        if (!callState || callState.connectedAt || !isCallOpen()) {
            return;
        }

        if (callState.ringTimeout) {
            clearTimeout(callState.ringTimeout);
        }

        const characterName = callState.name;

        callState = null;
        dashboardLastCallEndedAt = Date.now();

        stopDashboardDialTone();

        if (callScreen) {

            callScreen.classList.remove(
                'open',
                'state-ringing',
                'state-connected',
                'is-incoming'
            );

        }

        recordMissedCallLog(
            characterName,
            reason === 'missed' ? 'missed' : 'declined'
        );

        renderStoryContacts();

        scheduleHangupReaction(
            characterName,
            reason === 'missed' ? 'missed' : 'declined'
        );

    }

    // Ends the call from the story side: {{char}}'s line carried a
    // [HANGUP] tag. Leaves the last line on screen for a moment first
    // so it doesn't vanish mid-read, then hangs up exactly the way
    // the button does — but this is {{char}} ending it on their own
    // terms, so it's explicitly marked as NOT a user-triggered
    // hang-up (see hangUpCall) and doesn't trigger a reaction text.
    function endCallFromStory() {

        if (!callState) {
            return;
        }

        setTimeout(() => hangUpCall(false), 1500);

    }

    // =====================================================
    // HANG-UP / DECLINE / MISSED-CALL REACTIONS
    // =====================================================
    // A short, in-character text that follows a beat after {{user}}
    // declines a call, lets one ring out, or cuts a live call short —
    // generated the same independent, phone-thread-only way ordinary
    // texts and call lines are, so it never touches the main story.

    function buildHangupReactionPrompt(characterName, situationKey) {

        const situations = {

            declined:
                `เมื่อครู่ ${characterName} โทรหา {{user}} แต่ {{user}} กดปฏิเสธสายทันที ไม่ยอมรับสายเลย`,

            missed:
                `เมื่อครู่ ${characterName} โทรหา {{user}} แต่ {{user}} ไม่รับสาย ปล่อยให้สายเรียกจนตัดไปเองโดยไม่มีใครรับ`,

            hangup_incoming:
                `${characterName} เพิ่งโทรหา {{user}} และกำลังคุยกันอยู่สด ๆ แต่จู่ ๆ {{user}} ก็วางสายตัดกลางคันไปเฉย ๆ`,

            hangup_outgoing:
                `{{user}} เป็นฝ่ายโทรหา ${characterName} เองและกำลังคุยกันอยู่สด ๆ แต่จู่ ๆ {{user}} ก็วางสายตัดกลางคันไปเฉย ๆ`

        };

        const situation = situations[situationKey] || situations.hangup_incoming;

        const lines = [
            '[OOC — ระบบโทรศัพท์: นี่คือแอปแชท/โทรศัพท์ ไม่ใช่เนื้อเรื่องหลัก อ่านเพื่อทราบบริบทเท่านั้น ห้ามเขียนต่อเนื้อเรื่องหลักในคำตอบนี้]',
            situation,
            `เขียนข้อความที่ ${characterName} จะพิมพ์ส่งกลับมาในแอปแชท ทันทีหลังจากเรื่องนี้เกิดขึ้น สะท้อนความรู้สึกและนิสัยของ ${characterName} ต่อสิ่งที่ {{user}} เพิ่งทำ (จะหงุดหงิด ห่วง ตลก เฉย ๆ หรืออื่นใดก็ได้ แล้วแต่นิสัยตัวละครล้วน ๆ) และให้ต่อเนื่องกับบทสนทนาก่อนหน้านี้ในแอปด้วย`,
            '',
            'กติกาที่ต้องทำตามอย่างเคร่งครัด:',
            '- ผลลัพธ์ทั้งหมดคือข้อความที่พิมพ์ลงแอปแชทเท่านั้น ห้ามมีคำบรรยายเจือปนแม้แต่ประโยคเดียว',
            '- ห้ามบรรยายฉาก ท่าทาง สีหน้า ความรู้สึก อากาศ เวลา หรือสิ่งแวดล้อมใด ๆ ทั้งสิ้น ไม่ว่าจะมีเครื่องหมาย *ดอกจัน* หรือไม่ก็ตาม',
            '- ห้ามเขียนถึงตัวเองในมุมมองบุคคลที่สาม',
            '- ห้ามใส่ป้ายเวลา วันที่ หรือสัญลักษณ์นาฬิกา/ทรายไหลใด ๆ',
            '- ห้ามใส่ชื่อผู้พูดนำหน้า เครื่องหมายคำพูดครอบทั้งข้อความ แท็ก หรือคำอธิบายใด ๆ',
            `- สั้น กระชับ 1-3 ประโยคสั้น ๆ เหมือนคนจริงพิมพ์แชท ในน้ำเสียงและนิสัยของ ${characterName}`,
            '- ห้ามเปลี่ยนไปคุยเรื่องอื่นที่ไม่เกี่ยวกับสิ่งที่เพิ่งเกิดขึ้นนี้',
            '',
            'บทสนทนาในโทรศัพท์ที่ผ่านมา:',
            buildPhoneTranscript(characterName),
            '',
            `${characterName} พิมพ์ตอบว่า:`
        ];

        return lines.join('\n');

    }

    async function requestHangupReactionLine(characterName, situationKey) {

        const context = getDashboardContext();

        if (!context) {
            return '';
        }

        let raw;

        try {

            raw = await runQuietPhonePrompt(
                context,
                buildHangupReactionPrompt(characterName, situationKey),
                characterName
            );

        } catch (error) {

            console.log(
                '[Dashboard] Hang-up reaction generation failed',
                error
            );

            return '';

        }

        const clean = sanitizePhoneText(raw, characterName);

        if (
            !hasReadableContent(clean) ||
            looksLikeNarration(raw, clean, characterName)
        ) {
            return '';
        }

        return clean.length > PHONE_NARRATION_LENGTH_LIMIT
            ? `${clean.slice(0, PHONE_NARRATION_LENGTH_LIMIT).trim()}…`
            : clean;

    }

    // Fires the reaction a short, natural beat later — long enough
    // to feel like {{char}} actually noticed and typed something,
    // short enough that it isn't a dead silence either.
    function scheduleHangupReaction(characterName, situationKey) {

        if (!characterName) {
            return;
        }

        const delay = 1200 + Math.floor(Math.random() * 1800);

        setTimeout(
            async () => {

                let line = '';

                try {

                    line = await requestHangupReactionLine(
                        characterName,
                        situationKey
                    );

                } catch (error) {

                    console.log(
                        '[Dashboard] Hang-up reaction request failed',
                        error
                    );

                }

                if (!line) {
                    return;
                }

                appendPhoneMessage(characterName, 'in', line, 'text');

                if (isThreadOpenFor(characterName)) {
                    renderChatBody(getChatDisplayHistory(characterName));
                }

                renderStoryContacts();

            },
            delay
        );

    }

    // Looks at whatever the real chat's newest line is and reacts if
    // it carries a [CALL] or [HANGUP] tag. This is what makes the
    // call screen open and close itself in step with the story
    // instead of waiting for the call button — run on every character
    // reply, before the thread/captions get re-mirrored.
    function checkForPhoneEvents() {

        const context = getDashboardContext();
        const chatLog = context && context.chat;

        if (!Array.isArray(chatLog) || chatLog.length === 0) {
            return;
        }

        const lastIndex = chatLog.length - 1;
        const entry = chatLog[lastIndex];

        if (
            !entry ||
            entry.is_user ||
            !entry.mes ||
            lastIndex === dashboardLastPhoneEventIndex
        ) {
            return;
        }

        dashboardLastPhoneEventIndex = lastIndex;

        const characterName = entry.name || activeChatName;

        if (!characterName) {
            return;
        }

        // A call already running gets first say on whether this line
        // ends it — checked ahead of "start a new one" so a tag can't
        // do both in the same breath.
        if (
            DASHBOARD_CALL_END_TAG.test(entry.mes) &&
            isCallOpen() &&
            callState &&
            callState.name === characterName
        ) {

            endCallFromStory();
            return;

        }

        const startsVideoCall =
            DASHBOARD_VIDEO_CALL_START_TAG.test(entry.mes);

        if (
            (startsVideoCall || DASHBOARD_CALL_START_TAG.test(entry.mes)) &&
            !isCallOpen()
        ) {

            // Only what the character actually SAYS crosses over to
            // the phone — the narration around it stays in the story.
            const spoken = extractSpokenLines(
                stripPhoneEventTags(entry.mes)
            );

            openIncomingCallScreen(characterName, spoken, startsVideoCall);

        }

    }

    if (callButton) {

        addPressEffect(callButton);

        callButton.addEventListener('click', () => openCallScreen());

    }

    if (videoCallButton) {

        addPressEffect(videoCallButton);

        videoCallButton.addEventListener('click', openVideoCallScreen);

    }

    if (callScreenHangup) {

        addPressEffect(callScreenHangup);

        callScreenHangup.addEventListener(
            'click',
            () => hangUpCall(true)
        );

    }

    if (callScreenDecline) {

        addPressEffect(callScreenDecline);

        callScreenDecline.addEventListener(
            'click',
            () => declineIncomingCall('declined')
        );

    }

    if (callScreenAccept) {

        addPressEffect(callScreenAccept);

        callScreenAccept.addEventListener('click', connectIncomingCall);

    }

    if (callScreenSend) {

        addPressEffect(callScreenSend);

        callScreenSend.addEventListener('click', sendCallMessage);

    }

    if (callScreenInput) {

        callScreenInput.addEventListener(
            'keydown',
            (event) => {

                if (event.key === 'Enter') {
                    sendCallMessage();
                }

            }
        );

    }

    // Mute/speaker are presentational toggles (this dashboard has no
    // real audio to control) — they just hold a pressed-looking state
    // so the call screen reads as a genuine call UI.
    [callScreenMute, callScreenSpeaker].forEach((button) => {

        if (!button) {
            return;
        }

        addPressEffect(button);

        const icon = button.querySelector('i');

        const iconPairs = button === callScreenMute
            ? ['fa-microphone', 'fa-microphone-slash']
            : ['fa-volume-high', 'fa-volume-xmark'];

        button.addEventListener('click', () => {

            const active = button.classList.toggle('is-active');

            if (icon) {

                icon.classList.toggle(iconPairs[0], !active);
                icon.classList.toggle(iconPairs[1], active);

            }

        });

    });


    // Wires up press-feedback + open-thread behavior for one
    // contact row. Used both for the static "ระบบ" row and for
    // every dynamically-generated story contact row below.
    function bindFullMessageItem(item) {

        addPressEffect(item);

        item.addEventListener(
            'click',
            () => openChatThread(item)
        );

    }

    dashboard
        .querySelectorAll('.full-message')
        .forEach(bindFullMessageItem);


    // =====================================================
    // STORY CONTACTS (current bot + in-story NPCs)
    // =====================================================

    const fullListCard =
        dashboard.querySelector('#full-list-card');

    const systemMessageRow =
        dashboard.querySelector('#system-message-row');

    // Figures out which characters belong in the contact list:
    // the character/bot the user is currently chatting with, plus
    // — if it's a group chat — every other NPC member of that
    // same story. Returns [] if SillyTavern context isn't available
    // (e.g. previewing this file outside SillyTavern).
    function getStoryCharacters() {

        const context = getDashboardContext();

        if (!context) {
            return [];
        }

        const allCharacters = context.characters || [];

        // Group chat: every member is an NPC in the current story.
        if (context.groupId && Array.isArray(context.groups)) {

            const group = context.groups.find(
                (g) => g.id === context.groupId
            );

            if (!group || !Array.isArray(group.members)) {
                return [];
            }

            return group.members
                .map((avatarFile) => allCharacters.find(
                    (c) => c.avatar === avatarFile
                ))
                .filter(Boolean)
                .map((c) => ({ name: c.name, avatar: c.avatar }));

        }

        // Solo chat: just the one character currently loaded.
        if (context.name2) {

            const current = allCharacters[context.characterId];

            return [{
                name: context.name2,
                avatar: current ? current.avatar : null
            }];

        }

        return [];

    }

    // Avatar filename for one character by name, or null — used when
    // a call opens itself (openIncomingCallScreen) and there's no
    // picker card or contact row at hand to read the avatar off of.
    function getStoryCharacterAvatar(characterName) {

        const match = getStoryCharacters()
            .find((character) => character.name === characterName);

        return match ? match.avatar : null;

    }

    // Finds that character's most recent line in the actual
    // SillyTavern chat log, to use as the message preview / the
    // thread's starting bubble.
    function getLastLineFrom(characterName) {

        const thread = getPhoneThread(characterName);

        for (let i = thread.length - 1; i >= 0; i--) {

            if (thread[i] && thread[i].text) {
                return thread[i].text;
            }

        }

        return null;

    }

    // Fills an avatar box with the character's real card image,
    // falling back to the same initial-letter circle used
    // elsewhere if there's no image (or it fails to load).
    function renderContactAvatarInto(box, avatarFile, initial) {

        if (!avatarFile) {
            box.textContent = initial;
            return;
        }

        const url = `/characters/${encodeURIComponent(avatarFile)}`;

        // Already loaded once this session — apply it immediately,
        // no placeholder, no visible loading gap.
        if (dashboardLoadedAvatars.has(url)) {

            box.textContent = '';

            const img = document.createElement('img');

            img.src = url;
            img.alt = initial;

            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '50%';

            box.appendChild(img);

            return;

        }

        // First time seeing this avatar: keep the calm initial-letter
        // placeholder showing while it loads off-screen, and only
        // touch the box once the image is actually ready. This is
        // what avoids the broken-icon flash — the box never displays
        // a half-loaded <img>.
        box.textContent = initial;

        const preload = new Image();

        preload.addEventListener('load', () => {

            dashboardLoadedAvatars.add(url);

            box.textContent = '';

            const img = document.createElement('img');

            img.src = url;
            img.alt = initial;

            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '50%';

            box.appendChild(img);

        });

        // Real failure (file genuinely missing) — the letter placeholder
        // set above just stays as-is.
        preload.src = url;

    }

    // Builds one contact row for a story character, matching the
    // exact markup/classes (and therefore colors) of the original
    // static rows.
    function buildStoryContactRow(character) {

        const initial =
            character.name ? character.name.charAt(0).toUpperCase() : '?';

        const lastLine = getLastLineFrom(character.name);

        const row = document.createElement('div');

        row.className = 'full-message story-contact';
        row.dataset.chatName = character.name;
        row.dataset.chatInitial = initial;

        const avatar = document.createElement('div');
        avatar.className = 'full-message-avatar';

        renderContactAvatarInto(avatar, character.avatar, initial);

        const textBox = document.createElement('div');
        textBox.className = 'full-message-text';

        const nameEl = document.createElement('b');
        nameEl.textContent = character.name;

        const previewEl = document.createElement('span');
        previewEl.textContent =
            lastLine || 'แตะเพื่อเริ่มบทสนทนา';

        textBox.appendChild(nameEl);
        textBox.appendChild(previewEl);

        const prefs = getContactPrefs(character.name);

        row.classList.toggle('is-pinned', !!prefs.pinned);
        row.classList.toggle('is-blocked', !!prefs.blocked);

        const markers = [];

        if (prefs.pinned) {
            markers.push('<i class="fa-solid fa-thumbtack contact-flag"></i>');
        }

        if (prefs.muted) {
            markers.push('<i class="fa-solid fa-bell-slash contact-flag"></i>');
        }

        if (prefs.blocked) {
            markers.push('<i class="fa-solid fa-ban contact-flag is-blocked"></i>');
        }

        const meta = document.createElement('div');
        meta.className = 'full-message-meta';
        meta.innerHTML =
            `<time></time>${markers.join('')}<i class="fa-solid fa-chevron-right"></i>`;

        row.appendChild(avatar);
        row.appendChild(textBox);
        row.appendChild(meta);

        return row;

    }

    // Rebuilds the contact list from scratch — clears out any
    // previously-rendered story rows and re-adds one per current
    // character/NPC, ahead of the fixed "ระบบ" row. Safe to call
    // every time the dashboard opens, since the active character
    // can change between visits.
    function renderStoryContacts() {

        if (!fullListCard) {
            return;
        }

        fullListCard
            .querySelectorAll('.story-contact')
            .forEach((row) => row.remove());

        const characters = getStoryCharacters()
            .slice()
            .sort((a, b) => {

                const pinnedA = isContactPinned(a.name) ? 1 : 0;
                const pinnedB = isContactPinned(b.name) ? 1 : 0;

                return pinnedB - pinnedA;

            });

        characters.forEach((character) => {

            const row = buildStoryContactRow(character);

            bindFullMessageItem(row);

            if (systemMessageRow) {
                fullListCard.insertBefore(row, systemMessageRow);
            } else {
                fullListCard.appendChild(row);
            }

        });

    }

    if (chatThreadBack) {

        addPressEffect(chatThreadBack);

        chatThreadBack.addEventListener(
            'click',
            closeChatThread
        );

    }

    if (chatThreadSend) {

        addPressEffect(chatThreadSend);

        chatThreadSend.addEventListener(
            'click',
            sendChatMessage
        );

    }

    // =====================================================
    // CONFIRM MODAL (replacement for window.confirm)
    // =====================================================
    // window.confirm()/alert()/prompt() are native browser dialogs,
    // and every browser treats those as a reason to force the page
    // out of fullscreen the moment they open — there's no way to
    // keep fullscreen and use the real one. This is a small in-page
    // modal with the same yes/no shape, resolved as a promise, so
    // anything that used to call window.confirm(message) can instead
    // do: if (!(await showDashboardConfirm(message))) return;

    const dashboardConfirmModal =
        dashboard.querySelector('#dashboard-confirm');

    const dashboardConfirmMessage =
        dashboard.querySelector('#dashboard-confirm-message');

    const dashboardConfirmOk =
        dashboard.querySelector('#dashboard-confirm-ok');

    const dashboardConfirmCancel =
        dashboard.querySelector('#dashboard-confirm-cancel');

    // Only one confirm can be on screen at a time, so a single
    // pending resolver is enough — a new call just replaces it.
    let dashboardConfirmResolve = null;

    function settleDashboardConfirm(result) {

        if (!dashboardConfirmModal) {
            return;
        }

        dashboardConfirmModal.classList.remove('open');

        const resolve = dashboardConfirmResolve;
        dashboardConfirmResolve = null;

        if (resolve) {
            resolve(result);
        }

    }

    function showDashboardConfirm(message, okLabel) {

        return new Promise((resolve) => {

            if (!dashboardConfirmModal || !dashboardConfirmMessage) {
                // No modal in the DOM for some reason — fail safe by
                // treating it as "cancelled" rather than silently
                // doing the (often destructive) action anyway.
                resolve(false);
                return;
            }

            // Anything still waiting on a previous confirm (there
            // shouldn't be one) is treated as cancelled.
            settleDashboardConfirm(false);

            dashboardConfirmResolve = resolve;
            dashboardConfirmMessage.textContent = message;

            if (dashboardConfirmOk && okLabel) {
                dashboardConfirmOk.textContent = okLabel;
            } else if (dashboardConfirmOk) {
                dashboardConfirmOk.textContent = 'ยืนยัน';
            }

            dashboardConfirmModal.classList.add('open');

        });

    }

    if (dashboardConfirmOk) {

        addPressEffect(dashboardConfirmOk);

        dashboardConfirmOk.addEventListener(
            'click',
            () => settleDashboardConfirm(true)
        );

    }

    if (dashboardConfirmCancel) {

        addPressEffect(dashboardConfirmCancel);

        dashboardConfirmCancel.addEventListener(
            'click',
            () => settleDashboardConfirm(false)
        );

    }

    if (dashboardConfirmModal) {

        // Clicking the dimmed backdrop counts as cancel — same as
        // clicking outside any other dropdown/sheet in this app.
        dashboardConfirmModal.addEventListener('click', (event) => {

            if (event.target === dashboardConfirmModal) {
                settleDashboardConfirm(false);
            }

        });

    }

    document.addEventListener('keydown', (event) => {

        if (
            event.key === 'Escape' &&
            dashboardConfirmModal &&
            dashboardConfirmModal.classList.contains('open')
        ) {
            settleDashboardConfirm(false);
        }

    });


    // =====================================================
    // CHAT THREAD "..." MENU (currently just: clear history)
    // =====================================================

    function closeThreadMoreMenu() {

        if (chatThreadMoreMenu) {
            chatThreadMoreMenu.classList.remove('open');
        }

    }

    if (chatThreadMoreButton && chatThreadMoreMenu) {

        addPressEffect(chatThreadMoreButton);

        chatThreadMoreButton.addEventListener('click', (event) => {

            event.stopPropagation();

            chatThreadMoreMenu.classList.toggle('open');

        });

        document.addEventListener('click', (event) => {

            if (
                chatThreadMoreMenu.classList.contains('open') &&
                !chatThreadMoreMenu.contains(event.target) &&
                event.target !== chatThreadMoreButton
            ) {
                closeThreadMoreMenu();
            }

        });

        document.addEventListener('keydown', (event) => {

            if (event.key === 'Escape') {
                closeThreadMoreMenu();
            }

        });

    }

    if (chatThreadClearHistoryButton) {

        addPressEffect(chatThreadClearHistoryButton);

        chatThreadClearHistoryButton.addEventListener('click', async () => {

            closeThreadMoreMenu();

            if (!activeChatName || activeChatName === 'ระบบ') {
                return;
            }

            const confirmed = await showDashboardConfirm(
                `ลบประวัติการแชทกับ ${activeChatName} ทั้งหมด? การกระทำนี้ย้อนกลับไม่ได้`,
                'ลบ'
            );

            if (!confirmed) {
                return;
            }

            const threads = getPhoneThreadStore();

            threads[activeChatName] = [];

            // Call logs are part of "the history with this contact",
            // so they go away together with the messages instead of
            // lingering in the call-history sheet.
            const callLogs = getCallLogStore();

            delete callLogs[activeChatName];

            saveDashboardSettings();

            closeChatSheet();

            if (isThreadOpenFor(activeChatName)) {
                renderChatBody([]);
            }

            renderStoryContacts();

        });

    }

    // =====================================================
    // CHAT THREAD "..." MENU — THE REST OF THE ITEMS
    // =====================================================
    // Search, mute, pin, room theme, call history, block, export
    // and the single-message undo. Everything here is stored per
    // contact and per chat (see getContactPrefs / getCallLogs).

    const CHAT_WALLPAPER_OPTIONS = [
        { id: 'default', label: 'ชมพูพาสเทล (เริ่มต้น)' },
        { id: 'sunset', label: 'พระอาทิตย์ตก' },
        { id: 'ocean', label: 'ทะเลใส' },
        { id: 'mint', label: 'มินต์' },
        { id: 'night', label: 'กลางคืน' },
        { id: 'mono', label: 'กระดาษเรียบ' }
    ];

    const CHAT_BUBBLE_OPTIONS = [
        { id: 'default', label: 'ชมพู-ม่วง (เริ่มต้น)' },
        { id: 'sunset', label: 'ส้มพีช' },
        { id: 'ocean', label: 'ฟ้าน้ำเงิน' },
        { id: 'mint', label: 'เขียวมินต์' },
        { id: 'night', label: 'ม่วงเข้ม' },
        { id: 'mono', label: 'ขาว-ดำ' }
    ];

    const chatThreadSearchBar =
        dashboard.querySelector('#chat-thread-search');

    const chatThreadSearchInput =
        dashboard.querySelector('#chat-thread-search-input');

    const chatThreadSearchCount =
        dashboard.querySelector('#chat-thread-search-count');

    const chatThreadSearchCloseButton =
        dashboard.querySelector('#chat-thread-search-close');

    const chatThreadSearchToggle =
        dashboard.querySelector('#chat-thread-search-toggle');

    const chatThreadBlockedBanner =
        dashboard.querySelector('#chat-thread-blocked-banner');

    const chatThreadMuteButton =
        dashboard.querySelector('#chat-thread-mute');

    const chatThreadPinButton =
        dashboard.querySelector('#chat-thread-pin');

    const chatThreadThemeButton =
        dashboard.querySelector('#chat-thread-theme');

    const chatThreadCallLogButton =
        dashboard.querySelector('#chat-thread-call-log');

    const chatThreadExportButton =
        dashboard.querySelector('#chat-thread-export');

    const chatThreadUndoButton =
        dashboard.querySelector('#chat-thread-undo-last');

    const chatThreadBlockButton =
        dashboard.querySelector('#chat-thread-block');

    const chatSheet =
        dashboard.querySelector('#chat-sheet');

    const chatSheetTitle =
        dashboard.querySelector('#chat-sheet-title');

    const chatSheetBody =
        dashboard.querySelector('#chat-sheet-body');

    const chatSheetCloseButton =
        dashboard.querySelector('#chat-sheet-close');

    // -----------------------------------------------------
    // SEARCH IN CHAT
    // -----------------------------------------------------

    function updateChatSearchCount() {

        if (!chatThreadSearchCount) {
            return;
        }

        chatThreadSearchCount.textContent = chatSearchTerm.trim()
            ? `${chatSearchMatchCount} รายการ`
            : '';

    }

    function resetChatSearch(rerender) {

        chatSearchTerm = '';
        chatSearchMatchCount = 0;

        if (chatThreadSearchInput) {
            chatThreadSearchInput.value = '';
        }

        if (chatThreadSearchBar) {
            chatThreadSearchBar.classList.remove('open');
        }

        updateChatSearchCount();

        if (rerender) {
            renderChatBody(lastRenderedHistory);
        }

    }

    function openChatSearch() {

        if (!chatThreadSearchBar) {
            return;
        }

        chatThreadSearchBar.classList.add('open');

        if (chatThreadSearchInput) {

            chatThreadSearchInput.focus();
            chatThreadSearchInput.select();

        }

    }

    if (chatThreadSearchToggle) {

        addPressEffect(chatThreadSearchToggle);

        chatThreadSearchToggle.addEventListener('click', () => {

            closeThreadMoreMenu();

            if (
                chatThreadSearchBar &&
                chatThreadSearchBar.classList.contains('open')
            ) {
                resetChatSearch(true);
                return;
            }

            openChatSearch();

        });

    }

    if (chatThreadSearchInput) {

        chatThreadSearchInput.addEventListener('input', () => {

            chatSearchTerm = chatThreadSearchInput.value;

            renderChatBody(lastRenderedHistory);

        });

        chatThreadSearchInput.addEventListener('keydown', (event) => {

            if (event.key === 'Escape') {

                event.preventDefault();

                resetChatSearch(true);

            }

        });

    }

    if (chatThreadSearchCloseButton) {

        addPressEffect(chatThreadSearchCloseButton);

        chatThreadSearchCloseButton.addEventListener(
            'click',
            () => resetChatSearch(true)
        );

    }

    // -----------------------------------------------------
    // MENU STATE (labels follow whatever this contact is set to)
    // -----------------------------------------------------

    function setThreadMenuItem(button, iconClass, label, isDanger) {

        if (!button) {
            return;
        }

        const icon = button.querySelector('i');
        const text = button.querySelector('span');

        if (icon) {
            icon.className = iconClass;
        }

        if (text) {
            text.textContent = label;
        }

        if (typeof isDanger === 'boolean') {
            button.classList.toggle('is-danger', isDanger);
        }

    }

    function syncThreadMenuLabels() {

        const name = activeChatName;
        const usable = !!name && name !== 'ระบบ';
        const prefs = usable ? getContactPrefs(name) : null;

        setThreadMenuItem(
            chatThreadMuteButton,
            prefs && prefs.muted
                ? 'fa-solid fa-bell'
                : 'fa-solid fa-bell-slash',
            prefs && prefs.muted
                ? 'เปิดการแจ้งเตือน'
                : 'ปิดการแจ้งเตือน'
        );

        setThreadMenuItem(
            chatThreadPinButton,
            'fa-solid fa-thumbtack',
            prefs && prefs.pinned
                ? 'เลิกปักหมุดแชท'
                : 'ปักหมุดแชท'
        );

        setThreadMenuItem(
            chatThreadBlockButton,
            prefs && prefs.blocked
                ? 'fa-solid fa-circle-check'
                : 'fa-solid fa-ban',
            prefs && prefs.blocked
                ? 'เลิกบล็อกผู้ติดต่อ'
                : 'บล็อกผู้ติดต่อ',
            !(prefs && prefs.blocked)
        );

        [
            chatThreadSearchToggle,
            chatThreadMuteButton,
            chatThreadPinButton,
            chatThreadThemeButton,
            chatThreadCallLogButton,
            chatThreadExportButton,
            chatThreadUndoButton,
            chatThreadBlockButton
        ].forEach((button) => {

            if (!button) {
                return;
            }

            button.disabled = !usable;

            button.classList.toggle('is-disabled', !usable);

        });

    }

    // Wallpaper, bubble colors, the blocked banner and the composer
    // state all follow whichever contact's thread just opened.
    function applyContactPrefsToThread(name, isSystem) {

        const prefs = (name && !isSystem)
            ? getContactPrefs(name)
            : null;

        if (chatThread) {

            chatThread.dataset.wallpaper =
                prefs ? prefs.wallpaper : 'default';

            chatThread.dataset.bubble =
                prefs ? prefs.bubble : 'default';

        }

        const blocked = !!(prefs && prefs.blocked);

        if (chatThreadBlockedBanner) {
            chatThreadBlockedBanner.classList.toggle('open', blocked);
        }

        if (!isSystem && chatThreadInput && chatThreadSend) {

            chatThreadInput.disabled = blocked;
            chatThreadSend.disabled = blocked;

            chatThreadInput.placeholder = blocked
                ? 'บล็อกอยู่ — เลิกบล็อกเพื่อส่งข้อความ'
                : 'พิมพ์ข้อความ...';

        }

        if (!isSystem && videoCallButton) {

            videoCallButton.disabled = blocked;

            videoCallButton.classList.toggle('is-disabled', blocked);

        }

        if (!isSystem && callButton) {

            callButton.disabled = blocked;

            callButton.classList.toggle('is-disabled', blocked);

        }

        syncThreadMenuLabels();

    }

    // -----------------------------------------------------
    // BOTTOM SHEET (theme picker / call history)
    // -----------------------------------------------------

    function closeChatSheet() {

        if (chatSheet) {
            chatSheet.classList.remove('open');
        }

    }

    function openChatSheet(title, buildBody) {

        if (!chatSheet || !chatSheetBody) {
            return;
        }

        if (chatSheetTitle) {
            chatSheetTitle.textContent = title;
        }

        chatSheetBody.innerHTML = '';

        buildBody(chatSheetBody);

        chatSheet.classList.add('open');

    }

    if (chatSheetCloseButton) {

        addPressEffect(chatSheetCloseButton);

        chatSheetCloseButton.addEventListener('click', closeChatSheet);

    }

    if (chatSheet) {

        chatSheet.addEventListener('click', (event) => {

            if (event.target === chatSheet) {
                closeChatSheet();
            }

        });

    }

    document.addEventListener('keydown', (event) => {

        if (
            event.key === 'Escape' &&
            chatSheet &&
            chatSheet.classList.contains('open')
        ) {
            closeChatSheet();
        }

    });

    // -----------------------------------------------------
    // MUTE / PIN
    // -----------------------------------------------------

    if (chatThreadMuteButton) {

        addPressEffect(chatThreadMuteButton);

        chatThreadMuteButton.addEventListener('click', () => {

            closeThreadMoreMenu();

            if (!activeChatName || activeChatName === 'ระบบ') {
                return;
            }

            setContactPref(
                activeChatName,
                'muted',
                !isContactMuted(activeChatName)
            );

            syncThreadMenuLabels();

            renderStoryContacts();

        });

    }

    if (chatThreadPinButton) {

        addPressEffect(chatThreadPinButton);

        chatThreadPinButton.addEventListener('click', () => {

            closeThreadMoreMenu();

            if (!activeChatName || activeChatName === 'ระบบ') {
                return;
            }

            setContactPref(
                activeChatName,
                'pinned',
                !isContactPinned(activeChatName)
            );

            syncThreadMenuLabels();

            renderStoryContacts();

        });

    }

    // -----------------------------------------------------
    // WALLPAPER + BUBBLE THEME
    // -----------------------------------------------------

    function buildThemeSheet(container) {

        const name = activeChatName;

        if (!name) {
            return;
        }

        const prefs = getContactPrefs(name);

        const buildGroup = (heading, options, currentId, onPick) => {

            const wrap = document.createElement('div');
            wrap.className = 'chat-sheet-group';

            const title = document.createElement('h4');
            title.textContent = heading;
            wrap.appendChild(title);

            const grid = document.createElement('div');
            grid.className = 'chat-sheet-grid';

            options.forEach((option) => {

                const button = document.createElement('button');

                button.type = 'button';
                button.className = 'chat-theme-option';
                button.dataset.preview = option.id;

                button.classList.toggle(
                    'is-active',
                    option.id === currentId
                );

                const swatch = document.createElement('span');
                swatch.className = 'chat-theme-swatch';

                const label = document.createElement('span');
                label.className = 'chat-theme-label';
                label.textContent = option.label;

                button.appendChild(swatch);
                button.appendChild(label);

                addPressEffect(button);

                button.addEventListener('click', () => {

                    onPick(option.id);

                    grid
                        .querySelectorAll('.chat-theme-option')
                        .forEach((el) => el.classList.remove('is-active'));

                    button.classList.add('is-active');

                });

                grid.appendChild(button);

            });

            wrap.appendChild(grid);

            return wrap;

        };

        container.appendChild(
            buildGroup(
                'วอลเปเปอร์ห้องแชท',
                CHAT_WALLPAPER_OPTIONS,
                prefs.wallpaper,
                (id) => {

                    setContactPref(name, 'wallpaper', id);

                    if (chatThread) {
                        chatThread.dataset.wallpaper = id;
                    }

                }
            )
        );

        container.appendChild(
            buildGroup(
                'สีฟองข้อความ',
                CHAT_BUBBLE_OPTIONS,
                prefs.bubble,
                (id) => {

                    setContactPref(name, 'bubble', id);

                    if (chatThread) {
                        chatThread.dataset.bubble = id;
                    }

                }
            )
        );

    }

    if (chatThreadThemeButton) {

        addPressEffect(chatThreadThemeButton);

        chatThreadThemeButton.addEventListener('click', () => {

            closeThreadMoreMenu();

            if (!activeChatName || activeChatName === 'ระบบ') {
                return;
            }

            openChatSheet('ธีมห้องแชท', buildThemeSheet);

        });

    }

    // -----------------------------------------------------
    // CALL HISTORY
    // -----------------------------------------------------

    function formatCallLogTimestamp(timestamp) {

        try {

            return new Date(timestamp).toLocaleString(
                'th-TH',
                {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit'
                }
            );

        } catch (error) {
            return '';
        }

    }

    function describeCallLog(log) {

        if (log.status === 'answered') {

            const kind = log.video
                ? (log.direction === 'in'
                    ? 'วิดีโอคอลเข้า'
                    : 'วิดีโอคอลออก')
                : (log.direction === 'in' ? 'สายเข้า' : 'สายออก');

            return `${kind} • ${formatCallDuration(log.seconds || 1)}`;

        }

        return log.status === 'declined'
            ? 'ปฏิเสธสาย'
            : 'สายที่ไม่ได้รับ';

    }

    function buildCallLogSheet(container) {

        const name = activeChatName;

        if (!name) {
            return;
        }

        const logs = getCallLogs(name).slice().reverse();

        if (!logs.length) {

            const empty = document.createElement('p');

            empty.className = 'chat-sheet-empty';
            empty.textContent =
                'ยังไม่มีประวัติการโทรกับผู้ติดต่อนี้';

            container.appendChild(empty);

            return;

        }

        logs.forEach((log) => {

            const card = document.createElement('div');
            card.className = 'chat-call-log';

            const head = document.createElement('button');
            head.type = 'button';
            head.className = 'chat-call-log-head';

            const icon = document.createElement('i');

            icon.className = log.status === 'answered'
                ? (log.video
                    ? 'fa-solid fa-video'
                    : (log.direction === 'in'
                        ? 'fa-solid fa-phone-flip'
                        : 'fa-solid fa-phone'))
                : 'fa-solid fa-phone-slash';

            const main = document.createElement('span');
            main.className = 'chat-call-log-main';

            const strong = document.createElement('strong');
            strong.textContent = describeCallLog(log);

            const small = document.createElement('small');
            small.textContent = formatCallLogTimestamp(log.at);

            main.appendChild(strong);
            main.appendChild(small);

            const chevron = document.createElement('i');
            chevron.className =
                'fa-solid fa-chevron-down chat-call-log-chevron';

            head.appendChild(icon);
            head.appendChild(main);
            head.appendChild(chevron);

            if (log.status !== 'answered') {
                head.classList.add('is-missed');
            }

            const body = document.createElement('div');
            body.className = 'chat-call-log-body';

            const lines = Array.isArray(log.lines) ? log.lines : [];

            if (lines.length) {

                lines.forEach((line) => {

                    const row = document.createElement('div');

                    row.className = 'chat-call-log-line';

                    if (line.kind === 'call-ambient') {

                        row.classList.add('is-ambient');

                    } else {

                        row.classList.add(
                            line.from === 'in' ? 'is-in' : 'is-out'
                        );

                        const who = document.createElement('b');

                        who.textContent =
                            line.from === 'in' ? name : 'คุณ';

                        row.appendChild(who);

                    }

                    const text = document.createElement('p');
                    text.textContent = line.text;

                    row.appendChild(text);

                    body.appendChild(row);

                });

            } else {

                const empty = document.createElement('p');

                empty.className = 'chat-call-log-empty';
                empty.textContent =
                    'สายนี้ไม่มีบทสนทนาที่บันทึกไว้';

                body.appendChild(empty);

            }

            addPressEffect(head);

            head.addEventListener(
                'click',
                () => card.classList.toggle('open')
            );

            card.appendChild(head);
            card.appendChild(body);

            container.appendChild(card);

        });

    }

    if (chatThreadCallLogButton) {

        addPressEffect(chatThreadCallLogButton);

        chatThreadCallLogButton.addEventListener('click', () => {

            closeThreadMoreMenu();

            if (!activeChatName || activeChatName === 'ระบบ') {
                return;
            }

            openChatSheet('ประวัติการโทร', buildCallLogSheet);

        });

    }

    // -----------------------------------------------------
    // BLOCK / UNBLOCK
    // -----------------------------------------------------

    if (chatThreadBlockButton) {

        addPressEffect(chatThreadBlockButton);

        chatThreadBlockButton.addEventListener('click', async () => {

            closeThreadMoreMenu();

            const name = activeChatName;

            if (!name || name === 'ระบบ') {
                return;
            }

            const blocked = isContactBlocked(name);

            if (!blocked) {

                const confirmed = await showDashboardConfirm(
                    `บล็อก ${name}? จะส่งหรือรับข้อความและสายจากคนนี้ไม่ได้ จนกว่าคุณจะเลิกบล็อก`,
                    'บล็อก'
                );

                if (!confirmed) {
                    return;
                }

            }

            setContactPref(name, 'blocked', !blocked);

            applyContactPrefsToThread(name, false);

            renderStoryContacts();

        });

    }

    // -----------------------------------------------------
    // EXPORT CHAT HISTORY
    // -----------------------------------------------------

    function buildChatExportText(name) {

        const lines = [
            `ประวัติการแชทกับ ${name}`,
            `ส่งออกเมื่อ ${formatCallLogTimestamp(Date.now())}`,
            ''
        ];

        const history = getChatDisplayHistory(name);

        if (!history.length) {
            lines.push('(ยังไม่มีข้อความ)');
        }

        history.forEach((entry) => {

            const text = String(entry.text || '').replace(/\n/g, ' ');

            if (entry.kind === 'call-summary') {
                lines.push(`[การโทร • ${text}]`);
                return;
            }

            lines.push(
                `[${entry.time || '--:--'}] ${entry.from === 'in' ? name : 'คุณ'}: ${text}`
            );

        });

        const logs = getCallLogs(name);

        if (logs.length) {

            lines.push('', '=== ประวัติการโทร ===');

            logs.forEach((log) => {

                lines.push(
                    '',
                    `${formatCallLogTimestamp(log.at)} — ${describeCallLog(log)}`
                );

                (Array.isArray(log.lines) ? log.lines : []).forEach((line) => {

                    const text = String(line.text || '').replace(/\n/g, ' ');

                    lines.push(
                        line.kind === 'call-ambient'
                            ? `  (${text})`
                            : `  ${line.from === 'in' ? name : 'คุณ'}: ${text}`
                    );

                });

            });

        }

        return lines.join('\n');

    }

    // Saved as a plain .txt through a temporary blob link — no
    // server round-trip, and nothing is left behind afterwards.
    function exportChatHistory(name) {

        let url = '';

        try {

            const blob = new Blob(
                [buildChatExportText(name)],
                { type: 'text/plain;charset=utf-8' }
            );

            url = URL.createObjectURL(blob);

            const link = document.createElement('a');

            link.href = url;

            link.download =
                `chat-${name}-${new Date().toISOString().slice(0, 10)}.txt`;

            document.body.appendChild(link);

            link.click();

            link.remove();

        } catch (error) {

            console.log('[Dashboard] Chat export failed', error);

        } finally {

            if (url) {
                setTimeout(() => URL.revokeObjectURL(url), 2000);
            }

        }

    }

    if (chatThreadExportButton) {

        addPressEffect(chatThreadExportButton);

        chatThreadExportButton.addEventListener('click', () => {

            closeThreadMoreMenu();

            if (!activeChatName || activeChatName === 'ระบบ') {
                return;
            }

            exportChatHistory(activeChatName);

        });

    }

    // -----------------------------------------------------
    // UNDO: DROP JUST THE LAST MESSAGE
    // -----------------------------------------------------

    if (chatThreadUndoButton) {

        addPressEffect(chatThreadUndoButton);

        chatThreadUndoButton.addEventListener('click', async () => {

            closeThreadMoreMenu();

            const name = activeChatName;

            if (!name || name === 'ระบบ') {
                return;
            }

            const thread = getPhoneThread(name);

            // Live call dialogue never shows as a bubble, so "the
            // last message" means the last thing actually visible in
            // the thread.
            let index = -1;

            for (let i = thread.length - 1; i >= 0; i--) {

                const kind = (thread[i] && thread[i].kind) || 'text';

                if (kind !== 'call' && kind !== 'call-ambient') {
                    index = i;
                    break;
                }

            }

            if (index < 0) {
                return;
            }

            const preview = String(thread[index].text || '')
                .replace(/\n/g, ' ')
                .slice(0, 60);

            const confirmed = await showDashboardConfirm(
                `ลบข้อความล่าสุดนี้? “${preview}”`,
                'ลบ'
            );

            if (!confirmed) {
                return;
            }

            thread.splice(index, 1);

            saveDashboardSettings();

            if (isThreadOpenFor(name)) {
                renderChatBody(getChatDisplayHistory(name));
            }

            renderStoryContacts();

        });

    }

    // Header call/video icons and the composer's plus/emoji icons
    // are decorative — same treatment as the notification bell
    // elsewhere in the dashboard — but they still get the press
    // feedback so nothing feels dead under a tap. The "..." button
    // has its own real behavior above, so it's excluded here to
    // avoid binding the press effect twice.
    dashboard
        .querySelectorAll(
            '.chat-thread-icon-button:not(#chat-thread-more-button), .chat-thread-composer-icon'
        )
        .forEach((button) => addPressEffect(button));

    if (chatThreadInput) {

        chatThreadInput.addEventListener(
            'keydown',
            (event) => {

                if (event.key === 'Enter') {
                    event.preventDefault();
                    sendChatMessage();
                }

            }
        );

    }


    // =====================================================
    // BANK COPY BUTTON
    // =====================================================

    const bankCopyBtn =
        dashboard.querySelector('#bank-copy-btn');

    if (bankCopyBtn) {

        bankCopyBtn.addEventListener(
            'click',
            async (event) => {

                event.stopPropagation();

                try {

                    await navigator.clipboard.writeText('9987');

                } catch (error) {

                    console.log(
                        '[Dashboard] Copy failed',
                        error
                    );

                }

                bankCopyBtn.innerHTML =
                    '<i class="fa-solid fa-check"></i>';

                bankCopyBtn.classList.add('copied');

                setTimeout(() => {

                    bankCopyBtn.innerHTML =
                        '<i class="fa-solid fa-copy"></i>';

                    bankCopyBtn.classList.remove('copied');

                }, 1500);

            }
        );

    }


    // =====================================================
    // CLOSE DASHBOARD
    // =====================================================

    closeButton.addEventListener(
        'click',
        async () => {

            dashboard.classList.remove(
                'open'
            );

            try {

                if (
                    document.fullscreenElement
                ) {

                    await document.exitFullscreen();

                }

            } catch (error) {

                console.log(
                    '[Dashboard] Fullscreen exit failed',
                    error
                );

            }

        }
    );


    // =====================================================
    // WELCOME / BOOT SCREEN
    // =====================================================

    const dashboardBootScreen =
        dashboard.querySelector('#dashboard-boot-screen');

    const dashboardBootBg =
        dashboard.querySelector('#dashboard-boot-bg');

    const dashboardBootStar =
        dashboard.querySelector('#dashboard-boot-star');

    const dashboardBootContinue =
        dashboard.querySelector('#dashboard-boot-continue');

    const dashboardBootMusic =
        dashboard.querySelector('#dashboard-boot-music');

    const dashboardBootClickSound =
        dashboard.querySelector('#dashboard-boot-click-sound');

    if (dashboardBootMusic && DASHBOARD_WELCOME_MUSIC_URL) {
        dashboardBootMusic.src = DASHBOARD_WELCOME_MUSIC_URL;
        dashboardBootMusic.volume = DASHBOARD_WELCOME_MUSIC_VOLUME;
    }

    if (dashboardBootClickSound && DASHBOARD_BOOT_BUTTON_SOUND_URL) {
        dashboardBootClickSound.src = DASHBOARD_BOOT_BUTTON_SOUND_URL;
    }

    // Holds the stop() function for the generated ambient pad
    // while it's playing, so it's only started once per open.
    let dashboardBootMusicStop = null;

    // Starts the welcome screen's background music from the top —
    // the hosted file if one is set, otherwise the generated pad.
    // Browsers block audio unless it's triggered by an actual user
    // gesture (a click/tap) — every place this is called from is
    // already inside a click handler, so that's satisfied. If it's
    // ever blocked anyway (e.g. autoplay settings), fail quietly
    // rather than throwing.
    function playBootMusic() {

        if (dashboardBootMusic && dashboardBootMusic.src) {

            try {
                dashboardBootMusic.currentTime = 0;
            } catch (error) {
                // Ignore — some browsers disallow this before the
                // audio has finished loading.
            }

            dashboardBootMusic.play().catch((error) => {
                console.log(
                    '[Dashboard] Boot music autoplay blocked',
                    error
                );
            });

            return;

        }

        if (!dashboardBootMusicStop) {
            dashboardBootMusicStop = startGeneratedBootMusic();
        }

    }

    // Stops the welcome screen's music (used when leaving it, so it
    // doesn't keep playing underneath the rest of the dashboard).
    function stopBootMusic() {

        if (dashboardBootMusic) {

            dashboardBootMusic.pause();

            try {
                dashboardBootMusic.currentTime = 0;
            } catch (error) {
                // Ignore, same as above.
            }

        }

        if (dashboardBootMusicStop) {
            dashboardBootMusicStop();
            dashboardBootMusicStop = null;
        }

    }

    // Plays the short tap sound once — the hosted file if one is
    // set, otherwise the generated chime — restarting from the top
    // even if it's still finishing from a previous press.
    function playBootButtonSound() {

        if (dashboardBootClickSound && dashboardBootClickSound.src) {

            try {
                dashboardBootClickSound.currentTime = 0;
            } catch (error) {
                // Ignore, same as above.
            }

            dashboardBootClickSound.play().catch((error) => {
                console.log(
                    '[Dashboard] Button sound blocked',
                    error
                );
            });

            return;

        }

        playGeneratedTapSound();

    }

    // Drop in the hosted background image if a link has been
    // pasted into DASHBOARD_WELCOME_BACKGROUND_URL up top —
    // otherwise the plain CSS gradient fallback stays as-is.
    if (dashboardBootBg && DASHBOARD_WELCOME_BACKGROUND_URL) {

        dashboardBootBg.style.backgroundImage =
            `url('${DASHBOARD_WELCOME_BACKGROUND_URL}')`;

    }

    // Same for the star/compass graphic — swap the plain "✦"
    // glyph for the real image once a link is pasted in.
    if (dashboardBootStar && DASHBOARD_WELCOME_STAR_URL) {

        dashboardBootStar.textContent = '';

        const starImg = document.createElement('img');

        starImg.src = DASHBOARD_WELCOME_STAR_URL;
        starImg.alt = '';

        starImg.addEventListener('error', () => {
            dashboardBootStar.textContent = '✦';
        });

        dashboardBootStar.appendChild(starImg);

    }

    if (dashboardBootContinue) {

        addPressEffect(dashboardBootContinue);

        // Water-drop ripple that spreads from wherever the button
        // was actually touched / clicked.
        dashboardBootContinue.addEventListener(
            'pointerdown',
            (event) => {

                const rect =
                    dashboardBootContinue.getBoundingClientRect();

                const size =
                    Math.max(rect.width, rect.height) * 2;

                const ripple = document.createElement('span');

                ripple.className = 'dashboard-boot-button-ripple';

                ripple.style.width = `${size}px`;
                ripple.style.height = `${size}px`;

                ripple.style.left =
                    `${event.clientX - rect.left - (size / 2)}px`;

                ripple.style.top =
                    `${event.clientY - rect.top - (size / 2)}px`;

                ripple.addEventListener('animationend', () => {
                    ripple.remove();
                });

                dashboardBootContinue.appendChild(ripple);

            }
        );

        dashboardBootContinue.addEventListener(
            'click',
            () => {

                // Quick bloom on the button itself before the whole
                // welcome screen fades away.
                dashboardBootContinue.classList.add('is-launching');

                setTimeout(() => {
                    dashboardBootContinue
                        .classList.remove('is-launching');
                }, 500);

                playBootButtonSound();
                stopBootMusic();

                if (dashboardBootScreen) {
                    dashboardBootScreen.classList.add('is-dismissed');
                }

                // The welcome screen now hands off to the character
                // select screen rather than straight to the dashboard.
                openPickerScreen();

            }
        );

    }


    // =====================================================
    // CHARACTER SELECT SCREEN
    // =====================================================

    const dashboardPickerScreen =
        dashboard.querySelector('#dashboard-picker-screen');

    const dashboardPickerBg =
        dashboard.querySelector('#dashboard-picker-bg');

    const dashboardPickerGrid =
        dashboard.querySelector('#dashboard-picker-grid');

    const dashboardPickerEmpty =
        dashboard.querySelector('#dashboard-picker-empty');

    const dashboardPickerScope =
        dashboard.querySelector('#dashboard-picker-scope');

    const dashboardPickerSearch =
        dashboard.querySelector('#dashboard-picker-search-input');

    const dashboardBrandButton =
        dashboard.querySelector('#dashboard-brand-button');

    if (dashboardPickerBg && DASHBOARD_WELCOME_BACKGROUND_URL) {

        dashboardPickerBg.style.backgroundImage =
            `url('${DASHBOARD_WELCOME_BACKGROUND_URL}')`;

    }

    // Every character card in the library, not just the ones in the
    // current chat — that's what makes the dashboard browsable.
    function getLibraryCharacters() {

        const context = getDashboardContext();

        if (!context || !Array.isArray(context.characters)) {
            return [];
        }

        return context.characters
            .filter((character) => character && character.name)
            .map((character) => ({
                id: character.avatar || character.name,
                name: character.name,
                avatar: character.avatar || null
            }));

    }

    // Avatar filenames of whoever is actually in the chat right now,
    // so those cards can be pushed to the front and badged.
    function getChatMemberIds() {

        return getStoryCharacters()
            .map((character) => character.avatar)
            .filter(Boolean);

    }

    // Short line under the title explaining the storage scope, so it's
    // obvious the data belongs to this chat and nothing else.
    function refreshPickerScope() {

        if (!dashboardPickerScope) {
            return;
        }

        const context = getDashboardContext();

        const chatName =
            (context && context.groupId)
                ? 'แชทกลุ่มปัจจุบัน'
                : `แชทกับ ${(context && context.name2) || 'ตัวละคร'}`;

        dashboardPickerScope.textContent =
            `ข้อมูลทั้งหมดถูกบันทึกไว้ใน${chatName} เท่านั้น`;

    }

    function buildPickerCard(profile, isInChat) {

        const card = document.createElement('button');

        card.type = 'button';
        card.className = 'dashboard-picker-card';

        card.dataset.profileId = profile.id;
        card.dataset.profileName = profile.name;

        if (profile.avatar) {
            card.dataset.profileAvatar = profile.avatar;
        }

        if (isInChat) {
            card.classList.add('is-in-chat');
        }

        if (hasProfileData(profile.id)) {
            card.classList.add('has-data');
        }

        const avatarBox = document.createElement('span');

        avatarBox.className = 'dashboard-picker-avatar';

        renderContactAvatarInto(
            avatarBox,
            profile.avatar,
            profile.name.charAt(0).toUpperCase()
        );

        const nameBox = document.createElement('span');

        nameBox.className = 'dashboard-picker-name';
        nameBox.textContent = profile.name;

        const tag = document.createElement('span');

        tag.className = 'dashboard-picker-tag';

        if (isInChat) {
            tag.textContent = 'อยู่ในแชทนี้';
        } else if (hasProfileData(profile.id)) {
            tag.textContent = 'เคยเปิดไว้';
        } else {
            tag.textContent = 'ยังไม่มีข้อมูล';
        }

        card.appendChild(avatarBox);
        card.appendChild(nameBox);
        card.appendChild(tag);

        addPressEffect(card);

        card.addEventListener(
            'click',
            () => {
                selectProfile(profile);
            }
        );

        return card;

    }

    function renderPickerGrid(filterText) {

        if (!dashboardPickerGrid) {
            return;
        }

        dashboardPickerGrid.innerHTML = '';

        const memberIds = getChatMemberIds();

        const needle = (filterText || '').trim().toLowerCase();

        const profiles = getLibraryCharacters()
            .filter((profile) => (
                needle.length === 0 ||
                profile.name.toLowerCase().includes(needle)
            ))
            .sort((a, b) => {

                // In-chat characters first, then ones that already
                // have data in this chat, then plain alphabetical.
                const rank = (profile) => {

                    if (memberIds.includes(profile.id)) {
                        return 0;
                    }

                    if (hasProfileData(profile.id)) {
                        return 1;
                    }

                    return 2;

                };

                const diff = rank(a) - rank(b);

                if (diff !== 0) {
                    return diff;
                }

                return a.name.localeCompare(b.name);

            });

        profiles.forEach((profile) => {

            dashboardPickerGrid.appendChild(
                buildPickerCard(
                    profile,
                    memberIds.includes(profile.id)
                )
            );

        });

        if (dashboardPickerEmpty) {

            dashboardPickerEmpty.classList.toggle(
                'is-visible',
                profiles.length === 0
            );

        }

    }

    function openPickerScreen() {

        if (!dashboardPickerScreen) {
            return;
        }

        if (dashboardPickerSearch) {
            dashboardPickerSearch.value = '';
        }

        refreshPickerScope();
        renderPickerGrid('');

        dashboardPickerScreen.classList.remove('is-dismissed');

    }

    // Locks the dashboard onto one character and reveals it.
    function selectProfile(profile) {

        setActiveProfile(profile);

        // Touch the store so the card exists from now on and the
        // profile shows up as "เคยเปิดไว้" next time.
        getDashboardSettings();
        saveDashboardSettings();

        applyActiveProfile();

        if (dashboardPickerScreen) {
            dashboardPickerScreen.classList.add('is-dismissed');
        }

    }

    // Repaints everything that depends on WHICH character is selected.
    // The corner icon stays a plain ✦ on purpose — only the name and
    // the actual dashboard content switch with the profile.
    function applyActiveProfile() {

        const profileName = getActiveProfileName();

        dashboard
            .querySelectorAll('[data-profile-name]')
            .forEach((element) => {
                element.textContent = profileName;
            });

        // The quote and the online dot both live on the profile's
        // own card, so they have to be re-read after every switch.
        refreshQuoteDisplay();
        refreshStatusDisplays(dashboard);
        refreshUserInfo(dashboard);
        renderStoryContacts();

    }

    if (dashboardBrandButton) {

        addPressEffect(dashboardBrandButton);

        dashboardBrandButton.addEventListener(
            'click',
            openPickerScreen
        );

    }

    if (dashboardPickerSearch) {

        dashboardPickerSearch.addEventListener(
            'input',
            () => {
                renderPickerGrid(dashboardPickerSearch.value);
            }
        );

    }


    // =====================================================
    // OPEN DASHBOARD
    // =====================================================

    menuItem.addEventListener(
        'click',
        async () => {

            // Close SillyTavern's options menu so it doesn't stay
            // floating on top of the dashboard.
            const optionsRoot = document.querySelector('#options');

            if (optionsRoot) {

                if (typeof jQuery !== 'undefined') {
                    jQuery(optionsRoot).stop().fadeOut(200);
                } else {
                    optionsRoot.style.display = 'none';
                }

            }

            // Shown fresh every time, like a boot screen —
            // welcome first, then the character select screen.
            if (dashboardBootScreen) {
                dashboardBootScreen.classList.remove('is-dismissed');
            }

            if (dashboardPickerScreen) {
                dashboardPickerScreen.classList.remove('is-dismissed');
            }

            // This click is the user gesture that unlocks audio
            // playback, so start the welcome screen's music here.
            playBootMusic();

            refreshPickerScope();
            renderPickerGrid('');

            // Refresh {{user}}'s name/avatar in case the persona
            // changed since the dashboard was created.
            refreshUserInfo(dashboard);
            refreshStatusDisplays(dashboard);
            renderStoryContacts();

            dashboard.classList.add(
                'open'
            );

            try {

                if (
                    !document.fullscreenElement
                ) {

                    await document.documentElement
                        .requestFullscreen();

                }

            } catch (error) {

                console.log(
                    '[Dashboard] Fullscreen unavailable',
                    error
                );

            }

        }
    );


    // =====================================================
    // CHAT SWITCHED — START OVER
    // =====================================================
    // Dashboard data is scoped to the chat file, so as soon as
    // SillyTavern loads a different chat the selected profile is
    // dropped and the welcome / select screens come back.

    try {

        const eventContext = getDashboardContext();

        const eventSource = eventContext && eventContext.eventSource;

        const eventTypes =
            eventContext &&
            (eventContext.eventTypes || eventContext.event_types);

        if (eventSource && eventTypes && eventTypes.CHAT_CHANGED) {

            eventSource.on(
                eventTypes.CHAT_CHANGED,
                () => {

                    setActiveProfile(null);

                    // A different chat means a different message list
                    // to watch for [CALL]/[HANGUP] — without this, the
                    // old index could match the new chat's length by
                    // coincidence and silently swallow a real tag.
                    dashboardLastPhoneEventIndex = -1;

                    // Any call screen still open belonged to the chat
                    // being left — drop it quietly rather than logging
                    // a summary line into whichever chat loads next.
                    if (callState) {

                        if (callState.ringTimeout) {
                            clearTimeout(callState.ringTimeout);
                        }

                        if (callState.captionTimer) {
                            clearInterval(callState.captionTimer);
                        }

                        callState = null;

                        if (callScreen) {
                            callScreen.classList.remove(
                                'open',
                                'state-ringing',
                                'state-connected',
                                'is-incoming'
                            );
                        }

                    }

                    installPhoneTagInstruction();

                    if (dashboardBootScreen) {
                        dashboardBootScreen
                            .classList.remove('is-dismissed');
                    }

                    // CHAT_CHANGED fires whenever SillyTavern loads a
                    // chat — including on page load, before the user
                    // has ever opened the dashboard. Starting the
                    // music here was the bug: it played in the
                    // background even though the welcome screen
                    // wasn't actually on screen yet. The music should
                    // only start from the real "open" action (the
                    // menuItem click below), so this just makes sure
                    // nothing from a previous open is still playing.
                    stopBootMusic();

                    if (dashboardPickerScreen) {
                        dashboardPickerScreen
                            .classList.remove('is-dismissed');
                    }

                }
            );

        }

    } catch (error) {

        console.log('[Dashboard] Could not hook CHAT_CHANGED', error);

    }


    // =====================================================
    // ESC / FULLSCREEN CHANGE
    // =====================================================

    document.addEventListener(
        'fullscreenchange',
        () => {

            if (
                !document.fullscreenElement &&
                dashboard.classList.contains('open')
            ) {

                // Keep dashboard visible.
                // Browser fullscreen and Dashboard UI
                // are independent.
                console.log(
                    '[Dashboard] Browser fullscreen closed.'
                );

            }

        }
    );


    // =====================================================
    // CLOCK
    // =====================================================

    function updateClock() {

        const now = new Date();

        const time =
            now.toLocaleTimeString(
                'th-TH',
                {
                    hour: '2-digit',
                    minute: '2-digit'
                }
            );

        const date =
            now.toLocaleDateString(
                'en-GB',
                {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric'
                }
            );


        const clock =
            dashboard.querySelector(
                '#dashboard-clock'
            );

        const dateElement =
            dashboard.querySelector(
                '#dashboard-date'
            );


        if (clock) {
            clock.textContent = time;
        }

        if (dateElement) {
            dateElement.textContent = date;
        }

    }


    updateClock();

    setInterval(
        updateClock,
        1000
    );


    console.log(
        '[Dashboard] Ready.'
    );
}


// =========================================================
// CALENDAR
// =========================================================

function generateCalendar() {

    const days = [];

    const firstDay =
        new Date(
            2026,
            8,
            1
        ).getDay();

    const totalDays = 30;


    for (
        let i = 0;
        i < firstDay;
        i++
    ) {

        days.push(
            '<span class="calendar-empty"></span>'
        );

    }


    for (
        let day = 1;
        day <= totalDays;
        day++
    ) {

        const active =
            day === 14
                ? 'today'
                : '';

        days.push(
            `
            <span class="${active}">
                ${day}
            </span>
            `
        );

    }


    return days.join('');
}


export {
    init
};
