export const themeStyles = String.raw`
:root{color-scheme:light;--bg:#f5f6f3;--surface:#fff;--ink:#18332d;--muted:#61746d;--line:#e2e8e2;--green:#14654e;--mint:#e8f3ed;--red:#b13635;--red-bg:#fff1ef;--radius:18px;--radius-control:10px;--radius-dialog:18px;--font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--focus:#8ebfb0;--shadow-dialog:0 20px 80px #122d3430;--subtle:#f8faf7;--hover:#edf3ed;--accent-hover:#0b513c;--on-accent:#fff;--warning:#8e6523;--warning-bg:#fbf2e3;--info:#5d6dae;--info-bg:#edf0fa;--danger-hover:#fce4df;--toast-bg:#18332d}
:root[data-theme=dark]{color-scheme:dark;--bg:#111b18;--surface:#1a2823;--ink:#e5f0ea;--muted:#adbbb3;--line:#374a40;--green:#79d7b4;--mint:#233f33;--red:#ffaaa3;--red-bg:#442a29;--focus:#79d7b4;--shadow-dialog:0 20px 80px #0008;--subtle:#17231e;--hover:#2a3c32;--accent-hover:#a1e7ca;--on-accent:#10291e;--warning:#e8c17c;--warning-bg:#3d3220;--info:#aebcfb;--info-bg:#2c3249;--danger-hover:#58332f;--toast-bg:#284a3b}
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;flex:0 0 40px;padding:0;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px}.theme-toggle:hover{background:var(--hover)}.theme-floating{position:fixed;top:16px;right:16px;z-index:10}.admin-page header .theme-toggle{margin-left:8px}.admin-page header>a[href="/admin/logout"]{margin-left:auto}.account .theme-toggle{width:36px;height:36px;flex-basis:36px}
dialog{background:var(--surface)}input,select,textarea{color:var(--ink);background-color:var(--surface)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--font-ui)}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button,a{ -webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:wait;opacity:.6}a{color:inherit;text-decoration:none}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #8ebfb0;outline-offset:3px}[hidden]{display:none!important}svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
button,input,select{border-radius:var(--radius-control)}
`;


/** Run in the head so the saved theme is applied before the first paint. */
export const themeBoot = String.raw`<script>(function(){
  const key = 'vbook-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (['light','dark','system'].includes(saved)) preference = saved; } catch {}
  const labels = {system:'Theo thiết bị',light:'Sáng',dark:'Tối'};
  function apply(){
    const dark = preference === 'dark' || (preference === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    const button = document.getElementById('theme-toggle');
    if (button) {
      const next = preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system';
      button.title = 'Giao diện: ' + labels[preference] + '. Chuyển sang ' + labels[next].toLowerCase();
      button.setAttribute('aria-label', button.title);
      button.dataset.preference = preference;
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24">' + (preference === 'system' ? '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>' : dark ? '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z"/>' : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>') + '</svg>';
    }
  }
  apply();
  media.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = ['light','dark','system'].includes(event.newValue) ? event.newValue : 'system';
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.createElement('button');
    button.id = 'theme-toggle'; button.type = 'button'; button.className = 'theme-toggle';
    const target = document.querySelector('.account') || document.querySelector('.admin-page header');
    if (target) target.appendChild(button);
    else { button.classList.add('theme-floating'); document.body.appendChild(button); }
    button.addEventListener('click', () => {
      preference = preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system';
      try { localStorage.setItem(key, preference); } catch {}
      apply();
    });
    apply();
  });
})();</script>`;
