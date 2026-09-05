import { themeStyles } from "./theme";
export const adminStyles = themeStyles + String.raw`
        .password-dialog { box-sizing: border-box; border: 1px solid #e2e8f0; border-radius: 20px; padding: 28px; width: min(440px, calc(100vw - 32px)); max-width: none; margin: auto; color: #0f172a; background: #fff; box-shadow: 0 24px 80px #0f172a33; }
        .password-dialog::backdrop { background: #0f172a80; backdrop-filter: blur(3px); }
        .password-dialog h2 { font-size: 20px; line-height: 1.4; font-weight: 700; margin: 0 0 6px; }
        .password-dialog .password-account { color: #64748b; font-size: 14px; margin: 0 0 22px; overflow-wrap: anywhere; }
        .password-dialog .password-field { box-sizing: border-box; display: block; width: 100%; padding: 14px; border: 1px solid #cbd5e1; border-radius: 10px; color: #0f172a; background: #f8fafc; font: 16px/1.5 ui-monospace, monospace; }
        .password-dialog .password-note { color: #64748b; font-size: 12px; margin: 12px 0 24px; }
        .password-dialog .password-footer { display: flex; justify-content: flex-end; gap: 10px; }
        .password-dialog .password-close, .password-dialog .password-copy { padding: 10px 18px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid #e2e8f0; }
        .password-dialog .password-close { background: #fff; color: #475569; }
        .password-dialog .password-copy { background: #2563eb; color: #fff; border-color: #2563eb; }
        .password-dialog button:focus-visible, .user-actions button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
        .user-actions { display: grid; grid-template-columns: repeat(2, minmax(108px, 1fr)); gap: 8px; min-width: 224px; }
        .user-actions form { margin: 0; display: contents; }
        .user-actions .btn { justify-content: center; min-height: 40px; width: 100%; padding: 9px 12px; white-space: nowrap; line-height: 20px; border-radius: 9px; font-size: 13px; font-weight: 600; box-shadow: none; }
        .user-actions .btn:disabled { opacity: .55; cursor: wait; transform: none; }
        body { font-family: system-ui, sans-serif; background-color: #fbfbfb; color: #333;
          background-image: radial-gradient(rgba(128,198,249,0.2) 1px, transparent 1px); background-size: 20px 20px; }
        .glass { background: rgba(255,255,255,0.85); backdrop-filter: blur(12px); border: 1px solid rgba(250,232,122,0.6); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .bar-track { background: #f1f5f9; border-radius: 9999px; overflow: hidden; height: 8px; border: 1px solid #e2e8f0; }
        .bar-fill  { height: 100%; border-radius: 9999px; transition: width 0.4s ease; }
        input, select { transition: all 0.2s; border: 1px solid #cbd5e1; }
        input:focus, select:focus { outline: none; border-color: #80c6f9 !important; box-shadow: 0 0 0 3px rgba(128,198,249,0.2); }
        .btn { display: inline-flex; align-items: center; gap: 4px; font-size: 0.75rem; font-weight: 500;
               padding: 4px 12px; border-radius: 6px; cursor: pointer; transition: all 0.2s; border: 1px solid transparent; }
        .btn-edit    { background: #eff6ff; color: #3b82f6; border-color: #bfdbfe; }
        .btn-edit:hover { background: #dbeafe; transform: translateY(-1px); }
        .btn-suspend { background: #fef3c7; color: #d97706; border-color: #fde68a; }
        .btn-suspend:hover { background: #fde68a; transform: translateY(-1px); }
        .btn-activate{ background: #ecfdf5; color: #059669; border-color: #a7f3d0; }
        .btn-activate:hover { background: #d1fae5; transform: translateY(-1px); }
        .btn-delete  { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
        .btn-delete:hover { background: #fee2e2; transform: translateY(-1px); }
        #toast { position: fixed; bottom: 24px; right: 24px; padding: 14px 24px; border-radius: 12px;
                 font-size: 0.875rem; font-weight: 600; opacity: 0; transform: translateY(12px); color: #fff;
                 transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); pointer-events: none; z-index: 999; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); }
        #toast.show { opacity: 1; transform: translateY(0); }
        .toast-success { background: #10b981; }
        .toast-error { background: #e43b12; }
        .toast-info { background: #80c6f9; color: #1e293b !important; }

body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--font-ui)}
.glass{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:none;backdrop-filter:none}
input:not([type=hidden]),select{box-sizing:border-box;min-height:42px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface);color:var(--ink);font:inherit;padding:10px 12px}
input:focus,select:focus{border-color:var(--green)!important;box-shadow:none;outline:3px solid var(--focus);outline-offset:2px}
.btn,.user-actions .btn,button[type=submit],#form-cancel-btn{font:550 13px/1.35 var(--font-ui);min-height:40px;border-radius:var(--radius-control);padding:9px 14px;border:1px solid var(--line);box-shadow:none;transform:none}
.btn-edit,.btn-activate{background:var(--mint);color:var(--green);border-color:var(--line)}
.btn-suspend{background:var(--surface);color:var(--muted);border-color:var(--line)}
.btn-delete{background:var(--red-bg);color:var(--red);border-color:transparent}
.btn:hover{transform:none;background:var(--mint)}
.btn-delete:hover{background:#fce4df}
#form-submit-btn,.login-page button[type=submit]{background:var(--green);color:white;border-color:var(--green)}
.password-dialog{font-family:var(--font-ui);border-color:var(--line);border-radius:var(--radius-dialog);color:var(--ink);box-shadow:var(--shadow-dialog)}
.password-dialog::backdrop{background:#14332966}
.password-dialog h2{font-size:22px;letter-spacing:-.6px;color:var(--ink)}
.password-dialog .password-account,.password-dialog .password-note{color:var(--muted)}
.password-dialog .password-field{border-color:var(--line);border-radius:var(--radius-control);background:var(--bg);color:var(--ink);font-family:var(--font-ui)}
.password-dialog .password-close,.password-dialog .password-copy{border-radius:var(--radius-control);border:1px solid var(--line);font:550 13px/1.35 var(--font-ui);min-height:40px}
.password-dialog .password-copy{background:var(--green);border-color:var(--green);color:white}
.password-dialog .password-close{color:var(--ink)}
.password-dialog button:focus-visible,.user-actions button:focus-visible{outline-color:var(--focus)}
.bar-track{background:var(--mint);border:0;box-shadow:none;height:5px}
.bar-fill{background:var(--green)!important}
#toast{border-radius:var(--radius-control);font:550 13px/1.5 var(--font-ui);max-width:calc(100vw - 32px)}
.toast-success,.toast-info{background:var(--green);color:white!important}.toast-error{background:var(--red)}
.login-page{padding:24px;min-height:100vh;display:flex;align-items:center;justify-content:center}
.login-page form,.login-page>div{width:min(400px,100%);padding:28px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:none}
h1,h2,p{margin-top:0}h1{font-size:34px;line-height:1.2;letter-spacing:-1.1px}h2{font-size:17px;letter-spacing:-.3px}
table{border-collapse:collapse;width:100%}th{font-size:11px;font-weight:600;color:var(--muted);background:#f8faf7}td,th{border-bottom:1px solid var(--line)}
.hidden{display:none}.block{display:block}.inline{display:inline}.flex{display:flex}.grid{display:grid;min-width:0}.grid>*{min-width:0}.flex-1{flex:1}.items-center{align-items:center}.justify-between{justify-content:space-between}.justify-center{justify-content:center}.grid-cols-1{grid-template-columns:1fr}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.gap-2{gap:8px}.gap-3{gap:12px}.gap-6{gap:24px}
.w-full{width:100%}.w-28{width:112px}.max-w-6xl{max-width:1168px}.mx-auto{margin-inline:auto}.overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.space-y-4>*+*{margin-top:16px}
.text-center{text-align:center}.text-left{text-align:left}.text-right{text-align:right}.font-bold,.font-semibold{font-weight:650}.font-medium{font-weight:550}.font-normal{font-weight:400}.text-xs{font-size:12px}.text-sm{font-size:13px}.text-lg{font-size:17px}.text-xl{font-size:22px}.text-2xl{font-size:26px}.text-4xl{font-size:34px}
.text-slate-400,.text-slate-500,.text-slate-600{color:var(--muted)}.text-slate-700,.text-slate-800,.text-slate-900{color:var(--ink)}.text-danger,.text-red-700{color:var(--red)}.text-emerald-700{color:var(--green)}
.bg-primary{background:var(--green)}.bg-secondary,.bg-emerald-100{background:var(--mint)}.bg-red-100{background:var(--red-bg)}.bg-white{background:var(--surface)}.border,.border-b{border:1px solid var(--line)}.rounded-lg{border-radius:var(--radius-control)}.rounded-2xl{border-radius:var(--radius)}.rounded-full{border-radius:999px}
@media(min-width:1100px){.lg\:grid-cols-3{grid-template-columns:minmax(260px,1fr) minmax(0,2fr)}.lg\:col-span-2{grid-column:span 1}.sticky{position:sticky;top:24px}}
@media(max-width:600px){.admin-page thead{display:none}.admin-page tbody,.admin-page table{display:block}.admin-page tbody tr{display:grid;grid-template-columns:1fr 1fr;padding:16px;border-bottom:1px solid var(--line);gap:12px}.admin-page tbody td{display:block;padding:0;border:0;min-width:0;overflow-wrap:anywhere}.admin-page tbody td:first-child,.admin-page tbody td:last-child{grid-column:1/-1}.admin-page .user-actions{min-width:0}.admin-page .grid>div>div>div.flex{flex-wrap:wrap;gap:8px}body.admin-page{padding:16px}.admin-page header{align-items:flex-start;gap:12px}.admin-page h1{font-size:26px}.user-actions{min-width:224px}.password-dialog{padding:28px}}
.p-0\.5{padding:2px}
.px-0\.5{padding-inline:2px}
.py-0\.5{padding-block:2px}
.pt-0\.5{padding-top:2px}
.mb-0\.5{margin-bottom:2px}
.mt-0\.5{margin-top:2px}
.ml-0\.5{margin-left:2px}
.p-1{padding:4px}
.px-1{padding-inline:4px}
.py-1{padding-block:4px}
.pt-1{padding-top:4px}
.mb-1{margin-bottom:4px}
.mt-1{margin-top:4px}
.ml-1{margin-left:4px}
.p-1\.5{padding:6px}
.px-1\.5{padding-inline:6px}
.py-1\.5{padding-block:6px}
.pt-1\.5{padding-top:6px}
.mb-1\.5{margin-bottom:6px}
.mt-1\.5{margin-top:6px}
.ml-1\.5{margin-left:6px}
.p-2{padding:8px}
.px-2{padding-inline:8px}
.py-2{padding-block:8px}
.pt-2{padding-top:8px}
.mb-2{margin-bottom:8px}
.mt-2{margin-top:8px}
.ml-2{margin-left:8px}
.p-2\.5{padding:10px}
.px-2\.5{padding-inline:10px}
.py-2\.5{padding-block:10px}
.pt-2\.5{padding-top:10px}
.mb-2\.5{margin-bottom:10px}
.mt-2\.5{margin-top:10px}
.ml-2\.5{margin-left:10px}
.p-3{padding:12px}
.px-3{padding-inline:12px}
.py-3{padding-block:12px}
.pt-3{padding-top:12px}
.mb-3{margin-bottom:12px}
.mt-3{margin-top:12px}
.ml-3{margin-left:12px}
.p-4{padding:16px}
.px-4{padding-inline:16px}
.py-4{padding-block:16px}
.pt-4{padding-top:16px}
.mb-4{margin-bottom:16px}
.mt-4{margin-top:16px}
.ml-4{margin-left:16px}
.p-5{padding:20px}
.px-5{padding-inline:20px}
.py-5{padding-block:20px}
.pt-5{padding-top:20px}
.mb-5{margin-bottom:20px}
.mt-5{margin-top:20px}
.ml-5{margin-left:20px}
.p-6{padding:24px}
.px-6{padding-inline:24px}
.py-6{padding-block:24px}
.pt-6{padding-top:24px}
.mb-6{margin-bottom:24px}
.mt-6{margin-top:24px}
.ml-6{margin-left:24px}
.p-8{padding:32px}
.px-8{padding-inline:32px}
.py-8{padding-block:32px}
.pt-8{padding-top:32px}
.mb-8{margin-bottom:32px}
.mt-8{margin-top:32px}
.ml-8{margin-left:32px}
.p-10{padding:40px}
.px-10{padding-inline:40px}
.py-10{padding-block:40px}
.pt-10{padding-top:40px}
.mb-10{margin-bottom:40px}
.mt-10{margin-top:40px}
.ml-10{margin-left:40px}

.admin-page header{padding:16px 20px;margin-bottom:20px;align-items:center}.admin-page header h1{font-size:25px;line-height:1.2;margin:0 0 4px}.admin-page header p{margin:0;font-size:12px}.admin-page header a{padding:8px 12px;font-size:12px}.admin-page td{padding-block:10px}.user-actions{grid-template-columns:1fr 1fr;min-width:190px;align-items:start}.user-actions .btn{font-size:12px;min-height:38px;padding:8px 10px}.account-menu summary{cursor:pointer;list-style:none}.account-menu summary::-webkit-details-marker{display:none}.account-menu-items{display:grid;gap:6px;margin-top:6px}.account-menu-items form{display:contents}.account-menu[open]{grid-column:2}.admin-page td:nth-child(3){white-space:nowrap}
@media(max-width:600px){.admin-page header{padding:14px 16px}.admin-page header h1{font-size:22px}.admin-page tbody tr{padding:12px 16px;gap:8px}.user-actions .btn{min-height:40px}}
`;
