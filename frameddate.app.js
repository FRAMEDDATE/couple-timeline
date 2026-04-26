/* ==================================
State Management & Mock DB
================================== */
const STORE_KEY = 'framed_date_db';

let db = {
    lang: 'lv', // Language: 'lv' or 'en'
    auth: null, // { email, linked: false }
    points: 0,
    relationship_start: '2023-08-15T00:00:00Z',
    coupons: [], // { id, type, title, task, expiry, status: 'pending'|'accepted'|'done'|'failed' }
    history: [], // { id, date, title, points }
    photos: [],
    goals: [], // { id, title, icon, achieved, date }
    linkCode: null
};

/* ==================================
   Localization (i18n)
   ================================== */
window.t = (lv, en) => { return (db && db.lang === 'en') ? en : lv; };

window.setLang = (l) => {
    db.lang = l;
    saveDB();
    updateSharedUI();
};

function updateSharedUI() {
    const lbls = {
        'timeline': t('Vēsture', 'History'),
        'coupons': t('Uzdevumi', 'Tasks'),
        'photos': t('Bildes', 'Photos'),
        'rewards': t('Kuponi', 'Coupons'),
        'profile': t('Savienot', 'Connect')
    };
    for (const [route, text] of Object.entries(lbls)) {
        const el = document.querySelector(`button[data-route="${route}"] span`);
        if (el) el.innerText = text;
    }
    const lvBtn = document.getElementById('lang-lv');
    const enBtn = document.getElementById('lang-en');
    if (lvBtn) lvBtn.style.color = db.lang === 'lv' ? 'var(--text-main)' : 'var(--text-muted)';
    if (enBtn) enBtn.style.color = db.lang === 'en' ? 'var(--text-main)' : 'var(--text-muted)';
    navigate(currentRoute);
}

let globalPeer = null;
let peerConnection = null;

function loadDB() {
    try {
        const saved = localStorage.getItem(STORE_KEY);
        if (saved) {
            db = { ...db, ...JSON.parse(saved) };
            if (db.auth && db.auth.icebreakerDone === undefined) {
                db.auth.icebreakerDone = false;
                db.auth.icebreakerFailed = false;
                db.auth.penaltyDone = false;
            }
            if (db.auth && db.auth.myPoints === undefined) {
                db.auth.myPoints = 0;
                db.auth.partnerPoints = 0;
            }
            if (!db.goals) db.goals = [];
            // Auto reconnect on refresh if linked and role is known
            if (db.auth && db.auth.peerRole && db.linkCode) {
                if (db.auth.peerRole === 'host') initHostPeer(db.linkCode);
                else if (db.auth.peerRole === 'client') initClientPeer(db.linkCode);
            }
        }
    } catch (e) { }
}

function saveDB(skipBroadcast = false) {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    if (!skipBroadcast && peerConnection && peerConnection.open) {
        peerConnection.send(JSON.stringify({ type: 'SYNC_DB', payload: db }));
    }
    updateHeader();
}

/* ==================================
   PeerJS P2P Network Logic
   ================================== */
function setupConnListen(conn) {
    conn.on('data', (dataStr) => {
        try {
            const data = JSON.parse(dataStr);
            if (data.type === 'FULL_SYNC' || data.type === 'SYNC_DB') {
                const mergedPayload = data.payload;
                const myAuth = { ...db.auth };

                db = { ...mergedPayload };
                db.auth = myAuth;
                db.auth.linked = true;

                if (mergedPayload.auth) {
                    db.auth.icebreakerDone = mergedPayload.auth.icebreakerDone;
                    db.auth.icebreakerFailed = mergedPayload.auth.icebreakerFailed;
                    db.auth.penaltyDone = mergedPayload.auth.penaltyDone;
                    if (mergedPayload.auth.myIcebreaker) {
                        db.auth.partnerIcebreaker = mergedPayload.auth.myIcebreaker;
                        if (db.auth.myIcebreaker && !db.auth.icebreakerDone && !db.auth.icebreakerFailed) {
                            db.auth.icebreakerSkipped = false;
                        }
                    }
                    if (mergedPayload.auth.username) {
                        db.auth.partnerUsername = mergedPayload.auth.username;
                    }
                    if (mergedPayload.auth.myAvatar) {
                        db.auth.partnerAvatar = mergedPayload.auth.myAvatar;
                    }
                    if (mergedPayload.auth.myPoints !== undefined) {
                        db.auth.partnerPoints = Math.max(db.auth.partnerPoints || 0, mergedPayload.auth.myPoints);
                    }

                    // Recover our own lost state from partner's memory if needed
                    if (mergedPayload.auth.partnerUsername && !db.auth.username) {
                        db.auth.username = mergedPayload.auth.partnerUsername;
                    }
                    if (mergedPayload.auth.partnerAvatar && !db.auth.myAvatar) {
                        db.auth.myAvatar = mergedPayload.auth.partnerAvatar;
                    }
                    if (mergedPayload.auth.partnerPoints !== undefined) {
                        db.auth.myPoints = Math.max(db.auth.myPoints || 0, mergedPayload.auth.partnerPoints);
                    }
                }

                saveDB(true);
                updateSharedUI();
                if (currentRoute) navigate(currentRoute);
            }
        } catch (e) { }
    });
}

window.initHostPeer = (code) => {
    if (globalPeer) globalPeer.destroy();
    globalPeer = new Peer(`framed-date-${code}`);
    globalPeer.on('connection', (conn) => {
        peerConnection = conn;
        setupConnListen(conn);
        conn.on('open', () => {
            if (!db.auth.linked) {
                db.auth.linked = true;
                db.auth.myPoints = (db.auth.myPoints || 0) + 10;
                db.auth.partnerPoints = (db.auth.partnerPoints || 0) + 10;
                db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('Pāris veiksmīgi savienots pāri tīklam!', 'Partner linked over P2P!'), points: 10 });
                saveDB(true);
                updateSharedUI();
                if (currentRoute) navigate(currentRoute);
            }
            conn.send(JSON.stringify({ type: 'FULL_SYNC', payload: db }));
        });
    });
};

window.initClientPeer = (code) => {
    if (globalPeer) globalPeer.destroy();
    globalPeer = new Peer();
    globalPeer.on('open', () => {
        peerConnection = globalPeer.connect(`framed-date-${code}`);
        peerConnection.on('open', () => {
            setupConnListen(peerConnection);
            // Client should also announce its state so the host recovers anything the host missed
            peerConnection.send(JSON.stringify({ type: 'FULL_SYNC', payload: db }));
        });
    });
};

/* ==================================
   Router & App Shell Core
   ================================== */
const routes = {
    auth: renderAuth,
    timeline: renderTimeline,
    coupons: renderCoupons,
    'timeline': renderTimeline,
    'coupons': renderCoupons,
    'photos': renderPhotos,
    'rewards': renderRewards,
    'profile': renderProfile,
    'onboarding': renderOnboarding
};

let currentRoute = 'timeline';

function navigate(route) {
    if (!db.auth) {
        document.getElementById('auth-guard').classList.remove('hidden');
        document.getElementById('main-shell').classList.add('hidden');
        renderAuth(document.getElementById('auth-guard'));
        return;
    }

    if (db.auth && (!db.auth.linked || (!db.auth.icebreakerDone && !db.auth.icebreakerSkipped)) && route !== 'onboarding') {
        route = 'onboarding';
    }

    currentRoute = route;
    document.getElementById('auth-guard').classList.add('hidden');

    // Render correct application shell components
    document.getElementById('main-shell').classList.remove('hidden');

    // Toggle global back button visibility
    const backBtn = document.getElementById('global-back-btn');
    const headerLogo = document.querySelector('.header-logo');
    if (backBtn && headerLogo) {
        if (route === 'timeline' || route === 'onboarding') {
            backBtn.classList.add('hidden');
            headerLogo.style.display = 'block';
        } else {
            backBtn.classList.remove('hidden');
            headerLogo.style.display = 'none';
        }
    }

    const mainContent = document.getElementById('app-content');
    if (!routes[route]) {
        mainContent.innerHTML = '<div class="glass-panel text-center">Not Found</div>';
    } else {
        mainContent.innerHTML = '';
        routes[route](mainContent);
    }
    updateHeader();
}

function updateHeader() {
    const ptEl = document.getElementById('user-points');
    if (ptEl) ptEl.textContent = db.points;
}

function showOverlay(html) {
    const div = document.createElement('div');
    div.className = 'overlay animate-fade-in';
    div.innerHTML = `<div class="modal-box">
           <button class="modal-close" onclick="this.closest('.overlay').remove()"><i class="fa-solid fa-xmark"></i></button>
           ${html}
       </div>`;
    document.body.appendChild(div);
}

function closeOverlays() {
    document.querySelectorAll('.overlay').forEach(el => el.remove());
}

/* ==================================
   View Renderers
   ================================== */

// 1. Auth View
window.authMode = 'register';

window.toggleAuthMode = (mode) => {
    window.authMode = mode;
    renderAuth(document.getElementById('auth-guard'));
};

window.togglePasswordVisibility = (inputId) => {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(inputId + '-icon');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    }
};

function renderAuth(container) {
    const isEn = db.lang === 'en';
    const isLogin = window.authMode === 'login';

    let formHtml = '';

    if (isLogin) {
        formHtml = `
            <div class="auth-input-group animate-fade-in">
                <label class="auth-input-label">${t('E-pasts vai lietotājvārds', 'Email or username')}</label>
                <div class="auth-input-wrapper">
                    <i class="fa-regular fa-user left-icon"></i>
                    <input type="text" id="auth-email" class="auth-input" placeholder="${t('E-pasts vai lietotājvārds', 'Email or username')}">
                </div>
            </div>
            <div class="auth-input-group animate-fade-in">
                <label class="auth-input-label">${t('Parole', 'Password')}</label>
                <div class="auth-input-wrapper">
                    <i class="fa-solid fa-lock left-icon" style="font-size:0.9rem;"></i>
                    <input type="password" id="auth-pass" class="auth-input" placeholder="${t('Jūsu parole', 'Your password')}">
                    <button class="right-action" onclick="togglePasswordVisibility('auth-pass')">
                        <i id="auth-pass-icon" class="fa-regular fa-eye-slash"></i>
                    </button>
                </div>
            </div>
            <button class="auth-submit-btn animate-fade-in" onclick="login()">${t('Pieslēgties', 'Login')}</button>
        `;
    } else {
        formHtml = `
            <div class="auth-input-group animate-fade-in">
                <label class="auth-input-label">${t('Lietotājvārds', 'Username')}</label>
                <div class="auth-input-wrapper">
                    <i class="fa-regular fa-user left-icon"></i>
                    <input type="text" id="auth-user" class="auth-input" placeholder="${t('Jūsu lietotājvārds', 'Your username')}">
                </div>
            </div>
            <div class="auth-input-group animate-fade-in">
                <label class="auth-input-label">${t('E-pasts', 'Email')}</label>
                <div class="auth-input-wrapper">
                    <i class="fa-regular fa-envelope left-icon"></i>
                    <input type="email" id="auth-email" class="auth-input" placeholder="${t('jusu@epasts.lv', 'you@email.com')}">
                </div>
            </div>
            <div class="auth-input-group animate-fade-in">
                <label class="auth-input-label">${t('Parole', 'Password')}</label>
                <div class="auth-input-wrapper">
                    <i class="fa-solid fa-lock left-icon" style="font-size:0.9rem;"></i>
                    <input type="password" id="auth-pass" class="auth-input" placeholder="${t('Vismaz 6 simboli', 'At least 6 characters')}">
                    <button class="right-action" type="button" onclick="togglePasswordVisibility('auth-pass')">
                        <i id="auth-pass-icon" class="fa-regular fa-eye-slash"></i>
                    </button>
                </div>
            </div>
            <button class="auth-submit-btn animate-fade-in" onclick="login()">${t('Izveidot profilu', 'Create profile')}</button>
        `;
    }

    container.innerHTML = `
        <div class="auth-wrapper">
            <img src="assets/logo.png" alt="Framed Date Logo" class="auth-logo animate-fade-in">
            
            <h1 class="auth-header-text animate-fade-in" style="animation-delay: 0.1s;">${t('Krāj punktus - veido<br>atmiņas', 'Collect points - create<br>memories')}</h1>
            <p class="auth-subtitle animate-fade-in" style="animation-delay: 0.2s;">${t('Saglabājiet mirkļus, kas veido jūsu stāstu.', 'Keep the moments that make up your story.')}</p>
            
            <div class="auth-form">
                <div class="auth-tabs animate-fade-in" style="animation-delay: 0.3s;">
                    <button class="auth-tab ${isLogin ? 'active' : ''}" onclick="toggleAuthMode('login')">${t('Pieslēgties', 'Login')}</button>
                    <button class="auth-tab ${!isLogin ? 'active' : ''}" onclick="toggleAuthMode('register')">${t('Reģistrēties', 'Register')}</button>
                </div>
                
                ${formHtml}
            </div>
            
            <div style="flex:1;"></div>
            
            <button class="btn-secondary danger-text animate-fade-in" style="animation-delay:0.5s; border:none; background:transparent; color:#ff6b6b; margin-top:2rem; font-size:0.85rem;" onclick="if(confirm('${t('Vai tiešām vēlaties dzēst visus datus?', 'Are you sure you want to delete all data?')}')) { localStorage.removeItem('framed_date_db'); location.reload(); }">
                <i class="fa-solid fa-trash"></i> ${t('Sākt no nulles (Dzēst datus)', 'Reset all data')}
            </button>
        </div>
    `;
}

window.login = () => {
    const isLogin = window.authMode === 'login';
    const email = document.getElementById('auth-email').value.trim();
    if (!email) return alert(isLogin ? t("Ievadiet epastu vai lietotājvārdu!", "Enter email or username!") : t("Ievadiet epastu!", "Enter email!"));

    let username = 'Lietotājs';
    if (!isLogin) {
        const userEl = document.getElementById('auth-user');
        if (userEl && userEl.value.trim()) {
            username = userEl.value.trim();
        }
    }

    // Existing check
    if (db.auth && (db.auth.email === email || db.auth.username === email)) {
        // returning user
    } else {
        db.auth = {
            email,
            username,
            linked: false,
            icebreakerDone: false,
            icebreakerFailed: false,
            penaltyDone: false
        };
    }
    saveDB(); updateSharedUI();
    if (typeof checkQRMagnet === 'function') checkQRMagnet();
    if (currentRoute !== 'rewards') {
        navigate('timeline');
    }
};

// 2. Profile & Link View
function renderProfile(container) {
    let linkStatus = '';
    if (db.auth.linked) {
        linkStatus = `<div class="glass-panel text-center" style="background: rgba(105, 219, 124,0.1); border-color:#69db7c;">
               <i class="fa-solid fa-check-circle" style="color:#69db7c; font-size:2rem; margin-bottom:1rem;"></i>
               <h3>${t('Jūs esat savienoti!', 'You are connected!')}</h3>
               <p style="margin-top:0.5rem; font-size:0.9rem;">${t('Jūs spēlējat kopā ar partneri.', 'You are playing with your partner.')}</p>
           </div>`;
    } else {
        linkStatus = `
               <div class="glass-panel text-center" style="margin-bottom:2rem;">
                   <h3 style="margin-bottom: 1rem;">${t('Uzaicini Partneri', 'Invite Partner')}</h3>`;

        if (db.linkCode) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=https://frameddate.com/?join=${db.linkCode}&color=1d1d1f&bgcolor=ffffff`;
            linkStatus += `
                   <p style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.5rem;">${t('Tavs savienošanās kods:', 'Your connection code:')}</p>
                   <h2 class="number-font" style="margin-bottom:1.5rem; letter-spacing:5px; font-size:2.5rem; color:var(--text-main);">${db.linkCode}</h2>
                   <p style="font-size:0.9rem; color:var(--text-muted); margin-bottom:1rem;">${t('Lūdz partnerim noskenēt šo QR kodu, vai ievadīt ciparus:', 'Ask partner to scan QR or enter code:')}</p>
                   <div style="background:white; padding:15px; border-radius:16px; display:inline-block; box-shadow:0 4px 15px rgba(0,0,0,0.05); margin-bottom:1rem;">
                       <img src="${qrUrl}" alt="QR Kods" style="width: 180px; height: 180px; border-radius:10px;">
                   </div>
            `;
        } else {
            linkStatus += `
                   <p style="font-size:0.95rem; color:var(--text-muted); margin-bottom:1.5rem; line-height:1.4;">${t('Ģenerē 6 ciparu kodu un QR kodu formātu, lai pievienotu savu otro pusīti.', 'Generate a 6-digit or QR code to link your partner.')}</p>
                   <button class="btn-primary" onclick="generateCode()"><i class="fa-solid fa-qrcode"></i> ${t('Ģenerēt Kodu', 'Generate Code')}</button>
            `;
        }

        linkStatus += `</div>
               <div class="glass-panel text-center">
                   <h3 style="margin-bottom: 1rem;">${t('Pievienoties Partnerim', 'Join Partner')}</h3>
                   <input type="text" id="joinCodeInput" class="input-field text-center number-font" placeholder="123456" maxlength="6" style="margin-bottom:1rem; letter-spacing:5px;">
                   <button class="btn-primary" onclick="joinCouple()"><i class="fa-solid fa-link"></i> ${t('Pievienoties partnerim', 'Connect Link')}</button>
                   <p id="joinStatus" style="margin-top:1rem; font-weight:600; color:#ff3b30;"></p>
               </div>
           `;
    }

    container.innerHTML = `
           <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem; padding-top: 0.5rem;">
               <div onclick="navigate('timeline')" style="cursor:pointer; font-size:1.3rem; color:#A3A3A3; width: 32px;"><i class="fa-solid fa-arrow-left"></i></div>
               <h2 class="view-title" style="margin-bottom:0; font-size:1.4rem; color:#A3A3A3; font-weight:800;">${t('Mans Profils', 'My Profile')}</h2>
               <div style="width: 32px;"></div>
           </div>
           
           <div class="glass-panel" style="margin-bottom:2rem;">
               <h3 style="margin-bottom: 1rem;">${t('Profila iestatījumi', 'Profile Settings')}</h3>
               <label style="font-size:0.8rem; font-weight:700; color:var(--text-muted);">${t('Vārds', 'Name')}</label>
               <input type="text" id="profNameInput" class="input-field" value="${db.auth.username || ''}" style="margin-bottom:1rem;">
               
               <label style="font-size:0.8rem; font-weight:700; color:var(--text-muted);">${t('E-pasts', 'Email')}</label>
               <input type="email" id="profEmailInput" class="input-field" value="${db.auth.email || ''}" style="margin-bottom:1.5rem;">
               
               <button class="btn-primary" onclick="saveProfileSettings()">${t('Saglabāt izmaiņas', 'Save Changes')}</button>
           </div>
           
           <h3 class="section-subtitle" style="margin-top:2rem;">${t('Savienojums ar partneri', 'Partner Connection')}</h3>
           ${linkStatus}
           
           <h2 class="view-title" style="margin-top:3rem; font-size:1.5rem;">${t('Fiziskais Ietvars (Frame)', 'Physical Frame')}</h2>
           <div class="glass-panel text-center" style="margin-bottom:2rem;">
               <h3 style="margin-bottom: 1rem;">${t('Aktivizēt Rāmi', 'Activate Frame')}</h3>
               <input type="text" id="frameIdInput" class="input-field text-center" placeholder="${t('Ievadi Frame ID (piem., FD-0001)', 'Enter Frame ID (e.g. FD-0001)')}" style="margin-bottom:1rem;">
               <button id="activateBtn" class="btn-primary" onclick="activateFrame()">${t('Aktivizēt', 'Activate')}</button>
               <p id="statusMessage" style="margin-top:1rem; font-weight:500;"></p>
               <p id="bonusPointsLabel" class="text-gold" style="margin-top:0.5rem; font-weight:700; font-size:1.1rem;"></p>
           </div>

           <button class="btn-secondary danger-text" onclick="logout()" style="margin-top:1rem; border-color:#ff6b6b; color:#ff6b6b;">${t('Iziet no profila', 'Log out')}</button>
           <button class="btn-secondary danger-text" onclick="if(confirm('${t('Vai tiešām vēlaties izdzēst VISU progresu un sākt aplikāciju no nulles?', 'Are you sure you want to delete all progress and start from scratch?')}')) { localStorage.removeItem('framed_date_db'); location.reload(); }" style="margin-top:1rem; border-color:#ff6b6b; color:#ff6b6b; font-weight:700;"><i class="fa-solid fa-trash-can"></i> ${t('Dzēst visus datus', 'Delete all data')}</button>
       `;
}

window.saveProfileSettings = () => {
    const fn = document.getElementById('profNameInput').value.trim();
    const em = document.getElementById('profEmailInput').value.trim();
    if (fn) db.auth.username = fn;
    if (em) db.auth.email = em;
    saveDB(true);
    alert(t('Profila dati saglabāti! Tavi dati automātiski atjaunosies abos profilos.', 'Profile settings saved! Syncing...'));
    renderProfile(document.getElementById('main-content'));
};

window.generateCode = () => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    db.linkCode = code;
    db.auth.peerRole = 'host';
    saveDB();
    initHostPeer(code);
    navigate('onboarding');
};

window.joinCouple = () => {
    const input = document.getElementById('joinCodeInput').value.trim();
    const status = document.getElementById('joinStatus');
    if (!input || input.length !== 6) return status.innerText = "Ievadi 6 ciparu kodu.";

    status.innerText = t("Savienojas...", "Connecting...");
    status.style.color = "var(--text-main)";

    if (input === db.linkCode) {
        db.auth.linked = true;
        db.points += 10;
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: 'Profils savienots (Lokāli)', points: 10 });
        saveDB();
        navigate('onboarding');
        return;
    }

    db.linkCode = input;
    db.auth.peerRole = 'client';
    saveDB(true);

    if (globalPeer) globalPeer.destroy();
    globalPeer = new Peer();

    globalPeer.on('open', () => {
        peerConnection = globalPeer.connect(`framed-date-${input}`);

        peerConnection.on('open', () => {
            setupConnListen(peerConnection);
        });
    });

    globalPeer.on('error', () => {
        status.innerText = t("Nepareizs kods vai serveris neaktīvs.", "Wrong code or host inactive.");
        status.style.color = "#ff3b30";
    });
};

window.activateFrame = async () => {
    const frameId = document.getElementById("frameIdInput").value.trim();
    const statusEl = document.getElementById("statusMessage");
    const bonusEl = document.getElementById("bonusPointsLabel");

    if (!frameId) return statusEl.innerText = "Ievadi Frame ID.";

    statusEl.innerText = "Aktivizēju...";
    statusEl.style.color = "inherit";

    // Simulate API delay
    await new Promise(r => setTimeout(r, 700));

    statusEl.innerText = "Rāmis aktivizēts! Bonuss pievienots.";
    statusEl.style.color = "#69db7c";
    bonusEl.innerText = "+20 punkti";

    db.auth.myPoints = (db.auth.myPoints || 0) + 20;
    db.auth.partnerPoints = (db.auth.partnerPoints || 0) + 20;
    db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `Rāmis ${frameId} aktivizēts`, points: 20 });
    saveDB();
};

window.logout = () => { db.auth = null; saveDB(); navigate('timeline'); };

/* ==================================
   Onboarding (Cold Breaker) View
   ================================== */
function renderOnboarding(container) {
    if (!db.auth.linked) {
        // Step 1: Connect Partner
        let linkStatus = `
           <div class="glass-panel text-center" style="margin-bottom:2rem;">
               <h3 style="margin-bottom: 1rem;">${t('Solis 1: Savieno Pāri', 'Step 1: Connect')}</h3>
               <p style="font-size:0.95rem; color:var(--text-muted); margin-bottom:1.5rem; line-height:1.4;">${t('Lai sāktu spēli, uzaicini partneri! Ģenerē kodu vai pievienojies.', 'To start playing, invite your partner! Generate a code or join.')}</p>
        `;
        if (db.linkCode) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=https://frameddate.com/?join=${db.linkCode}&color=1d1d1f&bgcolor=ffffff`;
            linkStatus += `
               <h2 class="number-font" style="margin-bottom:1rem; letter-spacing:5px; font-size:2.5rem; color:var(--text-main);">${db.linkCode}</h2>
               <div style="background:white; padding:15px; border-radius:16px; display:inline-block; box-shadow:0 4px 15px rgba(0,0,0,0.05); margin-bottom:1rem;">
                   <img src="${qrUrl}" alt="QR Kods" style="width: 150px; height: 150px; border-radius:10px;">
               </div>
            `;
        } else {
            linkStatus += `
               <button class="btn-primary" onclick="generateCode()"><i class="fa-solid fa-qrcode"></i> ${t('Ģenerēt Kodu', 'Generate Code')}</button>
            `;
        }
        linkStatus += `</div>
           <div class="glass-panel text-center animate-fade-in" style="animation-delay:0.1s;">
               <h3 style="margin-bottom: 1rem;">${t('Pievienoties Partnerim', 'Join Partner')}</h3>
               <input type="text" id="joinCodeInput" class="input-field text-center number-font" placeholder="123456" maxlength="6" style="margin-bottom:1rem; letter-spacing:5px;">
               <button class="btn-primary" onclick="joinCouple()"><i class="fa-solid fa-link"></i> ${t('Pievienoties', 'Connect')}</button>
               <p id="joinStatus" style="margin-top:1rem; font-weight:600; color:#ff3b30;"></p>
           </div>
        `;
        container.innerHTML = `<h2 class="view-title animate-fade-in">${t('Sveicināti!', 'Welcome!')}</h2>${linkStatus}`;
    }
    else if (!db.auth.icebreakerDone && !db.auth.icebreakerFailed) {
        // Step 2: Icebreaker Match
        if (!db.auth.myIcebreaker) {
            container.innerHTML = `
               <h2 class="view-title animate-fade-in" style="text-align:center;">${t('Cold Breaker', 'Cold Breaker')} 🧊</h2>
               <div class="glass-panel text-center animate-fade-in" style="animation-delay:0.1s;">
                   <i class="fa-solid fa-calendar-heart text-gold" style="font-size:3.5rem; margin-bottom:1.5rem;"></i>
                   <h3 style="margin-bottom:1rem;">${t('Vai zini, cik ilgi esat attiecībās?', 'Do you know how long you\\\'ve been together?')}</h3>
                   <p style="font-size:0.95rem; color:var(--text-muted); margin-bottom:1.5rem; line-height:1.4;">${t('Ievadi datumu kad sākāt satikties. Kad arī partneris būs ievadījis savu atbildi, varēsiet pārbaudīt, vai tās sakrīt!', 'Enter the exact start date. Wait for partner to do the same and check!')}</p>
                   
                   <div style="text-align:left; margin-bottom:2rem;">
                       <label class="input-label">${t('Tava atbilde:', 'Your Answer:')}</label>
                       <input type="date" id="ice-mine" class="input-field">
                   </div>
                   
                   <button class="btn-primary" style="font-size:1.1rem; padding:15px;" onclick="submitMyIcebreaker()">${t('Iesniegt', 'Submit')}</button>
               </div>
            `;
        } else if (!db.auth.partnerIcebreaker) {
            container.innerHTML = `
               <h2 class="view-title animate-fade-in" style="text-align:center;">${t('Cold Breaker', 'Cold Breaker')} 🧊</h2>
               <div class="glass-panel text-center animate-fade-in" style="animation-delay:0.1s;">
                   <i class="fa-solid fa-hourglass-half text-gold" style="font-size:3.5rem; margin-bottom:1.5rem;"></i>
                   <h3 style="margin-bottom:1rem;">${t('Gaidām partneri...', 'Waiting for partner...')}</h3>
                   <p style="font-size:0.95rem; color:var(--text-muted); margin-bottom:1.5rem; line-height:1.4;">${t(`Tava atbilde: ${db.auth.myIcebreaker}`, `Your answer: ${db.auth.myIcebreaker}`)}</p>
                   
                   <button class="btn-secondary" style="margin-top:1rem; font-size:0.95rem;" onclick="skipIcebreaker()">${t('Atgriezties sākumā (Gaidot)', 'Return to Timeline (Waiting)')}</button>
               </div>
            `;
        } else {
            container.innerHTML = `
               <h2 class="view-title animate-fade-in" style="text-align:center;">${t('Cold Breaker', 'Cold Breaker')} 🧊</h2>
               <div class="glass-panel text-center animate-fade-in" style="animation-delay:0.1s;">
                   <i class="fa-solid fa-masks-theater text-gold" style="font-size:3.5rem; margin-bottom:1.5rem;"></i>
                   <h3 style="margin-bottom:1rem;">${t('Abi esat atbildējuši!', 'Both have answered!')}</h3>
                   <p style="font-size:0.95rem; color:var(--text-muted); margin-bottom:1.5rem; line-height:1.4;">${t('Spied pogu, lai atklātu rezultātu!', 'Press the button to reveal!')}</p>
                   
                   <button class="btn-primary" style="font-size:1.1rem; padding:15px; background:var(--color-success);" onclick="checkIcebreaker()">${t('Pārbaudīt Saderību', 'Check Match')}</button>
               </div>
            `;
        }
    }
    else if (db.auth.icebreakerFailed && !db.auth.penaltyDone) {
        // Step 3: Penalty
        container.innerHTML = `
           <h2 class="view-title animate-fade-in" style="color:#ff6b6b; text-align:center;">${t('Ups... Datumi nesakrita', 'Oops... Dates didn\\\'t match')} 💔</h2>
           <div class="glass-panel text-center animate-fade-in" style="animation-delay:0.1s;">
               <p style="font-size:1rem; color:var(--text-main); margin-bottom:1.5rem;">${t('Vieta izaugsmei! Starta rādītājs ir samazināts. Lai atjaunotu attiecību statusu, Jums kopīgi jāizpilda šis uzdevums:', 'Room for growth! To restore the health score, complete this joint task:')}</p>
               
               <div style="background:rgba(255, 107, 107, 0.05); border:2px dashed #ff6b6b; border-radius:12px; padding:1.5rem; margin-bottom:2rem;">
                   <h3 style="color:#ff6b6b; margin-bottom:1rem;"><i class="fa-solid fa-eye"></i> ${t('Saldēšanas uzdevums', 'Icebreaker Task')}</h3>
                   <b style="font-size:1.15rem; color:var(--text-main); line-height:1.4;">${t('Skatieties viens otram tieši acīs 1 minūti nesakot nevienu vārdu un nesmejoties.', 'Look into each other\\\'s eyes for 1 minute without talking or laughing.')}</b>
               </div>
               
               <button class="btn-primary" style="font-size:1.1rem; padding:15px;" onclick="completePenalty()"><i class="fa-solid fa-check"></i> ${t('Mēs to izdarījām!', 'We did it!')}</button>
           </div>
        `;
    }
}

window.submitMyIcebreaker = () => {
    const mine = document.getElementById('ice-mine').value;
    if (!mine) return alert(t('Lūdzu ievadi datumu!', 'Please enter the date!'));

    db.auth.myIcebreaker = mine;
    saveDB();
    navigate('onboarding');
};

window.skipIcebreaker = () => {
    db.auth.icebreakerSkipped = true;
    saveDB();
    navigate('timeline');
};

window.checkIcebreaker = () => {
    const mine = db.auth.myIcebreaker;
    const partner = db.auth.partnerIcebreaker;

    if (!mine || !partner) return;

    if (mine === partner) {
        db.relationship_start = mine;
        db.auth.myPoints = (db.auth.myPoints || 0) + 100;
        db.auth.partnerPoints = (db.auth.partnerPoints || 0) + 100;
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('ColdBreaker: Veiksmīgs datumu mačs!', 'ColdBreaker: Date Match!'), points: 100 });
        db.auth.icebreakerDone = true;

        alert(t('Apsveicam! Jūsu datumi sakrīt! Esat nopelnījuši 100 punktus!', 'Congratulations! Dates match! You get 100 points!'));
        saveDB(); navigate('timeline');
    } else {
        db.relationship_start = mine; // Set roughly
        db.auth.icebreakerFailed = true;
        db.auth.myPoints = Math.max(0, (db.auth.myPoints || 0) - 20);
        db.auth.partnerPoints = Math.max(0, (db.auth.partnerPoints || 0) - 20);
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('ColdBreaker: Datumi nesakrita', 'ColdBreaker: Dates mismatched'), points: -20 });
        saveDB(); navigate('onboarding');
    }
};

const MAGNET_CATALOG = {
    '1': {
        cost: 100,
        title: 'VIEGLA ATPŪTA',
        category: 'BĒRNĪBAS NAŠĶI',
        task: 'Dodieties uz veikalu, atsevišķi iegādājieties "5" našķus, ko bijāt iekārojuši savā bērnībā.\n(neļauj partnerim redzēt savas izvēles, noformējums pirms pasniegšanas ir obligāts)\nPavadot laiku pastāstiet par šiem našķiem, kādēļ Jums tie bērnībā tik ļoti garšoja.'
    }
};

window.completePenalty = () => {
    db.auth.penaltyDone = true;
    db.auth.icebreakerDone = true;
    db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('Saldēšanas uzdevums izpildīts', 'Icebreaker task completed'), points: 0 });
    saveDB(); navigate('timeline');
};

// 3. Rewards View
function renderRewards(container) {
    let magnetsHtml = '';
    if (!db.magnets || db.magnets.length === 0) {
        magnetsHtml = `
        <div style="text-align:center; padding: 2rem 0; color:#A3A3A3; opacity:0.8;">
            <i class="fa-solid fa-qrcode" style="font-size:3rem; margin-bottom:1rem;"></i>
            <h3 style="margin-bottom:0.5rem;">${t('Nav atrasts neviens magnēts', 'No magnets found')}</h3>
            <p style="font-size:0.9rem;">${t('Noskanējiet fizisko magnēta QR kodu, lai tas parādītos šeit.', 'Scan a physical magnet QR code to see it here.')}</p>
        </div>`;
    } else {
        magnetsHtml += `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">`;
        db.magnets.forEach(m => {
            const data = MAGNET_CATALOG[m.code] || {
                cost: m.code.includes('partner') ? 150 : 100,
                title: 'NEZINĀMS',
                category: 'NOSLĒPUMS',
                task: 'Šī magnēta dati nav atrasti datubāzē.'
            };

            if (m.unlocked) {
                magnetsHtml += `
                <div style="width:100%; aspect-ratio: 1000/1550; background-image:url('assets/magnet_blank.png'); background-size:cover; background-position:center; border-radius:12px; position:relative; overflow:hidden; box-shadow:0 10px 20px rgba(0,0,0,0.15);">
                    <div style="position:absolute; top:32%; left:12%; right:12%; height:52%; display:flex; flex-direction:column; align-items:center; color:white; text-align:center;">
                        <h2 style="margin:10px 0 0 0; font-family:'Montserrat', sans-serif; font-weight:900; font-size:1.4rem; letter-spacing:1px; line-height:1.1; color: white; text-shadow: 1px 1px 2px rgba(0,0,0,0.3); text-transform:uppercase;">${data.title}</h2>
                        <h4 style="margin:2px 0 10px 0; font-family:'Montserrat', sans-serif; font-weight:500; font-size:0.7rem; letter-spacing:2px; color:rgba(255,255,255,0.85); text-transform:uppercase;">${data.category}</h4>
                        <div style="flex:1; display:flex; align-items:center; padding:0 5px;">
                            <p style="margin:0; font-family:'Inter', sans-serif; font-size:0.7rem; font-weight:500; line-height:1.4; white-space:pre-wrap;">${data.task}</p>
                        </div>
                    </div>
                </div>`;
            } else {
                magnetsHtml += `
                <div style="width:100%; aspect-ratio: 1000/1550; background-image:url('assets/magnet_blank.png'); background-size:cover; background-position:center; border-radius:12px; position:relative; overflow:hidden; box-shadow:0 10px 20px rgba(0,0,0,0.15);">
                    <div style="position:absolute; top:31%; left:10%; right:10%; height:55%; background-image: repeating-linear-gradient(45deg, #b0b0b5 25%, transparent 25%, transparent 75%, #b0b0b5 75%, #b0b0b5), repeating-linear-gradient(45deg, #b0b0b5 25%, #c8c8cd 25%, #c8c8cd 75%, #b0b0b5 75%, #b0b0b5); background-position: 0 0, 10px 10px; background-size: 20px 20px; border-radius:5px; box-shadow: inset 0 2px 10px rgba(0,0,0,0.2); display:flex; flex-direction:column; align-items:center; justify-content:center; color:#555;">
                        <i class="fa-solid fa-lock" style="font-size:3rem; margin-bottom:15px; color:#333; filter: drop-shadow(0 2px 2px rgba(255,255,255,0.5));"></i>
                        <button class="btn-primary" style="padding:10px 20px; font-size:0.95rem; font-weight:800; border-radius:20px; box-shadow:0 4px 10px rgba(0,0,0,0.3);" onclick="unlockMagnet(${m.id}, ${data.cost})">
                            <i class="fa-solid fa-star" style="color:#FFD700; margin-right:5px;"></i> Atvērt (${data.cost} pt)
                        </button>
                    </div>
                </div>`;
            }
        });
        magnetsHtml += `</div>`;
    }

    container.innerHTML = `
        <h2 class="view-title">${t('Noslēpumu Magnēti', 'Mystery Magnets')}</h2>
        
        <div style="background:rgba(255,90,126,0.1); border:1px solid rgba(255,90,126,0.3); padding:15px; border-radius:16px; margin-bottom:1.5rem; display:flex; gap:15px; align-items:center;">
            <i class="fa-solid fa-circle-info" style="color:#FF5A7E; font-size:1.5rem; flex-shrink:0;"></i>
            <p style="font-size:0.85rem; color:var(--text-main); margin:0;">${t('Krājiet punktus kopīgajos uzdevumos, lai atvērtu fiziskajos magnētos paslēptos pārsteigumus!', 'Earn points in shared tasks to unlock surprises hidden in physical magnets!')}</p>
        </div>
        
        ${magnetsHtml}
    `;
}

window.unlockMagnet = (id, cost) => {
    const totalMyPoints = db.points + (db.auth.myPoints || 0);
    if (totalMyPoints >= cost) {
        if (confirm(t(`Izmantot ${cost} punktus, lai atvērtu šo magnētu?`, `Use ${cost} points to open this magnet?`))) {
            db.auth.myPoints = (db.auth.myPoints || 0) - cost;
            const mag = db.magnets.find(x => x.id === id);
            if (mag) mag.unlocked = true;

            db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('Es atslēdzu fizisko magnētu!', 'I unlocked a physical magnet!'), points: -cost });
            saveDB();
            renderRewards(document.getElementById('app-content'));
            updateHeader();
        }
    } else {
        alert(t(`Nepietiek punktu! Tev ir: ${totalMyPoints}`, `Not enough points! You have: ${totalMyPoints}`));
    }
};

window.checkQRMagnet = () => {
    const params = new URLSearchParams(window.location.search);
    const magnetCode = params.get('magnet');
    if (magnetCode && db.auth) {
        if (!db.magnets) db.magnets = [];
        const existing = db.magnets.find(m => m.code === magnetCode);
        if (!existing) {
            db.magnets.unshift({ id: Date.now(), code: magnetCode, unlocked: false, dateAdded: new Date().toISOString() });
            saveDB();
        }
        window.history.replaceState({}, document.title, window.location.pathname);
        if (currentRoute !== 'rewards') navigate('rewards');
    }
};

// 4. Coupons View
const COUPON_TYPES = {
    'party': { name: 'Ballīšu rāmis', enName: 'Party Frame', cls: 'cat-party', magnets: ['Spēle', 'Sacensības', 'Cīņa par balvu'], enMagnets: ['Game', 'Competition', 'Prize fight'] },
    'date': { name: 'Randiņu rāmis', enName: 'Date Frame', cls: 'cat-date', magnets: ['Piedzīvojums', 'Rokdarbi', 'Viegla atpūta', 'Izaicinājums', 'Kulinārija'], enMagnets: ['Adventure', 'Crafts', 'Relaxation', 'Challenge', 'Cooking'] },
    'travel': { name: 'Ceļojumu rāmis', enName: 'Travel Frame', cls: 'cat-travel', magnets: ['Izaicinājums', 'Aktivitāte', 'Randiņš', 'Piedzīvojums'], enMagnets: ['Challenge', 'Activity', 'Date', 'Adventure'] },
    'custom': { name: 'Personalizēts kupons', enName: 'Custom Coupon', cls: 'cat-custom', magnets: ['(Rakstīt savu...)'], enMagnets: ['(Write your own...)'] }
};

function renderCoupons(container) {
    window.couponsTab = window.couponsTab || 'received';
    const myEmail = db.auth.email;
    const activeCoupons = db.coupons.filter(c => c.status === 'pending' || c.status === 'accepted');
    const sentCoupons = activeCoupons.filter(c => c.sender === myEmail);
    const receivedCoupons = activeCoupons.filter(c => c.sender !== myEmail);


    let goalsHtml = '';
    if (!db.goals || db.goals.length === 0) {
        goalsHtml = `<div style="font-size:0.85rem; color:var(--text-muted); opacity:0.8; font-weight:600; width:100%; text-align:center; padding:10px 0;">${t('Vēl neesat izvirzījuši attiecību mērķus.', 'No relationship goals yet.')}</div>`;
    } else {
        db.goals.forEach(g => {
            const bg = g.achieved ? '#FF5A7E' : '#EBEBEB';
            const fg = g.achieved ? 'white' : '#A3A3A3';
            goalsHtml += `
                <div style="display:flex; align-items:center; gap:6px; background:${bg}; color:${fg}; padding:6px 12px; border-radius:20px; font-size:0.8rem; font-weight:700; transition:0.3s; cursor:pointer;" onclick="window.manageGoals()">
                    <i class="fa-solid ${g.icon}"></i> <span>${g.title}${g.year ? ` (` + g.year + `)` : ""}</span>
                </div>
            `;
        });
    }

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1.5rem; padding-top: 0.5rem;">
            <div onclick="navigate('timeline')" style="cursor:pointer; font-size:1.3rem; color:#A3A3A3; width: 32px;"><i class="fa-solid fa-arrow-left"></i></div>
            <h2 style="margin:0; font-size:1.4rem; color:#A3A3A3; font-weight:800;">${t('Mani uzdevumi', 'My tasks')}</h2>
            <div onclick="openSendCouponModal()" style="width: 32px; height: 32px; border-radius: 50%; background: #A3A3A3; display: flex; align-items: center; justify-content: center; color: white; cursor:pointer; font-size: 1rem;">
                <i class="fa-solid fa-plus"></i>
            </div>
        </div>
        
        <div style="display:flex; background:white; border-radius:20px; padding:4px; margin-bottom:2rem; box-shadow:0 4px 15px rgba(0,0,0,0.03);">
            <div onclick="window.couponsTab='received'; navigate('coupons');" style="flex:1; text-align:center; padding:12px; border-radius:16px; font-weight:800; font-size:0.95rem; cursor:pointer; transition:0.3s; ${window.couponsTab === 'received' ? 'background:#A3A3A3; color:white;' : 'background:transparent; color:#A3A3A3;'}">
                ${t('Saņemtie', 'Received')} (${receivedCoupons.length})
            </div>
            <div onclick="window.couponsTab='sent'; navigate('coupons');" style="flex:1; text-align:center; padding:12px; border-radius:16px; font-weight:800; font-size:0.95rem; cursor:pointer; transition:0.3s; ${window.couponsTab === 'sent' ? 'background:#A3A3A3; color:white;' : 'background:transparent; color:#A3A3A3;'}">
                ${t('Nosūtītie', 'Sent')} (${sentCoupons.length})
            </div>
        </div>
    `;

    const renderCard = (c, isSent) => {
        const meta = COUPON_TYPES[c.type];
        const isPending = c.status === 'pending';
        let actionsHtml = '';

        if (isSent) {
            if (isPending) {
                actionsHtml = `<div class="coupon-timer" style="color:var(--text-muted);"><i class="fa-regular fa-paper-plane"></i> ${t('Nosūtīts. Gaidām, kad partneris pieņems.', 'Sent. Waiting for partner to accept.')}</div>`;
            } else {
                actionsHtml = `
                <div style="margin-bottom:12px; font-size:0.85rem; font-weight:600; color:var(--text-main);">${t('Partneris ir pieņēmis! 🚀 Kad viņš pabeigs, apstiprini:', 'Partner accepted! 🚀 Confirm when done:')}</div>
                <div class="coupon-actions">
                    <button class="btn-approve" onclick="completeCoupon(${c.id})"><i class="fa-solid fa-check"></i> ${t('Atzīmēt izpildītu', 'Mark as done')}</button>
                    <button class="btn-reject" onclick="failCoupon(${c.id})" title="${t('Nepaspēja', 'Failed')}"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
            }
        } else {
            if (isPending) {
                actionsHtml = `
                <div class="coupon-actions">
                    <button class="btn-approve" onclick="acceptCoupon(${c.id})">${t('Pieņemt izaicinājumu', 'Accept challenge')}</button>
                    <button class="btn-reject" onclick="rejectCoupon(${c.id})" title="${t('Noraidīt', 'Reject')}"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
            } else {
                actionsHtml = `<div class="coupon-timer" style="color:var(--color-success); font-weight:600;"><i class="fa-solid fa-rocket"></i> ${t('Šis šobrīd jāizpilda tev! Kad esi gatavs, saki partnerim, viņš to apstiprinās.', 'You must complete this now! Tell your partner when ready.')}</div>`;
            }
        }

        return `
            <div class="glass-panel coupon-card ${meta.cls}" style="position:relative;">
                <div style="position:absolute; top:15px; right:15px; display:flex; align-items:center; gap:8px;">
                    <i class="fa-solid fa-ticket coupon-tag" style="position:static; margin:0;"></i>
                    <div style="background:rgba(255,149,0,0.15); color:#FF9500; font-weight:700; font-size:0.85rem; padding:4px 10px; border-radius:20px; display:flex; align-items:center; gap:5px;">
                        <i class="fa-solid fa-star"></i> +${c.points || 50} pt
                    </div>
                </div>
                <div class="coupon-category">${t(meta.name, meta.enName)}</div>
                <h3 class="coupon-title">${c.title}</h3>
                <p class="coupon-task">${t('Uzdevums:', 'Task:')} <strong>${c.task}</strong></p>
                <div class="coupon-timer"><i class="fa-regular fa-clock"></i> ${t('Līdz:', 'Until:')} ${new Date(c.expiry).toLocaleString(db.lang === 'en' ? 'en-US' : 'lv-LV')}</div>
                ${actionsHtml}
            </div>
        `;
    };

    const activeList = window.couponsTab === 'received' ? receivedCoupons : sentCoupons;
    const isSentContext = window.couponsTab === 'sent';

    html += `<div class="coupons-list" style="margin-bottom: 4rem;">`;
    if (activeList.length === 0) {
        const emptyText = window.couponsTab === 'received'
            ? t('Nav saņemto uzdevumu', 'No received tasks')
            : t('Nav nosūtīto uzdevumu', 'No sent tasks');
        const emptySubtext = window.couponsTab === 'received'
            ? t('Jūsu partneris var nosūtīt jums uzdevumus', 'Your partner can send you tasks')
            : t('Izveidojiet un nosūtiet uzdevumu savam partnerim!', 'Create and send a task to your partner!');

        html += `
        <div style="text-align:center; margin-top:4rem; color:#D1D1D6;">
            <i class="fa-solid fa-gift" style="font-size:6rem; margin-bottom:1.5rem; opacity:0.6;"></i>
            <h3 style="color:#A3A3A3; font-size:1.2rem; font-weight:800; margin-bottom:0.8rem;">${emptyText}</h3>
            <p style="font-size:0.95rem; color:#C7C7CC; max-width:80%; margin:0 auto; font-weight:500;">${emptySubtext}</p>
        </div>`;
    } else {
        activeList.forEach(c => html += renderCard(c, isSentContext));
    }
    html += `</div>`;

    container.innerHTML = html;
}

window.selectedCouponCat = 'date';

window.selectCouponCat = (cat) => {
    window.selectedCouponCat = cat;
    ['date', 'party', 'travel', 'custom'].forEach(c => {
        const el = document.getElementById('cat-btn-' + c);
        if (el) {
            if (c === cat) {
                el.style.borderColor = '#FF9500';
                el.style.background = 'rgba(255,149,0,0.1)';
            } else {
                el.style.borderColor = 'transparent';
                el.style.background = 'var(--bg-panel)';
            }
        }
    });

    const magSelect = document.getElementById('coup-magnet');
    const custInput = document.getElementById('coup-custom');
    if (magSelect && custInput) {
        if (cat === 'custom') {
            magSelect.classList.add('hidden');
            custInput.classList.remove('hidden');
        } else {
            magSelect.classList.remove('hidden');
            custInput.classList.add('hidden');
        }
    }
};

window.openSendCouponModal = () => {
    window.selectedCouponCat = 'date';

    const iconBox = (id, icon, color, labelKey, labelEn) => `
        <div id="cat-btn-${id}" onclick="selectCouponCat('${id}')" style="padding:15px 10px; border-radius:12px; border:2px solid ${id === 'date' ? '#FF9500' : 'transparent'}; text-align:center; cursor:pointer; background:${id === 'date' ? 'rgba(255,149,0,0.1)' : 'var(--bg-panel)'}; transition:0.3s; user-select:none;">
            <i class="fa-solid fa-${icon}" style="color:${color}; font-size:1.6rem; margin-bottom:8px;"></i>
            <div style="font-size:0.8rem; font-weight:600; color:var(--text-main);">${t(labelKey, labelEn)}</div>
        </div>
    `;

    const catHtml = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:1.5rem;">
         ${iconBox('date', 'heart', '#FF9500', 'Randiņu', 'Date')}
         ${iconBox('party', 'glass-cheers', '#4dabf7', 'Ballīšu', 'Party')}
         ${iconBox('travel', 'plane', '#69db7c', 'Ceļojumu', 'Travel')}
         ${iconBox('custom', 'pen-nib', '#ff6b6b', 'Cits', 'Other')}
      </div>
    `;

    const staticMagsLv = ['Kulinārija', 'Viegla atpūta', 'Izaicinājums', 'Aktivitāte'];
    const staticMagsEn = ['Cooking', 'Relaxation', 'Challenge', 'Activity'];
    const magOpts = (db.lang === 'en' ? staticMagsEn : staticMagsLv).map(m => `<option value="${m}">${m}</option>`).join('');

    showOverlay(`
           <h3 class="modal-title" style="margin-bottom:1.5rem; text-align:center;"><i class="fa-solid fa-gift text-gold" style="margin-right:8px;"></i> ${t('Nosūtīt Kuponu', 'Send Coupon')}</h3>
           
           ${catHtml}
           
           <div class="input-group" style="position:relative;">
               <i class="fa-solid fa-magnet" style="position:absolute; left:15px; top:42px; color:var(--text-muted);"></i>
               <label class="input-label" style="text-transform:uppercase; font-size:0.75rem; letter-spacing:1px; margin-bottom:8px;">${t('Magnēta tips', 'Magnet Type')}</label>
               <select id="coup-magnet" class="input-field" style="padding-left:40px;">${magOpts}</select>
               <input type="text" id="coup-custom" class="input-field hidden" style="padding-left:40px;" placeholder="${t('Raksti savu nosaukumu...', 'Write a custom title...')}">
           </div>
           
           <div class="input-group" style="position:relative;">
               <i class="fa-solid fa-clipboard-check" style="position:absolute; left:15px; top:42px; color:var(--text-muted);"></i>
               <label class="input-label">${t('Pievieno uzdevumu, kas jāizpilda, lai saņemtu punktus', 'Add task to be completed for points')}</label>
               <input type="text" id="coup-task" class="input-field" style="padding-left:40px;" placeholder="${t('Piem., pagatavot vakariņas...', 'E.g., cook dinner...')}">
           </div>
           
           <div style="display:flex; gap:1rem; margin-bottom:1rem;">
               <div class="input-group" style="flex:1; position:relative; margin-bottom:0;">
                   <i class="fa-solid fa-star text-gold" style="position:absolute; left:15px; top:42px;"></i>
                   <label class="input-label">${t('Punkti', 'Points')}</label>
                   <input type="number" id="coup-points" class="input-field" style="padding-left:40px; font-weight:bold; color:var(--text-main);" placeholder="50" value="50" min="10" step="10">
               </div>
               <div class="input-group" style="flex:1.5; position:relative; margin-bottom:0;">
                   <i class="fa-regular fa-calendar-xmark" style="position:absolute; left:15px; top:42px; color:var(--text-muted);"></i>
                   <label class="input-label">${t('Termiņš', 'Deadline')}</label>
                   <input type="datetime-local" id="coup-expiry" class="input-field" style="padding-left:40px; font-size:0.85rem;">
               </div>
           </div>
           
           <div style="background:rgba(77, 171, 247, 0.1); border-radius:10px; padding:12px; margin-bottom:1.5rem; display:flex; gap:12px; align-items:flex-start;">
               <i class="fa-solid fa-circle-info" style="color:#4dabf7; margin-top:2px;"></i>
               <p style="font-size:0.8rem; opacity:0.9; margin:0; line-height:1.4;">${t('Reālus punktus partneris saņems TIKAI tad, kad tu pats apstiprināsi uzdevuma izpildi!', 'Real points will be awarded ONLY when you confirm task completion!')}</p>
           </div>
           
           <button class="btn-primary" style="font-size:1.1rem; padding:12px;" onclick="sendCoupon()"><i class="fa-solid fa-paper-plane" style="margin-right:8px;"></i> ${t('Nosūtīt Partnerim', 'Send to Partner')}</button>
    `);
};

window.sendCoupon = () => {
    const cat = window.selectedCouponCat || 'date';
    let title = document.getElementById('coup-magnet').value;
    if (cat === 'custom') title = document.getElementById('coup-custom').value;
    const task = document.getElementById('coup-task').value;
    const expiry = document.getElementById('coup-expiry').value;
    const pts = parseInt(document.getElementById('coup-points').value) || 50;

    if (!title || !task || !expiry) return alert(t("Aizpildiet visus laukus!", "Please fill all fields!"));

    db.coupons.push({ id: Date.now(), type: cat, title, task, expiry, points: pts, status: 'pending', sender: db.auth.email });
    saveDB(); closeOverlays(); navigate('coupons');
};

window.acceptCoupon = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) { cp.status = 'accepted'; saveDB(); navigate('coupons'); }
};

window.rejectCoupon = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) { cp.status = 'failed'; saveDB(); navigate('coupons'); }
};

window.completeCoupon = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) {
        cp.status = 'done';
        const pointsAwarded = cp.points || 50;
        // The sender clicked this to confirm that the partner did it.
        // So the partner earns the points!
        db.auth.partnerPoints = (db.auth.partnerPoints || 0) + pointsAwarded;
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `${t('Partneris izpildīja kuponu', 'Partner completed')}: ${cp.title}`, points: pointsAwarded });
        saveDB(); navigate('coupons');
    }
};

window.failCoupon = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) {
        cp.status = 'failed';
        const penalty = Math.round((cp.points || 50) / 2);
        // Partner failed it, so partner loses points.
        db.auth.partnerPoints = Math.max(0, (db.auth.partnerPoints || 0) - penalty);
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `${t('Partneris neizpildīja', 'Partner failed')}: ${cp.title}`, points: -penalty });
        saveDB(); navigate('coupons');
    }
};

// 5. Photos View
function renderPhotos(container) {

    let goalsHtml = '';
    if (!db.goals || db.goals.length === 0) {
        goalsHtml = `<div style="font-size:0.85rem; color:var(--text-muted); opacity:0.8; font-weight:600; width:100%; text-align:center; padding:10px 0;">${t('Vēl neesat izvirzījuši attiecību mērķus.', 'No relationship goals yet.')}</div>`;
    } else {
        db.goals.forEach(g => {
            const bg = g.achieved ? '#FF5A7E' : '#EBEBEB';
            const fg = g.achieved ? 'white' : '#A3A3A3';
            goalsHtml += `
                <div style="display:flex; align-items:center; gap:6px; background:${bg}; color:${fg}; padding:6px 12px; border-radius:20px; font-size:0.8rem; font-weight:700; transition:0.3s; cursor:pointer;" onclick="window.manageGoals()">
                    <i class="fa-solid ${g.icon}"></i> <span>${g.title}${g.year ? ` (` + g.year + `)` : ""}</span>
                </div>
            `;
        });
    }

    let html = `
       <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 2rem;">
           <h2 class="view-title" style="margin-bottom:0; color:#A3A3A3; font-size:1.3rem;">${t('Kopīgi uzņemtās bildes', 'Shared Photos')}</h2>
           <div onclick="document.getElementById('photo-upload').click()" style="width: 32px; height: 32px; border-radius: 50%; background: #A3A3A3; display: flex; align-items: center; justify-content: center; color: white; cursor:pointer; font-size: 1rem;">
               <i class="fa-solid fa-plus"></i>
           </div>
       </div>
       <input type="file" id="photo-upload" class="hidden" accept="image/*" onchange="uploadPhoto(this)">
    `;

    if (db.photos.length === 0) {
        html += `
           <div class="animate-fade-in" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height: 60vh; text-align:center;">
               <i class="fa-regular fa-images" style="font-size: 6rem; color: #E0E0E0; margin-bottom: 1.5rem;"></i>
               <h3 style="color: #ABAAA4; font-weight: 800; font-size: 1.15rem; margin-bottom: 0.5rem;">${t('Vēl nav fotoattēlu', 'No photos yet')}</h3>
               <p style="color: #C8C7C3; font-size: 0.8rem; font-weight: 600; margin-bottom: 2rem; max-width:80%; line-height:1.4;">${t('Pievienojiet savas kopīgās bildes Polaroid stilā', 'Add your shared memories in Polaroid style')}</p>
               <button class="btn-primary" style="background:#A3A3A3; color:white; width:auto; padding:0.9rem 1.8rem; font-weight:700; border-radius:24px; font-size:0.9rem; box-shadow:none;" onclick="document.getElementById('photo-upload').click()">${t('Pievienot pirmo foto', 'Add first photo')}</button>
           </div>
        `;
    } else {
        html += `<div class="photo-grid">`;
        db.photos.forEach(p => {
            const dateStr = new Date(p.id).toLocaleDateString(db.lang === 'en' ? 'en-US' : 'lv-LV', { year: 'numeric', month: 'short', day: 'numeric' });
            html += `
               <div class="polaroid animate-fade-in">
                   <div class="polaroid-img-wrapper">
                       <img src="${p.dataUrl}" onclick="viewPhoto(${p.id})">
                   </div>
                   <input type="text" class="polaroid-title" data-id="${p.id}" value="${p.title}" onblur="editPhotoTitle(${p.id}, this.value)" placeholder="${t('Pievieno nosaukumu...', 'Add a title...')}">
                   <div class="polaroid-date">${dateStr}</div>
                   <div class="polaroid-actions">
                       <button class="pol-btn download" onclick="downloadPhotoRaw('${p.dataUrl}')" title="${t('Iegūt', 'Download')}"><i class="fa-solid fa-arrow-up-from-bracket" style="transform: translateY(1px);"></i></button>
                       <button class="pol-btn edit" onclick="document.querySelector('.polaroid-title[data-id=\\'${p.id}\\']').focus()" title="${t('Rediģēt', 'Edit')}"><i class="fa-solid fa-pen"></i></button>
                       <button class="pol-btn delete" onclick="deletePhoto(${p.id})" title="${t('Dzēst', 'Delete')}"><i class="fa-regular fa-trash-can"></i></button>
                   </div>
               </div>`;
        });
        html += `</div>`;
    }

    container.innerHTML = html;
}

window.downloadPhotoRaw = (dataUrl) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'framed_date_mem.jpg';
    a.click();
};

window.deletePhoto = (id) => {
    if (confirm(t('Vai tiešām vēlies izdzēst bildi?', 'Are you sure you want to delete this photo?'))) {
        db.photos = db.photos.filter(p => p.id !== id);
        saveDB();
        navigate('photos');
    }
};

let cropperInstance = null;

window.uploadPhoto = (input) => {
    if (!input.files || !input.files[0]) return;
    const reader = new FileReader();
    const mode = input.dataset.mode || 'photo';
    reader.onload = (e) => {
        openCropper(e.target.result, mode);
    };
    reader.readAsDataURL(input.files[0]);
    // reset input so the same file can be selected again
    input.value = '';
};

window._cropperMode = 'photo';

window.openCropper = (imgUrl, mode = 'photo') => {
    window._cropperMode = mode;
    const overlay = document.createElement('div');
    overlay.id = 'cropper-overlay';
    // Style as black background covering everything
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:#111; z-index:9999; display:flex; flex-direction:column;';

    overlay.innerHTML = `
        <div style="padding: 20px 20px 10px; text-align: center; color: white; display:flex; justify-content:center; align-items:center; position:relative;">
            <h3 style="margin:0; font-weight:700; font-size:1.1rem; font-family:-apple-system, system-ui, sans-serif;">Choose Photo</h3>
        </div>
        <div style="flex:1; width:100%; position:relative; overflow:hidden; display:flex; align-items:center; justify-content:center; background:#000;">
            <img id="cropper-img" src="${imgUrl}" style="max-width: 100%; max-height: 100%; display:block;">
        </div>
        <div style="padding: 25px 30px 40px; display:flex; justify-content:space-between; align-items:center; font-family:-apple-system, system-ui, sans-serif;">
            <button onclick="closeCropper()" style="color:white; background:transparent; border:none; font-size:1.1rem; font-weight:400; padding:0;">Cancel</button>
            <button onclick="applyCrop()" style="color:white; background:transparent; border:none; font-size:1.1rem; font-weight:600; padding:0;">Choose</button>
        </div>
    `;

    document.body.appendChild(overlay);

    const imgEl = document.getElementById('cropper-img');
    cropperInstance = new Cropper(imgEl, {
        aspectRatio: 1, // force square crop
        viewMode: 1,
        dragMode: 'move',
        background: false,
        modal: true,
        guides: true,
        highlight: false,
        autoCropArea: 1,
        cropBoxMovable: false,
        cropBoxResizable: false,
        toggleDragModeOnDblclick: false,
    });
};

window.closeCropper = () => {
    if (cropperInstance) {
        cropperInstance.destroy();
        cropperInstance = null;
    }
    const overlay = document.getElementById('cropper-overlay');
    if (overlay) overlay.remove();
};

window.applyCrop = () => {
    if (!cropperInstance) return;
    const canvas = cropperInstance.getCroppedCanvas({
        width: 1000,
        height: 1000,
        imageSmoothingQuality: 'high'
    });

    const croppedUrl = canvas.toDataURL('image/jpeg', 0.85);
    closeCropper();

    if (window._cropperMode === 'avatar') {
        db.auth.myAvatar = croppedUrl;
        saveDB();
        navigate('timeline');
    } else {
        openPhotoDetailsSheet(croppedUrl);
    }
};

window.openPhotoDetailsSheet = (imgUrl) => {
    const overlay = document.createElement('div');
    overlay.id = 'photo-details-overlay';
    // Style as translucent background with bottom sheet
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:flex-end; justify-content:center;';

    overlay.innerHTML = `
        <div class="animate-slide-up" style="background:#F2F2F7; width:100%; border-radius:30px 30px 0 0; padding:2rem 1.5rem; padding-bottom: max(2rem, env(safe-area-inset-bottom)); box-shadow: 0 -10px 40px rgba(0,0,0,0.1);">
            <h3 style="font-weight:800; font-size:1.4rem; color:#A3A3A3; margin-bottom:1.5rem;">${t('Pievienot parakstu', 'Add caption')}</h3>
            
            <div style="width:100%; aspect-ratio:1; max-height:40vh; border-radius:16px; overflow:hidden; margin-bottom:1.5rem; display:flex; justify-content:center;">
                <img src="${imgUrl}" style="width:100%; height:100%; object-fit:contain; border-radius:16px;">
            </div>
            
            <input type="text" id="photo-caption-input" style="width:100%; background:#FFFFFF; border:none; border-radius:14px; padding:1.2rem; font-size:1rem; color:#333; margin-bottom:1.5rem; outline:none; box-sizing:border-box;" placeholder="${t('Ievadiet parakstu (neobligāti)', 'Enter caption (optional)')}">
            
            <div style="display:flex; gap:10px;">
                <button onclick="document.getElementById('photo-details-overlay').remove()" style="flex:1; background:#D1D1D6; color:#8E8E93; border:none; font-weight:700; font-size:1rem; padding:1.2rem; border-radius:16px; cursor:pointer;">${t('Atcelt', 'Cancel')}</button>
                <button onclick="saveFinalPhoto('${imgUrl}')" style="flex:1; background:#A3A3A3; color:white; border:none; font-weight:700; font-size:1rem; padding:1.2rem; border-radius:16px; cursor:pointer;">${t('Pievienot', 'Add')}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    setTimeout(() => {
        const input = document.getElementById('photo-caption-input');
        if (input) input.focus();
    }, 100);
};

window.saveFinalPhoto = (imgUrl) => {
    const caption = document.getElementById('photo-caption-input').value || '';
    document.getElementById('photo-details-overlay').remove();

    db.photos.unshift({ id: Date.now(), dataUrl: imgUrl, title: caption });
    saveDB();
    navigate('photos');
};

window.editPhotoTitle = (id, newTitle) => {
    const p = db.photos.find(p => p.id === id);
    if (p) { p.title = newTitle; saveDB(); }
};

window.viewPhoto = (id) => {
    const p = db.photos.find(p => p.id === id);
    if (!p) return;
    showOverlay(`
        <div style="text-align: center;">
            <img src="${p.dataUrl}" style="width: 100%; max-height: 50vh; object-fit: contain; border-radius: 8px; margin-bottom: 1.5rem; background:black;">
            <h3 style="font-family: 'Playfair Display', serif; font-size: 1.5rem; margin-bottom: 1rem;">${p.title}</h3>
            <a href="${p.dataUrl}" download="atmina.jpg" class="btn-primary" style="display:inline-flex; width: auto; padding: 1rem 2rem; border-radius: 30px;"><i class="fa-solid fa-download"></i> ${t('Lejuplādēt Bildi', 'Download Photo')}</a>
        </div>
    `);
};

// Function to calculate detailed time together for the dashboard
function getDetailedTimeStats() {
    const start = new Date(db.relationship_start || '2025-01-01');
    const now = new Date();
    const diffMs = now - start;
    const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    // Absolute totals
    const years = Math.floor(totalDays / 365);
    const months = Math.floor(totalDays / 30);

    return { years, months, days: totalDays };
}

// Function to format time together
function getTimeTogether() {
    const stats = getDetailedTimeStats();
    let resLv = []; let resEn = [];
    if (stats.years > 0) { resLv.push(`${Math.floor(stats.days / 365)} gadi`); resEn.push(`${Math.floor(stats.days / 365)} years`); }
    const remMonths = Math.floor((stats.days % 365) / 30);
    if (remMonths > 0) { resLv.push(`${remMonths} mēn.`); resEn.push(`${remMonths} mo.`); }
    const remDays = (stats.days % 365) % 30;
    if (remDays > 0 || resLv.length === 0) { resLv.push(`${remDays} dienas`); resEn.push(`${remDays} days`); }

    return t(resLv.join(', '), resEn.join(', '));
}

window.toggleActivityChart = () => {
    const el = document.getElementById('dash-chart-panel');
    if (el) {
        el.classList.toggle('hidden');
    }
};

// Function to calculate health score
function getRelationshipScore() {
    const allGoalsCount = (db.goals || []).length;
    const achievedGoals = (db.goals || []).filter(g => g.achieved).length;

    let percentage = 0;
    if (allGoalsCount > 0) {
        percentage = Math.floor((achievedGoals / allGoalsCount) * 100);
    }

    let pt = (percentage / 10).toFixed(1);

    let lvl = 'Pievieno pirmos mērķus!'; let color = '#A3A3A3';
    if (allGoalsCount > 0) {
        if (percentage >= 100) { lvl = 'Pilnība!'; color = '#FF5A7E'; }
        else if (percentage >= 70) { lvl = 'Lielisks virziens'; color = '#4dabf7'; }
        else if (percentage >= 30) { lvl = 'Labs progress'; color = '#69db7c'; }
        else { lvl = 'Sākam strādāt'; color = '#ff922b'; }
    }

    return {
        level: t(lvl, lvl),
        val: pt,
        percentage,
        color
    };
}

// 6. Timeline / Dashboard View
function renderTimeline(container) {
    const recent = db.history.slice(0, 5);

    const myCompletedTaskCount = db.coupons.filter(c => c.status === 'done' && c.sender !== db.auth.email).length;
    const pendingCoupons = db.coupons.filter(c => c.status === 'pending').length;
    const photosCount = db.photos.length;
    const totalPoints = db.points + (db.auth.myPoints || 0) + (db.auth.partnerPoints || 0);
    const timeStats = getDetailedTimeStats();
    const scr = getRelationshipScore();

    // Determine Names
    const myName = db.auth.username || t('Es', 'Me');
    const partName = db.auth.partnerUsername || t('Partneris', 'Partner');
    const combinedNames = `${myName} un ${partName}`;

    const myAvatar = db.auth.myAvatar;
    const partAvatar = db.auth.partnerAvatar;


    let goalsHtml = '';
    if (!db.goals || db.goals.length === 0) {
        goalsHtml = `<div style="font-size:0.85rem; color:var(--text-muted); opacity:0.8; font-weight:600; width:100%; text-align:center; padding:10px 0;">${t('Vēl neesat izvirzījuši attiecību mērķus.', 'No relationship goals yet.')}</div>`;
    } else {
        db.goals.forEach(g => {
            const bg = g.achieved ? '#FF5A7E' : '#EBEBEB';
            const fg = g.achieved ? 'white' : '#A3A3A3';
            goalsHtml += `
                <div style="display:flex; align-items:center; gap:6px; background:${bg}; color:${fg}; padding:6px 12px; border-radius:20px; font-size:0.8rem; font-weight:700; transition:0.3s; cursor:pointer;" onclick="window.manageGoals()">
                    <i class="fa-solid ${g.icon}"></i> <span>${g.title}${g.year ? ` (` + g.year + `)` : ""}</span>
                </div>
            `;
        });
    }

    let html = `
           <div class="dash-header-row animate-fade-in">
               <div class="dash-title-wrap" style="display:flex; align-items:center; gap:12px;">
                   <div class="dash-avatars">
                       <div class="dash-avatar" onclick="document.getElementById('avatar-upload').click()">
                           ${myAvatar ? `<img src="${myAvatar}">` : `<i class="fa-solid fa-user"></i>`}
                           <div class="avatar-badge"><i class="fa-solid fa-plus"></i></div>
                       </div>
                       <div class="dash-avatar partner">
                           ${partAvatar ? `<img src="${partAvatar}">` : `<i class="fa-solid fa-user"></i>`}
                       </div>
                   </div>
                   <div>
                       <h1>${combinedNames}</h1>
                       <p>${t('Jūsu mīlas stāsts', 'Your love story')}</p>
                   </div>
               </div>
               <div class="dash-palette-icon">
                   <i class="fa-solid fa-palette"></i>
               </div>
           </div>
           
           <!-- Hidden avatar upload input -->
           <input type="file" id="avatar-upload" accept="image/*" data-mode="avatar" onchange="uploadPhoto(this)" style="display:none;">
           
           <div class="dash-hero-card animate-fade-in" style="animation-delay: 0.1s;">
               <div class="dash-heart">
                   <i class="fa-solid fa-heart"></i>
               </div>
               
               <div class="dash-stats-grid">
                   <div class="dash-stat-col">
                       <h2>${timeStats.years}</h2>
                       <p>${t('Gadi', 'Years')}</p>
                   </div>
                   <div class="dash-stat-col">
                       <h2>${timeStats.months}</h2>
                       <p>${t('Mēneši', 'Months')}</p>
                   </div>
                   <div class="dash-stat-col">
                       <h2>${timeStats.days}</h2>
                       <p>${t('Dienas', 'Days')}</p>
                   </div>
               </div>
               
               <div class="dash-progress-title">${t('Sasniegtie mērķi', 'Achieved goals')}</div>
                <div class="dash-progress-wrap">
                    <div class="dash-progress-bar">
                        <div class="dash-progress-fill" style="width: ${scr.percentage}%;"></div>
                    </div>
                    <div class="dash-progress-val">${scr.percentage}%</div>
                </div>

                <div style="margin-top: 2rem; text-align: left; background: rgba(255,255,255,0.5); padding: 15px; border-radius: 16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.8rem;">
                        <div class="dash-progress-title" style="margin-bottom:0; color:#8D8C86;">${t('Attiecību Mērķi', 'Relationship Goals')}</div>
                        <div onclick="window.manageGoals()" style="color:#FF5A7E; font-size:0.8rem; font-weight:800; cursor:pointer;"><i class="fa-solid fa-pen"></i> ${t('Pārvaldīt', 'Manage')}</div>
                    </div>
                    <div style="display:flex; flex-wrap:wrap; gap:8px;">
                        ${goalsHtml}
                    </div>
                </div>
            </div>

           <h3 class="dash-section-title animate-fade-in" style="animation-delay: 0.15s;">${t('Jūsu aktivitātes', 'Your activities')}</h3>
           
           <div class="dash-activity-slider animate-fade-in" style="animation-delay: 0.2s;">
                <div class="dash-act-card purple" onclick="navigate('photos')">
                    <div class="dash-plus-icon"><i class="fa-solid fa-plus"></i></div>
                    <div class="dash-act-icon-wrap purple">
                        <i class="fa-regular fa-image"></i>
                    </div>
                    <h3 class="number-font">${photosCount}</h3>
                    <p>${t('Mūsu bildes', 'Our photos')}</p>
                </div>

                <div class="dash-act-card orange" onclick="navigate('rewards')">
                    <div class="dash-act-icon-wrap orange">
                        <i class="fa-solid fa-star" style="color: #F59E0B;"></i>
                    </div>
                    <h3 class="number-font" style="color: #F59E0B;">${db.auth.myPoints || 0}</h3>
                    <p>${t('Punkti', 'Points')}</p>
                </div>
                
                <div class="dash-act-card green" onclick="navigate('coupons')">
                    <div class="dash-act-icon-wrap green">
                        <i class="fa-regular fa-circle-check"></i>
                    </div>
                    <h3 class="number-font">${myCompletedTaskCount}</h3>
                    <p>${t('Pabeigtie uzdevumi', 'Completed Tasks')}</p>
                </div>
                
                <div class="dash-act-card blue" onclick="navigate('coupons')">
                    <div class="dash-act-icon-wrap blue">
                        <i class="fa-solid fa-clock" style="color: #3B82F6;"></i>
                    </div>
                    <h3 class="number-font" style="color: #3B82F6;">${pendingCoupons}</h3>
                    <p>${t('Gaida apstiprinājumu', 'Waiting approval')}</p>
                </div>
            </div>

           <h3 class="dash-section-title animate-fade-in" style="animation-delay: 0.25s;">${t('Ātrās darbības', 'Quick Actions')}</h3>
           
           <div class="dash-actions-row animate-fade-in" style="animation-delay: 0.3s;">
               <div class="dash-action-btn teal" onclick="navigate('profile')">
                   <i class="fa-solid fa-user-group"></i>
                   <span>${t('Profils', 'Profile')}</span>
               </div>
               <div class="dash-action-btn pink" onclick="navigate('coupons')">
                   <i class="fa-solid fa-list-check"></i>
                   <span>${t('Uzdevumi', 'Tasks')}</span>
               </div>
               <div class="dash-action-btn orange" onclick="navigate('rewards')">
                   <i class="fa-solid fa-ticket"></i>
                   <span>${t('Kuponi', 'Coupons')}</span>
               </div>
           </div>

           <div class="dash-history-toggle animate-fade-in" style="animation-delay: 0.35s;" onclick="toggleActivityChart()">
               <i class="fa-solid fa-chart-column"></i>
               <span>${t('Aktivitāšu vēsture', 'Activity History')}</span>
           </div>

           <div id="dash-chart-panel" class="glass-panel hidden animate-fade-in" style="margin-bottom:2rem; padding:1.5rem 1rem;">
               <h3 style="margin-bottom: 1rem; font-size:1.1rem; color:var(--text-main); text-align:center;">${t('Aktivitāšu Līkne', 'Activity Graph')}</h3>
               <div style="height:150px; width:100%;">
                   <canvas id="activityChart"></canvas>
               </div>
           </div>

           <h3 class="section-subtitle animate-fade-in" style="animation-delay: 0.4s;">${t('Notikumu vēsture', 'History Log')}</h3>
        `;

    if (recent.length === 0) {
        html += `<div class="glass-panel text-center animate-fade-in" style="opacity:0.7; animation-delay: 0.4s;">${t('Nav neviena notikuma vēsturē.', 'No history events yet.')}</div>`;
    } else {
        html += `<div class="history-list animate-fade-in" style="animation-delay: 0.4s;">`;
        recent.forEach((h, index) => {
            html += `
               <div class="history-item" style="animation-delay: ${0.4 + (index * 0.1)}s;">
                   <div class="history-dot"></div>
                   <div class="history-date">${new Date(h.date).toLocaleDateString(db.lang === 'en' ? 'en-US' : 'lv-LV', { day: 'numeric', month: 'short', year: 'numeric' })} ${new Date(h.date).toLocaleTimeString(db.lang === 'en' ? 'en-US' : 'lv-LV', { hour: '2-digit', minute: '2-digit' })}</div>
                   <div class="history-title">${h.title}</div>
                   ${h.points !== 0 ? `<div class="history-points">${h.points > 0 ? '+' : ''}${h.points} pt</div>` : ''}
               </div>`;
        });
        html += `</div>`;
    }

    container.innerHTML = html;

    setTimeout(() => {
        const ctx = document.getElementById('activityChart');
        if (ctx) setupChart(ctx);
    }, 100);
}

function setupChart(ctx) {
    if (window.activityChartInstance) window.activityChartInstance.destroy();

    const labels = [];
    const dataPoints = [];

    // Plot exactly 7 days to form a proper line graph curve
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dStr = d.toLocaleDateString(db.lang === 'en' ? 'en-US' : 'lv-LV', { month: 'short', day: 'numeric' });
        labels.push(dStr);
        dataPoints.push(0); // Default 0 activities
    }

    db.history.forEach(h => {
        const dStr = new Date(h.date).toLocaleDateString(db.lang === 'en' ? 'en-US' : 'lv-LV', { month: 'short', day: 'numeric' });
        const idx = labels.indexOf(dStr);
        if (idx !== -1) {
            dataPoints[idx] += 1; // Count events per day
        }
    });

    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = "#86868b";

    window.activityChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: t('Notikumi', 'Events'),
                data: dataPoints,
                borderColor: '#FF9500',
                backgroundColor: 'rgba(255, 149, 0, 0.15)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#FF9500',
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(29, 29, 31, 0.9)',
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 5 }
                },
                y: {
                    display: false,
                    beginAtZero: true,
                    suggestedMax: Math.max(...dataPoints) + 1
                }
            }
        }
    });
}

/* ==================================
   Initialization
   ================================== */

/* ==================================
   Goals Management (Mērķi)
   ================================== */
window.manageGoals = () => {
    window.renderGoalsModal();
};

window.renderGoalsModal = () => {
    let listHtml = '';
    if (!db.goals || db.goals.length === 0) {
        listHtml = `<div class="text-center" style="color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;">${t('Nekas vēl nav pievienots.', 'Nothing added yet.')}</div>`;
    } else {
        db.goals.forEach(g => {
            const checkIcon = g.achieved ? 'fa-solid fa-circle-check text-green' : 'fa-regular fa-circle text-muted';
            const textStyle = g.achieved ? 'text-decoration:line-through; opacity:0.6;' : 'font-weight:700;';
            listHtml += `
                <div style="display:flex; justify-content:space-between; align-items:center; background:#f4f4f5; padding:10px 15px; border-radius:12px; margin-bottom:10px;">
                    <div style="display:flex; align-items:center; gap:10px; cursor:pointer;" onclick="toggleGoal(${g.id})">
                        <i class="${checkIcon}" style="font-size:1.2rem;"></i>
                        <span style="${textStyle} font-size:0.95rem;"><i class="fa-solid ${g.icon}" style="margin-right:5px; opacity:0.7;"></i> ${g.title}${g.year ? ` (` + g.year + `)` : ""}</span>
                    </div>
                    <div style="color:#ff3b30; cursor:pointer; padding:5px;" onclick="deleteGoal(${g.id})"><i class="fa-solid fa-trash"></i></div>
                </div>
            `;
        });
    }

    const popupHtml = `
        <div style="padding:10px;">
            <h2 class="view-title" style="font-size:1.4rem; margin-bottom:1.5rem; text-align:center;">${t('Mūsu Lielie Mērķi', 'Our Big Goals')}</h2>
            
            <div style="max-height:40vh; overflow-y:auto; margin-bottom:1.5rem;">
                ${listHtml}
            </div>
            
            <div style="background:#fff; padding:15px; border-radius:16px; box-shadow:0 0 10px rgba(0,0,0,0.05);">
                <h4 style="margin-bottom:10px; font-size:0.9rem;">${t('Pievienot citu', 'Add new')}</h4>
                <div style="display:flex; gap:5px; margin-bottom:10px; align-items: center;">
                    <select id="goalIconSel" class="input-field" style="width:60px; padding:0; text-align:center;">
                        <option value="fa-heart">❤️</option>
                        <option value="fa-baby">👶</option>
                        <option value="fa-house">🏠</option>
                        <option value="fa-dog">🐶</option>
                        <option value="fa-cat">🐱</option>
                        <option value="fa-ring">💍</option>
                        <option value="fa-plane">✈️</option>
                        <option value="fa-car">🚗</option>
                        <option value="fa-piggy-bank">💰</option>
                        <option value="fa-gift">🎁</option>
                        <option value="fa-star">⭐️</option>
                    </select>
                    <input type="text" id="goalTitleInput" class="input-field" placeholder="${t('Piem., Kopīgs mājoklis', 'E.g., Our own house')}" style="flex:1; padding: 0 10px;">
                    <select id="goalYearSel" class="input-field" style="width:80px; padding:0 5px;">
                        ${(() => {
            let opts = '';
            const cur = new Date().getFullYear();
            for (let i = 0; i <= 10; i++) opts += `<option value="${cur + i}">${cur + i}</option>`;
            return opts;
        })()}
                    </select>
                </div>
                <button class="btn-primary" onclick="addGoal()">${t('Pievienot Mērķi', 'Add Goal')}</button>
            </div>
        </div>
    `;

    closeOverlays();
    showOverlay(popupHtml);
};

window.addGoal = () => {
    const title = document.getElementById('goalTitleInput').value.trim();
    const icon = document.getElementById('goalIconSel').value;
    const year = document.getElementById('goalYearSel').value;

    if (!title) return;
    if (!db.goals) db.goals = [];

    db.goals.push({
        id: Date.now(),
        title: title,
        icon: icon,
        year: year,
        achieved: false,
        date: new Date().toISOString()
    });

    db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `Jauns attiecību mērķis: ${title}`, points: 0 });
    saveDB();
    renderGoalsModal();
    if (currentRoute === 'timeline') renderTimeline(document.getElementById('app-content'));
};

window.toggleGoal = (id) => {
    const g = db.goals.find(x => x.id === id);
    if (g) {
        g.achieved = !g.achieved;
        if (g.achieved) {
            db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `Mērķis SASNIEGTS! 🎉 ${g.title}`, points: 50 });
        }
        saveDB();
        renderGoalsModal();
        if (currentRoute === 'timeline') renderTimeline(document.getElementById('app-content'));
    }
};

window.deleteGoal = (id) => {
    if (confirm(t('Dzēst šo mērķi?', 'Delete this goal?'))) {
        db.goals = db.goals.filter(x => x.id !== id);
        saveDB();
        renderGoalsModal();
        if (currentRoute === 'timeline') renderTimeline(document.getElementById('app-content'));
    }
};

document.addEventListener('DOMContentLoaded', () => {
    loadDB();

    // Bind Nav clicks
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => navigate(btn.dataset.route));
    });

    updateHeader();
    if (typeof checkQRMagnet === 'function') checkQRMagnet();

    // Only run default nav if QR logic didn't navigate already
    if (currentRoute !== 'rewards') {
        navigate(db.auth ? 'timeline' : 'auth'); // Root init
    }
});
