/* ============================================================================
   OMEGA SSO — the tenant side. ONE SCRIPT TAG, nothing else to change.

   Add this as the FIRST script in the <head> of any app the gateway hands
   off to — the ClearSky portal, OGI Solar, the ops console, financing:

       <script type="module" src="https://clearskyomega.com/omega-sso.js"></script>

   What it does, and only when it sees #omega_sso= in the URL:

     1. Takes the token out of the address bar immediately, so it never
        lands in history, a screenshot, or the next page's Referer.
     2. Trades it at /api/omega-sso for a Firebase custom token.
     3. Signs in with that token, which writes the session into this
        origin's IndexedDB.
     4. Reloads the page, clean. Your app then boots with a signed-in user
        and shows the dashboard instead of a login form.

   The reload is deliberate. Firebase keeps its session under a key built
   from the API key and the app name, so a session created here is visible
   to your app's own getAuth() on the next load — even if your app bundles a
   different copy or version of the SDK. No shared imports, no coupling to
   how your app is built.

   On ANY failure it does nothing at all and your normal login screen
   appears. The worst case is the sign-in the user would have had anyway.
   ========================================================================= */

(async function () {
  const HASH_KEY = 'omega_sso';

  /* The Cloud Function inside the clearsky-portal project. v1 URLs are
     deterministic — <region>-<project>.cloudfunctions.net/<name> — so this
     can be hardcoded. If `firebase deploy` prints a different URL, paste
     that one here instead. */
  const EXCHANGE = 'https://us-central1-clearsky-portal.cloudfunctions.net/omegaSso';

  /* Same project as the gateway. Public web config — safe in the browser;
     your Firestore rules are what enforce access. */
  const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyABoM1lgOYUnd5ZadaoTMhYmA9cHa8Tyo0",
    authDomain:        "clearsky-portal.firebaseapp.com",
    projectId:         "clearsky-portal",
    storageBucket:     "clearsky-portal.firebasestorage.app",
    messagingSenderId: "742134484347",
    appId:             "1:742134484347:web:ab0f95fd221536158481de"
  };

  const params  = new URLSearchParams(location.hash.slice(1));
  const idToken = params.get(HASH_KEY);
  if (!idToken) return;                 // Normal visit. Do nothing.

  /* Out of the URL before anything else can read it. */
  history.replaceState(null, '', location.pathname + location.search);

  /* A guard against a reload loop: if the exchange succeeds but the app
     still can't see a user, we must not try again forever. */
  const GUARD = 'omega_sso_attempt';
  try {
    if (sessionStorage.getItem(GUARD)) { sessionStorage.removeItem(GUARD); return; }
    sessionStorage.setItem(GUARD, '1');
  } catch (_) { /* private mode — carry on without the guard */ }

  try {
    const r = await fetch(EXCHANGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    if (!r.ok) throw new Error('exchange failed: ' + r.status);
    const { customToken } = await r.json();
    if (!customToken) throw new Error('no token returned');

    const V = 'https://www.gstatic.com/firebasejs/10.12.5/';
    const [{ initializeApp, getApps, getApp }, auth] = await Promise.all([
      import(V + 'firebase-app.js'),
      import(V + 'firebase-auth.js')
    ]);

    /* Reuse the page's default app if it already made one with these
       options; otherwise create it. Either way the session lands under the
       same persistence key your app reads. */
    const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
    const A = auth.getAuth(app);
    await auth.setPersistence(A, auth.browserLocalPersistence).catch(() => {});
    await auth.signInWithCustomToken(A, customToken);

    try { sessionStorage.removeItem(GUARD); } catch (_) {}
    location.replace(location.pathname + location.search);
  } catch (err) {
    /* Deliberately quiet for the user: they simply see the normal login. */
    console.warn('[omega-sso] handoff did not complete:', err && err.message);
    try { sessionStorage.removeItem(GUARD); } catch (_) {}
  }
})();
