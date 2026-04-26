/* ==================================
   🔥 Firebase Configuration
   ================================== */
// ⚠️ REPLACE THESE WITH YOUR FIREBASE WEB SDK CONFIG
// Go to Firebase Console → Project Settings → Your apps → Web app
const firebaseConfig = {
    apiKey: "AIzaSyCiuYqnyAEy64TEu5sWI0WS7rCEiqwCP5A",
    authDomain: "framed-date.firebaseapp.com",
    databaseURL: "https://framed-date-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "framed-date",
    storageBucket: "framed-date.firebasestorage.app",
    messagingSenderId: "296843934965",
    appId: "1:296843934965:web:50b449d62d3b4c1d2fd9bc",
    measurementId: "G-VTDRZECHGZ"
};

firebase.initializeApp(firebaseConfig);
const firebaseAuth = firebase.auth();
const firebaseDB = firebase.database();
const firebaseStorage = firebase.storage();

// Social Providers
const googleProvider = new firebase.auth.GoogleAuthProvider();
const appleProvider = new firebase.auth.OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

/* ==================================
   State Management
   ================================== */
const STORE_KEY = 'framed_date_db';

// The "db" object is now a local cache of the Firebase "Source of Truth"
let db = {
    lang: 'lv',
    auth: {
        uid: null,
        username: 'Lietotājs',
        email: '',
        avatar: null,
        gameId: null,
        role: null, // 'host' or 'client'
        connected: false,
        onboardingFinished: false
    },
    points: 0,
    relationship_start: null,
    coupons: [],
    history: [],
    photos: [],
    goals: [],
    magnets: [],
    darkMode: false,
    currentRoute: 'auth'
};

// Runtime Firebase state
let myUID = null;
let currentGameRef = null;
let gameListener = null;
let imagesListenerRef = null;
let avatarsListenerRef = null;
let isFirebaseConnected = false;
let isSyncingFromFirebase = false;

/* ==================================
   Global window functions
   ================================== */
window.t = (lv, en) => { return (db && db.lang === 'en') ? en : lv; };

window.setLang = (l) => {
    if (db.lang === l) return;
    db.lang = l;
    saveDB();
    updateSharedUI();
    if (typeof currentRoute !== 'undefined') navigate(currentRoute);
};

window.toggleDarkMode = () => {
    db.darkMode = !db.darkMode;
    document.body.classList.toggle('dark-mode', db.darkMode);
    saveDB();
};

window.saveProfileSettings = () => {
    const fn = document.getElementById('profNameInput').value.trim();
    const em = document.getElementById('profEmailInput').value.trim();
    if (fn) db.auth.username = fn;
    if (em) db.auth.email = em;
    saveDB();
    alert(t('Profila dati saglabāti!', 'Profile settings saved!'));
    renderProfile(document.getElementById('app-content'));
};

window.showReconnectionQR = () => {
    if (!db.linkCode) return;
    const baseUrl = window.location.origin + window.location.pathname;
    const joinUrl = baseUrl + '?join=' + db.linkCode;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(joinUrl)}&color=1d1d1f&bgcolor=ffffff`;

    const html = `
        <div style="text-align:center; padding:10px;">
            <h3 style="margin-bottom:1.5rem;">${t('Savienošanās kods', 'Connection Code')}</h3>
            <h2 class="number-font" style="letter-spacing:5px; font-size:2.5rem; color:var(--text-main); margin-bottom:1rem;">${db.linkCode}</h2>
            <div style="background:white; padding:15px; border-radius:16px; display:inline-block; box-shadow:0 4px 15px rgba(0,0,0,0.05); margin-bottom:1.5rem;">
                <img src="${qrUrl}" alt="QR" style="width:200px; height:200px; border-radius:10px;">
            </div>
            <p style="font-size:0.9rem; color:var(--text-muted); line-height:1.4;">${t('Lūdz partnerim noskenēt šo kodu savā tālrunī.', 'Ask partner to scan this code on their phone.')}</p>
            <button class="btn-primary" style="margin-top:2rem;" onclick="closeOverlays()">${t('Aizvērt', 'Close')}</button>
        </div>
    `;
    showOverlay(html);
};

window.logout = async () => {
    showLoading(t("Izrakstās...", "Logging out..."));
    try {
        // Attempt sign out but don't block on it
        await firebaseAuth.signOut();
    } catch (err) {}
    
    localStorage.removeItem(STORE_KEY);
    // Force a clean state before reload
    db = { lang: db.lang || 'lv', photos: [], coupons: [], history: [], goals: [], magnets: [], auth: { uid: null } };
    localStorage.setItem('forceAuth', 'true');
    setTimeout(() => location.reload(), 300);
};

function updateSharedUI() {
    const lvBtn = document.getElementById('lang-lv');
    const enBtn = document.getElementById('lang-en');
    if (lvBtn) lvBtn.style.color = db.lang === 'lv' ? 'var(--text-main)' : 'var(--text-muted)';
    if (enBtn) enBtn.style.color = db.lang === 'en' ? 'var(--text-main)' : 'var(--text-muted)';
    // REMOVED navigate(currentRoute) to prevent infinite loop
}

/* ==================================
   Firebase Auth System (Production Ready)
   ================================== */
function initFirebaseAuth() {
    const loadingText = document.getElementById('loading-text');
    if (loadingText) loadingText.innerText = t("Sagatavo sesiju...", "Preparing session...");

    // 1. Set explicit local persistence for PWA stability
    firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
        .then(() => {
            console.log("📍 Persistence set to LOCAL");
        })
        .catch((error) => console.error("❌ Persistence Error:", error));

    // 2. Main Auth Listener
    firebaseAuth.onAuthStateChanged(async (user) => {
        if (user) {
            myUID = user.uid;
            db.auth.uid = myUID;
            console.log("🔑 Authenticated as:", myUID);

            // Fetch or Initialize User Profile
            await syncUserProfile();
            
            // Re-route if we are on auth page
            if (currentRoute === 'auth') {
                handlePostLogin();
            }
        } else {
            // Check if user intentionally logged out
            if (localStorage.getItem('forceAuth') === 'true') {
                console.log("📍 User logged out intentionally, redirecting to Auth.");
                localStorage.removeItem('forceAuth');
                navigate('auth');
                return;
            }

            // Automatic Anonymous Sign-in for consistent UID on startup
            console.log("📍 Signing in anonymously...");
            try {
                await firebaseAuth.signInAnonymously();
            } catch (err) {
                console.error("❌ Anonymous Auth failed:", err);
                navigate('auth');
            }
        }
    });
}

async function syncUserProfile() {
    try {
        const snapshot = await firebaseDB.ref(`users/${myUID}`).once('value');
        const userData = snapshot.val() || {};
        
        // Merge Firebase data into local state
        db.auth.username = userData.profile?.name || db.auth.username || 'Lietotājs';
        db.auth.email = userData.profile?.email || firebaseAuth.currentUser.email || '';
        db.auth.avatar = userData.profile?.avatar || null;
        db.auth.gameId = userData.session?.gameId || null;
        db.auth.role = userData.session?.role || null;
        db.auth.connected = userData.session?.connected || false;
        db.auth.onboardingFinished = userData.session?.onboardingFinished || false;

        // Session Validation: Verify gameId still exists
        if (db.auth.gameId) {
            const gameSnap = await firebaseDB.ref(`games/${db.auth.gameId}/metadata`).once('value');
            if (!gameSnap.exists()) {
                console.warn("⚠️ Session no longer valid. Cleaning up...");
                db.auth.gameId = null;
                db.auth.connected = false;
                await firebaseDB.ref(`users/${myUID}/session`).update({ gameId: null, connected: false });
            } else {
                attachGameListener(db.auth.gameId);
            }
        }

        // If it's a new user, initialize their profile in Firebase
        if (!snapshot.exists()) {
            await firebaseDB.ref(`users/${myUID}/profile`).set({
                name: db.auth.username,
                email: db.auth.email,
                createdAt: firebase.database.ServerValue.TIMESTAMP
            });
        }
        
        saveDBLocal();
    } catch (err) {
        console.error("❌ Profile Sync Error:", err);
    }
}

/* ==================================
   Firebase Connection Monitor
   ================================== */
function monitorFirebaseConnection() {
    const connectedRef = firebaseDB.ref('.info/connected');
    connectedRef.on('value', (snap) => {
        isFirebaseConnected = snap.val() === true;
        // Only show green if we're also authenticated and have an active session
        updateConnectionStatus(isFirebaseConnected && !!myUID && !!db.auth.gameId);
    });
}

window.updateConnectionStatus = (isOnline) => {
    const statusPin = document.getElementById('connection-status-dot');
    if (statusPin) {
        statusPin.style.background = isOnline ? '#69db7c' : '#ff6b6b';
        statusPin.title = isOnline ? t('Firebase savienots', 'Firebase connected') : t('Atvienots', 'Disconnected');
        statusPin.classList.toggle('pulse', isOnline);
    }
};

/* ==================================
   Firebase Game Session Management
   ================================== */

/* ==================================
   Firebase Storage Helper
   ================================== */
async function uploadImage(dataUrl, path) {
    try {
        const ref = firebaseStorage.ref(path);
        
        // Convert to Blob for better mobile stability
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        
        console.log("📤 Starting upload to:", path, "| Size:", blob.size);
        
        const snapshot = await ref.put(blob, {
            contentType: 'image/jpeg'
        });
        
        const downloadURL = await snapshot.ref.getDownloadURL();
        console.log("✅ Upload successful:", downloadURL);
        return downloadURL;
    } catch (error) {
        console.error("❌ Storage Upload Error:", error);
        // Provide more context for debugging
        if (error.code === 'storage/unauthorized') {
            alert("Kļūda: Nav atļaujas augšupielādēt. Pārbaudiet Firebase Storage Rules.");
        }
        throw error;
    }
}

// Create a new game session in Firebase
window.generateCode = async () => {
    console.log("🎲 generateCode starting... myUID:", myUID);
    if (!myUID && db.auth.uid) myUID = db.auth.uid;
    
    if (!myUID) {
        console.warn("⚠️ No UID found, attempting to wait for auth...");
        alert(t("Lūdzu uzgaidiet — notiek autentifikācija.", "Please wait — authenticating."));
        return;
    }

    showLoading(t("Ģenerē kodu...", "Generating code..."));

    try {
        const gameId = firebaseDB.ref('games').push().key;
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const now = Date.now();
        const expiresAt = now + (10 * 60 * 1000); // 10 minutes TTL

        const gameData = {
            metadata: {
                hostUid: myUID,
                status: 'waiting',
                createdAt: firebase.database.ServerValue.TIMESTAMP,
                relationship_start: new Date().toISOString()
            },
            shared: {
                points: 0,
                history: {},
                coupons: {},
                goals: {}
            }
        };

        const updates = {};
        updates[`games/${gameId}`] = gameData;
        updates[`codes/${code}`] = {
            gameId: gameId,
            expiresAt: expiresAt,
            hostUid: myUID
        };
        updates[`users/${myUID}/session`] = {
            gameId: gameId,
            role: 'host',
            onboardingFinished: false,
            connected: false
        };

        await firebaseDB.ref().update(updates);
        
        db.auth.gameId = gameId;
        db.auth.role = 'host';
        saveDBLocal();
        
        attachGameListener(gameId);
        renderOnboarding(document.getElementById('app-content'));
        console.log("✅ Game created with code:", code, "Expires at:", new Date(expiresAt).toLocaleTimeString());
    } catch (err) {
        console.error("❌ Game creation error:", err);
        alert(t("Kļūda veidojot sesiju!", "Error creating session!"));
    } finally {
        hideLoading();
    }
};

// Join an existing game session
window.joinCouple = async () => {
    const input = document.getElementById('joinCodeInput')?.value.trim();
    if (!input || input.length !== 6) {
        alert(t("Ievadi 6 ciparu kodu.", "Enter 6 digit code."));
        return;
    }

    if (!myUID) return;

    showLoading(t("Savienojas...", "Connecting..."));

    try {
        // 1. Resolve Code to GameID
        const codeSnap = await firebaseDB.ref(`codes/${input}`).once('value');
        if (!codeSnap.exists()) {
            alert(t("Kods nav atrasts vai ir beidzies tā derīguma termiņš!", "Code not found or expired!"));
            hideLoading();
            return;
        }
        
        const codeData = codeSnap.val();
        if (Date.now() > codeData.expiresAt) {
            alert(t("Koda derīguma termiņš ir beidzies!", "Code has expired!"));
            await firebaseDB.ref(`codes/${input}`).remove();
            hideLoading();
            return;
        }

        const gameId = codeData.gameId;

        // 2. Verify Game Session
        const gameSnap = await firebaseDB.ref(`games/${gameId}`).once('value');
        if (!gameSnap.exists()) {
            alert(t("Sesija vairs nav pieejama!", "Session no longer available!"));
            hideLoading();
            return;
        }

        const gameData = gameSnap.val();
        if (gameData.metadata.clientUid && gameData.metadata.clientUid !== myUID) {
            alert(t("Šī sesija jau ir aizņemta!", "This session is already full!"));
            hideLoading();
            return;
        }

        // 3. Update Session & User
        const updates = {};
        updates[`games/${gameId}/metadata/clientUid`] = myUID;
        updates[`games/${gameId}/metadata/status`] = 'active';
        updates[`games/${gameId}/metadata/connected`] = true;
        updates[`users/${myUID}/session`] = {
            gameId: gameId,
            role: 'client',
            onboardingFinished: true,
            connected: true
        };
        // Also update host's session status in user node
        updates[`users/${gameData.metadata.hostUid}/session/connected`] = true;
        updates[`users/${gameData.metadata.hostUid}/session/onboardingFinished`] = true;

        await firebaseDB.ref().update(updates);

        // 4. Cleanup Code (optional, but good for security/reuse)
        await firebaseDB.ref(`codes/${input}`).remove();

        db.auth.gameId = gameId;
        db.auth.role = 'client';
        db.auth.connected = true;
        db.auth.onboardingFinished = true;
        saveDBLocal();

        attachGameListener(gameId);
        navigate('timeline');
        console.log("✅ Joined game successfully");
    } catch (err) {
        console.error("❌ Join error:", err);
        alert(t("Kļūda pievienojoties!", "Error joining!"));
    } finally {
        hideLoading();
    }
};

window.autoJoin = (input) => {
    if (document.getElementById('joinCodeInput')) {
        document.getElementById('joinCodeInput').value = input;
        window.joinCouple();
    }
};

/* ==================================
   Firebase Real-time Listener (Production)
   ================================== */
function attachGameListener(gameId) {
    if (!gameId) return;

    // 1. Detach ALL previous listeners
    if (currentGameRef) {
        currentGameRef.off();
        firebaseDB.ref(`games/${currentGameRef.key}/photos`).off();
        console.log("🧹 Listeners detached for:", currentGameRef.key);
    }

    currentGameRef = firebaseDB.ref(`games/${gameId}`);

    // A. Metadata & Status Listener
    currentGameRef.child('metadata').on('value', (snap) => {
        const meta = snap.val();
        if (!meta) return;

        db.auth.connected = meta.status === 'active';
        db.relationship_start = meta.relationship_start;
        saveDBLocal();
        updateConnectionStatus(isFirebaseConnected && !!myUID);
        updateHeader();
    });

    // B. Shared Data Listener (Points, History, Coupons, Goals)
    currentGameRef.child('shared').on('value', (snapshot) => {
        if (!snapshot.exists()) return;
        const sharedData = snapshot.val();
        console.log("📥 Shared data sync received");

        isSyncingFromFirebase = true;
        mergeFirebaseData(sharedData);
        isSyncingFromFirebase = false;

        // Re-render current view to show fresh data
        const mainContent = document.getElementById('app-content');
        if (mainContent && routes[currentRoute]) {
            routes[currentRoute](mainContent);
        }
        updateHeader();
    });

    // C. Atomic Photos Listener
    const photosRef = firebaseDB.ref(`games/${gameId}/photos`);
    photosRef.on('child_added', (snapshot) => {
        const p = snapshot.val();
        if (!p) return;
        
        const exists = (db.photos || []).some(item => item.id === p.id);
        if (!exists) {
            db.photos.unshift(p);
            db.photos.sort((a, b) => b.id - a.id);
            saveDBLocal();
            if (currentRoute === 'photos') appendPhotoToUI(p);
        }
    });

    photosRef.on('child_removed', (snapshot) => {
        const p = snapshot.val();
        db.photos = db.photos.filter(x => x.id !== p.id);
        saveDBLocal();
        if (currentRoute === 'photos') navigate('photos');
    });
}

function mergeFirebaseData(remoteData) {
    // Merge shared fields from Firebase into local cache
    if (remoteData.coupons) {
        db.coupons = Object.values(remoteData.coupons).sort((a, b) => b.id - a.id);
    }
    if (remoteData.history) {
        db.history = Object.values(remoteData.history).sort((a, b) => b.id - a.id);
    }
    if (remoteData.goals) {
        db.goals = Object.values(remoteData.goals);
    }
    if (remoteData.magnets) {
        db.magnets = Object.values(remoteData.magnets);
    }
    
    if (remoteData.points !== undefined) {
        db.points = remoteData.points;
    }

    saveDBLocal();
}

/* ==================================
   Build Shared Data for Firebase
   ================================== */
function buildSharedData() {
    const data = {
        coupons: db.coupons || [],
        history: db.history || [],
        goals: db.goals || [],
        magnets: db.magnets || [],
        // NEW: Shared photos are handled atomically via /state/images, NOT here.
        relationship_start: db.relationship_start,
        points: db.points || 0,
        icebreakerData: {
            player1Answer: db.auth.peerRole === 'host' ? (db.auth.myIcebreaker || null) : null,
            player2Answer: db.auth.peerRole === 'client' ? (db.auth.myIcebreaker || null) : null,
            icebreakerDone: db.auth.icebreakerDone || false,
            icebreakerFailed: db.auth.icebreakerFailed || false,
            penaltyDone: db.auth.penaltyDone || false
        }
    };

    // Add username for partner identification
    if (db.auth.peerRole === 'host') {
        data.hostUsername = db.auth.username || '';
    } else {
        data.partnerUsername = db.auth.username || '';
    }

    return data;
}

/* ==================================
   Save DB — Local + Firebase (Production)
   ================================== */
function saveDBLocal() {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    updateHeader();
    updateConnectionStatus(isFirebaseConnected && !!myUID && !!db.auth.gameId);
}

function saveDB() {
    saveDBLocal();

    // Push to Firebase if we have an active game and aren't processing incoming data
    if (db.auth.gameId && myUID && !isSyncingFromFirebase) {
        const shared = {
            points: db.points || 0,
            coupons: {},
            history: {},
            goals: {},
            magnets: {}
        };
        
        // Convert arrays to objects for Firebase atomic compatibility
        (db.coupons || []).forEach(c => shared.coupons[c.id] = c);
        (db.history || []).forEach(h => shared.history[h.id] = h);
        (db.goals || []).forEach(g => shared.goals[g.id] = g);
        (db.magnets || []).forEach(m => shared.magnets[m.id] = m);

        firebaseDB.ref(`games/${db.auth.gameId}/shared`).update(shared)
            .then(() => console.log("📤 Firebase shared data sync sent"))
            .catch((err) => console.error("❌ Firebase write error:", err));
    }
}

function loadDB() {
    try {
        const saved = localStorage.getItem(STORE_KEY);
        if (saved) {
            db = { ...db, ...JSON.parse(saved) };
            if (db.darkMode) document.body.classList.add('dark-mode');
            if (db.currentRoute) currentRoute = db.currentRoute;
            if (!db.auth) db.auth = { linked: false, email: '' };

            // Self-Healing Session
            if (db.linkCode && !db.auth.linked) {
                db.auth.linked = true;
            }
        }
    } catch (e) {
        console.error("loadDB error:", e);
    }

    // Always init Firebase auth (this will reconnect to game if linkCode exists)
    initFirebaseAuth();
    monitorFirebaseConnection();
}

/* ==================================
   Toast Notification System
   ================================== */
function showToast(title, message, type = 'info', route = null, duration = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
        'task': '<i class="fa-solid fa-list-check"></i>',
        'success': '<i class="fa-solid fa-circle-check"></i>',
        'warning': '<i class="fa-solid fa-triangle-exclamation"></i>',
        'info': '<i class="fa-solid fa-bell"></i>',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || icons.info}</div>
        <div class="toast-body">
            <div class="toast-title">${title}</div>
            ${message ? `<div class="toast-msg">${message}</div>` : ''}
        </div>
        <div style="opacity:0.6; font-size:0.8rem; align-self:flex-start; margin-top:2px;"><i class="fa-solid fa-xmark"></i></div>
    `;

    const dismiss = () => {
        toast.classList.add('dismissing');
        setTimeout(() => toast.remove(), 300);
    };

    toast.addEventListener('click', () => {
        dismiss();
        if (route) navigate(route);
    });

    container.appendChild(toast);
    setTimeout(dismiss, duration);
}

/* ==================================
   Router & App Shell Core
   ================================== */
const routes = {
    'auth': renderAuth,
    'timeline': renderTimeline,
    'coupons': renderCoupons,
    'photos': renderPhotos,
    'rewards': renderRewards,
    'profile': renderProfile,
    'onboarding': renderOnboarding
};

let currentRoute = 'timeline';

function navigate(route, addToHistory = true) {
    if (route === 'auth' || !db.auth || !db.auth.uid) {
        document.getElementById('auth-guard').classList.remove('hidden');
        document.getElementById('main-shell').classList.add('hidden');
        renderAuth(document.getElementById('auth-guard'));
        currentRoute = 'auth';
        return;
    }

    if (db.auth && route !== 'onboarding' && route !== 'timeline') {
        const isLinked = db.auth.linked || !!db.linkCode || db.auth.connected;
        const onboardingFinished = db.auth.onboardingFinished || false;

        // Redirect to onboarding ONLY if user hasn't finished it AND isn't connected
        if (!isLinked && !onboardingFinished) {
            route = 'onboarding';
        }
    }

    // Ensure main shell is visible if we have auth and not on auth page
    document.getElementById('auth-guard').classList.add('hidden');
    document.getElementById('main-shell').classList.remove('hidden');

    currentRoute = route;
    if (db) db.currentRoute = route;
    saveDBLocal(); // silent save
    document.getElementById('auth-guard').classList.add('hidden');

    // Handle Browser History for mobile back button
    if (addToHistory) {
        history.pushState({ route: route }, "", "");
    }

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
    window.scrollTo(0, 0); // Scroll to top on navigation
}

// Handle browser Back button
window.onpopstate = (event) => {
    if (event.state && event.state.route) {
        navigate(event.state.route, false);
    } else {
        navigate('timeline', false);
    }
};

function updateHeader() {
    const ptEl = document.getElementById('user-points');
    if (ptEl) ptEl.textContent = db.points;
    
    const kidsToggle = document.getElementById('kids-mode-toggle');
    const kidsKnob = document.getElementById('kids-mode-knob');
    const kidsIcon = document.getElementById('kids-mode-icon');
    
    if (kidsToggle && kidsKnob && kidsIcon) {
        if (db && db.kidsMode) {
            kidsToggle.style.background = '#34C759'; // Green when ON
            kidsKnob.style.transform = 'translateX(22px)';
            kidsIcon.style.color = '#34C759';
        } else {
            kidsToggle.style.background = '#FF3B30'; // Red when OFF
            kidsKnob.style.transform = 'translateX(0px)';
            kidsIcon.style.color = '#FF3B30';
        }
    }
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

            <div class="marquee-container animate-fade-in" style="animation-delay: 0.1s;">
                <div class="marquee-content">
                    <span>${t('Krāj punktus — veido atmiņas', 'Collect points — create memories')}</span>
                    <span>${t('Krāj punktus — veido atmiņas', 'Collect points — create memories')}</span>
                    <span>${t('Krāj punktus — veido atmiņas', 'Collect points — create memories')}</span>
                    <span>${t('Krāj punktus — veido atmiņas', 'Collect points — create memories')}</span>
                    <span>${t('Krāj punktus — veido atmiņas', 'Collect points — create memories')}</span>
                    <span>${t('Krāj punktus — veido atmiņas', 'Collect points — create memories')}</span>
                </div>
            </div>
            <p class="auth-subtitle animate-fade-in" style="animation-delay: 0.2s;">${t('Vēl viens iemesls radīt atmiņas, nevis plānus.', 'Another reason to create memories, not plans.')}</p>

            <div class="auth-form">
                <div class="auth-tabs animate-fade-in" style="animation-delay: 0.3s;">
                    <button class="auth-tab ${isLogin ? 'active' : ''}" onclick="toggleAuthMode('login')">${t('Pieslēgties', 'Login')}</button>
                    <button class="auth-tab ${!isLogin ? 'active' : ''}" onclick="toggleAuthMode('register')">${t('Reģistrēties', 'Register')}</button>
                </div>

                ${formHtml}

                <div class="auth-divider"><span>${t('vai turpināt ar', 'or continue with')}</span></div>
                
                <div class="social-login-grid">
                    <button class="btn-social" onclick="continueWithGoogle()">
                        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google"> Google
                    </button>
                    <button class="btn-social" onclick="continueWithApple()">
                        <i class="fa-brands fa-apple"></i> Apple
                    </button>
                </div>
            </div>

            <div style="flex:1;"></div>
        </div>
    `;
}

window.login = async () => {
    const isLogin = window.authMode === 'login';
    const email = document.getElementById('auth-email').value.trim();
    const pass = document.getElementById('auth-pass').value.trim();
    
    if (!email || !pass) {
        alert(t("Lūdzu ievadiet e-pastu un paroli!", "Please enter email and password!"));
        return;
    }

    showLoading(isLogin ? t("Pieslēdzas...", "Logging in...") : t("Veido profilu...", "Creating profile..."));

    try {
        const currentUser = firebaseAuth.currentUser;

        if (isLogin) {
            // Standard sign in
            await firebaseAuth.signInWithEmailAndPassword(email, pass);
        } else {
            // Registration with account linking to preserve Anonymous UID
            const username = document.getElementById('auth-user').value.trim() || 'Lietotājs';
            const credential = firebase.auth.EmailAuthProvider.credential(email, pass);

            const actionCodeSettings = {
                url: window.location.origin + window.location.pathname,
                handleCodeInApp: true,
            };

            if (currentUser && currentUser.isAnonymous) {
                await currentUser.linkWithCredential(credential);
                await currentUser.sendEmailVerification(actionCodeSettings);
                console.log("✅ Anonymous account linked to email and verification sent");
            } else {
                const userCredential = await firebaseAuth.createUserWithEmailAndPassword(email, pass);
                await userCredential.user.sendEmailVerification(actionCodeSettings);
                console.log("✅ New permanent account created and verification email sent");
            }
            
            // Set initial profile
            await firebaseDB.ref(`users/${firebaseAuth.currentUser.uid}/profile`).update({
                name: username,
                email: email,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });
            db.auth.username = username;
        }
        console.log("✅ Auth successful");
    } catch (error) {
        console.error("❌ Auth Error:", error);
        let msg = error.message;
        if (error.code === 'auth/credential-already-in-use') msg = t("Šis e-pasts jau ir piesaistīts citam kontam!", "This email is already linked to another account!");
        if (error.code === 'auth/email-already-in-use') msg = t("Šāds e-pasts jau tiek izmantots!", "Email already in use!");
        alert(msg);
    } finally {
        hideLoading();
    }
};

window.loginAnonymously = async () => {
    showLoading(t("Sagatavo sesiju...", "Preparing session..."));
    try {
        await firebaseAuth.signInAnonymously();
    } catch (error) {
        console.error("❌ Anonymous Auth Error:", error);
        alert(t("Kļūda pieslēdzoties anonīmi!", "Error signing in anonymously!"));
    } finally {
        hideLoading();
    }
};

window.continueWithGoogle = () => {
    if (typeof showLoading === 'function') showLoading(t("Savienojas ar Google...", "Connecting with Google..."));
    firebaseAuth.signInWithPopup(googleProvider)
        .then((result) => {
            const user = result.user;
            setupSocialUser(user);
        }).catch((error) => {
            if (typeof hideLoading === 'function') hideLoading();
            console.error("Google Auth Error:", error);
            if (error.code === 'auth/unauthorized-domain') {
                alert(t(`Kļūda: Šis domēns nav autorizēts Firebase konsolē. Lūdzu, pievienojiet ${window.location.hostname} pie "Authorized Domains"!`, `Error: This domain is not authorized in Firebase Console. Please add ${window.location.hostname} to "Authorized Domains"!`));
            } else if (error.code !== 'auth/popup-closed-by-user') {
                alert("Google Auth Error: " + error.message);
            }
        });
};

window.continueWithApple = () => {
    if (typeof showLoading === 'function') showLoading(t("Savienojas ar Apple...", "Connecting with Apple..."));
    firebaseAuth.signInWithPopup(appleProvider)
        .then((result) => {
            const user = result.user;
            setupSocialUser(user);
        }).catch((error) => {
            if (typeof hideLoading === 'function') hideLoading();
            console.error("Apple Auth Error:", error);
            if (error.code === 'auth/unauthorized-domain') {
                alert(t(`Kļūda: Šis domēns nav autorizēts Firebase konsolē. Lūdzu, pievienojiet ${window.location.hostname} pie "Authorized Domains"!`, `Error: This domain is not authorized in Firebase Console. Please add ${window.location.hostname} to "Authorized Domains"!`));
            } else if (error.code !== 'auth/popup-closed-by-user') {
                alert("Apple Auth Error: " + error.message);
            }
        });
};

window.showReconnectionQR = () => {
    if (!db.linkCode) return;
    const baseUrl = window.location.origin + window.location.pathname;
    const joinUrl = baseUrl + '?join=' + db.linkCode;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(joinUrl)}&color=1d1d1f&bgcolor=ffffff`;

    const html = `
        <h2 class="modal-title">${t('Tavs QR Kods', 'Your QR Code')}</h2>
        <div class="text-center">
            <p style="margin-bottom:1.5rem; color:var(--text-muted);">${t('Lūdz partnerim noskenēt šo kodu, lai savienotos.', 'Ask partner to scan this code to link.')}</p>
            <div style="background:white; padding:20px; border-radius:24px; display:inline-block; box-shadow:0 10px 30px rgba(0,0,0,0.1); margin-bottom:2rem;">
                <img src="${qrUrl}" alt="QR Kods" style="width: 220px; height: 220px; border-radius:12px;">
            </div>
            <h1 class="number-font" style="letter-spacing:8px; font-size:3rem; margin-bottom:1rem;">${db.linkCode}</h1>
            <p style="font-size:0.85rem; opacity:0.6;">${t('Kods: ', 'Code: ')} ${db.linkCode}</p>
        </div>
    `;
    showOverlay(html);
};

async function setupSocialUser(user) {
    let name = user.displayName;
    if (!name && user.email) {
        name = user.email.split('@')[0];
    }
    if (!name) name = t('Lietotājs', 'User');

    // Update profile in Firebase if missing
    const snap = await firebaseDB.ref(`users/${user.uid}/profile`).once('value');
    if (!snap.exists()) {
        await firebaseDB.ref(`users/${user.uid}/profile`).set({
            name: name,
            email: user.email || '',
            avatar: user.photoURL || null,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        });
    }

    // syncUserProfile() will be called by onAuthStateChanged
}

function handlePostLogin() {
    let target = 'timeline';
    // Logic: if not connected and haven't finished onboarding, show onboarding
    if (db.auth && !db.auth.connected && !db.auth.onboardingFinished) {
        target = 'onboarding';
    }

    currentRoute = target;
    updateSharedUI();
    
    if (typeof checkQRMagnet === 'function') checkQRMagnet();
    const pendingJoin = localStorage.getItem('pendingJoin');
    if (pendingJoin) {
        localStorage.removeItem('pendingJoin');
        window.autoJoin(pendingJoin);
        return;
    }
    navigate(target);
}

// 2. Profile & Link View
function renderProfile(container) {
    if (!db || !db.auth) return;

    let linkStatusHtml = '';
    if (db.auth.linked) {
        linkStatusHtml = `
           <div class="glass-panel text-center" style="background: rgba(105, 219, 124, 0.1); border-color: #69db7c; margin-bottom: 2rem;">
               <i class="fa-solid fa-check-circle" style="color: #69db7c; font-size: 2.5rem; margin-bottom: 1rem;"></i>
               <h3>${t('Jūs esat savienoti!', 'You are connected!')}</h3>
               <p style="margin-top: 0.5rem; font-size: 0.95rem; color: var(--text-main); font-weight: 500;">
                   ${t('Jūs lieliski sadarbojaties ar savu partneri!', 'You are working great with your partner!')}
               </p>
           </div>
        `;
    } else {
        // Pairing UI for unlinked users (Onboarding style)
        linkStatusHtml = `
           <div class="glass-panel text-center" style="margin-bottom: 2rem; border: 2px dashed var(--color-accent);">
               <h3 style="margin-bottom: 1rem; color: var(--color-accent);"><i class="fa-solid fa-link"></i> ${t('Savieno ar Partneri', 'Connect Partner')}</h3>
               <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 1.5rem; line-height: 1.4;">
                   ${t('Lai pilnvērtīgi izmantotu lietotni, uzaicini partneri vai pievienojies viņa izveidotajai spēlei.', 'To use the app fully, invite your partner or join their game.')}
               </p>
               
               ${db.linkCode ? `
                   <div style="background: var(--bg-primary); border: 1px solid var(--glass-border); padding: 15px; border-radius: 16px; margin-bottom: 1.5rem;">
                       <p style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">${t('Tavs Kods', 'Your Code')}</p>
                       <h2 class="number-font" style="letter-spacing: 5px; font-size: 2.5rem; margin: 10px 0;">${db.linkCode}</h2>
                       <button class="btn-primary" style="width: auto; padding: 10px 20px; font-size: 0.9rem;" onclick="showReconnectionQR()">
                           <i class="fa-solid fa-qrcode"></i> ${t('Rādīt QR Kodu', 'Show QR Code')}
                       </button>
                   </div>
               ` : `
                   <button class="btn-primary" style="margin-bottom: 1.5rem;" onclick="generateCode()">
                       <i class="fa-solid fa-qrcode"></i> ${t('Ģenerēt uzaicinājuma kodu', 'Generate Invite Code')}
                   </button>
               `}

               <hr style="opacity: 0.1; margin: 1.5rem 0;">

               <h4 style="margin-bottom: 1rem;">${t('Pievienoties Partnerim', 'Join Partner')}</h4>
               <input type="text" id="joinCodeInput" class="input-field text-center number-font" placeholder="123456" maxlength="6" style="margin-bottom: 1rem; letter-spacing: 5px;">
               <button id="joinPartnerBtn" class="btn-primary" onclick="joinCouple()"><i class="fa-solid fa-link"></i> ${t('Pievienoties', 'Connect')}</button>
               <button class="btn-secondary" style="margin-top: 10px;" onclick="startQRScanner()"><i class="fa-solid fa-qrcode"></i> ${t('Skenēt QR', 'Scan QR')}</button>
               <p id="joinStatus" style="margin-top: 1rem; font-weight: 600; color: #ff3b30;"></p>
           </div>
        `;
    }

    const firebaseStatus = isFirebaseConnected && myUID;

    container.innerHTML = `
           <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem; padding-top: 0.5rem;">
               <div onclick="navigate('timeline')" style="cursor:pointer; font-size:1.3rem; color:var(--text-main); width: 32px;"><i class="fa-solid fa-arrow-left"></i></div>
               <h2 class="view-title" style="margin-bottom:0; font-size:1.4rem; color:var(--text-main); font-weight:800;">${t('Mans Profils', 'My Profile')}</h2>
               <div style="width: 32px;"></div>
           </div>

           ${linkStatusHtml}

           <div class="glass-panel" style="margin-bottom: 2rem;">
               <h3 style="margin-bottom: 1rem;">${t('Profila iestatījumi', 'Profile Settings')}</h3>
               
               <div class="input-group">
                   <label class="input-label">${t('Lietotājvārds', 'Username')}</label>
                   <input type="text" id="profNameInput" class="input-field" value="${db.auth.username || ''}">
               </div>

               <div class="input-group">
                   <label class="input-label">${t('E-pasts', 'Email')}</label>
                   <input type="email" id="profEmailInput" class="input-field" value="${db.auth.email || ''}">
               </div>

               <button id="saveProfileBtn" class="btn-primary" style="margin-top: 1rem;" onclick="saveProfileSettings()">${t('Saglabāt izmaiņas', 'Save Changes')}</button>
           </div>

           <div class="glass-panel" style="margin-bottom: 2rem; border-left: 5px solid ${firebaseStatus ? '#69db7c' : '#ff3b30'};">
               <div style="display: flex; justify-content: space-between; align-items: center;">
                   <div>
                       <h4 style="margin: 0; font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase;">${t('Sistēmas Statuss', 'System Status')}</h4>
                       <p style="margin: 5px 0 0 0; font-weight: 700; color: ${firebaseStatus ? '#69db7c' : '#ff3b30'};">
                           ${firebaseStatus ? t('Firebase Savienots', 'Firebase Connected') : t('Firebase Atvienots', 'Firebase Disconnected')}
                       </p>
                   </div>
                   <div style="width: 12px; height: 12px; border-radius: 50%; background: ${firebaseStatus ? '#69db7c' : '#ff3b30'}; box-shadow: 0 0 10px ${firebaseStatus ? 'rgba(105, 219, 124, 0.4)' : 'rgba(255, 59, 48, 0.4)'};"></div>
               </div>
           </div>

           <div class="glass-panel text-center" style="margin-bottom: 3rem;">
               <h3 style="margin-bottom: 1rem;">${t('Fiziskais Ietvars', 'Physical Frame')}</h3>
               <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.5rem;">${t('Aktivizē savu "Framed Date" rāmi šeit.', 'Activate your "Framed Date" frame here.')}</p>
               <input type="text" id="frameIdInput" class="input-field text-center" placeholder="FD-0001" style="margin-bottom: 1rem;">
               <button class="btn-primary" onclick="activateFrame()">${t('Aktivizēt', 'Activate')}</button>
               <p id="statusMessage" style="margin-top:1rem; font-weight:500;"></p>
               <p id="bonusPointsLabel" class="text-gold" style="margin-top:0.5rem; font-weight:700; font-size:1.1rem;"></p>
           </div>

           <div class="glass-panel" style="margin-bottom: 2rem;">
                <h3 style="margin-bottom: 1rem;">${t('Informācija', 'Information')}</h3>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <a href="privacy.html" style="color: var(--text-muted); text-decoration: none; font-size: 0.9rem; display: flex; justify-content: space-between; align-items: center;">
                        ${t('Privātuma Politika', 'Privacy Policy')} <i class="fa-solid fa-chevron-right" style="font-size: 0.7rem;"></i>
                    </a>
                    <div style="height: 1px; background: rgba(0,0,0,0.05);"></div>
                    <a href="terms.html" style="color: var(--text-muted); text-decoration: none; font-size: 0.9rem; display: flex; justify-content: space-between; align-items: center;">
                        ${t('Lietošanas Noteikumi', 'Terms of Service')} <i class="fa-solid fa-chevron-right" style="font-size: 0.7rem;"></i>
                    </a>
                </div>
            </div>

            <div class="glass-panel" style="margin-bottom: 2rem; padding: 0; overflow: hidden;">
                ${db.auth.gameId ? `
                <button style="width:100%; padding:16px 20px; background:none; border:none; border-bottom:0.5px solid var(--glass-border); color:#FF3B30; font-size:1rem; font-weight:600; font-family:inherit; cursor:pointer; text-align:center;" onclick="disconnectCouple()">
                    ${t('Atvienot Pāri', 'Disconnect Couple')}
                </button>` : ''}
                <button id="logoutBtn" style="width:100%; padding:16px 20px; background:none; border:none; border-bottom:0.5px solid var(--glass-border); color:#FF3B30; font-size:1rem; font-weight:600; font-family:inherit; cursor:pointer; text-align:center;" onclick="logout()">
                    ${t('Izrakstīties', 'Logout')}
                </button>
                <button style="width:100%; padding:16px 20px; background:none; border:none; color:#FF3B30; font-size:0.9rem; font-weight:600; font-family:inherit; cursor:pointer; text-align:center; opacity:0.7;" onclick="window.resetAppData()">
                    ${t('Dzēst datus un restartēt', 'Delete Data & Restart')}
                </button>
            </div>
    `;
}

window.activateFrame = async () => {
    const frameId = document.getElementById("frameIdInput").value.trim();
    const statusEl = document.getElementById("statusMessage");
    const bonusEl = document.getElementById("bonusPointsLabel");

    if (!frameId) return statusEl.innerText = "Ievadi Frame ID.";

    statusEl.innerText = "Aktivizēju...";
    statusEl.style.color = "inherit";

    await new Promise(r => setTimeout(r, 700));

    statusEl.innerText = "Rāmis aktivizēts! Bonuss pievienots.";
    statusEl.style.color = "#69db7c";
    bonusEl.innerText = "+20 punkti";

    db.auth.myPoints = (db.auth.myPoints || 0) + 20;
    db.auth.partnerPoints = (db.auth.partnerPoints || 0) + 20;
    db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `Rāmis ${frameId} aktivizēts`, points: 20 });
    saveDB();
};

window.resetAppData = () => {
    if (confirm(t('Dzēst visus datus? Jūsu konts un dati Firebase netiks dzēsti, bet šī sesija tiks pārtraukta.', 'Delete all data? Your Firebase account won\'t be deleted, but this session will be cleared.'))) {
        localStorage.clear();
        db = { lang: 'lv', photos: [], coupons: [], history: [], goals: [], magnets: [], auth: { uid: null } };
        localStorage.setItem('forceAuth', 'true');
        location.href = location.pathname; // Hard reload
    }
};

/* ==================================
   Onboarding (Cold Breaker) View
   ================================== */
function renderOnboarding(container) {
    if (!db || !db.auth) return;
    if (!db.auth.linked) {
        // Step 1: Connect Partner
        let linkStatus = `
           <div class="glass-panel text-center" style="margin-bottom:2rem;">
               <h3 style="margin-bottom: 1rem;">${t('Solis 1: Savieno Pāri', 'Step 1: Connect')}</h3>
               <p style="font-size:0.95rem; color:var(--text-muted); margin-bottom:1.5rem; line-height:1.4;">${t('Lai sāktu spēli, uzaicini partneri! Ģenerē kodu vai pievienojies.', 'To start playing, invite your partner! Generate a code or join.')}</p>
        `;
        if (db.linkCode) {
            const baseUrl = window.location.origin + window.location.pathname;
            const joinUrl = baseUrl + '?join=' + db.linkCode;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(joinUrl)}&color=1d1d1f&bgcolor=ffffff`;
            linkStatus += `
               <h2 class="number-font" style="margin-bottom:1rem; letter-spacing:5px; font-size:2.5rem; color:var(--text-main);">${db.linkCode}</h2>
               <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.8rem;">${t('Gaidām partneri...', 'Waiting for partner...')}</p>
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
               <button class="btn-secondary" style="margin-top:10px;" onclick="startQRScanner()"><i class="fa-solid fa-qrcode"></i> ${t('Noskanēt QR kodu', 'Scan QR Code')}</button>
               <p id="joinStatus" style="margin-top:1rem; font-weight:600; color:#ff3b30;"></p>
           </div>

           <div class="onboarding-actions" style="margin-top:2rem; display:flex; flex-direction:column; gap:12px;">
               <button class="btn-primary" onclick="finishOnboarding()">
                   <i class="fa-solid fa-arrow-right"></i> ${t('Turpināt vēlāk (Sākt spēli)', 'Continue Later (Start Game)')}
               </button>
               <p style="font-size:0.8rem; color:var(--text-muted); text-align:center;">${t('Varēsi savienoties vēlāk sava profila iestatījumos.', 'You can connect later in your profile settings.')}</p>
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
                   <h3 style="margin-bottom:1rem;">${t('Vai zini, cik ilgi esat attiecībās?', 'Do you know how long you\'ve been together?')}</h3>
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

                   <button class="btn-primary" style="font-size:1.1rem; padding:15px;" onclick="checkIcebreaker()">${t('Pārbaudīt Saderību', 'Check Match')}</button>
               </div>
            `;
        }
    }
    else if (db.auth.icebreakerFailed && !db.auth.penaltyDone) {
        // Step 3: Penalty
        container.innerHTML = `
           <h2 class="view-title animate-fade-in" style="color:#ff6b6b; text-align:center;">${t('Ups... Datumi nesakrita', 'Oops... Dates didn\'t match')} 💔</h2>
           <div class="glass-panel text-center animate-fade-in" style="animation-delay:0.1s;">
               <p style="font-size:1rem; color:var(--text-main); margin-bottom:1.5rem;">${t('Vieta izaugsmei! Starta rādītājs ir samazināts. Lai atjaunotu attiecību statusu, Jums kopīgi jāizpilda šis uzdevums:', 'Room for growth! To restore the health score, complete this joint task:')}</p>

                       <div style="background:rgba(255, 107, 107, 0.05); border:2px dashed #ff6b6b; border-radius:12px; padding:1.5rem; margin-bottom:2rem;">
                   <h3 style="color:#ff6b6b; margin-bottom:1rem;"><i class="fa-solid fa-eye"></i> ${t('Saldēšanas uzdevums', 'Icebreaker Task')}</h3>
                   <b style="font-size:1.15rem; color:var(--text-main); line-height:1.4;">${t('Skatieties viens otram tieši acīs 1 minūti nesakot nevienu vārdu un nesmejoties.', 'Look into each other\'s eyes for 1 minute without talking or laughing.')}</b>
               </div>

               <button class="btn-primary" style="font-size:1.1rem; padding:15px;" onclick="completePenalty()"><i class="fa-solid fa-check"></i> ${t('Mēs to izdarījām!', 'We did it!')}</button>
           </div>
        `;
    }
}

window.disconnectCouple = async () => {
    if (!confirm(t("Vai tiešām vēlaties atvienoties no partnera? Kopīgie dati netiks dzēsti, bet Jūs tos vairs neredzēsiet.", "Are you sure you want to disconnect? Shared data won't be deleted, but you will lose access."))) return;

    showLoading(t("Atvienojas...", "Disconnecting..."));
    try {
        const gameId = db.auth.gameId;
        const updates = {};
        
        // 1. Remove gameId from current user
        updates[`users/${myUID}/session/gameId`] = null;
        updates[`users/${myUID}/session/connected`] = false;
        updates[`users/${myUID}/session/role`] = null;

        // 2. Fetch partner and remove gameId from them too
        const gameSnap = await firebaseDB.ref(`games/${gameId}/metadata`).once('value');
        if (gameSnap.exists()) {
            const meta = gameSnap.val();
            const partnerUid = (meta.hostUid === myUID) ? meta.clientUid : meta.hostUid;
            if (partnerUid) {
                updates[`users/${partnerUid}/session/gameId`] = null;
                updates[`users/${partnerUid}/session/connected`] = false;
                updates[`users/${partnerUid}/session/role`] = null;
            }
            
            // 3. Mark game as inactive
            updates[`games/${gameId}/metadata/status`] = 'inactive';
        }

        await firebaseDB.ref().update(updates);
        
        db.auth.gameId = null;
        db.auth.connected = false;
        db.auth.role = null;
        saveDBLocal();
        
        location.reload();
    } catch (err) {
        console.error("❌ Disconnect Error:", err);
        alert(t("Kļūda atvienojoties!", "Error disconnecting!"));
    } finally {
        hideLoading();
    }
};

window.finishOnboarding = () => {
    if (!db.auth) return;
    db.auth.onboardingFinished = true;
    saveDBLocal();
    
    // Persist to Firebase so it survives across logins
    if (myUID) {
        firebaseDB.ref(`users/${myUID}/settings`).update({
            onboardingFinished: true
        });
    }
    
    navigate('timeline');
};

window.submitMyIcebreaker = () => {
    const mine = document.getElementById('ice-mine').value;
    if (!mine) return alert(t('Lūdzu ievadi datumu!', 'Please enter the date!'));

    db.auth.myIcebreaker = mine;
    saveDB(); // This pushes to Firebase

    renderOnboarding(document.getElementById('app-content'));
};

window.skipIcebreaker = () => {
    db.auth.icebreakerSkipped = true;
    saveDB();
    navigate('timeline');
};

window.checkIcebreaker = () => {
    const mine = db.auth.myIcebreaker;
    const partner = db.auth.partnerIcebreaker;

    if (!mine || !partner) {
        alert(t('Gaidām otru atbildi...', 'Waiting for second answer...'));
        return;
    }

    if (mine === partner) {
        db.relationship_start = mine;
        db.auth.myPoints = (db.auth.myPoints || 0) + 100;
        db.auth.partnerPoints = (db.auth.partnerPoints || 0) + 100;
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('ColdBreaker: Veiksmīgs datumu mačs!', 'ColdBreaker: Date Match!'), points: 100 });
        db.auth.icebreakerDone = true;
        saveDB();

        alert(t('Apsveicam! Jūsu datumi sakrīt! Esat nopelnījuši 100 punktus!', 'Congratulations! Dates match! You get 100 points!'));
        navigate('timeline');
    } else {
        db.relationship_start = mine;
        db.auth.icebreakerFailed = true;
        db.auth.myPoints = Math.max(0, (db.auth.myPoints || 0) - 20);
        db.auth.partnerPoints = Math.max(0, (db.auth.partnerPoints || 0) - 20);
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('ColdBreaker: Datumi nesakrita', 'ColdBreaker: Dates mismatched'), points: -20 });
        saveDB();
        navigate('onboarding');
    }
};

const MAGNET_CATALOG = {
    '1': { cost: 100, title: 'VIEGLA ATPŪTA', category: 'BĒRNĪBAS NAŠĶI', task: 'Dodieties uz veikalu, atsevišķi iegādājieties "5" našķus, ko bijāt iekārojuši savā bērnībā.\n(neļauj partnerim redzēt savas izvēles, noformējums pirms pasniegšanas ir obligāts)\nPavadot laiku pastāstiet par šiem našķiem, kādēļ Jums tie bērnībā tik ļoti garšoja.' },
    '2': { cost: 150, title: 'PIEDZĪVOJUMS', category: 'AKLAIS RANDIŅŠ', task: 'Viens no Jums izvēlas galamērķi (līdz 30km rādiusā), otram ir aizsietas acis līdz pat pēdējam brīdim.\nSagatavojiet mazu pikniku vai pārsteiguma aktivitāti šajā vietā.' },
    '3': { cost: 80, title: 'KULINĀRIJA', category: 'RECEPTES EKSPERIMENTS', task: 'Pagatavojiet vakariņas, izmantojot 3 sastāvdaļas, ko nekad iepriekš neesat lietojuši kopā.\ngala rezultātam ir jābūt baudāmam!' },
    '4': { cost: 120, title: 'RADOŠUMS', category: 'KOPĪGAIS GLIEMEZIS', task: 'Uzzīmējiet viens otra portretu 5 minūšu laikā, neskatoties uz papīru (tikai uz partneri).\nRezultātu ierāmējiet vai pielieciet pie ledusskapja uz nedēļu.' },
    '5': { cost: 200, title: 'IZAICINĀJUMS', category: 'DIGITĀLĀ DETOKSĀCIJA', task: 'Pavadiet 4 stundas bez telefoniem un ekrāniem. Dodieties pastaigā vai spēlējiet galda spēles.\nPar katru pārkāpumu - soda punkts (viens otram izdomā mazu sodu).' },
    '6': { cost: 100, title: 'RELAKSĀCIJA', category: 'MĀJAS SPA', task: 'Izveidojiet mājās spa atmosfēru (sveces, mūzika). Veiciet viens otram 15 minūšu masāžu.\nTelefoniem jābūt "Do Not Disturb" režīmā.' },
    '7': { cost: 130, title: 'ATMIŅAS', category: 'LAIKA KAPSULA', task: 'Uzrakstiet vēstuli viens otram, ko atvērsiet pēc gada. Ievietojiet tajā mazu piemiņas lietu no šodienas.' },
    '8': { cost: 150, title: t('AKTIVITĀTE', 'ACTIVITY'), category: 'JAUNS HOBIJS', task: 'Izmēģiniet kaut ko, ko neviens no Jums nekad nav darījis (piem., loka šaušana, keramikas nodarbība vai skvošs).' },
    '9': { cost: 90, title: 'ROMANTIKA', category: 'ZVAIGŽŅU VĒROŠANA', task: 'Atrodiet vietu ārpus pilsētas gaismām un vērojiet zvaigznes tējas pauzē.\nPamēģiniet atrast vismaz 3 zvaigznājus.' },
    '10': { cost: 110, title: 'KULTŪRA', category: 'KINO VAKARS CITIEM', task: 'Sarīkojiet kino vakaru, kur filmas žanru izvēlas monētas metiens (pēc tam, kad katrs ir izvēlējies savu favorītu).' },
    '11': { cost: 180, title: 'FIZISKĀS', category: 'SAULLĒKTA PĀRGĀJIENS', task: 'Celieties pirms saules un dodieties uz tuvāko dabas taku vai purvu, lai sagaidītu saullēktu kopā.' },
    '12': { cost: 70, title: 'MĀJAS', category: 'MĒBEĻU PĀRKĀRTOŠANA', task: 'Pārkārtojiet vismaz vienu telpas stūri vai nomainiet dekorācijas, lai radītu jaunu enerģiju mājās.' },
    '13': { cost: 140, title: 'MĀKSLA', category: 'MUZEJU APSKATS', task: 'Apmeklējiet vietējo mākslas galeriju un mēģiniet uzminēt katra darba "slēpto nozīmi" pirms lasāt aprakstu.' }
};

window.completePenalty = () => {
    db.auth.penaltyDone = true;
    db.auth.icebreakerDone = true;
    db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('Saldēšanas uzdevums izpildīts', 'Icebreaker task completed'), points: 0 });
    saveDB(); navigate('timeline');
};

// 3. Rewards View
function renderRewards(container) {
    if (!db || !db.auth) return;
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
                title: 'NEZINĀMS', category: 'NOSLĒPUMS', task: 'Šī magnēta dati nav atrasti datubāzē.'
            };

            if (m.completed && m.photoId) {
                // Completed magnet — show photo thumbnail
                const photo = db.photos.find(p => p.id === m.photoId);
                const thumbSrc = photo ? (photo.imageUrl || photo.dataUrl) : 'assets/magnet_open.png';
                magnetsHtml += `
                <div style="width:100%; aspect-ratio: 628/1000; border-radius:12px; position:relative; overflow:hidden; box-shadow:0 10px 20px rgba(0,0,0,0.15); cursor:pointer;" onclick="zoomMagnet(${m.id})">
                    <img src="${thumbSrc}" style="width:100%; height:100%; object-fit:cover;" alt="">
                    <div style="position:absolute; bottom:0; left:0; right:0; padding:12px; background:linear-gradient(transparent, rgba(0,0,0,0.7));">
                        <div style="font-size:0.7rem; font-weight:800; color:white; text-transform:uppercase; letter-spacing:1px;">${data.title}</div>
                    </div>
                    <div style="position:absolute; top:8px; right:8px; width:24px; height:24px; border-radius:50%; background:#34C759; display:flex; align-items:center; justify-content:center;">
                        <i class="fa-solid fa-check" style="color:white; font-size:0.6rem;"></i>
                    </div>
                </div>`;
            } else if (m.unlocked) {
                // Unlocked but not completed — show magnet card
                magnetsHtml += `
                <div style="width:100%; aspect-ratio: 628/1000; background-image:url('assets/magnet_open.png'); background-size:cover; background-position:center; border-radius:12px; position:relative; overflow:hidden; box-shadow:0 10px 20px rgba(0,0,0,0.15); cursor:pointer;" onclick="zoomMagnet(${m.id})">
                    <div style="position:absolute; bottom:8px; left:8px; right:8px; text-align:center;">
                        <span style="background:rgba(255,90,126,0.9); color:white; font-size:0.65rem; font-weight:700; padding:4px 10px; border-radius:10px;">📸 ${t('Pievieno foto', 'Add photo')}</span>
                    </div>
                </div>`;
            } else {
                // Locked magnet
                magnetsHtml += `
                <div style="width:100%; aspect-ratio: 628/1000; background-image:url('assets/magnet_open.png'); background-size:cover; background-position:center; border-radius:12px; position:relative; overflow:hidden; box-shadow:0 10px 20px rgba(0,0,0,0.15);">
                    <div id="magnet-overlay-${m.id}" style="position:absolute; top:0; left:0; width:100%; height:100%; background-image:url('assets/magnet_scratch.png'); background-size:cover; background-position:center; z-index:1;"></div>
                    <div id="magnet-controls-${m.id}" style="position:absolute; top:0; left:0; width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:2;">
                        <i class="fa-solid fa-lock" style="font-size:2rem; margin-bottom:10px; color:#333; filter: drop-shadow(0 2px 2px rgba(255,255,255,0.5));"></i>
                        <button class="btn-primary" style="padding:4px 10px; font-size:0.8rem; font-weight:700; border-radius:12px; box-shadow:0 2px 5px rgba(0,0,0,0.3); white-space:nowrap; max-width:90%; overflow:hidden;" onclick="unlockMagnet(${m.id}, ${data.cost})">
                            <i class="fa-solid fa-star" style="color:#FFD700; margin-right:3px;"></i> Atvērt <span style="font-size:0.7em; opacity:0.8;">(${data.cost} pt)</span>
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

        <button class="btn-primary" style="width:100%; margin-top:2rem; background: linear-gradient(135deg, #14B8A6, #0D9488); border:none;" onclick="startQRScanner()">
            <i class="fa-solid fa-qrcode"></i> ${t('Noskanēt magnēta kodu', 'Scan Magnet QR')}
        </button>
    `;
}

window.unlockMagnet = (id, cost) => {
    const totalMyPoints = db.points + (db.auth.myPoints || 0);
    if (totalMyPoints >= cost) {
        if (confirm(t(`Izmantot ${cost} punktus, lai atvērtu šo magnētu?`, `Use ${cost} points to open this magnet?`))) {
            const overlay = document.getElementById(`magnet-overlay-${id}`);
            const controls = document.getElementById(`magnet-controls-${id}`);

            if (overlay) overlay.classList.add('scratching');
            if (controls) controls.style.display = 'none';

            setTimeout(() => {
                db.auth.myPoints = (db.auth.myPoints || 0) - cost;
                const mag = db.magnets.find(x => x.id === id);
                if (mag) mag.unlocked = true;

                db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: t('Es atslēdzu fizisko magnētu!', 'I unlocked a physical magnet!'), points: -cost });
                saveDB();
                renderRewards(document.getElementById('app-content'));
                updateHeader();
            }, 900);
        }
    } else {
        alert(t(`Nepietiek punktu! Tev ir: ${totalMyPoints}`, `Not enough points! You have: ${totalMyPoints}`));
    }
};

window.zoomImage = (src) => {
    const zoomHtml = `
        <div class="magnet-zoom-overlay animate-fade-in" id="image-zoom" onclick="if(event.target===this) this.remove()" style="display:flex; justify-content:center; align-items:center; background:rgba(0,0,0,0.9); padding:20px; z-index:10000; position:fixed; top:0; left:0; right:0; bottom:0; cursor:pointer;">
            <button class="zoom-close-btn" onclick="document.getElementById('image-zoom').remove()" style="position:absolute; top:20px; right:20px; background:rgba(255,255,255,0.2); border:none; width:40px; height:40px; border-radius:50%; color:white; font-size:1.5rem; cursor:pointer;"><i class="fa-solid fa-xmark"></i></button>
            <img src="${src}" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,0.5);" />
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', zoomHtml);
};

window.zoomMagnet = (id) => {
    const mag = db.magnets.find(x => x.id === id);
    if (!mag) return;

    const data = MAGNET_CATALOG[mag.code] || { title: 'NEZINĀMS', category: 'NOSLĒPUMS', task: '...' };

    // STATE: Completed with photo — show the memory
    if (mag.completed && mag.photoId) {
        const photo = db.photos.find(p => p.id === mag.photoId);
        if (photo) {
            const imgSrc = photo.imageUrl || photo.dataUrl;
            const dateStr = new Date(mag.completedAt || photo.id).toLocaleDateString(db.lang === 'en' ? 'en-US' : 'lv-LV', { year: 'numeric', month: 'long', day: 'numeric' });
            const zoomHtml = `
                <div class="magnet-zoom-overlay animate-fade-in" id="magnet-zoom" onclick="if(event.target===this) closeMagnetZoom()">
                    <button class="zoom-close-btn" onclick="closeMagnetZoom()"><i class="fa-solid fa-xmark"></i></button>
                    <div style="width:90%; max-width:420px; animation: magnet-pop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
                        <div style="border-radius:24px; overflow:hidden; box-shadow:0 30px 60px rgba(0,0,0,0.5); background:var(--bg-panel);">
                            <img src="${imgSrc}" style="width:100%; aspect-ratio:1; object-fit:cover; display:block;" alt="">
                            <div style="padding:20px;">
                                <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                                    <div style="width:8px; height:8px; border-radius:50%; background:#34C759;"></div>
                                    <span style="font-size:0.75rem; font-weight:700; color:#34C759; text-transform:uppercase; letter-spacing:1px;">${t('Izpildīts', 'Completed')}</span>
                                </div>
                                <h3 style="font-size:1.2rem; font-weight:800; color:var(--text-main); margin-bottom:4px; letter-spacing:-0.3px;">${data.title}</h3>
                                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:8px;">${data.category}</p>
                                <p style="font-size:0.95rem; color:var(--text-main); line-height:1.5; margin-bottom:12px; white-space:pre-wrap;">${photo.title || data.task}</p>
                                <p style="font-size:0.8rem; color:var(--text-muted); margin:0;"><i class="fa-regular fa-calendar" style="margin-right:6px;"></i>${dateStr}</p>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', zoomHtml);
            return;
        }
    }

    // STATE: Unlocked but not completed — show task + add photo button
    const addPhotoBtn = mag.unlocked ? `
        <div style="padding:0 20px 20px; text-align:center;">
            <button onclick="closeMagnetZoom(); addMagnetPhoto(${mag.id});" style="background:linear-gradient(135deg,#FF5A7E,#C084FC); color:white; border:none; padding:14px 24px; border-radius:16px; font-weight:700; font-size:0.95rem; font-family:inherit; cursor:pointer; width:100%; box-shadow:0 4px 15px rgba(255,90,126,0.3);">
                <i class="fa-solid fa-camera" style="margin-right:8px;"></i>${t('Pievienot foto (Uzdevums izpildīts!)', 'Add photo (Task completed!)')}
            </button>
        </div>
    ` : '';

    const zoomHtml = `
        <div class="magnet-zoom-overlay animate-fade-in" id="magnet-zoom" onclick="if(event.target===this) closeMagnetZoom()">
            <button class="zoom-close-btn" onclick="closeMagnetZoom()"><i class="fa-solid fa-xmark"></i></button>
            <div class="magnet-zoom-card-container">
                <div class="magnet-zoom-card" style="background-image:url('assets/magnet_open.png');">
                    <div class="magnet-zoom-content">
                        <h2 style="margin:20px 0 5px 0; font-family:'Montserrat', sans-serif; font-weight:900; font-size:2rem; letter-spacing:1px; line-height:1.1; color: white; text-shadow: 2px 2px 4px rgba(0,0,0,0.4); text-transform:uppercase;">${data.title}</h2>
                        <h4 style="margin:5px 0 20px 0; font-family:'Montserrat', sans-serif; font-weight:600; font-size:0.9rem; letter-spacing:3px; color:rgba(255,255,255,0.9); text-transform:uppercase;">${data.category}</h4>
                        <div style="flex:1; display:flex; align-items:center; padding:0 10px;">
                            <p style="margin:0; font-family:'Inter', sans-serif; font-size:1.1rem; font-weight:500; line-height:1.5; white-space:pre-wrap; text-shadow: 1px 1px 2px rgba(0,0,0,0.3);">${data.task}</p>
                        </div>
                    </div>
                </div>
                ${addPhotoBtn}
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', zoomHtml);
};

window.addMagnetPhoto = (magnetId) => {
    const mag = db.magnets.find(x => x.id === magnetId);
    if (!mag) return;
    const data = MAGNET_CATALOG[mag.code] || { title: 'Magnēta uzdevums', category: '', task: '' };

    // Create a hidden file input and trigger it
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            // Compress image
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxDim = 1200;
                let w = img.width, h = img.height;
                if (w > maxDim || h > maxDim) {
                    if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
                    else { w = Math.round(w * maxDim / h); h = maxDim; }
                }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                const compressed = canvas.toDataURL('image/jpeg', 0.8);

                // Create photo entry
                const photoId = Date.now();
                const photoTitle = `🧲 ${data.title} — ${data.category}`;
                db.photos.unshift({
                    id: photoId,
                    dataUrl: compressed,
                    title: photoTitle
                });

                // Mark magnet as completed
                mag.completed = true;
                mag.photoId = photoId;
                mag.completedAt = new Date().toISOString();

                // Add history entry
                db.history.unshift({
                    id: Date.now() + 1,
                    date: new Date().toISOString(),
                    title: t(`Magnēta uzdevums izpildīts: ${data.title}`, `Magnet task completed: ${data.title}`),
                    points: 25
                });

                saveDB();
                renderRewards(document.getElementById('app-content'));
                updateHeader();

                // Show success toast or alert
                alert(t('🎉 Uzdevums izpildīts! Foto pievienota galerijā.', '🎉 Task completed! Photo added to gallery.'));
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        input.remove();
    };

    input.click();
};

window.closeMagnetZoom = () => {
    const zoom = document.getElementById('magnet-zoom');
    if (zoom) {
        zoom.classList.add('animate-fade-out');
        setTimeout(() => zoom.remove(), 300);
    }
};

window.checkQRMagnet = () => {
    const params = new URLSearchParams(window.location.search);
    const magnetCode = params.get('magnet');
    if (magnetCode && db.auth) {
        if (!db.magnets) db.magnets = [];
        const existing = db.magnets.find(m => m.code === magnetCode);

        if (existing && existing.completed && existing.photoId) {
            // Already completed — go straight to the photo view
            window.history.replaceState({}, document.title, window.location.pathname);
            setTimeout(() => zoomMagnet(existing.id), 500);
            return;
        }

        if (existing && existing.unlocked) {
            // Unlocked but not completed — show task zoom
            window.history.replaceState({}, document.title, window.location.pathname);
            if (currentRoute !== 'rewards') navigate('rewards');
            setTimeout(() => zoomMagnet(existing.id), 500);
            return;
        }

        if (!existing) {
            db.magnets.unshift({ id: Date.now(), code: magnetCode, unlocked: false, completed: false, photoId: null, dateAdded: new Date().toISOString() });
            saveDB();
        }
        window.history.replaceState({}, document.title, window.location.pathname);
        if (currentRoute !== 'rewards') navigate('rewards');
    }
};

window.handleDeepLinks = () => {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (!db.auth) {
            sessionStorage.setItem('pendingJoin', joinCode);
        } else if (!db.auth.linked) {
            setTimeout(() => {
                if (document.getElementById('joinCodeInput')) {
                    document.getElementById('joinCodeInput').value = joinCode;
                }
                window.autoJoin(joinCode);
            }, 500);
        }
    }
};

// QR Scanner
window.startScannerActive = false;
window.startQRScanner = () => {
    showOverlay(`
        <h3 style="text-align:center; margin-bottom:1rem;">${t('Noskanē QR Kodu', 'Scan QR Code')}</h3>
        <p style="text-align:center; font-size:0.9rem; color:var(--text-muted); margin-bottom:1rem;">${t('Pavērs kameru pret partnera ekrānu.', 'Point camera at partner screen.')}</p>
        <div id="qr-reader" style="width:100%; border-radius:12px; overflow:hidden;"></div>
        <button class="btn-secondary danger-text" style="margin-top:1rem; width:100%;" onclick="closeQRScanner()">${t('Atcelt', 'Cancel')}</button>
    `);

    window.startScannerActive = true;
    setTimeout(() => {
        if (!window.Html5Qrcode) return alert('Kameras bibliotēka ielādējas, mēģini pēc mirkļa!');
        window.html5QrcodeScanner = new Html5Qrcode("qr-reader");
        window.html5QrcodeScanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (decodedText) => {
                if (window.startScannerActive) {
                    closeQRScanner();
                    let code = decodedText;

                    if (code.includes('magnet=')) {
                        const magCode = new URL(code).searchParams.get('magnet');
                        if (magCode) {
                            window.history.replaceState({}, document.title, "?magnet=" + magCode);
                            checkQRMagnet();
                            return;
                        }
                    }

                    if (code.includes('join=')) {
                        code = new URL(code).searchParams.get('join');
                    }
                    if (code) {
                        const joinInput = document.getElementById('joinCodeInput');
                        if (joinInput) joinInput.value = code;
                        joinCouple();
                    }
                }
            },
            () => { }
        ).catch(err => {
            alert(t("Neizdevās atvērt kameru. Pārbaudi atļaujas!", "Could not open camera. Check permissions!"));
            closeQRScanner();
        });
    }, 100);
};

window.closeQRScanner = () => {
    window.startScannerActive = false;
    if (window.html5QrcodeScanner) {
        window.html5QrcodeScanner.stop().then(() => {
            window.html5QrcodeScanner.clear();
        }).catch(err => console.error(err));
    }
    closeOverlays();
};

// 4. Tasks View (formerly Coupons)
const TASK_CATEGORIES = [
    { id: 'cooking', icon: 'utensils', color: '#FF9F43', bg: 'rgba(255,159,67,0.12)', lv: 'Kulinārija', en: 'Cooking', cls: 'cat-cooking' },
    { id: 'romance', icon: 'heart', color: '#FF5A7E', bg: 'rgba(255,90,126,0.12)', lv: 'Romantika', en: 'Romance', cls: 'cat-date' },
    { id: 'cleaning', icon: 'broom', color: '#54A0FF', bg: 'rgba(84,160,255,0.12)', lv: 'Tīrīšana', en: 'Cleaning', cls: 'cat-travel' },
    { id: 'travel', icon: 'plane', color: '#5F27CD', bg: 'rgba(95,39,205,0.12)', lv: 'Ceļojums', en: 'Travel', cls: 'cat-custom' },
    { id: 'fun', icon: 'masks-theater', color: '#00D2D3', bg: 'rgba(0,210,211,0.12)', lv: 'Izklaide', en: 'Fun', cls: 'cat-party' },
    { id: 'surprise', icon: 'gift', color: '#C084FC', bg: 'rgba(192,132,252,0.12)', lv: 'Pārsteigums', en: 'Surprise', cls: 'cat-custom' },
];

const CATEGORY_TEMPLATES = {
    cooking: [
        { lv: 'Pagatavot vakariņas divatā', en: 'Cook dinner together', points: 40 },
        { lv: 'Izcepa kūku vai desertu', en: 'Bake a cake or dessert', points: 35 },
        { lv: 'Pagatavot brokastis gultā', en: 'Make breakfast in bed', points: 50 },
        { lv: 'Pagatavot mīļāko ēdienu', en: 'Cook favourite meal', points: 40 },
        { lv: 'Kopīgi izmēģināt jaunu recepti', en: 'Try a new recipe together', points: 45 },
    ],
    romance: [
        { lv: 'Uzrakstīt mīļu zīmīti un paslēpt', en: 'Write a love note and hide it', points: 20 },
        { lv: 'Nofotografēt 10 kopīgus mirkļus', en: 'Take 10 shared photos today', points: 30 },
        { lv: 'Noskatīties kopā filmu bez telefoniem', en: 'Watch a movie without phones', points: 25 },
        { lv: 'Pastaiga parkā saulrietā', en: 'Walk in the park at sunset', points: 30 },
        { lv: 'Sarīkot romantiskas vakariņas pie svecēm', en: 'Organize candlelit dinner', points: 60 },
    ],
    cleaning: [
        { lv: 'Sakārtot virtuvi kopīgi', en: 'Clean the kitchen together', points: 30 },
        { lv: 'Uzslaucīt grīdas pa visu māju', en: 'Mop all floors', points: 35 },
        { lv: 'Sakārtot skapjus un atvilktnes', en: 'Organize wardrobes & drawers', points: 40 },
        { lv: 'Izmazgāt logus', en: 'Clean the windows', points: 30 },
        { lv: 'Sarīkot ģenerālo uzkopšanu', en: 'Do a full deep clean', points: 70 },
    ],
    travel: [
        { lv: 'Atrast nākamo ceļojuma galamērķi', en: 'Find next travel destination', points: 30 },
        { lv: 'Sapakot somas ceļojumam', en: 'Pack bags for the trip', points: 20 },
        { lv: 'Rezervēt viesnīcu vai Airbnb', en: 'Book hotel or Airbnb', points: 50 },
        { lv: 'Sarīkot pārsteiguma dienas izbraucienu', en: 'Plan a surprise day trip', points: 60 },
        { lv: 'Izpētīt jaunu pilsētu vai rajonu', en: 'Explore a new city or district', points: 45 },
    ],
    fun: [
        { lv: 'Noorganizēt spēļu vakaru', en: 'Organize a game night', points: 40 },
        { lv: 'Apmeklēt kino vai teātri', en: 'Visit cinema or theatre', points: 50 },
        { lv: 'Pamēģināt jaunu hobiju kopā', en: 'Try a new hobby together', points: 55 },
        { lv: 'Sarīkot piknika pusdienas', en: 'Have a picnic lunch', points: 35 },
        { lv: 'Aiziet uz dejošanas stundu', en: 'Go to a dance class', points: 60 },
    ],
    surprise: [
        { lv: 'Iegādāties mazumiņu bez iemesla', en: 'Buy a small gift for no reason', points: 40 },
        { lv: 'Sarīkot pārsteiguma vakaru', en: 'Plan a surprise evening', points: 70 },
        { lv: 'Izrotāt māju par godu partnera dienai', en: 'Decorate home for partner', points: 50 },
        { lv: 'Saņemt masāžu divatā', en: 'Get a couple massage', points: 80 },
        { lv: 'Uzrakstīt "100 iemesli, kāpēc es tevi mīlu"', en: 'Write "100 reasons I love you"', points: 90 },
    ],
};

const KIDS_CATEGORIES = [
    { id: 'chores', icon: 'broom', color: '#54A0FF', bg: 'rgba(84,160,255,0.12)', lv: 'Mājas darbi', en: 'Chores', cls: 'cat-cleaning' },
    { id: 'study', icon: 'book', color: '#FF9F43', bg: 'rgba(255,159,67,0.12)', lv: 'Mācības', en: 'Study', cls: 'cat-study' },
    { id: 'behavior', icon: 'star', color: '#FF5A7E', bg: 'rgba(255,90,126,0.12)', lv: 'Uzvedība', en: 'Behavior', cls: 'cat-star' },
];

const KIDS_CATEGORY_TEMPLATES = {
    chores: [
        { lv: 'Sakārtot savu istabu', en: 'Clean your room', points: 20 },
        { lv: 'Izpildīt trauku mašīnas izkraušanu', en: 'Empty the dishwasher', points: 15 },
        { lv: 'Iznest atkritumus', en: 'Take out the trash', points: 10 },
        { lv: 'Salocīt savas drēbes', en: 'Fold your clothes', points: 15 },
        { lv: 'Pabarot mājdzīvnieku', en: 'Feed the pet', points: 20 },
    ],
    study: [
        { lv: 'Izpildīt visus mājasdarbus', en: 'Do all homework', points: 30 },
        { lv: 'Izlasīt 1 nodaļu grāmatai', en: 'Read 1 chapter of a book', points: 20 },
        { lv: 'Papildus matemātikas uzdevums', en: 'Extra math task', points: 25 },
        { lv: 'Iemācīties ko jaunu', en: 'Learn something new', points: 30 },
    ],
    behavior: [
        { lv: 'Diena bez strīdiem', en: 'A day without arguments', points: 25 },
        { lv: 'Palīdzēt vecākiem bez lūguma', en: 'Help parents without asking', points: 30 },
        { lv: 'Uzzīmēt zīmējumu', en: 'Draw a picture', points: 15 },
        { lv: 'Ekrāna laiks zem 1h', en: 'Screen time under 1h', points: 40 },
    ],
};

window.toggleKidsMode = () => {
    if (!db) return;
    db.kidsMode = !db.kidsMode;
    saveDBLocal();
    updateHeader();
    if (currentRoute === 'coupons') {
        renderCoupons(document.getElementById('app-content'));
    } else if (currentRoute === 'timeline') {
        renderTimeline(document.getElementById('app-content'));
    }
};

// Automatic expiry penalty checker
function checkExpiredTasks() {
    if (!db || !db.auth || !db.coupons) return;
    const now = new Date();
    let changed = false;
    db.coupons.forEach(c => {
        if (c.status === 'accepted' && new Date(c.expiry) < now) {
            const penalty = c.penalty || Math.round((c.points || 50) * 0.5);
            c.status = 'expired';
            db.auth.partnerPoints = Math.max(0, (db.auth.partnerPoints || 0) - penalty);
            db.history.unshift({
                id: Date.now() + Math.random(),
                date: new Date().toISOString(),
                title: t(`Sods: uzdevums netika izpildīts laikā – "${c.title}"`, `Penalty: task not completed in time – "${c.title}"`),
                points: -penalty
            });
            changed = true;
        }
    });
    if (changed) { saveDB(); if (currentRoute === 'coupons') navigate('coupons'); }
}
setInterval(checkExpiredTasks, 60000);

function renderCoupons(container) {
    if (!db || !db.auth) return;
    window.couponsTab = window.couponsTab || 'received';
    const myEmail = db.auth.email;
    const activeCoupons = db.coupons.filter(c => c.status === 'pending' || c.status === 'accepted');
    const sentCoupons = activeCoupons.filter(c => c.sender === myEmail);
    const receivedCoupons = activeCoupons.filter(c => c.sender !== myEmail);

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1.5rem; padding-top: 0.5rem;">
            <div onclick="navigate('timeline')" style="cursor:pointer; font-size:1.3rem; color:#A3A3A3; width: 32px;"><i class="fa-solid fa-arrow-left"></i></div>
            <h2 style="margin:0; font-size:1.4rem; color:#A3A3A3; font-weight:800;">${t('Uzdevumi', 'Tasks')}</h2>
            <div onclick="openSendTaskModal()" style="width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg,#FF5A7E,#C084FC); display: flex; align-items: center; justify-content: center; color: white; cursor:pointer; font-size: 1rem; box-shadow:0 4px 12px rgba(255,90,126,0.4);">
                <i class="fa-solid fa-plus"></i>
            </div>
        </div>

        <div style="display:flex; background:var(--bg-panel); border-radius:20px; padding:4px; margin-bottom:2rem; box-shadow:0 4px 15px rgba(0,0,0,0.03);">
            <div onclick="window.couponsTab='received'; navigate('coupons');" style="flex:1; text-align:center; padding:12px; border-radius:16px; font-weight:800; font-size:0.95rem; cursor:pointer; transition:0.3s; ${window.couponsTab === 'received' ? 'background:linear-gradient(135deg,#FF5A7E,#C084FC); color:white; box-shadow:0 4px 10px rgba(255,90,126,0.3);' : 'background:transparent; color:#A3A3A3;'}">
                ${t('Saņemtie', 'Received')} (${receivedCoupons.length})
            </div>
            <div onclick="window.couponsTab='sent'; navigate('coupons');" style="flex:1; text-align:center; padding:12px; border-radius:16px; font-weight:800; font-size:0.95rem; cursor:pointer; transition:0.3s; ${window.couponsTab === 'sent' ? 'background:linear-gradient(135deg,#FF5A7E,#C084FC); color:white; box-shadow:0 4px 10px rgba(255,90,126,0.3);' : 'background:transparent; color:#A3A3A3;'}">
                ${t('Nosūtītie', 'Sent')} (${sentCoupons.length})
            </div>
        </div>
    `;

    const renderCard = (c, isSent) => {
        const catMeta = TASK_CATEGORIES.find(x => x.id === c.type) || TASK_CATEGORIES[1];
        const isPending = c.status === 'pending';
        const isExpired = new Date(c.expiry) < new Date() && c.status !== 'done';
        const penaltyPts = c.penalty || Math.round((c.points || 50) * 0.5);
        let actionsHtml = '';

        if (isSent) {
            if (isPending) {
                actionsHtml = `<div class="coupon-timer" style="color:var(--text-muted);"><i class="fa-regular fa-paper-plane"></i> ${t('Nosūtīts. Gaidām pieņemšanu.', 'Sent. Waiting for acceptance.')}</div>`;
            } else {
                actionsHtml = `
                <div style="margin-bottom:12px; font-size:0.85rem; font-weight:600; color:var(--text-main);">${t('Partneris pieņēmis! Kad viņš pabeigs – apstiprini:', 'Partner accepted! Confirm when done:')}</div>
                <div class="coupon-actions">
                    <button class="btn-approve" onclick="completeCoupon(${c.id})"><i class="fa-solid fa-check"></i> ${t('Atzīmēt izpildītu', 'Mark done')}</button>
                    <button class="btn-reject" onclick="failCoupon(${c.id})" title="${t('Neizpildīts', 'Failed')}"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
            }
        } else {
            if (isPending) {
                actionsHtml = `
                <div class="coupon-actions">
                    <button class="btn-approve" onclick="acceptTask(${c.id})">${t('Pieņemt izaicinājumu', 'Accept challenge')}</button>
                    <button class="btn-reject" onclick="rejectTask(${c.id})" title="${t('Noraidīt', 'Reject')}"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
            } else {
                actionsHtml = `<div class="coupon-timer" style="color:var(--color-success); font-weight:600;"><i class="fa-solid fa-rocket"></i> ${t('Šobrīd jāizpilda tev! Partneris apstiprinās.', 'Complete this now! Partner will confirm.')}</div>`;
            }
        }

        const expiryBadge = isExpired && c.status !== 'done'
            ? `<div style="background:rgba(255,59,48,0.15); color:#ff3b30; font-size:0.75rem; font-weight:700; padding:3px 9px; border-radius:20px; display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-triangle-exclamation"></i> ${t('Nokavēts! -' + penaltyPts + 'pt', 'Overdue! -' + penaltyPts + 'pt')}</div>`
            : '';

        return `
            <div class="glass-panel coupon-card" style="position:relative; border-left: 4px solid ${catMeta.color}; overflow:hidden;">
                <div style="position:absolute; top:0; left:0; right:0; bottom:0; background:${catMeta.bg}; pointer-events:none; border-radius:inherit;"></div>
                <div style="position:relative;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div style="width:32px; height:32px; border-radius:50%; background:${catMeta.color}; display:flex; align-items:center; justify-content:center; color:white; font-size:0.85rem;">
                                <i class="fa-solid fa-${catMeta.icon}"></i>
                            </div>
                            <div style="font-size:0.78rem; font-weight:700; color:${catMeta.color}; text-transform:uppercase; letter-spacing:0.05em;">${t(catMeta.lv, catMeta.en)}</div>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                            ${expiryBadge}
                            <div style="background:rgba(255,149,0,0.15); color:#FF9500; font-weight:700; font-size:0.82rem; padding:4px 10px; border-radius:20px; display:flex; align-items:center; gap:4px;">
                                <i class="fa-solid fa-star"></i> +${c.points || 50}
                            </div>
                        </div>
                    </div>
                    <h3 class="coupon-title" style="margin:0 0 6px;">${c.title}</h3>
                    <p class="coupon-task" style="margin:0 0 10px;">${t('Uzdevums:', 'Task:')} <strong>${c.task}</strong></p>
                    <div class="coupon-timer"><i class="fa-regular fa-clock"></i> ${t('Termiņš:', 'Deadline:')} ${new Date(c.expiry).toLocaleString(db.lang === 'en' ? 'en-US' : 'lv-LV')}</div>
                    <div style="margin-top:8px; padding:8px 10px; background:rgba(255,59,48,0.08); border-radius:10px; display:flex; gap:8px; align-items:flex-start;">
                        <i class="fa-solid fa-circle-exclamation" style="color:#ff3b30; font-size:0.9rem; margin-top:1px;"></i>
                        <span style="font-size:0.78rem; color:var(--text-muted); line-height:1.4;">${t('Ja uzdevums netiks izpildīts laikā, tiks atņemti ' + penaltyPts + ' punkti kā sods.', 'If the task is not completed on time, ' + penaltyPts + ' points will be deducted as a penalty.')}</span>
                    </div>
                    <div style="margin-top:12px;">${actionsHtml}</div>
                </div>
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
            : t('Nospied + lai izveidotu un nosūtītu uzdevumu!', 'Tap + to create and send a task!');
        html += `
        <div style="text-align:center; margin-top:4rem; color:#D1D1D6;">
            <i class="fa-solid fa-list-check" style="font-size:5rem; margin-bottom:1.5rem; opacity:0.4;"></i>
            <h3 style="color:#A3A3A3; font-size:1.2rem; font-weight:800; margin-bottom:0.8rem;">${emptyText}</h3>
            <p style="font-size:0.95rem; color:#C7C7CC; max-width:80%; margin:0 auto; font-weight:500;">${emptySubtext}</p>
        </div>`;
    } else {
        activeList.forEach(c => html += renderCard(c, isSentContext));
    }
    html += `</div>`;
    container.innerHTML = html;
}

window.selectedTaskCat = 'romance';
window.dismissedTemplates = new Set();

window.dismissTemplate = (catId, idx, event) => {
    event.stopPropagation();
    window.dismissedTemplates.add(`${catId}:${idx}`);
    const tplContainer = document.getElementById('quick-templates');
    if (tplContainer) renderTemplatesForCat(catId, tplContainer);
};

window.resetTemplates = () => {
    window.dismissedTemplates.clear();
    const tplContainer = document.getElementById('quick-templates');
    if (tplContainer) renderTemplatesForCat(window.selectedTaskCat, tplContainer);
};

function renderTemplatesForCat(catId, container) {
    let cats = db && db.kidsMode ? KIDS_CATEGORIES : TASK_CATEGORIES;
    let tpls = db && db.kidsMode ? KIDS_CATEGORY_TEMPLATES : CATEGORY_TEMPLATES;
    const templates = tpls[catId] || [];
    const catColor = cats.find(x => x.id === catId)?.color || '#FF5A7E';
    const visible = templates.filter((_, i) => !window.dismissedTemplates.has(`${catId}:${i}`));

    if (visible.length === 0) {
        container.innerHTML = `
            <div style="width:100%; padding:10px 0; text-align:center;">
                <span style="font-size:0.8rem; color:var(--text-muted);">${t('Visi varianti noņemti.', 'All options removed.')}</span>
                <span onclick="resetTemplates()" style="font-size:0.8rem; color:${catColor}; font-weight:700; cursor:pointer; margin-left:8px;">${t('Atjaunot', 'Restore')}</span>
            </div>`;
        return;
    }

    const preamble = visible.map(tmp => {
        const realIdx = templates.indexOf(tmp);
        const lvEsc = tmp.lv.replace(/'/g, "\\'");
        const enEsc = tmp.en.replace(/'/g, "\\'");
        return `<div style="position:relative; padding:8px 34px 8px 14px; background:var(--bg-panel); border:1.5px solid rgba(0,0,0,0.07); border-radius:14px; font-size:0.8rem; font-weight:600; cursor:pointer; color:var(--text-main); transition:0.2s; display:inline-flex; align-items:center; gap:6px;"
                 onclick="applyTaskTemplate('${lvEsc}', '${enEsc}', ${tmp.points})"
                 onmouseover="this.style.borderColor='${catColor}'" onmouseout="this.style.borderColor='rgba(0,0,0,0.07)'"
            >${t(tmp.lv, tmp.en)} <span style="color:#FF9500; font-weight:800;">+${tmp.points}</span>
            <span onclick="dismissTemplate('${catId}', ${realIdx}, event)"
                  style="position:absolute; right:7px; top:50%; transform:translateY(-50%); width:18px; height:18px; border-radius:50%; background:rgba(0,0,0,0.08); display:flex; align-items:center; justify-content:center; font-size:0.65rem; color:var(--text-muted); cursor:pointer; transition:0.2s;"
                  onmouseover="this.style.background='rgba(255,59,48,0.2)'; this.style.color='#ff3b30'" onmouseout="this.style.background='rgba(0,0,0,0.08)'; this.style.color='var(--text-muted)'"
            ><i class="fa-solid fa-xmark"></i></span></div>`;
    }).join('');

    const hasAnyDismissed = templates.some((_, i) => window.dismissedTemplates.has(`${catId}:${i}`));
    const resetBtn = hasAnyDismissed ? `<div onclick="resetTemplates()" style="display:inline-flex; align-items:center; gap:5px; padding:8px 14px; border:1.5px dashed rgba(0,0,0,0.12); border-radius:14px; font-size:0.78rem; font-weight:700; cursor:pointer; color:${catColor}; transition:0.2s;" onmouseover="this.style.background='${catColor}18'" onmouseout="this.style.background='transparent'"><i class="fa-solid fa-rotate-left"></i> ${t('Atjaunot sākotnējos', 'Restore defaults')}</div>` : '';

    container.innerHTML = preamble + resetBtn;
}

window.selectTaskCat = (catId) => {
    window.selectedTaskCat = catId;
    let cats = db && db.kidsMode ? KIDS_CATEGORIES : TASK_CATEGORIES;
    cats.forEach(c => {
        const el = document.getElementById('taskcat-' + c.id);
        if (el) {
            if (c.id === catId) {
                el.style.borderColor = c.color;
                el.style.background = c.bg;
                el.querySelector('.caticon').style.transform = 'scale(1.15)';
            } else {
                el.style.borderColor = 'rgba(0,0,0,0.06)';
                el.style.background = 'var(--bg-panel)';
                el.querySelector('.caticon').style.transform = 'scale(1)';
            }
        }
    });
    const tplContainer = document.getElementById('quick-templates');
    if (tplContainer) renderTemplatesForCat(catId, tplContainer);
};

window.openSendTaskModal = () => {
    let cats = db && db.kidsMode ? KIDS_CATEGORIES : TASK_CATEGORIES;
    window.selectedTaskCat = cats[0].id; // romance or chores
    window.dismissedTemplates = new Set();
    const catGrid = cats.map(c => `
        <div id="taskcat-${c.id}" onclick="selectTaskCat('${c.id}')"
             style="padding:14px 6px; border-radius:14px; border:2px solid ${c.id === cats[0].id ? c.color : 'rgba(0,0,0,0.06)'}; text-align:center; cursor:pointer; background:${c.id === cats[0].id ? c.bg : 'var(--bg-panel)'}; transition:0.25s; user-select:none;">
            <i class="fa-solid fa-${c.icon} caticon" style="color:${c.color}; font-size:1.4rem; margin-bottom:7px; display:block; transition:0.2s;"></i>
            <div style="font-size:0.73rem; font-weight:700; color:var(--text-main); line-height:1.2;">${t(c.lv, c.en)}</div>
        </div>
    `).join('');

    showOverlay(`
        <h3 class="modal-title" style="margin-bottom:1.5rem; text-align:center; background:linear-gradient(135deg,#FF5A7E,#C084FC); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;">
            <i class="fa-solid fa-list-check" style="-webkit-text-fill-color:#FF5A7E; margin-right:8px;"></i> ${t('Nosūtīt Uzdevumu', 'Send Task')}
        </h3>

        <div style="margin-bottom:1.2rem;">
            <label class="input-label" style="text-transform:uppercase; font-size:0.72rem; letter-spacing:1px; margin-bottom:10px;">${t('Kategorija', 'Category')}</label>
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">
                ${catGrid}
            </div>
        </div>

        <div style="margin-bottom:1.5rem;">
            <label class="input-label" style="text-transform:uppercase; font-size:0.72rem; letter-spacing:1px; margin-bottom:8px;">${t('Ātrās sagataves', 'Quick Templates')}</label>
            <div id="quick-templates" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
            <div style="margin-top:10px; background:linear-gradient(135deg, rgba(255,90,126,0.06), rgba(192,132,252,0.06)); border:1.5px solid rgba(255,90,126,0.15); border-radius:16px; padding:14px 14px 10px;">
                <div style="display:flex; align-items:center; gap:7px; margin-bottom:10px;">
                    <i class="fa-solid fa-pen" style="color:#FF5A7E; font-size:0.8rem;"></i>
                    <span style="font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.08em; color:#FF5A7E;">${t('Vai veido savu', 'Or create your own')}</span>
                </div>
                <input type="text" id="task-custom-title" class="input-field" placeholder="${t('Uzdevuma nosaukums...', 'Task title...')}" style="font-size:0.9rem; margin-bottom:10px; border-color:rgba(255,90,126,0.2);">
                <div style="position:relative;">
                    <i class="fa-solid fa-clipboard-check" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:#C084FC; font-size:0.9rem; pointer-events:none;"></i>
                    <input type="text" id="coup-task" class="input-field" style="padding-left:40px; border-color:rgba(192,132,252,0.2);" placeholder="${t('Apraksts – ko tieši jāizpilda...', 'Description – what exactly to do...')}">
                </div>
            </div>
        </div>

        <div style="display:flex; gap:1rem; margin-bottom:1rem;">
            <div class="input-group" style="flex:1; position:relative; margin-bottom:0;">
                <i class="fa-solid fa-star text-gold" style="position:absolute; left:15px; top:42px;"></i>
                <label class="input-label">${t('Punkti (+)', 'Points (+)')}</label>
                <input type="number" id="coup-points" class="input-field" style="padding-left:40px; font-weight:bold;" placeholder="50" value="50" min="10" step="10">
            </div>
            <div class="input-group" style="flex:1.5; position:relative; margin-bottom:0;">
                <i class="fa-solid fa-triangle-exclamation" style="position:absolute; left:15px; top:42px; color:#ff3b30;"></i>
                <label class="input-label">${t('Sods (-pt)', 'Penalty (-pt)')}</label>
                <input type="number" id="coup-penalty" class="input-field" style="padding-left:40px; font-weight:bold; color:#ff3b30;" placeholder="25" value="25" min="5" step="5">
            </div>
        </div>

        <div class="input-group" style="position:relative;">
            <i class="fa-regular fa-calendar-xmark" style="position:absolute; left:15px; top:42px; color:var(--text-muted);"></i>
            <label class="input-label">${t('Izpildes termiņš', 'Deadline')}</label>
            <input type="datetime-local" id="coup-expiry" class="input-field" style="padding-left:40px; font-size:0.85rem;">
        </div>

        <div style="background:rgba(255,59,48,0.08); border:1px solid rgba(255,59,48,0.2); border-radius:12px; padding:12px; margin-bottom:1.5rem; display:flex; gap:10px; align-items:flex-start;">
            <i class="fa-solid fa-circle-exclamation" style="color:#ff3b30; margin-top:2px;"></i>
            <p style="font-size:0.8rem; margin:0; line-height:1.5; color:var(--text-main);">${t('Ja partneris neizpildīs uzdevumu termiņā, viņam tiks atņemts norādītais sodu punktu skaits. Tu apstiprin uzdevuma izpildi.', 'If your partner fails to complete the task by the deadline, penalty points will be deducted from their score. You confirm task completion.')}</p>
        </div>

        <button class="btn-primary" style="font-size:1.05rem; padding:16px; background: linear-gradient(135deg, #FF5A7E, #C084FC); border: none;" onclick="sendTask()">
            <i class="fa-solid fa-paper-plane" style="margin-right:8px;"></i> ${t('Nosūtīt Uzdevumu', 'Send Task')}
        </button>
    `);

    const now = new Date();
    now.setDate(now.getDate() + 3);
    document.getElementById('coup-expiry').value = now.toISOString().slice(0, 16);
    const tplInit = document.getElementById('quick-templates');
    if (tplInit) renderTemplatesForCat('romance', tplInit);
};

window.applyTaskTemplate = (lv, en, points) => {
    const titleInput = document.getElementById('task-custom-title');
    const taskInput = document.getElementById('coup-task');
    const pointsInput = document.getElementById('coup-points');
    const penaltyInput = document.getElementById('coup-penalty');
    if (titleInput) titleInput.value = t(lv, en);
    if (taskInput) taskInput.value = t(lv, en);
    if (pointsInput) pointsInput.value = points;
    if (penaltyInput) penaltyInput.value = Math.round(points * 0.5);
};

window.sendTask = () => {
    const cat = window.selectedTaskCat || 'romance';
    const titleInput = document.getElementById('task-custom-title');
    const taskInput = document.getElementById('coup-task');
    const expiryInput = document.getElementById('coup-expiry');
    const pointsInput = document.getElementById('coup-points');
    const penaltyInput = document.getElementById('coup-penalty');

    const title = (titleInput?.value || '').trim() || taskInput?.value?.trim();
    const task = (taskInput?.value || '').trim();
    const expiry = expiryInput?.value;
    const pts = parseInt(pointsInput?.value) || 50;
    const penalty = parseInt(penaltyInput?.value) || 25;

    if (!title || !task || !expiry) return alert(t('Aizpildiet visus laukus!', 'Please fill all fields!'));

    db.coupons.push({
        id: Date.now(),
        type: cat,
        title,
        task,
        expiry,
        points: pts,
        penalty,
        status: 'pending',
        sender: db.auth.email
    });
    saveDB();
    closeOverlays();
    navigate('coupons');
};

window.acceptTask = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) { cp.status = 'accepted'; cp.acceptedAt = new Date().toISOString(); saveDB(); navigate('coupons'); }
};

window.rejectTask = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) { cp.status = 'failed'; saveDB(); navigate('coupons'); }
};

window.acceptCoupon = window.acceptTask;
window.rejectCoupon = window.rejectTask;

window.completeCoupon = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) {
        cp.status = 'done';
        const pointsAwarded = cp.points || 50;
        db.auth.partnerPoints = (db.auth.partnerPoints || 0) + pointsAwarded;
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `${t('Partneris izpildīja uzdevumu', 'Partner completed task')}: ${cp.title}`, points: pointsAwarded });
        saveDB();
        navigate('coupons');
    }
};

window.failCoupon = (id) => {
    const cp = db.coupons.find(c => c.id === id);
    if (cp) {
        cp.status = 'failed';
        const penalty = cp.penalty || Math.round((cp.points || 50) * 0.5);
        db.auth.partnerPoints = Math.max(0, (db.auth.partnerPoints || 0) - penalty);
        db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: `${t('Sods: uzdevums neizpildīts', 'Penalty: task failed')}: ${cp.title}`, points: -penalty });
        saveDB();
        navigate('coupons');
    }
};

// 5. Photos View
function renderPhotos(container) {
    if (!db || !db.auth) return;

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
            const finalImg = p.imageUrl || p.dataUrl;
            html += `
               <div class="polaroid animate-fade-in">
                   <div class="polaroid-img-wrapper">
                       <img src="${finalImg}" onclick="viewPhoto(${p.id})">
                   </div>
                   <input type="text" class="polaroid-title" data-id="${p.id}" value="${p.title}" onblur="editPhotoTitle(${p.id}, this.value)" placeholder="${t('Pievieno nosaukumu...', 'Add a title...')}">
                   <div class="polaroid-date">${dateStr}</div>
                   <div class="polaroid-actions">
                       <button class="pol-btn download" onclick="downloadPhotoRaw('${finalImg}')" title="${t('Iegūt', 'Download')}"><i class="fa-solid fa-arrow-up-from-bracket" style="transform: translateY(1px);"></i></button>
                       <button class="pol-btn edit" onclick="document.querySelector('.polaroid-title[data-id=\\'${p.id}\\']').focus()" title="${t('Rediģēt', 'Edit')}"><i class="fa-solid fa-pen"></i></button>
                       <button class="pol-btn delete" onclick="deletePhoto(${p.id})" title="${t('Dzēst', 'Delete')}"><i class="fa-regular fa-trash-can"></i></button>
                   </div>
               </div>`;
        });
        html += `</div>`;
    }

    container.innerHTML = html;
}

window.downloadPhotoRaw = (imgUrl) => {
    // If it's a base64 string, just use usual anchor download
    if (imgUrl.startsWith('data:')) {
        const a = document.createElement('a');
        a.href = imgUrl;
        a.download = 'framed_date_mem.jpg';
        a.click();
    } else {
        // If it's a URL, opening in new tab is safest for cross-origin
        window.open(imgUrl, '_blank');
    }
};

window.deletePhoto = (id) => {
    if (confirm(t('Vai tiešām vēlies izdzēst bildi?', 'Are you sure you want to delete this photo?'))) {
        db.photos = db.photos.filter(p => p.id !== id);
        saveDBLocal(); // Photos stay local only
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
    input.value = '';
};

window._cropperMode = 'photo';

window.openCropper = (imgUrl, mode = 'photo') => {
    window._cropperMode = mode;
    const overlay = document.createElement('div');
    overlay.id = 'cropper-overlay';
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
        aspectRatio: 1,
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

window.applyCrop = async () => {
    if (!cropperInstance) return;
    const canvas = cropperInstance.getCroppedCanvas({
        width: 1000,
        height: 1000,
        imageSmoothingQuality: 'high'
    });

    const croppedUrl = canvas.toDataURL('image/jpeg', 0.85);
    closeCropper();

    if (window._cropperMode === 'avatar') {
        if (!db.linkCode) {
            // Not connected yet, just save locally for now
            db.auth.myAvatar = croppedUrl;
            saveDBLocal();
            navigate('timeline');
            return;
        }

        showToast(t("Augšupielādē...", "Uploading..."), t("Profila bilde tiek saglabāta", "Profile picture is being saved"), "info");
        
        try {
            const downloadUrl = await uploadImage(croppedUrl, `games/${db.linkCode}/avatars/${myUID}.jpg`);
            db.auth.myAvatar = downloadUrl;
            
            // NEW: Atomic avatar sync
            const role = db.auth.peerRole; // 'host' or 'client'
            firebaseDB.ref(`games/${db.linkCode}/state/avatars`).update({ [role]: downloadUrl });
            
            showToast(t("Gatavs!", "Success!"), t("Profila bilde atjaunota", "Profile picture updated"), "success");
        } catch (e) {
            showToast(t("Kļūda", "Error"), t("Neizdevās augšupielādēt bildi", "Failed to upload image"), "warning");
        }
        navigate('timeline');
    } else {
        openPhotoDetailsSheet(croppedUrl);
    }
};

window.openPhotoDetailsSheet = (imgUrl) => {
    const overlay = document.createElement('div');
    overlay.id = 'photo-details-overlay';
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:flex-end; justify-content:center;';

    overlay.innerHTML = `
        <div class="animate-slide-up" style="background:var(--bg-panel); width:100%; border-radius:30px 30px 0 0; padding:2rem 1.5rem; padding-bottom: max(2rem, env(safe-area-inset-bottom)); box-shadow: 0 -10px 40px rgba(0,0,0,0.1);">
            <h3 style="font-weight:800; font-size:1.4rem; color:var(--text-main); margin-bottom:1.5rem;">${t('Pievienot parakstu', 'Add caption')}</h3>

            <div style="width:100%; aspect-ratio:1; max-height:40vh; border-radius:16px; overflow:hidden; margin-bottom:1.5rem; display:flex; justify-content:center;">
                <img src="${imgUrl}" style="width:100%; height:100%; object-fit:contain; border-radius:16px;">
            </div>

            <input type="text" id="photo-caption-input" style="width:100%; background:var(--bg-main); border:none; border-radius:14px; padding:1.2rem; font-size:1rem; color:var(--text-main); margin-bottom:1.5rem; outline:none; box-sizing:border-box;" placeholder="${t('Ievadiet parakstu (neobligāti)', 'Enter caption (optional)')}">

            <div style="display:flex; gap:10px;">
                <button onclick="document.getElementById('photo-details-overlay').remove()" style="flex:1; background:var(--glass-border); color:var(--text-muted); border:none; font-weight:700; font-size:1rem; padding:1.2rem; border-radius:16px; cursor:pointer;">${t('Atcelt', 'Cancel')}</button>
                <button onclick="saveFinalPhoto('${imgUrl}')" style="flex:1; background:var(--color-primary); color:var(--bg-primary); border:none; font-weight:700; font-size:1rem; padding:1.2rem; border-radius:16px; cursor:pointer;">${t('Pievienot', 'Add')}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    setTimeout(() => {
        const input = document.getElementById('photo-caption-input');
        if (input) input.focus();
    }, 100);
};

window.saveFinalPhoto = async (imgUrl) => {
    const caption = document.getElementById('photo-caption-input').value || '';
    document.getElementById('photo-details-overlay').remove();

    if (!db.linkCode) {
        // Not linked, keep local only
        db.photos.unshift({ id: Date.now(), dataUrl: imgUrl, title: caption });
        saveDBLocal();
        navigate('photos');
        return;
    }

    showToast(t("Augšupielādē...", "Uploading..."), t("Mirkļa iemūžināšana...", "Capturing the moment..."), "info");

    try {
        const id = Date.now();
        const downloadUrl = await uploadImage(imgUrl, `games/${db.linkCode}/photos/${id}.jpg`);
        
        // NEW: Atomic write using push() to prevent race conditions
        const imageRef = firebaseDB.ref(`games/${db.linkCode}/state/images`).push();
        await imageRef.set({ 
            id: id, 
            imageUrl: downloadUrl,
            title: caption,
            authorUID: myUID
        });
        
        showToast(t("Gatavs!", "Success!"), t("Atmiņa saglabāta", "Memory saved"), "success");
    } catch (e) {
        console.error(e);
        showToast(t("Kļūda", "Error"), t("Neizdevās saglabāt atmiņu", "Failed to save memory"), "warning");
    }
    
    navigate('photos');
};

window.editPhotoTitle = (id, newTitle) => {
    const p = db.photos.find(p => p.id === id);
    if (p) { p.title = newTitle; saveDBLocal(); }
};

window.viewPhoto = (id) => {
    const p = db.photos.find(p => p.id === id);
    if (!p) return;
    const finalImg = p.imageUrl || p.dataUrl;
    showOverlay(`
        <div style="text-align: center;">
            <img src="${finalImg}" style="width: 100%; max-height: 50vh; object-fit: contain; border-radius: 8px; margin-bottom: 1.5rem; background:black;">
            <h3 style="font-family: 'Playfair Display', serif; font-size: 1.5rem; margin-bottom: 1rem;">${p.title}</h3>
            <button onclick="downloadPhotoRaw('${finalImg}')" class="btn-primary" style="display:inline-flex; width: auto; padding: 1rem 2rem; border-radius: 30px;"><i class="fa-solid fa-download"></i> ${t('Saglabāt Bildi', 'Save Photo')}</button>
        </div>
    `);
};

// Dashboard helpers
function getDetailedTimeStats() {
    const startStr = db.relationship_start || '2025-01-01';
    const start = new Date(startStr);
    const now = new Date();

    if (isNaN(start.getTime())) return { years: 0, months: 0, days: 0 };

    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    let days = now.getDate() - start.getDate();

    if (days < 0) {
        months--;
        const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
        days += prevMonth;
    }

    if (months < 0) {
        years--;
        months += 12;
    }

    return { years, months, days };
}

function getTimeTogether() {
    const stats = getDetailedTimeStats();
    let resLv = []; let resEn = [];
    if (stats.years > 0) { resLv.push(`${stats.years} ${stats.years === 1 ? 'gads' : 'gadi'}`); resEn.push(`${stats.years} ${stats.years === 1 ? 'year' : 'years'}`); }
    if (stats.months > 0) { resLv.push(`${stats.months} ${stats.months === 1 ? 'mēn.' : 'mēn.'}`); resEn.push(`${stats.months} ${stats.months === 1 ? 'mo.' : 'mo.'}`); }
    if (stats.days > 0 || resLv.length === 0) { resLv.push(`${stats.days} ${stats.days === 1 ? 'diena' : 'dienas'}`); resEn.push(`${stats.days} ${stats.days === 1 ? 'day' : 'days'}`); }
    return t(resLv.join(', '), resEn.join(', '));
}

window.toggleActivityChart = () => {
    const el = document.getElementById('dash-chart-panel');
    if (el) el.classList.toggle('hidden');
};

window.toggleShopPromo = () => {
    const packaging = document.getElementById('shop-packaging');
    const products = document.getElementById('shop-products');
    if (!packaging || !products) return;

    if (products.style.display === 'none') {
        // Expand: hide packaging, show products
        packaging.style.opacity = '0';
        packaging.style.transform = 'scale(0.95)';
        setTimeout(() => {
            packaging.style.display = 'none';
            products.style.display = 'block';
            requestAnimationFrame(() => {
                products.style.opacity = '1';
            });
        }, 300);
    } else {
        // Collapse: show packaging, hide products
        products.style.opacity = '0';
        setTimeout(() => {
            products.style.display = 'none';
            packaging.style.display = 'block';
            requestAnimationFrame(() => {
                packaging.style.opacity = '1';
                packaging.style.transform = 'scale(1)';
            });
        }, 300);
    }
};

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
        else if (percentage >= 70) { lvl = 'Lielisks virziens'; color = '#555555'; }
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
    if (!db || !db.auth) return renderAuth(document.getElementById('auth-guard'));

    const recent = (db.history || []).slice(0, 5);

    const myCompletedTaskCount = (db.coupons || []).filter(c => c.status === 'done' && c.sender !== db.auth.email).length;
    const pendingCoupons = (db.coupons || []).filter(c => c.status === 'pending').length;
    const photosCount = (db.photos || []).length;
    const totalPoints = (db.points || 0) + (db.auth.myPoints || 0) + (db.auth.partnerPoints || 0);
    const timeStats = getDetailedTimeStats();
    const scr = getRelationshipScore();

    const myName = db.auth.username || t('Es', 'Me');
    const partName = db.auth.partnerUsername || t('Partneris', 'Partner');
    const combinedNames = `${myName} un ${partName}`;

    const myAvatar = db.auth.myAvatar;
    const partAvatar = db.auth.partnerAvatar;

    let goalsHtml = '';
    const emptyGoalsText = db.kidsMode ? t('Vēl neesat izvirzījuši šī gada mērķus.', 'No goals set for this year yet.') : t('Vēl neesat izvirzījuši attiecību mērķus.', 'No relationship goals yet.');
    if (!db.goals || db.goals.length === 0) {
        goalsHtml = `<div style="font-size:0.85rem; color:var(--text-muted); font-weight:600; width:100%; text-align:center; padding:12px 0; opacity:0.7;"><i class="fa-solid fa-flag" style="margin-right:6px;"></i>${emptyGoalsText}</div>`;
    } else {
        db.goals.forEach(g => {
            if (g.achieved) {
                goalsHtml += `<div style="display:flex; align-items:center; gap:6px; background:linear-gradient(135deg, #FF5A7E, #C084FC); color:white; padding:6px 14px; border-radius:20px; font-size:0.78rem; font-weight:700; cursor:pointer; box-shadow: 0 4px 12px rgba(255,90,126,0.3);" onclick="window.manageGoals()"><i class="fa-solid fa-check" style="font-size:0.65rem;"></i>&nbsp;<i class="fa-solid ${g.icon}"></i>&nbsp;<span>${g.title}${g.year ? ` (${g.year})` : ''}</span></div>`;
            } else {
                goalsHtml += `<div style="display:flex; align-items:center; gap:6px; background:var(--glass-border); color:var(--text-muted); padding:6px 14px; border-radius:20px; font-size:0.78rem; font-weight:700; cursor:pointer; border: 1.5px dashed var(--glass-border);" onclick="window.manageGoals()"><i class="fa-solid ${g.icon}"></i>&nbsp;<span>${g.title}${g.year ? ` (${g.year})` : ''}</span></div>`;
            }
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
                        <div style="display:flex; align-items:center; gap:10px;">
                            <h1 style="margin:0; color:var(--text-main);">${combinedNames}</h1>
                            <div onclick="window.toggleDarkMode()" style="cursor:pointer; font-size:1.2rem; color:var(--text-muted); transition:0.3s;">
                                <i class="fa-solid fa-palette"></i>
                            </div>
                        </div>
                        <p style="margin:0; color:var(--text-muted);">${db.kidsMode ? t('Mūsu komanda', 'Our family team') : t('Jūsu mīlas stāsts', 'Your love story')}</p>
                    </div>
                </div>
            </div>

           <input type="file" id="avatar-upload" accept="image/*" data-mode="avatar" onchange="uploadPhoto(this)" style="display:none;">

           <div class="dash-hero-card animate-fade-in" style="animation-delay: 0.1s;">
               <div class="dash-hero-top">
                   <div class="dash-heart">
                       <i class="fa-solid fa-heart"></i>
                   </div>

                   <div class="dash-stats-grid">
                       ${db.kidsMode ? `
                       <div class="dash-stat-col">
                           <h2>${totalPoints}</h2>
                           <p>${t('Punkti', 'Points')}</p>
                       </div>
                       <div class="dash-stat-col">
                           <h2>${myCompletedTaskCount}</h2>
                           <p>${t('Uzdevumi', 'Tasks')}</p>
                       </div>
                       <div class="dash-stat-col">
                           <h2>${db.magnets ? db.magnets.length : 0}</h2>
                           <p>${t('Magnēti', 'Magnets')}</p>
                       </div>
                       ` : `
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
                       `}
                   </div>
               </div>

               <div class="dash-hero-bottom">
                   <div class="dash-progress-title">${db.kidsMode ? t('Sasniegumi', 'Achievements') : t('Sasniegtie mērķi', 'Achieved goals')}</div>
                   <div class="dash-progress-wrap">
                       <div class="dash-progress-bar">
                           <div class="dash-progress-fill" style="width: ${scr.percentage}%; background: ${scr.color};"></div>
                       </div>
                       <div class="dash-progress-val">${scr.percentage}%</div>
                   </div>

                   <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.8rem;">
                       <div class="dash-progress-title" style="margin-bottom:0;">${db.kidsMode ? t('Bērna apņemšanās', 'Child commitments') : t('Attiecību Mērķi', 'Relationship Goals')}</div>
                       <div onclick="window.manageGoals()" style="color:#FF5A7E; font-size:0.8rem; font-weight:800; cursor:pointer; display:flex; align-items:center; gap:5px;">
                           <i class="fa-solid fa-pen"></i> ${t('Pārvaldīt', 'Manage')}
                       </div>
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
                    <i class="fa-solid fa-magnet"></i>
                    <span>${t('Magnēti', 'Magnets')}</span>
                </div>
           </div>

           <!-- SHOP PROMO SECTION -->
           <div class="animate-fade-in" style="animation-delay: 0.33s; margin-bottom:1.5rem;">
               <div id="shop-promo-card" style="position:relative; border-radius:24px; overflow:hidden; cursor:pointer; box-shadow:0 10px 40px rgba(0,0,0,0.12);" onclick="toggleShopPromo()">
                   <!-- Packaging hero (initial state) -->
                   <div id="shop-packaging" style="transition:all 0.6s cubic-bezier(0.4, 0, 0.2, 1);">
                       <img src="assets/baneris.PNG" style="width:100%; display:block; border-radius:24px;" alt="Framed Date">
                       <div style="position:absolute; bottom:0; left:0; right:0; padding:24px; background:linear-gradient(transparent, rgba(0,0,0,0.75)); border-radius:0 0 24px 24px;">
                           <p style="margin:0 0 4px 0; font-size:0.75rem; font-weight:700; color:rgba(255,255,255,0.7); text-transform:uppercase; letter-spacing:2px;">${t('FIZISKAIS PRODUKTS', 'PHYSICAL PRODUCT')}</p>
                           <h3 style="margin:0 0 8px 0; font-size:1.4rem; font-weight:800; color:white; letter-spacing:-0.5px;">Framed Date</h3>
                           <p style="margin:0; font-size:0.85rem; color:rgba(255,255,255,0.8);">${t('Nospied, lai apskatītu produktus →', 'Tap to explore products →')}</p>
                       </div>
                   </div>

                   <!-- Expanded products (hidden initially) -->
                   <div id="shop-products" style="display:none; opacity:0; transition:all 0.5s ease;">
                       <div style="padding:24px 20px; background:var(--bg-panel);">
                           <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px;">
                               <h3 style="margin:0; font-size:1.2rem; font-weight:800; color:var(--text-main); letter-spacing:-0.3px;">${t('Mūsu preces', 'Our Products')}</h3>
                               <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">Framed Date</span>
                           </div>
                           <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                               <!-- Frame Product -->
                               <div style="border-radius:20px; overflow:hidden; background:var(--color-secondary); border:1px solid var(--glass-border); cursor:pointer;" onclick="event.stopPropagation(); zoomImage('assets/shop_frame.png');">
                                   <div style="aspect-ratio:1; overflow:hidden;">
                                       <img src="assets/shop_frame.png" style="width:100%; height:100%; object-fit:cover;" alt="Rāmis">
                                   </div>
                                   <div style="padding:14px;">
                                       <h4 style="margin:0 0 4px 0; font-size:0.9rem; font-weight:800; color:var(--text-main);">${t('Rāmis 25x25', 'Frame 25x25')}</h4>
                                       <p style="margin:0 0 12px 0; font-size:0.75rem; color:var(--text-muted);">${t('Magnētiskais foto rāmis', 'Magnetic photo frame')}</p>
                                       <a href="#" onclick="event.stopPropagation(); zoomImage('assets/shop_frame.png'); return false;" style="display:block; text-align:center; padding:10px; background:var(--text-main); color:var(--bg-primary); border-radius:12px; font-weight:700; font-size:0.8rem; text-decoration:none; transition:opacity 0.2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
                                           <i class="fa-solid fa-expand" style="margin-right:4px;"></i> ${t('Apskatīt', 'View')}
                                       </a>
                                   </div>
                               </div>
                               <!-- Magnets Product -->
                               <div style="border-radius:20px; overflow:hidden; background:var(--color-secondary); border:1px solid var(--glass-border); cursor:pointer;" onclick="event.stopPropagation(); zoomImage('assets/shop_magnets.png');">
                                   <div style="aspect-ratio:1; overflow:hidden;">
                                       <img src="assets/shop_magnets.png" style="width:100%; height:100%; object-fit:cover;" alt="Magnēti">
                                   </div>
                                   <div style="padding:14px;">
                                       <h4 style="margin:0 0 4px 0; font-size:0.9rem; font-weight:800; color:var(--text-main);">${t('18 Magnēti', '18 Magnets')}</h4>
                                       <p style="margin:0 0 12px 0; font-size:0.75rem; color:var(--text-muted);">${t('Pāru uzdevumu komplekts', 'Couple task set')}</p>
                                       <a href="#" onclick="event.stopPropagation(); zoomImage('assets/shop_magnets.png'); return false;" style="display:block; text-align:center; padding:10px; background:var(--text-main); color:var(--bg-primary); border-radius:12px; font-weight:700; font-size:0.8rem; text-decoration:none; transition:opacity 0.2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
                                           <i class="fa-solid fa-expand" style="margin-right:4px;"></i> ${t('Apskatīt', 'View')}
                                       </a>
                                   </div>
                               </div>
                           </div>
                       </div>
                   </div>
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

    // Social Links Footer
    html += `
        <div class="dash-social-footer animate-fade-in" style="animation-delay: 0.5s; text-align:center; margin-top:2.5rem; padding-bottom:1rem; border-top:1px solid var(--glass-border); padding-top:1.5rem;">
            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.8rem; font-weight:600;">${t('Seko mums:', 'Follow us:')}</p>
            <div style="display:flex; justify-content:center; gap:15px;">
                <a href="https://instagram.com/frameddate" target="_blank" style="display:flex; align-items:center; justify-content:center; width:44px; height:44px; border-radius:50%; background:var(--glass-panel); color:var(--text-main); font-size:1.3rem; text-decoration:none; box-shadow:0 4px 12px rgba(0,0,0,0.08); transition:all 0.3s ease;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">
                    <i class="fa-brands fa-instagram"></i>
                </a>
                <a href="https://tiktok.com/@frameddate" target="_blank" style="display:flex; align-items:center; justify-content:center; width:44px; height:44px; border-radius:50%; background:var(--glass-panel); color:var(--text-main); font-size:1.3rem; text-decoration:none; box-shadow:0 4px 12px rgba(0,0,0,0.08); transition:all 0.3s ease;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">
                    <i class="fa-brands fa-tiktok"></i>
                </a>
            </div>
        </div>
    `;

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

    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dStr = d.toLocaleDateString(db.lang === 'en' ? 'en-US' : 'lv-LV', { month: 'short', day: 'numeric' });
        labels.push(dStr);
        dataPoints.push(0);
    }

    db.history.forEach(h => {
        const dStr = new Date(h.date).toLocaleDateString(db.lang === 'en' ? 'en-US' : 'lv-LV', { month: 'short', day: 'numeric' });
        const idx = labels.indexOf(dStr);
        if (idx !== -1) {
            dataPoints[idx] += 1;
        }
    });

    const isDark = document.body.classList.contains('dark-mode');
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = isDark ? "#A1A1A6" : "#86868b";

    window.activityChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: t('Notikumi', 'Events'),
                data: dataPoints,
                borderColor: '#FF9500',
                backgroundColor: isDark ? 'rgba(255, 149, 0, 0.25)' : 'rgba(255, 149, 0, 0.15)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#FF9500',
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBorderColor: isDark ? '#1D1D1F' : '#ffffff',
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? 'rgba(45, 45, 50, 0.95)' : 'rgba(29, 29, 31, 0.9)',
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    titleColor: '#FFFFFF',
                    bodyColor: '#FFFFFF'
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: isDark ? "#A1A1A6" : "#86868b",
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 5
                    }
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
   Goals Management (Mērķi)
   ================================== */
window.manageGoals = () => {
    window.renderGoalsModal();
};

window.renderGoalsModal = () => {
    if (!window.goalsSelectedYear) window.goalsSelectedYear = new Date().getFullYear();
    const selYear = window.goalsSelectedYear;

    const ICON_EMOJIS = db.kidsMode ? {
        'fa-star': '⭐', 'fa-book': '📚', 'fa-bicycle': '🚲', 'fa-gamepad': '🎮',
        'fa-broom': '🧹', 'fa-brush': '🎨', 'fa-apple-whole': '🍎', 'fa-football': '⚽',
        'fa-music': '🎵', 'fa-paw': '🐾', 'fa-school': '🏫'
    } : {
        'fa-heart': '❤️', 'fa-baby': '👶', 'fa-house': '🏠', 'fa-dog': '🐶',
        'fa-cat': '🐱', 'fa-ring': '💍', 'fa-plane': '✈️', 'fa-car': '🚗',
        'fa-piggy-bank': '💰', 'fa-gift': '🎁', 'fa-star': '⭐'
    };

    // Collect all relevant years
    const allYears = new Set();
    const curYear = new Date().getFullYear();
    for (let i = 0; i <= 5; i++) allYears.add(curYear + i);
    if (db.goals) db.goals.forEach(g => { if (g.year) allYears.add(Number(g.year)); });
    const sortedYears = [...allYears].sort();

    const yearTabsHtml = sortedYears.map(y => `
        <button onclick="window.goalsSelectedYear=${y}; renderGoalsModal();"
            style="padding:8px 20px; border-radius:20px; border:none; font-size:0.85rem; font-weight:700; font-family:inherit; cursor:pointer; transition:all 0.2s; white-space:nowrap; flex-shrink:0;
            ${y === selYear
                ? 'background:var(--text-main); color:var(--bg-primary); box-shadow:0 2px 8px rgba(0,0,0,0.15);'
                : 'background:var(--color-secondary); color:var(--text-muted);'
            }">${y}</button>
    `).join('');

    // Filter goals by selected year
    const yearGoals = (db.goals || []).filter(g => Number(g.year) === selYear);

    let listHtml = '';
    if (yearGoals.length === 0) {
        listHtml = `<div style="text-align:center; color:var(--text-muted); font-size:0.9rem; padding:2.5rem 1rem;">
            <i class="fa-solid fa-bullseye" style="font-size:2.5rem; opacity:0.2; display:block; margin-bottom:1rem;"></i>
            ${t('Nav mērķu šim gadam. Pievieno pirmo!', 'No goals for this year. Add your first!')}
        </div>`;
    } else {
        yearGoals.forEach(g => {
            const emoji = ICON_EMOJIS[g.icon] || '🎯';
            const done = g.achieved;
            listHtml += `
                <div style="display:flex; align-items:center; gap:14px; background:var(--bg-panel); padding:14px 16px; border-radius:16px; margin-bottom:10px; border:1px solid var(--glass-border); ${done ? 'opacity:0.5;' : ''}">
                    <div onclick="toggleGoal(${g.id})" style="cursor:pointer; font-size:1.4rem; flex-shrink:0; width:32px; text-align:center;">
                        ${done
                            ? '<i class="fa-solid fa-circle-check" style="color:#34C759; font-size:1.3rem;"></i>'
                            : '<i class="fa-regular fa-circle" style="color:var(--text-muted); font-size:1.3rem;"></i>'
                        }
                    </div>
                    <div style="flex:1; min-width:0; display:flex; align-items:center; gap:8px;">
                        <span style="font-size:1.3rem;">${emoji}</span>
                        <span style="font-weight:700; font-size:0.95rem; color:var(--text-main); ${done ? 'text-decoration:line-through;' : ''}">${g.title}</span>
                    </div>
                    <button onclick="deleteGoal(${g.id})" style="background:none; border:none; color:var(--text-muted); font-size:0.8rem; cursor:pointer; padding:8px; opacity:0.4;">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>`;
        });
    }

    // Icon picker options
    const iconOptions = Object.entries(ICON_EMOJIS).map(([val, em]) => `<option value="${val}">${em}</option>`).join('');

    const popupHtml = `
        <div style="padding:5px;">
            <h2 style="font-size:1.5rem; font-weight:800; text-align:center; margin-bottom:1.5rem; letter-spacing:-0.5px; color:var(--text-main);">${db.kidsMode ? t('Bērna apņemšanās', 'Child commitments') : t('Mūsu Lielie Mērķi', 'Our Big Goals')}</h2>

            <div style="display:flex; gap:8px; overflow-x:auto; padding-bottom:8px; margin-bottom:1.5rem; scrollbar-width:none;">
                ${yearTabsHtml}
            </div>

            <div style="max-height:40vh; overflow-y:auto; margin-bottom:1.5rem;">
                ${listHtml}
            </div>

            <div style="background:var(--bg-panel); padding:20px; border-radius:20px; border:1px solid var(--glass-border);">
                <h4 style="margin-bottom:14px; font-size:0.8rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">${db.kidsMode ? t('Pievienot jaunu apņemšanos', 'Add new commitment') : t('Pievienot jaunu mērķi', 'Add new goal')}</h4>
                <div style="display:flex; gap:10px; margin-bottom:14px;">
                    <select id="goalIconSel" class="input-field" style="width:65px; padding:10px 5px; text-align:center; font-size:1.3rem; border-radius:14px;">
                        ${iconOptions}
                    </select>
                    <input type="text" id="goalTitleInput" class="input-field" placeholder="${db.kidsMode ? t('Piem., Sakārtot istabu', 'E.g., Tidy my room') : t('Piem., Kopīgs mājoklis', 'E.g., Our own house')}" style="flex:1; padding:12px 14px; border-radius:14px;">
                </div>
                <input type="hidden" id="goalYearSel" value="${selYear}">
                <button class="btn-primary" style="border-radius:14px; padding:14px;" onclick="addGoal()">
                    <i class="fa-solid fa-plus" style="margin-right:6px;"></i> ${db.kidsMode ? t('Pievienot apņemšanos', 'Add Commitment') : t('Pievienot Mērķi', 'Add Goal')}
                </button>
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

    db.history.unshift({ id: Date.now(), date: new Date().toISOString(), title: db.kidsMode ? `Jauna apņemšanās: ${title}` : `Jauns attiecību mērķis: ${title}`, points: 0 });
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

/* ==================================
   Initialization
   ================================== */
window.showLoading = (text = null) => {
    const loader = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    if (loader) {
        if (text && loadingText) loadingText.innerText = text;
        loader.style.display = 'flex';
        loader.classList.remove('fade-out');
    }
};

window.hideLoading = () => {
    const loader = document.getElementById('loading-overlay');
    if (loader) {
        loader.classList.add('fade-out');
        setTimeout(() => loader.style.display = 'none', 500);
    }
};

window.continueOffline = () => {
    hideLoading();
};

document.addEventListener('DOMContentLoaded', () => {
    try {
        loadDB();

        if (!db.auth) {
            navigate('timeline');
        } else {
            navigate(currentRoute);
        }

        updateHeader();
        if (typeof checkQRMagnet === 'function') checkQRMagnet();
        if (typeof handleDeepLinks === 'function') handleDeepLinks();

        // Hide loading after a reasonable timeout
        setTimeout(hideLoading, 3000);
    } catch (e) {
        console.error("Initialization Error:", e);
        hideLoading();
    }
});
