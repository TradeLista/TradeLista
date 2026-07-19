/* ---------- TradeLista Auth ----------
   Backed by Supabase (real accounts, real Postgres database). Requires the
   Supabase JS client <script> tag to be loaded before this file — see the
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/..."> tag
   near the top of each page.

   All TLAuth methods that touch the network are async — callers must
   `await` them.
*/
(function(){
  const SUPABASE_URL = 'https://xkmpknoughjnxalkoatx.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_I4mtWXDs_GejiJPvzA-v4w_1xT-G4Un';
  const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    const row = {
      id: trade.id,
      user_id: session.user.id,
      account_id: trade.account_id || null,
      is_manual: !!trade.is_manual,
      is_deleted: !!trade.is_deleted,
      date: trade.date || null,
      symbol: trade.symbol || null,
      lot: trade.lot ?? null,
      entry: trade.entry ?? null,
      exit_price: trade.exit ?? null,
      profit: trade.profit ?? null,
      note: trade.note || '',
      images: trade.images || [],
      answers: trade.answers || {},
      updated_at: new Date().toISOString()
    };
    const { error } = await sb.from('trades').upsert(row);
    if(error) return { ok:false, error: error.message };
    return { ok:true };
  }

  async function uploadTradeImage(tradeId, file){
    const { data: { session } } = await sb.auth.getSession();
    if(!session) return { ok:false, error:'Not logged in.' };
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `${session.user.id}/${tradeId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
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
      const u = await this.getCurrentUser();
      if(!u || u.plan !== 'pro') return false;
      if(u.cancelAtPeriodEnd && u.periodEnd && Date.now() >= u.periodEnd){
        await sb.from('profiles').update({ plan:'free', cancel_at_period_end:false, period_end:null }).eq('id', u.id);
        return false;
      }
      return true;
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
        options: { data: { first_name: firstName, last_name: lastName } }
      });
      if(error) return { ok:false, error: error.message };
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
    }
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
      .tl-modal .tl-actions{display:flex; flex-direction:column; gap:10px;}
      .tl-modal .btn{width:100%;}
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
      .tl-am-acct-actions button{
        background:transparent; border:none; color:var(--text-faint); font-size:12.5px; font-family:inherit;
        padding:6px 8px; border-radius:7px; cursor:pointer; white-space:nowrap;
      }
      .tl-am-acct-actions button:hover{background:var(--bg-hover); color:var(--text);}
      .tl-am-acct-actions .tl-am-acct-delete:hover{color:var(--red);}
      .tl-am-add-account-form{
        background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--radius-sm);
        padding:14px; margin-bottom:10px;
      }
      .tl-am-acct-limit-note{
        font-size:12.5px; color:var(--text-faint); text-align:center; padding:10px 4px; margin-bottom:10px;
      }
      .tl-am-acct-limit-note a{color:var(--accent); text-decoration:underline;}
    `;
    document.head.appendChild(style);
  }

  function showModal({ icon, title, message, primaryLabel, primaryHref, primaryAction, secondaryLabel, secondaryHref }){
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
        <div class="tl-actions">
          <a class="btn btn-primary" id="tlPrimaryBtn" href="${primaryHref || '#'}">${primaryLabel}</a>
          ${secondaryLabel ? `<a class="btn btn-ghost" href="${secondaryHref || '#'}">${secondaryLabel}</a>` : ''}
          <button type="button" class="tl-cancel" id="tlCancelBtn">Not now</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    if(primaryAction){
      overlay.querySelector('#tlPrimaryBtn').addEventListener('click', (e) => {
        e.preventDefault();
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
        <h3>Your account</h3>

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

        <div class="tl-am-section-label">Trading accounts</div>
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

        <div class="tl-am-section-label">Plan</div>
        <div class="tl-am-plan-box" id="tlAmPlanStatus"></div>
        <div id="tlAmPlanAction"></div>

        <div class="tl-am-status" id="tlAmStatus"></div>
        <button type="button" class="btn btn-ghost" id="tlAmLogout" style="width:100%; margin-top:8px;">Log out</button>
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
    const addBtn = overlay.querySelector('#tlAmAddAccountBtn');
    const limitNote = overlay.querySelector('#tlAmAccountLimitNote');
    if(accounts.length >= limit){
      addBtn.style.display = 'none';
      limitNote.style.display = 'block';
      limitNote.innerHTML = limit === 1
        ? `Free plan is limited to 1 account. <a href="index.html#pricing" style="color:var(--accent);">Upgrade to Pro</a> to connect up to 5.`
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
            <div class="tl-am-acct-label">${a.label} <span class="tl-am-acct-badge">${a.platform}</span></div>
            <div class="tl-am-acct-sub">${a.account_type === 'live' ? 'Live' : 'Demo'} · ${a.currency} · Not connected — no EA linked yet</div>
          </div>
        </div>
        <div class="tl-am-acct-actions">
          <button type="button" class="tl-am-acct-key" data-key="${a.api_key}" title="Copy this account's API key">🔑 Copy key</button>
          ${accounts.length > 1 ? `<button type="button" class="tl-am-acct-delete" data-id="${a.id}" data-label="${a.label}" title="Delete account">🗑</button>` : ''}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.tl-am-acct-key').forEach(btn => {
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(btn.dataset.key);
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = original; }, 1500);
      });
    });
    list.querySelectorAll('.tl-am-acct-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if(btn.dataset.confirming !== '1'){
          btn.dataset.confirming = '1';
          btn.textContent = 'Confirm?';
          setTimeout(() => { btn.dataset.confirming = ''; btn.textContent = '🗑'; }, 4000);
          return;
        }
        await deleteAccount(btn.dataset.id);
        if(getActiveAccountId() === btn.dataset.id) setActiveAccountId('');
        await renderAccountModalAccounts(overlay);
        document.dispatchEvent(new CustomEvent('tl-accounts-changed'));
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
      actionBox.innerHTML = `<a class="btn btn-primary" style="width:100%; display:block; text-align:center;" href="index.html#pricing">Upgrade to Pro</a>`;
    } else if(info.cancelAtPeriodEnd){
      box.innerHTML = `<strong style="color:var(--text);">Pro plan</strong> — cancelled, active until <strong>${fmt(info.periodEnd)}</strong>`;
      actionBox.innerHTML = `<button type="button" class="btn btn-ghost" id="tlAmManagePro" style="width:100%;">Manage subscription</button>`;
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
  }

  async function openAccountModal(){
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
    await renderAccountModalAccounts(overlay);
    await renderAccountModalPlan(overlay);
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
          ${isPro ? '' : '<a href="index.html#pricing"><span class="tl-nav-menu-ic">⭐</span>Upgrade to Pro</a>'}
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
      openAccountModal();
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
        primaryHref: 'index.html#pricing'
      });
    },
    showModal
  };

  TLAuth.data = {
    getUserTrades,
    upsertTrade,
    uploadTradeImage,
    getAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
    ensureDefaultAccount,
    getActiveAccountId,
    setActiveAccountId
  };

  window.TLAuth = TLAuth;
})();
