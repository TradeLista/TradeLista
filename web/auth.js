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

    async initials(){
      const u = await this.getCurrentUser();
      if(!u) return '';
      return ((u.firstName[0] || '') + (u.lastName[0] || '')).toUpperCase();
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

  TLAuth.ui = {
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

  window.TLAuth = TLAuth;
})();
