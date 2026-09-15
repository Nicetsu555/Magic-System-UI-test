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
// Nothing is global any more. Everything lives inside the CURRENT
// CHAT's own metadata, so starting a new chat gives you a clean
// dashboard, and deleting the chat takes its dashboard with it:
//
//   chatMetadata.dashboardWidget = {
//       profiles: {
//           "Yuki.png": { quote, quoteEn, status },
//           "Ren.png":  { quote, quoteEn, status }
//       }
//   }
//
// Inside one chat you can still flip between any character in your
// library from the select screen — each one keeps its own card.

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

// The dashboard blob belonging to the chat that's open right now.
function getDashboardStore() {

    const metadata = getChatMetadata();

    if (metadata) {

        if (!metadata[DASHBOARD_EXT_KEY]) {
            metadata[DASHBOARD_EXT_KEY] = {};
        }

        const store = metadata[DASHBOARD_EXT_KEY];

        if (!store.profiles) {
            store.profiles = {};
        }

        return store;

    }

    const chatId = getCurrentChatId();

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

        // Chat metadata is what actually persists the per-chat card;
        // the rest are fallbacks for older SillyTavern builds.
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
            return;
        }

        if (typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
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
                            type="button"
                            title="วิดีโอคอล"
                        >
                            <i class="fa-solid fa-video"></i>
                        </button>

                        <span class="chat-thread-header-divider"></span>

                        <button
                            class="chat-thread-icon-button"
                            type="button"
                            title="เพิ่มเติม"
                        >
                            <i class="fa-solid fa-ellipsis"></i>
                        </button>

                    </div>

                </div>

                <div
                    class="chat-thread-body"
                    id="chat-thread-body"
                ></div>

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
                            hangUpCall();
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

        chatThreadAvatar.textContent = initial;
        chatThreadAvatar.classList.toggle('system-avatar', isSystem);

        // Reused for every message row's little avatar too, so the
        // thread doesn't need to re-derive it per line.
        activeChatInitial = initial;
        activeChatIsSystem = isSystem;

        renderChatBody(
            isSystem
                ? (chatConversations[name] || [])
                : getMirroredHistory(name)
        );

        chatThread.classList.add('open');

    }

    function closeChatThread() {

        if (chatThread) {
            chatThread.classList.remove('open');
        }

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
    function renderChatBody(history) {

        if (!chatThreadBody) {
            return;
        }

        chatThreadBody.innerHTML = history
            .map((message) => buildChatRowHtml(message))
            .join('');

        chatThreadBody.scrollTop =
            chatThreadBody.scrollHeight;

    }

    // Turns one {from, text, time} entry into a full row: an avatar
    // beside the bubble for incoming lines (matching the reference
    // layout), right-aligned bubble-only for outgoing ones. The text
    // is split into one <p> per line so a long narrated turn reads
    // as a few short paragraphs instead of one dense wall of text.
    function buildChatRowHtml(message) {

        const paragraphs = (message.text || '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => `<p>${escapeHtml(line)}</p>`)
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
    const DASHBOARD_CALL_END_TAG = /\[\s*(?:hangup|end ?call|วางสาย)\s*\]/i;

    // Removes the tags themselves from anything that actually gets
    // displayed (chat bubbles AND call captions both go through
    // cleanBotReply below) — the story should react to them, the
    // person reading shouldn't ever see the literal brackets.
    function stripPhoneEventTags(text) {

        return text
            .replace(DASHBOARD_CALL_START_TAG, '')
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

    // The actual mirror: reads SillyTavern's real chat log and turns
    // it into phone bubbles for one contact. Solo chats show every
    // line (it's all {{user}} <-> that one character anyway); group
    // chats are filtered down to {{user}}'s lines plus only this
    // character's own lines, so each NPC's thread stays "of this
    // character only" per the story.
    function getMirroredHistory(characterName) {

        const context = getDashboardContext();
        const chatLog = context && context.chat;

        if (!Array.isArray(chatLog)) {
            return [];
        }

        const isGroup = !!context.groupId;

        return chatLog
            .filter((entry) => (
                entry &&
                entry.mes &&
                (
                    entry.is_user ||
                    !isGroup ||
                    entry.name === characterName
                )
            ))
            .map((entry) => ({
                from: entry.is_user ? 'out' : 'in',
                text: cleanBotReply(entry.mes),
                time: formatEntryTime(entry)
            }));

    }

    // Simulates the user actually typing into SillyTavern's real
    // message box and hitting send, so the phone composer produces
    // a genuine story turn (and a genuine generation) rather than a
    // side-channel reply.
    async function sendToRealChat(text) {

        const textarea = document.getElementById('send_textarea');
        const sendButton = document.getElementById('send_but');

        if (!textarea || !sendButton) {
            throw new Error('ไม่พบช่องพิมพ์ข้อความหลักของ SillyTavern');
        }

        textarea.value = text;

        textarea.dispatchEvent(
            new Event('input', { bubbles: true })
        );

        sendButton.click();

    }

    // Asks SillyTavern to generate the next character line WITHOUT
    // posting a turn of {{user}}'s own — used to make a call "answer"
    // (connectCall) and to give an incoming auto-call an opening line
    // when [CALL] arrived with nothing else attached (see
    // openIncomingCallScreen). Two ways to ask for this exist:
    //
    //   1. context.executeSlashCommandsWithOptions('/trigger') — the
    //      documented, extension-facing way to run a slash command.
    //      Preferred: it doesn't depend on the textarea/button still
    //      being at those exact DOM ids, and any failure comes back
    //      as a real error instead of silence.
    //   2. Falling back to sendToRealChat('/trigger') — types the
    //      command into the real textarea and clicks send, the same
    //      way this extension always has.
    //
    // If BOTH paths run without throwing and the character still
    // never says anything, the most likely cause left is that this
    // SillyTavern build doesn't treat "/trigger" as a real command —
    // check the browser console for a "[Dashboard]" line logged
    // here, it will say plainly which path was tried and what came
    // back.
    async function requestGeneration() {

        const context = getDashboardContext();

        if (context && typeof context.executeSlashCommandsWithOptions === 'function') {

            try {

                const result = await context.executeSlashCommandsWithOptions(
                    '/trigger'
                );

                console.log(
                    '[Dashboard] Asked for a reply via executeSlashCommandsWithOptions(\'/trigger\')',
                    result
                );

                return;

            } catch (error) {

                console.log(
                    '[Dashboard] executeSlashCommandsWithOptions(\'/trigger\') failed, falling back to the real textarea',
                    error
                );

            }

        }

        await sendToRealChat('/trigger');

        console.log(
            '[Dashboard] Asked for a reply by typing \'/trigger\' into SillyTavern\'s own message box and clicking send.'
        );

    }

    // Sends whatever is in the composer straight into the real
    // story as {{user}}. The outgoing bubble and the character's
    // reply both arrive through the live chat-event listeners below
    // once SillyTavern actually processes the turn — this just
    // kicks that off and shows a typing indicator while it's out.
    async function sendChatMessage() {

        if (!chatThreadInput || !activeChatName || activeChatName === 'ระบบ') {
            return;
        }

        const text = chatThreadInput.value.trim();

        if (!text) {
            return;
        }

        chatThreadInput.value = '';
        chatThreadInput.disabled = true;

        if (chatThreadSend) {
            chatThreadSend.disabled = true;
        }

        try {

            await sendToRealChat(text);

        } catch (error) {

            console.log(
                '[Dashboard] Failed to send into the real chat',
                error
            );

            chatThreadInput.disabled = false;
            chatThreadInput.value = text;

            if (chatThreadSend) {
                chatThreadSend.disabled = false;
            }

        }

    }

    // =====================================================
    // LIVE SYNC WITH THE REAL CHAT
    // =====================================================

    // Called whenever the real chat gains a message (from either
    // side) or otherwise changes. Keeps the contact-list previews
    // current, and — if a real contact's thread is open — re-mirrors
    // it so what's on screen never drifts from the real story.
    function handleLiveChatChange() {

        renderStoryContacts();

        if (
            activeChatName &&
            activeChatName !== 'ระบบ' &&
            isThreadOpenFor(activeChatName)
        ) {

            renderChatBody(getMirroredHistory(activeChatName));

        }

    }

    // On top of the generic refresh above: right after {{user}}'s
    // own line lands, show a typing indicator (the character's
    // reply is presumably still generating) and lock the composer
    // until it arrives.
    function handleMessageSent() {

        handleLiveChatChange();

        if (isThreadOpenFor(activeChatName)) {
            showTypingBubble();
        }

        // A line just went out during an active call — re-mirror the
        // captions (drops the placeholder bubble a manual trigger may
        // have added) and show the "character is speaking" indicator
        // while the real reply is still generating.
        if (isCallOpen() && callState && callState.connectedAt) {
            renderCallCaptions();
            showCallSpeakingBubble();
        }

    }

    // The character's reply has landed for real — the refresh above
    // already rebuilt the thread with it (which also clears the
    // typing indicator), so just unlock the composer again.
    function handleMessageReceived() {

        checkForPhoneEvents();

        handleLiveChatChange();

        if (
            isThreadOpenFor(activeChatName) &&
            chatThreadInput &&
            chatThreadSend
        ) {

            chatThreadInput.disabled = false;
            chatThreadSend.disabled = false;

        }

        // Same idea for the call screen: the character's line has
        // really landed in the story now, so show it as a caption and
        // let the person "speak" again.
        if (isCallOpen() && callState && callState.connectedAt) {

            renderCallCaptions();

            if (callScreenInput && callScreenSend) {
                callScreenInput.disabled = false;
                callScreenSend.disabled = false;
            }

        }

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
            'System note: {{char}} is texting {{user}} on a phone. ' +
            'If, and only if, {{char}} would realistically switch from ' +
            'texting to an actual voice call, start that message with the ' +
            'exact tag [CALL], then continue in the same message with ' +
            'what {{char}} actually says once the call connects — never ' +
            'send [CALL] alone with nothing said after it. When that call ' +
            'naturally ends, end {{char}}\'s final line of the call with ' +
            'the exact tag [HANGUP]. Never use either tag for anything ' +
            'other than a real phone call actually starting or ending.';

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


    // =====================================================
    // CALL SCREEN (voice call overlay)
    // =====================================================
    // A "call" is not a separate scripted mini-game — it's the same
    // real story, same real generation pipeline as the phone chat
    // thread above (see sendToRealChat). All this screen adds is:
    // a ringing state with a random 6–10s delay, a full-screen
    // "in call" presentation that mirrors new lines as captions
    // instead of chat bubbles, and — on hang-up — one short line
    // logged back into the real chat so the story remembers the call
    // happened.

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

    function isCallOpen() {

        return !!(
            callScreen &&
            callScreen.classList.contains('open')
        );

    }

    // How many entries are in the REAL chat log right now. Used as a
    // watermark: only entries added after this point are "said during
    // the call" and belong in the captions panel.
    function getRealChatLength() {

        const context = getDashboardContext();
        const chatLog = context && context.chat;

        return Array.isArray(chatLog) ? chatLog.length : 0;

    }

    // Shows only the MOST RECENT line said during the call, as a
    // single subtitle centered on screen — not a scrolling bubble
    // list. {{char}}'s lines type themselves out letter by letter,
    // like they're being spoken live; {{user}}'s own words (typed a
    // moment ago) just appear.
    function renderCallCaptions() {

        if (!callScreenCaptions || !callState) {
            return;
        }

        const fullHistory = getMirroredHistory(callState.name);
        const duringCall = fullHistory.slice(callState.startIndex);
        const latest = duringCall[duringCall.length - 1];

        if (!latest) {

            if (callState.captionTimer) {
                clearInterval(callState.captionTimer);
                callState.captionTimer = null;
            }

            callScreenCaptions.innerHTML = '';
            callState.lastCaptionKey = null;

            return;

        }

        const text = (latest.text || '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join('\n');

        // Identifies this exact line so a re-render triggered by
        // something else (e.g. the timer ticking) never replays the
        // typewriter animation on a line already fully shown.
        const captionKey = `${duringCall.length}:${latest.from}:${text}`;

        if (captionKey === callState.lastCaptionKey) {
            return;
        }

        callState.lastCaptionKey = captionKey;

        if (callState.captionTimer) {
            clearInterval(callState.captionTimer);
            callState.captionTimer = null;
        }

        callScreenCaptions.innerHTML = `
            <p class="call-screen-subtitle ${message_class(latest.from)}">
                <span class="subtitle-text"></span><span class="subtitle-cursor"></span>
            </p>
        `;

        const subtitleText =
            callScreenCaptions.querySelector('.subtitle-text');

        const cursor =
            callScreenCaptions.querySelector('.subtitle-cursor');

        if (!subtitleText || !text) {
            return;
        }

        if (latest.from !== 'in') {

            subtitleText.textContent = text;

            if (cursor) {
                cursor.remove();
            }

            return;

        }

        let shown = 0;

        callState.captionTimer = setInterval(
            () => {

                shown += 1;

                subtitleText.textContent = text.slice(0, shown);

                if (shown >= text.length) {

                    clearInterval(callState.captionTimer);
                    callState.captionTimer = null;

                    if (cursor) {
                        cursor.remove();
                    }

                }

            },
            28
        );

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

    // "2 นาที" once a minute or more has passed, "45 วินาที" for
    // anything shorter — matches how a person would actually describe
    // how long a call lasted.
    function formatCallDuration(totalSeconds) {

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes < 1) {
            return `${seconds} วินาที`;
        }

        return `${minutes} นาที`;

    }

    // Ticks the connected-call timer once a second.
    function updateCallTimer() {

        if (!callState || !callState.connectedAt || !callScreenStatus) {
            return;
        }

        const elapsed =
            Math.floor((Date.now() - callState.connectedAt) / 1000);

        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');

        callScreenStatus.textContent = `${mm}:${ss}`;

    }

    // Opens the call screen for whichever contact's thread is
    // currently active and starts the ringing state. The ring itself
    // is purely presentational (random 6–10s) — nothing is generated
    // until the call actually connects.
    function openCallScreen() {

        if (
            !callScreen ||
            !activeChatName ||
            activeChatName === 'ระบบ' ||
            isCallOpen()
        ) {
            return;
        }

        callState = {
            name: activeChatName,
            startIndex: getRealChatLength(),
            connectedAt: null,
            ringTimeout: null,
            timerInterval: null,
            captionTimer: null,
            lastCaptionKey: null
        };

        if (callScreenAvatar) {
            callScreenAvatar.textContent = activeChatInitial;
        }

        if (callScreenName) {
            callScreenName.textContent = activeChatName;
        }

        if (callScreenStatus) {
            callScreenStatus.textContent = 'กำลังโทรออก...';
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

    // Ringing is over — the call is "answered". Starts the live
    // timer, then asks for an opening line through the exact same
    // real-generation pipeline as every other message in the app
    // (sendToRealChat), so what the character says is a genuine
    // reply with genuine thinking time, not scripted text.
    async function connectCall() {

        if (!callState || !isCallOpen()) {
            return;
        }

        callState.connectedAt = Date.now();
        callState.startIndex = getRealChatLength();

        callScreen.classList.remove('state-ringing');
        callScreen.classList.add('state-connected');

        updateCallTimer();

        callState.timerInterval = setInterval(updateCallTimer, 1000);

        const speakingBubble = showCallSpeakingBubble();

        try {

            // Asks SillyTavern to generate the next turn without
            // posting a line of its own — the character speaks
            // first, the way answering a call would feel.
            await requestGeneration();

        } catch (error) {

            console.log(
                '[Dashboard] Could not start the call',
                error
            );

            if (speakingBubble) {
                speakingBubble.remove();
            }

            if (callScreenCaptions) {

                callScreenCaptions.innerHTML = `
                    <p class="call-screen-subtitle in">[ไม่สามารถเชื่อมต่อเสียงได้ ลองพิมพ์ข้อความแทนได้เลย]</p>
                `;

            }

        }

    }

    // Sends whatever's in the "speak" box into the real story, exactly
    // like the phone chat composer does — same lock-while-waiting
    // pattern, same real reply on the way back.
    async function sendCallMessage() {

        if (
            !callScreenInput ||
            !callState ||
            !callState.connectedAt
        ) {
            return;
        }

        const text = callScreenInput.value.trim();

        if (!text) {
            return;
        }

        callScreenInput.value = '';
        callScreenInput.disabled = true;

        if (callScreenSend) {
            callScreenSend.disabled = true;
        }

        try {

            await sendToRealChat(text);

        } catch (error) {

            console.log(
                '[Dashboard] Failed to speak into the real chat',
                error
            );

            callScreenInput.disabled = false;
            callScreenInput.value = text;

            if (callScreenSend) {
                callScreenSend.disabled = false;
            }

        }

    }

    // Ends the call and tears down its timers. If the call was
    // actually answered, logs one short line into the real chat (e.g.
    // "[โทรศัพท์ 2 นาที]") so the story remembers it happened — a
    // call that was cancelled while still ringing leaves no trace.
    function hangUpCall() {

        if (!callState) {
            return;
        }

        if (callState.ringTimeout) {
            clearTimeout(callState.ringTimeout);
        }

        if (callState.timerInterval) {
            clearInterval(callState.timerInterval);
        }

        if (callState.captionTimer) {
            clearInterval(callState.captionTimer);
        }

        const wasConnected = !!callState.connectedAt;

        const durationSeconds = wasConnected
            ? Math.max(
                1,
                Math.floor((Date.now() - callState.connectedAt) / 1000)
            )
            : 0;

        callState = null;

        if (callScreen) {

            callScreen.classList.remove(
                'open',
                'state-ringing',
                'state-connected'
            );

        }

        if (wasConnected) {

            sendToRealChat(
                `[โทรศัพท์ ${formatCallDuration(durationSeconds)}]`
            ).catch((error) => {

                console.log(
                    '[Dashboard] Failed to log the call',
                    error
                );

            });

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
    function openIncomingCallScreen(characterName, entryIndexInChat) {

        if (!callScreen || isCallOpen()) {
            return;
        }

        callState = {
            name: characterName,
            startIndex: entryIndexInChat,
            connectedAt: null,
            ringTimeout: null,
            timerInterval: null,
            captionTimer: null,
            lastCaptionKey: null,
            auto: true
        };

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

        callScreen.classList.remove('state-connected');
        callScreen.classList.add('open', 'state-ringing');

        // Cosmetic ring so this still feels like a call arriving
        // rather than a screen just appearing. Usually the tagged
        // line already has the opening thing said in it and there's
        // nothing left to generate — but if {{char}} sent [CALL] on
        // its own with no dialogue attached, this asks for a real
        // opening line the same way an outgoing call does, instead
        // of leaving the screen connected but silent.
        callState.ringTimeout = setTimeout(
            () => {

                if (!callState || !isCallOpen()) {
                    return;
                }

                callState.connectedAt = Date.now();

                callScreen.classList.remove('state-ringing');
                callScreen.classList.add('state-connected');

                updateCallTimer();
                callState.timerInterval = setInterval(updateCallTimer, 1000);

                renderCallCaptions();

                if (callScreenInput && callScreenSend) {
                    callScreenInput.disabled = false;
                    callScreenSend.disabled = false;
                }

                const openingLines = getMirroredHistory(characterName)
                    .slice(entryIndexInChat);

                const hasOpeningLine = openingLines.some(
                    (message) => (message.text || '').trim().length > 0
                );

                if (!hasOpeningLine) {

                    const speakingBubble = showCallSpeakingBubble();

                    requestGeneration().catch((error) => {

                        console.log(
                            '[Dashboard] [CALL] arrived with no dialogue attached, and asking for an opening line also failed',
                            error
                        );

                        if (speakingBubble) {
                            speakingBubble.remove();
                        }

                    });

                }

            },
            2200
        );

    }

    // Ends the call from the story side: {{char}}'s line carried a
    // [HANGUP] tag. Leaves the last line on screen for a moment first
    // so it doesn't vanish mid-read, then hangs up exactly the way
    // the button does (same "[โทรศัพท์ ...]" summary logged back into
    // the real chat).
    function endCallFromStory() {

        if (!callState) {
            return;
        }

        setTimeout(hangUpCall, 1500);

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

        if (
            DASHBOARD_CALL_START_TAG.test(entry.mes) &&
            !isCallOpen()
        ) {

            openIncomingCallScreen(characterName, lastIndex);

        }

    }

    if (callButton) {

        addPressEffect(callButton);

        callButton.addEventListener('click', openCallScreen);

    }

    if (callScreenHangup) {

        addPressEffect(callScreenHangup);

        callScreenHangup.addEventListener('click', hangUpCall);

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

        const context = getDashboardContext();
        const chatLog = context && context.chat;

        if (!Array.isArray(chatLog)) {
            return null;
        }

        for (let i = chatLog.length - 1; i >= 0; i--) {

            const entry = chatLog[i];

            if (
                entry &&
                !entry.is_user &&
                entry.name === characterName &&
                entry.mes
            ) {

                return cleanBotReply(entry.mes);

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

        const meta = document.createElement('div');
        meta.className = 'full-message-meta';
        meta.innerHTML =
            '<time></time><i class="fa-solid fa-chevron-right"></i>';

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

        const characters = getStoryCharacters();

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

    // Header call/video/more icons and the composer's plus/emoji
    // icons are decorative — same treatment as the notification bell
    // elsewhere in the dashboard — but they still get the press
    // feedback so nothing feels dead under a tap.
    dashboard
        .querySelectorAll(
            '.chat-thread-icon-button, .chat-thread-composer-icon'
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

                        if (callState.timerInterval) {
                            clearInterval(callState.timerInterval);
                        }

                        if (callState.captionTimer) {
                            clearInterval(callState.captionTimer);
                        }

                        callState = null;

                        if (callScreen) {
                            callScreen.classList.remove(
                                'open',
                                'state-ringing',
                                'state-connected'
                            );
                        }

                    }

                    installPhoneTagInstruction();

                    if (dashboardBootScreen) {
                        dashboardBootScreen
                            .classList.remove('is-dismissed');
                    }

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
