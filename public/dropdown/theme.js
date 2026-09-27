(function(){
    function applyThemeClass(t) { document.body.className = t || 'theme-default'; }

    function hexToRgb(hex) { hex = hex.replace('#',''); const bigint = parseInt(hex, 16); return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 }; }
    function rgbToHex(r,g,b){ return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join(''); }
    function rgbToHsl(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h,s,l=(max+min)/2; if(max===min){h=s=0;}else{const d=max-min; s = l>0.5 ? d/(2-max-min) : d/(max+min); switch(max){case r: h=(g-b)/d + (g < b ? 6 : 0); break; case g: h=(b-r)/d + 2; break; case b: h=(r-g)/d +4; break;} h/=6;} return {h: h, s: s, l: l}; }
    function hslToRgb(h,s,l){ let r,g,b; if(s===0){r=g=b=l;} else {const hue2rgb=(p,q,t)=>{ if(t<0) t+=1; if(t>1) t-=1; if(t<1/6) return p + (q-p)*6*t; if(t<1/2) return q; if(t<2/3) return p + (q-p)*(2/3 - t)*6; return p; }; const q = l<0.5 ? l*(1+s) : l + s - l*s; const p = 2*l - q; r = hue2rgb(p,q,h + 1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h - 1/3);} return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) }; }
    function adjustLightness(hex, deltaPercent){ const rgb = hexToRgb(hex); const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b); hsl.l = Math.max(0, Math.min(1, hsl.l + deltaPercent/100)); const rgb2 = hslToRgb(hsl.h, hsl.s, hsl.l); return rgbToHex(rgb2.r, rgb2.g, rgb2.b); }
    function luminance(hex) { const {r,g,b}=hexToRgb(hex); const rs = r/255, gs = g/255, bs = b/255; const srgb=(v)=> v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); const L = 0.2126*srgb(rs)+0.7152*srgb(gs)+0.0722*srgb(bs); return L; }

    function applyCustomColors(hex){
        if (!hex) return;
        const primary = hex;
        const bgToolbar = primary;
        const bgMain = adjustLightness(primary, -18);
        const bgElementHover = adjustLightness(primary, 10);
        const bgInput = adjustLightness(primary, -8);
        const borderColor = adjustLightness(primary, -28);
        const bgTitlebar = adjustLightness(primary, -6);
        const L = luminance(primary);
        const textColor = L < 0.45 ? '#eaf1ff' : (L > 0.75 ? '#111111' : '#434c57');

        const root = document.documentElement;
        root.style.setProperty('--bg-toolbar', bgToolbar);
        root.style.setProperty('--bg-main', bgMain);
        root.style.setProperty('--bg-element-hover', bgElementHover);
        root.style.setProperty('--bg-input', bgInput);
        root.style.setProperty('--border-color', borderColor);
        root.style.setProperty('--text-color', textColor);
        root.style.setProperty('--bg-titlebar', bgTitlebar);
    }

    function loadAndApply(s){
        const t = s && s.theme ? s.theme : (localStorage.getItem('theme') || 'theme-default');
        applyThemeClass(t);
        if (t === 'theme-custom'){
            const c = (s && s.themeColor) ? s.themeColor : (localStorage.getItem('themeColor') || '#1E88E5');
            applyCustomColors(c);
        }
    }

    if (window.electronAPI && window.electronAPI.getSettings) {
        window.electronAPI.getSettings().then(loadAndApply).catch(() => { loadAndApply(null); });
        if (window.electronAPI.onSettingsUpdated) {
            window.electronAPI.onSettingsUpdated((s) => {
                loadAndApply(s);
            });
        }
    } else {
        loadAndApply(null);
    }
})();
