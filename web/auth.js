/* ---------- TradeLista Auth ----------
   Backed by Supabase (real accounts, real Postgres database). Requires the
   Supabase JS client <script> tag to be loaded before this file — see the
   <script src="vendor/supabase.js"> tag near the top of each page.

   All TLAuth methods that touch the network are async — callers must
   `await` them.
*/
(function(){
  const SUPABASE_URL = 'https://xkmpknoughjnxalkoatx.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_I4mtWXDs_GejiJPvzA-v4w_1xT-G4Un';
  const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Per-account cap on trade-screenshot storage. Deliberately generous
  // relative to what a real trader's chart screenshots add up to (a few
  // hundred KB each) — this exists to bound a runaway/abuse case, not to be
  // something a normal user ever bumps into.
  const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024; // 1 GiB

  // Account labels are free text the user (or, in principle, a compromised
  // account) chooses — never interpolate them into innerHTML unescaped.
  function escapeHtml(str){
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  async function callFunction(name){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { ok:false, error:'Not logged in.' };
    const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      }
    });
    const body = await res.json().catch(() => ({}));
    if(!res.ok || !body.url) return { ok:false, error: body.error || 'Something went wrong. Please try again.' };
    return { ok:true, url: body.url };
  }

  // Unauthenticated on purpose — contact-form visitors aren't logged in.
  // A network-level failure (offline, DNS, an ad-blocker eating the
  // request, CORS misconfig) throws from fetch() itself, before there's
  // any response to check .ok on — without this catch, that throw would
  // propagate out of the caller's submit handler and leave its "Sending…"
  // button disabled forever, with no error ever shown.
  async function sendContactMessage({ firstName, lastName, email, subject, message, website }){
    let res;
    try {
      res = await fetch(`${FUNCTIONS_URL}/send-contact-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email, subject, message, website })
      });
    } catch (err) {
      return { ok:false, error: 'Could not reach the server. Check your connection and try again.' };
    }
    const body = await res.json().catch(() => ({}));
    if(!res.ok) return { ok:false, error: body.error || 'Something went wrong. Please try again.' };
    return { ok:true };
  }

  // Unauthenticated on purpose — required by law (§356a BGB) to be usable
  // without logging in, so the person submitting isn't assumed to still
  // have (or want) account access.
  async function submitWithdrawal({ name, contractRef, email, details, website }){
    let res;
    try {
      res = await fetch(`${FUNCTIONS_URL}/submit-withdrawal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, contractRef, email, details, website })
      });
    } catch (err) {
      return { ok:false, error: 'Could not reach the server. Check your connection and try again.' };
    }
    const body = await res.json().catch(() => ({}));
    if(!res.ok) return { ok:false, error: body.error || 'Something went wrong. Please try again.' };
    return { ok:true };
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ---------- Trades (real persistence for notes/images/reflections) ----------
  async function getUserTrades(){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return [];
    const { data, error } = await sb.from('trades').select('*').eq('user_id', session.user.id);
    if(error) return [];
    return data;
  }

  // `trade` is the full current state of one trade (base fields + note/images/
  // answers) — the caller always sends the whole row, since Supabase upsert
  // replaces it wholesale rather than merging individual columns.
  async function upsertTrade(trade){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { ok:false, error:'Not logged in.' };

    // Once storage is full, block anything that keeps growing it — but
    // deletes and clearing existing content (empty note/tags/answers) are
    // always let through, so being full doesn't permanently lock someone
    // out of the one thing that would free up space again.
    const hasContent = !!(
      (trade.note && trade.note.length) ||
      (trade.tags && trade.tags.length) ||
      (trade.answers && Object.keys(trade.answers).length)
    );
    if(!trade.is_deleted && hasContent){
      const { used, limit } = await getStorageUsage();
      if(used >= limit){
        return { ok:false, error: `You've used all ${Math.round(limit/(1024*1024))} MB of your storage — delete a screenshot or some notes to free up space before saving more.` };
      }
    }

    // Reflection answers are a Pro feature — notes and tags aren't, so only
    // block this one field rather than the whole save.
    if(trade.answers && Object.keys(trade.answers).length && !(await isProUser(session.user.id))){
      return { ok:false, error:'Reflection questions are a Pro feature. Upgrade to save answers to your trades.' };
    }

    const row = {
      id: trade.id,
      user_id: session.user.id,
      account_id: trade.account_id || null,
      is_manual: !!trade.is_manual,
      is_deleted: !!trade.is_deleted,
      date: trade.date || null,
      time: trade.time || null,
      tz_offset_minutes: trade.tz_offset_minutes ?? null,
      symbol: trade.symbol || null,
      lot: trade.lot ?? null,
      entry: trade.entry ?? null,
      exit_price: trade.exit ?? null,
      profit: trade.profit ?? null,
      side: trade.side || null,
      note: trade.note || '',
      images: trade.images || [],
      answers: trade.answers || {},
      tags: trade.tags || [],
      updated_at: new Date().toISOString()
    };
    const { error } = await sb.from('trades').upsert(row);
    if(error) return { ok:false, error: error.message };
    return { ok:true };
  }

  // Walks the user's trade-images folder (one subfolder per trade) and sums
  // real object sizes — computed live from Storage rather than a maintained
  // counter, since counters drift the moment something deletes a file
  // without going through the one code path that decrements them.
  async function getImagesUsageBytes(userId){
    async function sumFolder(path){
      const { data, error } = await sb.storage.from('trade-images').list(path, { limit: 1000 });
      if(error || !data) return 0;
      let total = 0;
      for(const entry of data){
        if(entry.id === null) total += await sumFolder(`${path}/${entry.name}`); // a "folder" (no real object) — recurse
        else if(entry.metadata && entry.metadata.size) total += entry.metadata.size;
      }
      return total;
    }
    return sumFolder(userId);
  }

  // The quota is "everything TradeLista stores for you", not just images —
  // notes, tags and reflection answers live as text in the trades table
  // rather than in Storage, but they still take up real space and a user
  // could in principle write enough of them to matter. Each is measured in
  // UTF-8 bytes (not JS string .length, which undercounts multi-byte
  // characters like emoji) so the number means the same thing as file size.
  async function getTextUsageBytes(){
    const trades = await getUserTrades();
    const enc = new TextEncoder();
    return trades.reduce((total, row) => {
      const note = row.note || '';
      const tags = JSON.stringify(row.tags || []);
      const answers = JSON.stringify(row.answers || {});
      return total + enc.encode(note).length + enc.encode(tags).length + enc.encode(answers).length;
    }, 0);
  }

  async function getStorageUsage(){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { used: 0, limit: STORAGE_LIMIT_BYTES, imagesUsed: 0, textUsed: 0 };
    const [imagesUsed, textUsed] = await Promise.all([
      getImagesUsageBytes(session.user.id),
      getTextUsageBytes(),
    ]);
    return { used: imagesUsed + textUsed, limit: STORAGE_LIMIT_BYTES, imagesUsed, textUsed };
  }

  // Removes the storage object a public URL points to — trade edits just
  // drop the URL from the trade row, which by itself leaves the file
  // orphaned in Storage forever (and permanently counted against quota).
  async function deleteTradeImage(url){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { ok:false, error:'Not logged in.' };
    const marker = '/trade-images/';
    const idx = url.indexOf(marker);
    if(idx === -1) return { ok:false, error:'Could not determine which file to delete.' };
    const path = decodeURIComponent(url.slice(idx + marker.length));
    const { error } = await sb.storage.from('trade-images').remove([path]);
    if(error) return { ok:false, error: error.message };
    return { ok:true };
  }

  // Deletes every Storage object under one trade's folder
  // (`{userId}/{tradeId}/…`) in a single sweep. A trade's screenshots live
  // there in two shapes — the image-slot pictures and any embedded inline in
  // the note — and both go in the same folder, so deleting the folder frees
  // all of them at once. deleteTradeById relies on this: dropping just the
  // slot URLs (as it used to) left every inline note image orphaned in
  // Storage, still counting against the quota.
  async function deleteTradeFolder(tradeId){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { ok:false, error:'Not logged in.' };
    const prefix = `${session.user.id}/${tradeId}`;
    const { data, error } = await sb.storage.from('trade-images').list(prefix, { limit: 1000 });
    if(error) return { ok:false, error: error.message };
    const paths = (data || []).filter(e=>e.id !== null).map(e=>`${prefix}/${e.name}`);
    if(!paths.length) return { ok:true };
    const { error: rmErr } = await sb.storage.from('trade-images').remove(paths);
    if(rmErr) return { ok:false, error: rmErr.message };
    return { ok:true };
  }

  // Garbage-collects orphaned screenshots — Storage files that no live trade
  // points at any more. Inline note images live embedded in the note HTML
  // (not in the images array), so removing one from a note, swapping it out
  // via the draw editor, or deleting the trade used to drop only the
  // reference and leave the file behind, counting against the quota forever.
  // This reconciles the bucket against everything the account references now,
  // which both keeps the usage number honest and heals files orphaned before
  // the delete paths were fixed. `keepUrls` is an extra allow-list (raw note
  // HTML strings and/or plain URLs) the caller passes so an image inserted a
  // moment ago but not yet synced to the trades table is never swept.
  async function reconcileStorage(keepUrls){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { removed: 0 };
    const userId = session.user.id;

    const marker = '/trade-images/';
    const referenced = new Set();
    const addPath = (url)=>{
      if(typeof url !== 'string') return;
      const i = url.indexOf(marker);
      if(i === -1) return;
      referenced.add(decodeURIComponent(url.slice(i + marker.length)));
    };
    const addFromHtml = (html)=>{
      if(typeof html !== 'string' || html.indexOf(marker) === -1) return;
      const m = html.match(/[^\s"'()<>]+\/trade-images\/[^\s"'()<>]+/g);
      if(m) m.forEach(addPath);
    };

    // What the server currently knows about — live trades only. A deleted
    // trade's images must NOT be kept: they're exactly what we want to sweep.
    const trades = await getUserTrades();
    for(const row of trades){
      if(row.is_deleted) continue;
      if(Array.isArray(row.images)) row.images.forEach(addPath);
      addFromHtml(row.note);
    }
    // Plus the client's own not-yet-synced copy (notes persist on an 800ms
    // debounce), so a just-inserted screenshot is never swept mid-edit.
    if(Array.isArray(keepUrls)) keepUrls.forEach(u=>{ addPath(u); addFromHtml(u); });

    const toDelete = [];
    async function scan(path){
      const { data, error } = await sb.storage.from('trade-images').list(path, { limit: 1000 });
      if(error || !data) return;
      for(const entry of data){
        const full = `${path}/${entry.name}`;
        if(entry.id === null) await scan(full);             // a "folder" — recurse
        else if(!referenced.has(full)) toDelete.push(full); // real object, unreferenced
      }
    }
    await scan(userId);

    // remove() caps at ~1000 paths per call; chunk to stay well under it.
    for(let i = 0; i < toDelete.length; i += 100){
      await sb.storage.from('trade-images').remove(toDelete.slice(i, i + 100));
    }
    return { removed: toDelete.length };
  }

  async function uploadTradeImage(tradeId, file){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { ok:false, error:'Not logged in.' };
    if(!(await isProUser(session.user.id))) return { ok:false, error:'Image uploads are a Pro feature. Upgrade to add screenshots to your trades.' };
    const { used, limit } = await getStorageUsage();
    if(used + file.size > limit){
      const usedMb = Math.round(used / (1024*1024));
      const limitMb = Math.round(limit / (1024*1024));
      return { ok:false, error: `You've used ${usedMb} MB of your ${limitMb} MB storage. Delete a few old screenshots to make room, or try a smaller image.` };
    }
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `${session.user.id}/${tradeId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const { error } = await sb.storage.from('trade-images').upload(path, file, { contentType: file.type });
    if(error) return { ok:false, error: error.message };
    const { data } = sb.storage.from('trade-images').getPublicUrl(path);
    return { ok:true, url: data.publicUrl };
  }

  // ---------- Trading accounts (Live/Demo, MT4/MT5) ----------
  async function getAccounts(){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return [];
    const { data, error } = await sb.from('trading_accounts').select('*').eq('user_id', session.user.id).order('created_at');
    if(error) return [];
    return data;
  }

  // Free accounts can only ever have the one default account (manual entry
  // only); Pro accounts can connect up to 5. The very first (default)
  // account a user gets is exempt — everyone needs at least one to use the
  // app at all, regardless of plan.
  async function accountLimitFor(){
    return (await TLAuth.isPro()) ? 5 : 1;
  }

  async function createAccount({ label, account_type, platform, currency, is_default }){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { ok:false, error:'Not logged in.' };
    label = (label || '').trim();
    if(!label) return { ok:false, error:'Please enter a name for this account.' };
    if(!is_default){
      const existing = await getAccounts();
      const limit = await accountLimitFor();
      if(existing.length >= limit){
        return { ok:false, error: limit === 1
          ? 'Free plan is limited to 1 account. Upgrade to Pro to connect up to 5 accounts.'
          : `You've reached the maximum of ${limit} trading accounts.` };
      }
    }
    const row = {
      user_id: session.user.id,
      label,
      account_type: account_type === 'demo' ? 'demo' : 'live',
      platform: platform === 'MT5' ? 'MT5' : 'MT4',
      currency: (currency || 'USD').trim().toUpperCase(),
      is_default: !!is_default
    };
    const { data, error } = await sb.from('trading_accounts').insert(row).select().single();
    if(error) return { ok:false, error: error.message };
    return { ok:true, account: data };
  }

  async function updateAccount(id, fields){
    const { error } = await sb.from('trading_accounts').update(fields).eq('id', id);
    if(error) return { ok:false, error: error.message };
    return { ok:true };
  }

  async function deleteAccount(id){
    const { error } = await sb.from('trading_accounts').delete().eq('id', id);
    if(error) return { ok:false, error: error.message };
    return { ok:true };
  }

  // Invalidates the old key immediately — any EA still using it starts
  // failing on its next send, which is the point (this is how a leaked key
  // gets revoked without deleting the whole account and its trade history).
  async function regenerateApiKey(id){
    const newKey = crypto.randomUUID();
    const { data, error } = await sb.from('trading_accounts')
      .update({ api_key: newKey })
      .eq('id', id)
      .select()
      .single();
    if(error) return { ok:false, error: error.message };
    return { ok:true, account: data };
  }

  // Which account the calendar is currently scoped to. Kept in localStorage
  // (not Supabase) since it's a per-browser view preference, not user data.
  const ACTIVE_ACCOUNT_KEY = 'tradelista_active_account';
  function getActiveAccountId(){
    return localStorage.getItem(ACTIVE_ACCOUNT_KEY) || null;
  }
  function setActiveAccountId(id){
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
  }

  // Ensures every user has at least one trading account, so the multi-account
  // system has somewhere to attach existing/new trades to. The first account
  // ever created for a user is marked is_default — existing trades (which
  // predate this feature and have a null account_id) are treated by the
  // client as belonging to whichever account has that flag, so nothing a
  // user already logged disappears the day this shipped.
  async function ensureDefaultAccount(){
    const accounts = await getAccounts();
    if(accounts.length) return accounts;
    const res = await createAccount({ label:'FTMO 100k', account_type:'live', platform:'MT4', currency:'USD', is_default:true });
    return res.ok ? [res.account] : [];
  }

  async function getSessionUser(){
    const { data: { session } } = await sb.auth.getSession();
    return session ? session.user : null;
  }

  async function fetchProfile(userId){
    const { data, error } = await sb.from('profiles').select('*').eq('id', userId).single();
    if(error || !data) return null;
    return {
      id: data.id,
      firstName: data.first_name,
      lastName: data.last_name,
      plan: data.plan,
      stripeCustomerId: data.stripe_customer_id,
      stripeSubscriptionId: data.stripe_subscription_id,
      periodEnd: data.period_end ? new Date(data.period_end).getTime() : null,
      cancelAtPeriodEnd: data.cancel_at_period_end
    };
  }

  // Shared by TLAuth.isPro() and every server-reachable function that gates
  // a Pro-only feature (image uploads, reflection answers) — those checks
  // used to live only in the UI's requirePro() calls, which is trivial to
  // bypass from the browser console since it never touched the functions
  // actually doing the writing.
  async function isProUser(userId){
    const profile = await fetchProfile(userId);
    if(!profile || profile.plan !== 'pro') return false;
    if(profile.cancelAtPeriodEnd && profile.periodEnd && Date.now() >= profile.periodEnd){
      await sb.from('profiles').update({ plan:'free', cancel_at_period_end:false, period_end:null }).eq('id', userId);
      return false;
    }
    return true;
  }

  const TLAuth = {
    async isLoggedIn(){
      return !!(await getSessionUser());
    },

    async getCurrentUser(){
      const user = await getSessionUser();
      if(!user) return null;
      const profile = await fetchProfile(user.id);
      if(!profile) return null;
      return { ...profile, email: user.email };
    },

    async isPro(){
      const user = await getSessionUser();
      if(!user) return false;
      return isProUser(user.id);
    },

    async getPlanInfo(){
      const u = await this.getCurrentUser();
      if(!u) return null;
      const isPro = await this.isPro();
      return { plan: u.plan, isPro, cancelAtPeriodEnd: u.cancelAtPeriodEnd, periodEnd: u.periodEnd };
    },

    async signup({ firstName, lastName, email, password }){
      firstName = (firstName || '').trim();
      lastName = (lastName || '').trim();
      email = (email || '').trim().toLowerCase();
      if(!firstName || !lastName) return { ok:false, error:'Please enter your first and last name.' };
      if(!EMAIL_RE.test(email)) return { ok:false, error:'Please enter a valid email address.' };
      if(!password || password.length < 8) return { ok:false, error:'Password must be at least 8 characters.' };
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: {
          data: { first_name: firstName, last_name: lastName },
          // Without this, the confirmation email falls back to Supabase's
          // static "Site URL" dashboard setting regardless of where the
          // signup actually happened — explicit here so it always matches
          // whatever domain the person is really signing up from.
          // Land on the login page rather than straight in the app: auth.html
          // signs the freshly-created session back out and states in writing
          // that the address is verified, instead of silently dropping the
          // person into the calendar with no idea the click did anything.
          emailRedirectTo: `${location.origin}/auth.html?confirmed=1`
        }
      });
      if(error) return { ok:false, error: error.message };
      // Supabase's email-enumeration protection answers a signup for an address
      // that already has an account with a *fake* success: no error, but the
      // returned user carries an empty `identities` array. Without this check
      // the person is told to "check their inbox" for a confirmation mail that
      // is never sent, and they're stuck with no way forward.
      if(data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0){
        return { ok:false, error:'An account with this email already exists. Please log in instead, or use "Forgot your password?" to regain access.' };
      }
      if(!data.session) return { ok:true, needsConfirmation:true };
      return { ok:true };
    },

    async login({ email, password }){
      email = (email || '').trim().toLowerCase();
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if(error) return { ok:false, error: 'Incorrect email or password.' };
      return { ok:true };
    },

    async logout(){
      await sb.auth.signOut();
    },

    // Permanently deletes the account and everything tied to it (profile,
    // trading accounts, trades, screenshots) and cancels any active Stripe
    // subscription first. Irreversible — the confirmation UI calling this
    // needs to make that unmistakable.
    async deleteMyAccount(){
      const { data: { session } } = await sb.auth.getSession();
      if(!session) return { ok:false, error:'Not logged in.' };
      const res = await fetch(`${FUNCTIONS_URL}/delete-account`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      });
      const body = await res.json().catch(() => ({}));
      if(!res.ok) return { ok:false, error: body.error || 'Something went wrong. Please try again.' };
      await sb.auth.signOut();
      return { ok:true };
    },

    // Emails a recovery link that lands back on auth.html?mode=reset with a
    // Supabase recovery token in the URL — the client library picks that up
    // on its own and fires a PASSWORD_RECOVERY auth-state event, which the
    // page listens for to show the "set a new password" panel.
    async requestPasswordReset(email){
      email = (email || '').trim().toLowerCase();
      if(!EMAIL_RE.test(email)) return { ok:false, error:'Please enter a valid email address.' };
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/auth.html?mode=reset`
      });
      if(error) return { ok:false, error: error.message };
      return { ok:true };
    },

    // Only valid right after following a recovery-link redirect, which is
    // what supplies the short-lived session this relies on instead of the
    // current password changePassword() re-checks.
    async setPasswordAfterReset(newPassword){
      if(!newPassword || newPassword.length < 8) return { ok:false, error:'Password must be at least 8 characters.' };
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if(error) return { ok:false, error: error.message };
      return { ok:true };
    },

    // Fires once when Supabase's client picks up a recovery token from the
    // URL after a password-reset email link — the only reliable signal for
    // this, since exactly when the token finishes processing isn't
    // synchronous with page load.
    onPasswordRecovery(callback){
      sb.auth.onAuthStateChange((event) => {
        if(event === 'PASSWORD_RECOVERY') callback();
      });
    },

    // Redirects the browser to a real Stripe Checkout page for the Pro plan.
    // The `profiles` row is updated by the stripe-webhook Edge Function once
    // Stripe confirms the subscription — not by this call directly.
    async startCheckout(){
      return callFunction('create-checkout-session');
    },

    // Redirects the browser to the Stripe Billing Portal, where the user can
    // cancel or manage their subscription. Cancellation is reflected back
    // into `profiles` by the stripe-webhook Edge Function.
    async openBillingPortal(){
      return callFunction('create-portal-session');
    },

    // Backs the "Cancel contract here" button (§312k BGB): stops the Stripe
    // subscription from renewing at the end of the period already paid for,
    // and emails an immediate confirmation. Distinct from deleteMyAccount —
    // this only ends the subscription, not the whole account.
    async cancelSubscription(){
      const { data: { session } } = await sb.auth.getSession();
      if(!session) return { ok:false, error:'Not logged in.' };
      let res;
      try {
        res = await fetch(`${FUNCTIONS_URL}/cancel-subscription`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
      } catch (err) {
        return { ok:false, error: 'Could not reach the server. Check your connection and try again.' };
      }
      const body = await res.json().catch(() => ({}));
      if(!res.ok) return { ok:false, error: body.error || 'Something went wrong. Please try again.' };
      return { ok:true, periodEnd: body.periodEnd };
    },

    // Undoes a pending cancelSubscription() call. Calls the Stripe API
    // directly server-side rather than routing through the Stripe Billing
    // Portal's own "reactivate" button, which could not be confirmed to
    // work reliably in testing.
    async resumeSubscription(){
      const { data: { session } } = await sb.auth.getSession();
      if(!session) return { ok:false, error:'Not logged in.' };
      let res;
      try {
        res = await fetch(`${FUNCTIONS_URL}/resume-subscription`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
      } catch (err) {
        return { ok:false, error: 'Could not reach the server. Check your connection and try again.' };
      }
      const body = await res.json().catch(() => ({}));
      if(!res.ok) return { ok:false, error: body.error || 'Something went wrong. Please try again.' };
      return { ok:true, periodEnd: body.periodEnd };
    },

    async updateProfile({ firstName, lastName }){
      firstName = (firstName || '').trim();
      lastName = (lastName || '').trim();
      if(!firstName || !lastName) return { ok:false, error:'Please enter your first and last name.' };
      const u = await this.getCurrentUser();
      if(!u) return { ok:false, error:'Not logged in.' };
      const { error } = await sb.from('profiles')
        .update({ first_name:firstName, last_name:lastName })
        .eq('id', u.id);
      if(error) return { ok:false, error: error.message };
      return { ok:true };
    },

    async changePassword({ currentPassword, newPassword }){
      if(!newPassword || newPassword.length < 8) return { ok:false, error:'New password must be at least 8 characters.' };
      const user = await getSessionUser();
      if(!user) return { ok:false, error:'Not logged in.' };
      const { error: reAuthError } = await sb.auth.signInWithPassword({ email: user.email, password: currentPassword || '' });
      if(reAuthError) return { ok:false, error:'Current password is incorrect.' };
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if(error) return { ok:false, error: error.message };
      return { ok:true };
    },

    sendContactMessage,
    submitWithdrawal
  };

  /* ---------- Shared modal UI ---------- */
  function ensureStyles(){
    if(document.getElementById('tl-auth-style')) return;
    const style = document.createElement('style');
    style.id = 'tl-auth-style';
    style.textContent = `
      .tl-overlay{
        position:fixed; inset:0; background:rgba(5,7,11,0.72); backdrop-filter:blur(3px);
        display:flex; align-items:center; justify-content:center; padding:16px; z-index:1000;
      }
      .tl-modal{
        background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
        width:100%; max-width:400px; padding:26px; text-align:center;
        animation:tlPop .15s ease;
      }
      @keyframes tlPop{from{opacity:0; transform:translateY(8px) scale(.98);} to{opacity:1; transform:none;}}
      .tl-modal .tl-ic{
        width:44px; height:44px; border-radius:12px; background:var(--accent-dim); color:var(--accent);
        display:flex; align-items:center; justify-content:center; font-size:20px; margin:0 auto 16px;
      }
      .tl-modal h3{font-size:17px; font-weight:700; margin-bottom:8px;}
      .tl-modal p{font-size:13.5px; color:var(--text-dim); line-height:1.6; margin-bottom:20px;}
      .tl-confirm-input{
        width:100%; background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
        color:var(--text); font-family:inherit; font-size:13.5px; padding:10px 12px; outline:none;
        text-align:left; margin:-8px 0 20px;
      }
      .tl-confirm-input:focus{border-color:var(--accent);}
      .tl-modal .tl-actions{display:flex; flex-direction:column; gap:10px;}
      .tl-modal .btn{width:100%;}
      .tl-modal .btn-danger{background:var(--red-dim); border-color:var(--red-border); color:var(--red);}
      .tl-modal .btn-danger:hover{background:var(--red); color:#fff; border-color:var(--red);}
      .tl-modal .tl-cancel{
        background:transparent; border:none; color:var(--text-faint); font-size:13px; padding:4px; margin-top:2px;
      }
      .tl-modal .tl-cancel:hover{color:var(--text-dim);}

      .tl-nav-avatar-wrap{position:relative;}
      .tl-nav-avatar{
        width:34px; height:34px; border-radius:50%; background:linear-gradient(135deg,var(--accent),var(--accent2));
        display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:#fff;
        box-shadow:0 0 0 1px rgba(79,140,255,0.15), 0 0 16px -4px rgba(79,140,255,0.6);
        cursor:pointer; border:none; font-family:inherit;
      }
      .tl-nav-avatar.is-pro{
        box-shadow:0 0 0 2px #151b26, 0 0 0 4px #f5c451, 0 0 16px -4px rgba(245,196,81,0.7);
      }
      .tl-nav-menu{
        display:none; position:absolute; top:calc(100% + 12px); right:0; min-width:240px; z-index:60;
        background:var(--bg-card); border:1px solid var(--border); border-radius:14px;
        padding:8px; box-shadow:0 20px 48px -12px rgba(0,0,0,0.65);
        animation:tlPop .15s ease;
      }
      .tl-nav-menu.open{display:block;}
      .tl-nav-menu-head{display:flex; align-items:center; gap:11px; padding:10px 10px 14px; border-bottom:1px solid var(--border-soft); margin-bottom:6px;}
      .tl-nav-menu-avatar{
        width:38px; height:38px; border-radius:50%; background:linear-gradient(135deg,var(--accent),var(--accent2));
        display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; color:#fff; flex-shrink:0;
      }
      .tl-nav-menu-name{font-size:13.5px; font-weight:700; color:var(--text);}
      .tl-nav-menu-plan{
        display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600; color:var(--text-faint);
        margin-top:4px; padding:2px 8px; border-radius:99px; background:var(--bg-elevated); border:1px solid var(--border);
      }
      .tl-nav-menu-plan.is-pro{color:var(--accent); background:var(--accent-dim); border-color:rgba(79,140,255,0.35);}
      .tl-nav-menu a, .tl-nav-menu button{
        display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:transparent; border:none;
        font-family:inherit; color:var(--text); font-size:13.5px; padding:9px 10px; border-radius:9px; cursor:pointer;
      }
      .tl-nav-menu a:hover, .tl-nav-menu button:hover{background:var(--bg-hover);}
      .tl-nav-menu-ic{width:18px; text-align:center; flex-shrink:0; opacity:.85;}
      .tl-nav-menu-footer{border-top:1px solid var(--border-soft); margin-top:4px; padding-top:4px;}
      .tl-nav-menu-footer button{color:var(--red);}
      .tl-nav-menu-section-label{
        font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint);
        padding:8px 10px 4px;
      }
      .tl-nav-menu-acct{font-size:13px !important; padding:7px 10px !important;}
      .tl-nav-menu-acct.is-active{background:var(--bg-elevated);}
      .tl-nav-menu-acct-dot{width:7px; height:7px; border-radius:50%; flex-shrink:0;}
      .tl-nav-menu-acct-dot.is-live{background:var(--green); box-shadow:0 0 6px -1px var(--green);}
      .tl-nav-menu-acct-dot.is-demo{background:var(--text-faint);}
      .tl-nav-menu-acct-label{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
      .tl-nav-menu-acct-tag{
        font-size:10px; font-weight:700; color:var(--text-faint); background:var(--bg-elevated);
        border:1px solid var(--border); border-radius:5px; padding:1px 5px; flex-shrink:0;
      }
      .tl-nav-menu-acct.is-active .tl-nav-menu-acct-tag{background:var(--bg-card);}
      .tl-nav-menu-acct-check{color:var(--accent); font-weight:700; flex-shrink:0;}
      #tlNavAccounts{border-bottom:1px solid var(--border-soft); margin-bottom:6px; padding-bottom:6px;}
      .tl-nav-menu-footer button:hover{background:var(--red-dim);}

      .tl-am-overlay{
        display:none; position:fixed; inset:0; background:rgba(5,7,11,0.72); backdrop-filter:blur(3px);
        align-items:center; justify-content:center; padding:16px; z-index:1000;
      }
      .tl-am-overlay.open{display:flex;}
      .tl-am-modal{
        position:relative; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
        width:100%; max-width:440px; padding:26px; max-height:90vh; overflow-y:auto; animation:tlPop .15s ease;
      }
      .tl-am-close{
        position:absolute; top:16px; right:16px; background:transparent; border:none; color:var(--text-faint);
        font-size:16px; cursor:pointer; padding:4px;
      }
      .tl-am-close:hover{color:var(--text);}
      .tl-am-modal h3{font-size:17px; font-weight:700; margin-bottom:16px;}
      .tl-am-row{margin-bottom:14px;}
      .tl-am-row label{display:block; font-size:12px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px;}
      .tl-am-row label .tl-am-opt{text-transform:none; color:var(--text-faint); font-weight:400; letter-spacing:0;}
      .tl-am-row input, .tl-am-row select{
        width:100%; background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
        color:var(--text); font-family:inherit; font-size:13.5px; padding:10px 12px; outline:none;
      }
      .tl-am-row input:focus, .tl-am-row select:focus{border-color:var(--accent);}
      .tl-am-row input:disabled{opacity:.6;}
      .tl-am-grid-2{display:grid; grid-template-columns:1fr 1fr; gap:12px;}
      .tl-am-error{color:var(--red); font-size:12.5px; margin:-4px 0 10px; min-height:14px;}
      .tl-am-section-label{font-size:12px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em; margin:18px 0 8px;}
      .tl-am-plan-box{
        background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--radius-sm);
        padding:12px 14px; font-size:13px; color:var(--text-dim); margin-bottom:12px;
      }
      .tl-am-storage-box{
        background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--radius-sm);
        padding:12px 14px; margin-bottom:12px;
      }
      .tl-am-storage-row{display:flex; justify-content:space-between; font-size:12.5px; color:var(--text-dim); margin-bottom:8px;}
      .tl-am-storage-track{height:6px; border-radius:99px; background:var(--border-soft); overflow:hidden;}
      .tl-am-storage-fill{height:100%; border-radius:99px; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width .3s;}
      .tl-am-storage-fill.is-full{background:var(--red);}
      .tl-am-storage-caption{font-size:11px; color:var(--text-faint); margin-top:8px;}
      .tl-am-status{font-size:12.5px; color:var(--green); min-height:16px; margin-top:14px; text-align:center;}
      .tl-am-modal .btn-danger{background:var(--red-dim); border-color:var(--red-border); color:var(--red); border:1px solid var(--red-border);}
      .tl-am-modal .btn-danger:hover{background:var(--red); color:#fff;}

      .tl-am-acct-item{
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--radius-sm);
        padding:11px 12px; margin-bottom:8px;
      }
      .tl-am-acct-main{display:flex; align-items:center; gap:10px; min-width:0;}
      .tl-am-acct-dot{width:8px; height:8px; border-radius:50%; flex-shrink:0;}
      .tl-am-acct-dot.is-live{background:var(--green); box-shadow:0 0 8px -1px var(--green);}
      .tl-am-acct-dot.is-demo{background:var(--text-faint);}
      .tl-am-acct-label{font-size:13.5px; font-weight:600; color:var(--text); display:flex; align-items:center; gap:6px;}
      .tl-am-acct-badge{
        font-size:10.5px; font-weight:700; color:var(--text-dim); background:var(--bg-card);
        border:1px solid var(--border); border-radius:5px; padding:1px 5px;
      }
      .tl-am-acct-sub{font-size:12px; color:var(--text-faint); margin-top:2px;}
      .tl-am-acct-actions{display:flex; align-items:center; gap:4px; flex-shrink:0;}
      .tl-am-acct-actions button, .tl-am-acct-actions a{
        display:inline-flex; align-items:center;
        background:transparent; border:none; color:var(--text-faint); font-size:12.5px; font-family:inherit;
        padding:6px 8px; border-radius:7px; cursor:pointer; white-space:nowrap; text-decoration:none;
      }
      .tl-am-acct-actions button:hover, .tl-am-acct-actions a:hover{background:var(--bg-hover); color:var(--text);}
      .tl-am-acct-actions a.tl-am-acct-key{color:var(--accent);} /* Pro upgrade chip (Free users) */
      .tl-am-acct-actions .tl-am-acct-delete:hover{color:var(--red);}
      .tl-am-add-account-form{
        background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--radius-sm);
        padding:14px; margin-bottom:10px;
      }
      .tl-am-acct-limit-note{
        font-size:12.5px; color:var(--text-faint); text-align:center; padding:10px 4px; margin-bottom:10px;
      }
      .tl-am-acct-limit-note a{color:var(--accent); text-decoration:underline;}

      .tl-cookie-bar{
        position:fixed; left:16px; right:16px; bottom:16px; z-index:900; max-width:720px; margin:0 auto;
        background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
        padding:16px 18px; box-shadow:0 20px 48px -12px rgba(0,0,0,0.65);
        display:flex; align-items:center; gap:16px; flex-wrap:wrap; animation:tlPop .15s ease;
      }
      .tl-cookie-bar p{flex:1; min-width:220px; font-size:12.5px; color:var(--text-dim); line-height:1.6; margin:0;}
      .tl-cookie-bar p a{color:var(--text); text-decoration:underline;}
      .tl-cookie-actions{display:flex; gap:8px; flex-wrap:wrap;}
      .tl-cookie-actions .btn{padding:8px 14px; font-size:12.5px; white-space:nowrap;}
      .tl-cookie-cat{
        display:flex; align-items:flex-start; justify-content:space-between; gap:14px; text-align:left;
        padding:12px 0; border-bottom:1px solid var(--border-soft);
      }
      .tl-cookie-cat:last-child{border-bottom:none;}
      .tl-cookie-cat-name{font-size:13.5px; font-weight:700; margin-bottom:3px;}
      .tl-cookie-cat-desc{font-size:12px; color:var(--text-faint); line-height:1.5;}
      .tl-cookie-cat input[type="checkbox"]{width:17px; height:17px; flex-shrink:0; margin-top:2px; accent-color:var(--accent);}
      .tl-cookie-cat input[type="checkbox"]:disabled{opacity:.4;}
    `;
    document.head.appendChild(style);
  }

  function showModal({ icon, title, message, primaryLabel, primaryHref, primaryAction, primaryDanger, secondaryLabel, secondaryHref, cancelLabel, confirmText }){
    ensureStyles();
    const existing = document.querySelector('.tl-overlay');
    if(existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'tl-overlay';
    overlay.innerHTML = `
      <div class="tl-modal" role="dialog" aria-modal="true">
        <div class="tl-ic">${icon}</div>
        <h3>${title}</h3>
        <p>${message}</p>
        ${confirmText ? `<input type="text" class="tl-confirm-input" id="tlConfirmInput" placeholder="Type ${escapeHtml(confirmText)} to confirm" autocomplete="off">` : ''}
        <div class="tl-actions">
          <a class="btn ${primaryDanger ? 'btn-danger' : 'btn-primary'}" id="tlPrimaryBtn" href="${primaryHref || '#'}"${confirmText ? ' aria-disabled="true" style="opacity:.5; pointer-events:none;"' : ''}>${primaryLabel}</a>
          ${secondaryLabel ? `<a class="btn btn-ghost" href="${secondaryHref || '#'}">${secondaryLabel}</a>` : ''}
          <button type="button" class="tl-cancel" id="tlCancelBtn">${cancelLabel || 'Not now'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const primaryBtn = overlay.querySelector('#tlPrimaryBtn');
    if(confirmText){
      const input = overlay.querySelector('#tlConfirmInput');
      input.addEventListener('input', () => {
        const matches = input.value.trim().toLowerCase() === confirmText.trim().toLowerCase();
        primaryBtn.style.opacity = matches ? '' : '.5';
        primaryBtn.style.pointerEvents = matches ? '' : 'none';
        primaryBtn.setAttribute('aria-disabled', matches ? 'false' : 'true');
      });
    }
    if(primaryAction){
      primaryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if(primaryBtn.getAttribute('aria-disabled') === 'true') return;
        primaryAction();
      });
    }
    overlay.querySelector('#tlCancelBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
  }

  // ---------- Shared account modal (profile, password, plan) ----------
  // Lives in auth.js so "Account settings" opens in place on every page
  // instead of navigating to app.html.
  let accountModalMounted = false;

  function ensureAccountModal(){
    if(accountModalMounted) return;
    accountModalMounted = true;
    ensureStyles();

    const overlay = document.createElement('div');
    overlay.className = 'tl-am-overlay';
    overlay.id = 'tlAccountOverlay';
    overlay.innerHTML = `
      <div class="tl-am-modal" role="dialog" aria-modal="true">
        <button type="button" class="tl-am-close" id="tlAmClose">✕</button>
        <h3 id="tlAmTitle">Your account</h3>

        <div id="tlAmProfileSection">
          <div class="tl-am-row">
            <label>Email</label>
            <input type="email" id="tlAmEmail" disabled>
          </div>
          <div class="tl-am-grid-2">
            <div class="tl-am-row">
              <label>First name</label>
              <input type="text" id="tlAmFirstName">
            </div>
            <div class="tl-am-row">
              <label>Last name</label>
              <input type="text" id="tlAmLastName">
            </div>
          </div>
          <div class="tl-am-error" id="tlAmNameError"></div>
          <button type="button" class="btn btn-primary" id="tlAmSaveProfile" style="width:100%;">Save changes</button>

          <div class="tl-am-section-label">Password</div>
          <div class="tl-am-row">
            <label>Current password</label>
            <input type="password" id="tlAmCurrentPassword" autocomplete="current-password">
          </div>
          <div class="tl-am-row">
            <label>New password <span class="tl-am-opt">(min. 8 characters)</span></label>
            <input type="password" id="tlAmNewPassword" autocomplete="new-password">
          </div>
          <div class="tl-am-error" id="tlAmPasswordError"></div>
          <button type="button" class="btn btn-ghost" id="tlAmChangePassword" style="width:100%;">Change password</button>
        </div>

        <div class="tl-am-section-label" id="tlAmAccountsLabel">Trading accounts</div>
        <div id="tlAmAccountsList"></div>
        <button type="button" class="btn btn-ghost" id="tlAmAddAccountBtn" style="width:100%;">+ Add trading account</button>
        <div class="tl-am-acct-limit-note" id="tlAmAccountLimitNote" style="display:none;"></div>
        <div class="tl-am-add-account-form" id="tlAmAddAccountForm" style="display:none;">
          <div class="tl-am-row">
            <label>Label</label>
            <input type="text" id="tlAmNewLabel" placeholder="e.g. IC Markets 50k">
          </div>
          <div class="tl-am-grid-2">
            <div class="tl-am-row">
              <label>Type</label>
              <select id="tlAmNewType"><option value="live">Live</option><option value="demo">Demo</option></select>
            </div>
            <div class="tl-am-row">
              <label>Platform</label>
              <select id="tlAmNewPlatform"><option value="MT4">MT4</option><option value="MT5">MT5</option></select>
            </div>
          </div>
          <div class="tl-am-row">
            <label>Currency</label>
            <input type="text" id="tlAmNewCurrency" placeholder="USD" value="USD">
          </div>
          <div class="tl-am-error" id="tlAmAccountError"></div>
          <div style="display:flex; gap:10px;">
            <button type="button" class="btn btn-ghost" id="tlAmCancelAccount" style="flex:1;">Cancel</button>
            <button type="button" class="btn btn-primary" id="tlAmSaveAccount" style="flex:1;">Add account</button>
          </div>
        </div>

        <div id="tlAmPlanSection">
          <div class="tl-am-section-label">Plan</div>
          <div class="tl-am-plan-box" id="tlAmPlanStatus"></div>
          <div id="tlAmPlanAction"></div>
        </div>

        <div id="tlAmStorageSection" style="display:none;">
          <div class="tl-am-section-label">Storage</div>
          <div id="tlAmStorageStatus"></div>
        </div>

        <div class="tl-am-status" id="tlAmStatus"></div>
        <button type="button" class="btn btn-ghost" id="tlAmLogout" style="width:100%; margin-top:8px;">Log out</button>
        <button type="button" id="tlAmDeleteAccount" style="width:100%; margin-top:14px; background:none; border:none; color:var(--text-faint); font-size:12px; text-decoration:underline; padding:4px;">Delete my account</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.classList.remove('open'); });
    overlay.querySelector('#tlAmClose').addEventListener('click', () => overlay.classList.remove('open'));

    overlay.querySelector('#tlAmSaveProfile').addEventListener('click', async () => {
      const err = overlay.querySelector('#tlAmNameError');
      const res = await TLAuth.updateProfile({
        firstName: overlay.querySelector('#tlAmFirstName').value,
        lastName: overlay.querySelector('#tlAmLastName').value
      });
      if(!res.ok){ err.textContent = res.error; return; }
      err.textContent = '';
      const navRight = document.getElementById('navRight');
      if(navRight) await renderAccountNav(navRight, lastNavOpts);
      overlay.querySelector('#tlAmStatus').textContent = 'Profile updated.';
    });

    overlay.querySelector('#tlAmChangePassword').addEventListener('click', async () => {
      const err = overlay.querySelector('#tlAmPasswordError');
      const res = await TLAuth.changePassword({
        currentPassword: overlay.querySelector('#tlAmCurrentPassword').value,
        newPassword: overlay.querySelector('#tlAmNewPassword').value
      });
      if(!res.ok){ err.textContent = res.error; return; }
      err.textContent = '';
      overlay.querySelector('#tlAmCurrentPassword').value = '';
      overlay.querySelector('#tlAmNewPassword').value = '';
      overlay.querySelector('#tlAmStatus').textContent = 'Password updated.';
    });

    overlay.querySelector('#tlAmLogout').addEventListener('click', async () => {
      await TLAuth.logout();
      location.reload();
    });

    overlay.querySelector('#tlAmDeleteAccount').addEventListener('click', () => {
      showModal({
        icon: '⚠️',
        title: 'Delete your account?',
        message: 'This permanently deletes your profile, every trading account, trade, note and screenshot, and cancels any active subscription. There is no way to undo this.',
        primaryLabel: 'Delete my account permanently',
        primaryDanger: true,
        cancelLabel: 'Cancel',
        confirmText: 'DELETE',
        primaryAction: async () => {
          document.querySelector('.tl-overlay')?.remove();
          const res = await TLAuth.deleteMyAccount();
          if(!res.ok){ overlay.querySelector('#tlAmStatus').textContent = res.error; return; }
          location.href = '/';
        }
      });
    });

    const addForm = overlay.querySelector('#tlAmAddAccountForm');
    overlay.querySelector('#tlAmAddAccountBtn').addEventListener('click', () => {
      addForm.style.display = 'block';
      overlay.querySelector('#tlAmAddAccountBtn').style.display = 'none';
    });
    overlay.querySelector('#tlAmCancelAccount').addEventListener('click', () => {
      addForm.style.display = 'none';
      overlay.querySelector('#tlAmAddAccountBtn').style.display = 'block';
      overlay.querySelector('#tlAmAccountError').textContent = '';
    });
    overlay.querySelector('#tlAmSaveAccount').addEventListener('click', async () => {
      const err = overlay.querySelector('#tlAmAccountError');
      const res = await createAccount({
        label: overlay.querySelector('#tlAmNewLabel').value,
        account_type: overlay.querySelector('#tlAmNewType').value,
        platform: overlay.querySelector('#tlAmNewPlatform').value,
        currency: overlay.querySelector('#tlAmNewCurrency').value
      });
      if(!res.ok){ err.textContent = res.error; return; }
      err.textContent = '';
      overlay.querySelector('#tlAmNewLabel').value = '';
      overlay.querySelector('#tlAmNewCurrency').value = 'USD';
      addForm.style.display = 'none';
      overlay.querySelector('#tlAmAddAccountBtn').style.display = 'block';
      await renderAccountModalAccounts(overlay);
      document.dispatchEvent(new CustomEvent('tl-accounts-changed'));
    });
  }

  // Renders the trading-accounts list inside the account modal, and wires
  // its add/delete/copy-key controls. Re-run after any change so the list
  // (and every other open renderer of it, via tl-accounts-changed) reflects
  // the latest state.
  async function renderAccountModalAccounts(overlay){
    const list = overlay.querySelector('#tlAmAccountsList');
    const accounts = await ensureDefaultAccount();
    const limit = await accountLimitFor();
    // The API key is only for EA auto-sync, which is Pro-only (the server
    // rejects a non-Pro key with 402). Showing a Free user "Copy key" just
    // hands them a key that can't work — gate it behind Pro and point to
    // pricing instead.
    const isPro = await TLAuth.isPro();
    const addBtn = overlay.querySelector('#tlAmAddAccountBtn');
    const limitNote = overlay.querySelector('#tlAmAccountLimitNote');
    if(accounts.length >= limit){
      addBtn.style.display = 'none';
      limitNote.style.display = 'block';
      limitNote.innerHTML = limit === 1
        ? `Free plan is limited to 1 account. <a href="/#pricing" style="color:var(--accent);">Upgrade to Pro</a> to connect up to 5.`
        : `You've reached the maximum of ${limit} trading accounts.`;
    } else {
      addBtn.style.display = 'block';
      limitNote.style.display = 'none';
    }
    list.innerHTML = accounts.map(a => `
      <div class="tl-am-acct-item">
        <div class="tl-am-acct-main">
          <span class="tl-am-acct-dot ${a.account_type === 'live' ? 'is-live' : 'is-demo'}"></span>
          <div>
            <div class="tl-am-acct-label">${escapeHtml(a.label)} <span class="tl-am-acct-badge">${escapeHtml(a.platform)}</span></div>
            <div class="tl-am-acct-sub">${a.account_type === 'live' ? 'Live' : 'Demo'} · ${escapeHtml(a.currency)} · Not connected — no EA linked yet</div>
          </div>
        </div>
        <div class="tl-am-acct-actions">
          ${isPro ? `
          <button type="button" class="tl-am-acct-key" data-key="${escapeHtml(a.api_key)}" title="Copy this account's API key">🔑 Copy key</button>
          <button type="button" class="tl-am-acct-regen" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" title="Invalidate the old key and generate a new one">🔄</button>
          ` : `
          <a href="/#pricing" class="tl-am-acct-key" title="EA auto-sync and the API key are a Pro feature">🔒 Pro</a>
          `}
          ${accounts.length > 1 ? `<button type="button" class="tl-am-acct-delete" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" title="Delete account">🗑</button>` : ''}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('button.tl-am-acct-key').forEach(btn => {
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(btn.dataset.key);
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = original; }, 1500);
      });
    });
    list.querySelectorAll('.tl-am-acct-regen').forEach(btn => {
      btn.addEventListener('click', () => {
        showModal({
          icon: '🔄',
          title: `Regenerate the key for "${btn.dataset.label}"?`,
          message: `The old key stops working immediately — if an EA is using it to auto-sync trades, you'll need to paste the new key into that EA's Inputs tab afterward.`,
          primaryLabel: 'Regenerate key',
          primaryDanger: true,
          cancelLabel: 'Cancel',
          primaryAction: async () => {
            document.querySelector('.tl-overlay')?.remove();
            const res = await regenerateApiKey(btn.dataset.id);
            if(!res.ok){ overlay.querySelector('#tlAmStatus').textContent = res.error; return; }
            await renderAccountModalAccounts(overlay);
            overlay.querySelector('#tlAmStatus').textContent = 'New key generated — copy it and update your EA.';
          }
        });
      });
    });
    list.querySelectorAll('.tl-am-acct-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        // Trading accounts cascade-delete every trade under them (see
        // trading_accounts_schema.sql) — notes, tags and screenshots
        // included — so this needs an explicit, specific warning rather
        // than a quick double-click that's easy to trigger by accident.
        showModal({
          icon: '⚠️',
          title: `Delete "${btn.dataset.label}"?`,
          message: `This permanently deletes every trade, note, tag and screenshot recorded under this account. There's no way to undo it.`,
          primaryLabel: 'Delete account',
          primaryDanger: true,
          cancelLabel: 'Cancel',
          primaryAction: async () => {
            document.querySelector('.tl-overlay')?.remove();
            await deleteAccount(btn.dataset.id);
            if(getActiveAccountId() === btn.dataset.id) setActiveAccountId('');
            await renderAccountModalAccounts(overlay);
            document.dispatchEvent(new CustomEvent('tl-accounts-changed'));
          }
        });
      });
    });
  }

  async function renderAccountModalPlan(overlay){
    const info = await TLAuth.getPlanInfo();
    const box = overlay.querySelector('#tlAmPlanStatus');
    const actionBox = overlay.querySelector('#tlAmPlanAction');
    if(!info) return;
    const fmt = ts => new Date(ts).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
    if(info.plan !== 'pro'){
      box.innerHTML = `<strong style="color:var(--text);">Free plan</strong>`;
      actionBox.innerHTML = `<a class="btn btn-primary" style="width:100%; display:block; text-align:center;" href="/#pricing">Upgrade to Pro</a>`;
    } else if(info.cancelAtPeriodEnd){
      box.innerHTML = `<strong style="color:var(--text);">Pro plan</strong> — cancelled, active until <strong>${fmt(info.periodEnd)}</strong>`;
      actionBox.innerHTML = `
        <button type="button" class="btn btn-primary" id="tlAmResumePro" style="width:100%; margin-bottom:8px;">Resume subscription</button>
        <button type="button" class="btn btn-ghost" id="tlAmManagePro" style="width:100%;">Manage subscription</button>
      `;
    } else {
      box.innerHTML = `<strong style="color:var(--text);">Pro plan</strong> — renews on <strong>${fmt(info.periodEnd)}</strong>`;
      actionBox.innerHTML = `<button type="button" class="btn btn-danger" id="tlAmManagePro" style="width:100%;">Manage subscription</button>`;
    }
    const manageBtn = actionBox.querySelector('#tlAmManagePro');
    if(manageBtn){
      manageBtn.onclick = async () => {
        const res = await TLAuth.openBillingPortal();
        if(!res.ok){ overlay.querySelector('#tlAmStatus').textContent = res.error; return; }
        location.href = res.url;
      };
    }
    const resumeBtn = actionBox.querySelector('#tlAmResumePro');
    if(resumeBtn){
      resumeBtn.onclick = async () => {
        const statusEl = overlay.querySelector('#tlAmStatus');
        statusEl.textContent = '';
        resumeBtn.disabled = true;
        resumeBtn.textContent = 'Resuming…';
        const res = await TLAuth.resumeSubscription();
        resumeBtn.disabled = false;
        resumeBtn.textContent = 'Resume subscription';
        if(!res.ok){ statusEl.textContent = res.error; return; }
        await renderAccountModalPlan(overlay);
      };
    }
  }

  // Only shown on Pro — Free accounts can't upload images at all, so usage
  // is always 0 and the section would just be clutter.
  async function renderAccountModalStorage(overlay){
    const section = overlay.querySelector('#tlAmStorageSection');
    const isPro = await TLAuth.isPro();
    if(!isPro){ section.style.display = 'none'; return; }
    section.style.display = 'block';
    const box = overlay.querySelector('#tlAmStorageStatus');
    box.innerHTML = `<div class="tl-am-storage-box">Checking usage…</div>`;
    // Sweep any screenshot no live trade references any more before measuring,
    // so the number reflects what's actually stored. (Removed inline note
    // images used to orphan in Storage and never stop counting.) Pass the
    // client's local note cache as a safety allow-list for not-yet-synced
    // edits, and never let a sweep failure block showing the usage.
    try{
      let keep = [];
      try{
        const meta = JSON.parse(localStorage.getItem('tradelista_trade_meta')) || {};
        for(const id in meta){
          const m = meta[id];
          if(m && typeof m.note === 'string') keep.push(m.note);
          if(m && Array.isArray(m.images)) keep = keep.concat(m.images);
        }
      }catch(e){}
      await reconcileStorage(keep);
    }catch(e){ /* non-fatal — show usage even if the sweep couldn't run */ }
    const { used, limit } = await getStorageUsage();
    const usedMb = (used / (1024*1024)).toFixed(used < 10*1024*1024 ? 1 : 0);
    const limitMb = Math.round(limit / (1024*1024));
    const pct = Math.min(100, (used / limit) * 100);
    box.innerHTML = `
      <div class="tl-am-storage-box">
        <div class="tl-am-storage-row"><span>${usedMb} MB used</span><span>${limitMb} MB total</span></div>
        <div class="tl-am-storage-track"><div class="tl-am-storage-fill${pct >= 95 ? ' is-full' : ''}" style="width:${pct}%"></div></div>
        <div class="tl-am-storage-caption">Screenshots, notes, tags and reflection answers all count toward this.</div>
      </div>
    `;
  }

  async function openAccountModal(opts){
    opts = opts || {};
    ensureAccountModal();
    const overlay = document.getElementById('tlAccountOverlay');
    const user = await TLAuth.getCurrentUser();
    if(!user) return;
    overlay.querySelector('#tlAmEmail').value = user.email;
    overlay.querySelector('#tlAmFirstName').value = user.firstName;
    overlay.querySelector('#tlAmLastName').value = user.lastName;
    overlay.querySelector('#tlAmNameError').textContent = '';
    overlay.querySelector('#tlAmCurrentPassword').value = '';
    overlay.querySelector('#tlAmNewPassword').value = '';
    overlay.querySelector('#tlAmPasswordError').textContent = '';
    overlay.querySelector('#tlAmStatus').textContent = '';
    const addForm = overlay.querySelector('#tlAmAddAccountForm');
    addForm.style.display = 'none';
    overlay.querySelector('#tlAmAddAccountBtn').style.display = 'block';
    overlay.querySelector('#tlAmAccountError').textContent = '';

    // "Manage accounts" (from the nav dropdown) shows only the trading-accounts
    // list — profile/password/plan are a distinct concern reached via
    // "Account settings" instead, so the two entry points don't land on the
    // same overloaded screen.
    const accountsOnly = !!opts.accountsOnly;
    overlay.querySelector('#tlAmTitle').textContent = accountsOnly ? 'Trading accounts' : 'Your account';
    overlay.querySelector('#tlAmProfileSection').style.display = accountsOnly ? 'none' : 'block';
    overlay.querySelector('#tlAmPlanSection').style.display = accountsOnly ? 'none' : 'block';
    overlay.querySelector('#tlAmStorageSection').style.display = 'none'; // renderAccountModalStorage decides for itself once we know the plan
    overlay.querySelector('#tlAmStatus').style.display = accountsOnly ? 'none' : 'block';
    overlay.querySelector('#tlAmLogout').style.display = accountsOnly ? 'none' : 'block';
    overlay.querySelector('#tlAmAccountsLabel').style.display = accountsOnly ? 'none' : 'block';

    await renderAccountModalAccounts(overlay);
    if(!accountsOnly){
      await renderAccountModalPlan(overlay);
      await renderAccountModalStorage(overlay);
    }
    overlay.classList.add('open');
  }

  // Renders the logged-out (Log in / Start free) or logged-in (avatar +
  // dropdown) nav state into containerEl. Used identically on every page so
  // the top-right corner never looks different when navigating around.
  let lastNavOpts = {};
  async function renderAccountNav(containerEl, opts){
    opts = opts || {};
    lastNavOpts = opts;
    ensureStyles();
    if(!(await TLAuth.isLoggedIn())){
      containerEl.innerHTML = `
        <a class="btn btn-ghost" href="auth.html?mode=login">Log in</a>
        <a class="btn btn-primary" href="auth.html?mode=signup&redirect=app.html">Start free</a>
      `;
      return;
    }

    const user = await TLAuth.getCurrentUser();
    const isPro = await TLAuth.isPro();
    const initials = ((user.firstName[0] || '') + (user.lastName[0] || '')).toUpperCase();
    const accounts = await ensureDefaultAccount();
    const activeId = getActiveAccountId() || (accounts.find(a => a.is_default) || accounts[0] || {}).id;

    containerEl.innerHTML = `
      <div class="tl-nav-avatar-wrap">
        <button type="button" class="tl-nav-avatar ${isPro ? 'is-pro' : ''}" id="tlNavAvatarBtn">${initials}</button>
        <div class="tl-nav-menu" id="tlNavMenu">
          <div class="tl-nav-menu-head">
            <div class="tl-nav-menu-avatar">${initials}</div>
            <div>
              <div class="tl-nav-menu-name">${user.firstName} ${user.lastName}</div>
              <div class="tl-nav-menu-plan ${isPro ? 'is-pro' : ''}">${isPro ? '⭐ Pro plan' : 'Free plan'}</div>
            </div>
          </div>
          <div class="tl-nav-menu-section-label">Trading account</div>
          <div id="tlNavAccounts">
            ${accounts.map(a => `
              <button type="button" class="tl-nav-menu-acct ${a.id === activeId ? 'is-active' : ''}" data-id="${a.id}">
                <span class="tl-nav-menu-acct-dot ${a.account_type === 'live' ? 'is-live' : 'is-demo'}"></span>
                <span class="tl-nav-menu-acct-label">${a.label}</span>
                <span class="tl-nav-menu-acct-tag">${a.platform}</span>
                ${a.id === activeId ? '<span class="tl-nav-menu-acct-check">✓</span>' : ''}
              </button>
            `).join('')}
          </div>
          <a href="#" id="tlNavManageAccountsLink"><span class="tl-nav-menu-ic">🔗</span>Manage accounts</a>
          ${opts.hideCalendarLink ? '' : '<a href="app.html"><span class="tl-nav-menu-ic">📅</span>Go to Calendar</a>'}
          <a href="#" id="tlNavAccountSettingsLink"><span class="tl-nav-menu-ic">⚙️</span>Account settings</a>
          ${isPro ? '' : '<a href="/#pricing"><span class="tl-nav-menu-ic">⭐</span>Upgrade to Pro</a>'}
          <div class="tl-nav-menu-footer">
            <button type="button" id="tlNavLogoutBtn"><span class="tl-nav-menu-ic">↪</span>Log out</button>
          </div>
        </div>
      </div>
    `;

    const btn = containerEl.querySelector('#tlNavAvatarBtn');
    const menu = containerEl.querySelector('#tlNavMenu');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));
    containerEl.querySelectorAll('.tl-nav-menu-acct').forEach(acctBtn => {
      acctBtn.addEventListener('click', () => {
        if(acctBtn.dataset.id === activeId){ menu.classList.remove('open'); return; }
        setActiveAccountId(acctBtn.dataset.id);
        location.reload();
      });
    });
    containerEl.querySelector('#tlNavManageAccountsLink').addEventListener('click', (e) => {
      e.preventDefault();
      menu.classList.remove('open');
      openAccountModal({ accountsOnly: true });
    });
    containerEl.querySelector('#tlNavAccountSettingsLink').addEventListener('click', (e) => {
      e.preventDefault();
      menu.classList.remove('open');
      openAccountModal();
    });
    containerEl.querySelector('#tlNavLogoutBtn').addEventListener('click', async () => {
      await TLAuth.logout();
      location.reload();
    });
  }

  document.addEventListener('tl-accounts-changed', () => {
    const navRight = document.getElementById('navRight');
    if(navRight) renderAccountNav(navRight, lastNavOpts);
  });

  TLAuth.ui = {
    renderAccountNav,
    openAccountModal,
    requireAuth(redirectTo){
      const redirect = redirectTo ? `&redirect=${encodeURIComponent(redirectTo)}` : '';
      showModal({
        icon: '🔒',
        title: 'Create a free account',
        message: "You'll need a TradeLista account to open the calendar — it takes under a minute and it's free.",
        primaryLabel: 'Create free account',
        primaryHref: `auth.html?mode=signup${redirect}`,
        secondaryLabel: 'I already have one — log in',
        secondaryHref: `auth.html?mode=login${redirect}`
      });
    },
    requirePro(featureLabel){
      showModal({
        icon: '⭐',
        title: 'Upgrade to Pro',
        message: `${featureLabel} is part of the Pro plan. Upgrade to unlock it — no card needed for this demo.`,
        primaryLabel: 'See Pro plan',
        primaryHref: '/#pricing'
      });
    },
    showModal
  };

  // ---------- Cookie/consent banner ----------
  // TradeLista sets no analytics or advertising cookies today (see
  // privacy.html) — nothing here is required by law yet. It exists so
  // "accept/reject/manage" is already wired up and the stored choice is
  // meaningful the day any real analytics/marketing script gets added,
  // rather than bolting a consent flow on retroactively.
  const COOKIE_CONSENT_KEY = 'tradelista_cookie_consent';

  function saveCookieConsent(analytics, marketing){
    try{
      localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({ analytics: !!analytics, marketing: !!marketing, ts: Date.now() }));
    }catch(e){}
  }

  function openCookiePrefs(onDone){
    ensureStyles();
    const overlay = document.createElement('div');
    overlay.className = 'tl-overlay';
    overlay.innerHTML = `
      <div class="tl-modal" role="dialog" aria-modal="true" style="max-width:440px; text-align:left;">
        <h3 style="text-align:center;">Cookie preferences</h3>
        <div class="tl-cookie-cat">
          <div>
            <div class="tl-cookie-cat-name">Essential</div>
            <div class="tl-cookie-cat-desc">Keeps you logged in and remembers your settings. Required for the app to work — can't be turned off.</div>
          </div>
          <input type="checkbox" checked disabled>
        </div>
        <div class="tl-cookie-cat">
          <div>
            <div class="tl-cookie-cat-name">Analytics</div>
            <div class="tl-cookie-cat-desc">Not currently used — TradeLista sets no analytics cookies today.</div>
          </div>
          <input type="checkbox" id="tlCookieAnalytics">
        </div>
        <div class="tl-cookie-cat">
          <div>
            <div class="tl-cookie-cat-name">Marketing</div>
            <div class="tl-cookie-cat-desc">Not currently used — TradeLista sets no advertising cookies today.</div>
          </div>
          <input type="checkbox" id="tlCookieMarketing">
        </div>
        <div class="tl-actions" style="margin-top:18px;">
          <button type="button" class="btn btn-primary" id="tlCookieSave">Save preferences</button>
        </div>
        <button type="button" class="tl-cancel" id="tlCookieBack">← Back</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#tlCookieSave').addEventListener('click', ()=>{
      const analytics = overlay.querySelector('#tlCookieAnalytics').checked;
      const marketing = overlay.querySelector('#tlCookieMarketing').checked;
      overlay.remove();
      onDone(analytics, marketing);
    });
    // Closing without saving just re-reveals the still-present 3-button
    // banner underneath — it was never removed, only covered by this
    // overlay — rather than dismissing the whole consent flow outright.
    overlay.querySelector('#tlCookieBack').addEventListener('click', ()=> overlay.remove());
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.remove(); });
  }

  function initCookieBanner(){
    let existing;
    try{ existing = localStorage.getItem(COOKIE_CONSENT_KEY); }catch(e){ existing = 'unavailable'; }
    if(existing) return;

    ensureStyles();
    const bar = document.createElement('div');
    bar.className = 'tl-cookie-bar';
    bar.innerHTML = `
      <p>We use only essential cookies/local storage to keep you logged in and save your settings — no analytics or advertising. See our <a href="privacy.html">Privacy Policy</a>.</p>
      <div class="tl-cookie-actions">
        <button type="button" class="btn btn-ghost" id="tlCookieManageBtn">Manage</button>
        <button type="button" class="btn btn-ghost" id="tlCookieRejectBtn">Reject non-essential</button>
        <button type="button" class="btn btn-primary" id="tlCookieAcceptBtn">Accept all</button>
      </div>
    `;
    document.body.appendChild(bar);

    bar.querySelector('#tlCookieAcceptBtn').addEventListener('click', ()=>{
      saveCookieConsent(true, true);
      bar.remove();
    });
    bar.querySelector('#tlCookieRejectBtn').addEventListener('click', ()=>{
      saveCookieConsent(false, false);
      bar.remove();
    });
    bar.querySelector('#tlCookieManageBtn').addEventListener('click', ()=>{
      openCookiePrefs((analytics, marketing)=>{
        saveCookieConsent(analytics, marketing);
        bar.remove();
      });
    });
  }
  initCookieBanner();

  TLAuth.data = {
    getUserTrades,
    upsertTrade,
    uploadTradeImage,
    deleteTradeImage,
    deleteTradeFolder,
    reconcileStorage,
    getStorageUsage,
    getAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
    regenerateApiKey,
    ensureDefaultAccount,
    getActiveAccountId,
    setActiveAccountId
  };

  window.TLAuth = TLAuth;
})();
