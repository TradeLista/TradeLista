/* ---------- TradeLista Auth ----------
   Client-side demo only — there is no backend. Accounts and sessions live in
   localStorage on this device. Passwords are hashed (SHA-256) before storage
   so they're never kept as plain text, but this is not a substitute for real
   server-side authentication.
*/
(function(){
  const USERS_KEY = 'tradelista_users';
  const SESSION_KEY = 'tradelista_session';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function hashPassword(password){
    const data = new TextEncoder().encode(password);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function loadUsers(){
    try{ return JSON.parse(localStorage.getItem(USERS_KEY)) || []; }catch(e){ return []; }
  }
  function saveUsers(users){
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }
  function sessionEmail(){
    try{ return (JSON.parse(localStorage.getItem(SESSION_KEY)) || {}).email || null; }catch(e){ return null; }
  }

  const TLAuth = {
    isLoggedIn(){ return !!sessionEmail(); },

    getCurrentUser(){
      const email = sessionEmail();
      if(!email) return null;
      return loadUsers().find(u => u.email === email) || null;
    },

    isPro(){
      const u = this.getCurrentUser();
      if(!u || u.plan !== 'pro') return false;
      if(u.cancelAtPeriodEnd && u.periodEnd && Date.now() >= u.periodEnd){
        const users = loadUsers();
        const stored = users.find(x => x.email === u.email);
        if(stored){ stored.plan = 'free'; stored.cancelAtPeriodEnd = false; stored.periodEnd = null; saveUsers(users); }
        return false;
      }
      return true;
    },

    initials(){
      const u = this.getCurrentUser();
      if(!u) return '';
      return ((u.firstName[0] || '') + (u.lastName[0] || '')).toUpperCase();
    },

    async signup({ firstName, lastName, email, password }){
      firstName = (firstName || '').trim();
      lastName = (lastName || '').trim();
      email = (email || '').trim().toLowerCase();
      if(!firstName || !lastName) return { ok:false, error:'Please enter your first and last name.' };
      if(!EMAIL_RE.test(email)) return { ok:false, error:'Please enter a valid email address.' };
      if(!password || password.length < 8) return { ok:false, error:'Password must be at least 8 characters.' };
      const users = loadUsers();
      if(users.some(u => u.email === email)) return { ok:false, error:'An account with this email already exists.' };
      const passwordHash = await hashPassword(password);
      users.push({ firstName, lastName, email, passwordHash, plan:'free', createdAt:Date.now() });
      saveUsers(users);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ email }));
      return { ok:true };
    },

    async login({ email, password }){
      email = (email || '').trim().toLowerCase();
      const user = loadUsers().find(u => u.email === email);
      if(!user) return { ok:false, error:'No account found with this email.' };
      const passwordHash = await hashPassword(password || '');
      if(passwordHash !== user.passwordHash) return { ok:false, error:'Incorrect password.' };
      localStorage.setItem(SESSION_KEY, JSON.stringify({ email }));
      return { ok:true };
    },

    logout(){
      localStorage.removeItem(SESSION_KEY);
    },

    upgradeToPro(){
      const email = sessionEmail();
      if(!email) return false;
      const users = loadUsers();
      const user = users.find(u => u.email === email);
      if(!user) return false;
      user.plan = 'pro';
      user.cancelAtPeriodEnd = false;
      user.periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000;
      saveUsers(users);
      return true;
    },

    getPlanInfo(){
      const u = this.getCurrentUser();
      if(!u) return null;
      return {
        plan: u.plan,
        isPro: this.isPro(),
        cancelAtPeriodEnd: !!u.cancelAtPeriodEnd,
        periodEnd: u.periodEnd || null
      };
    },

    cancelPro(){
      const email = sessionEmail();
      if(!email) return { ok:false, error:'Not logged in.' };
      const users = loadUsers();
      const user = users.find(u => u.email === email);
      if(!user || user.plan !== 'pro') return { ok:false, error:'No active Pro plan to cancel.' };
      if(user.cancelAtPeriodEnd) return { ok:false, error:'Your Pro plan is already set to cancel.' };
      if(!user.periodEnd) user.periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000;
      user.cancelAtPeriodEnd = true;
      saveUsers(users);
      return { ok:true, periodEnd: user.periodEnd };
    },

    resumePro(){
      const email = sessionEmail();
      if(!email) return false;
      const users = loadUsers();
      const user = users.find(u => u.email === email);
      if(!user || user.plan !== 'pro') return false;
      user.cancelAtPeriodEnd = false;
      saveUsers(users);
      return true;
    },

    updateProfile({ firstName, lastName }){
      const email = sessionEmail();
      if(!email) return { ok:false, error:'Not logged in.' };
      firstName = (firstName || '').trim();
      lastName = (lastName || '').trim();
      if(!firstName || !lastName) return { ok:false, error:'Please enter your first and last name.' };
      const users = loadUsers();
      const user = users.find(u => u.email === email);
      if(!user) return { ok:false, error:'Account not found.' };
      user.firstName = firstName;
      user.lastName = lastName;
      saveUsers(users);
      return { ok:true };
    },

    async changePassword({ currentPassword, newPassword }){
      const email = sessionEmail();
      if(!email) return { ok:false, error:'Not logged in.' };
      if(!newPassword || newPassword.length < 8) return { ok:false, error:'New password must be at least 8 characters.' };
      const users = loadUsers();
      const user = users.find(u => u.email === email);
      if(!user) return { ok:false, error:'Account not found.' };
      const currentHash = await hashPassword(currentPassword || '');
      if(currentHash !== user.passwordHash) return { ok:false, error:'Current password is incorrect.' };
      user.passwordHash = await hashPassword(newPassword);
      saveUsers(users);
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
