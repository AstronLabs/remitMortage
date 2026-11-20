// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Inline script that runs before first paint so the right theme is applied
// without a flash. It cannot import anything, so it duplicates the small
// resolution logic from theme.ts / theme-schedule.ts; theme-boot.test.ts
// checks the two stay in agreement. Storage keys must match theme.ts.
export const THEME_BOOT_SCRIPT = `(function(){try{
var d=document.documentElement,ls=localStorage,mode=ls.getItem("remitmortgage-theme-mode"),stored=ls.getItem("remitmortgage-theme"),theme=null;
var hasStored=stored==="light"||stored==="dark";
if(mode!=="system"&&mode!=="scheduled"&&mode!=="manual")mode=hasStored?"manual":"system";
if(mode==="manual"&&hasStored)theme=stored;
else if(mode==="scheduled"){
var s=JSON.parse(ls.getItem("remitmortgage-theme-schedule")||"null"),re=/^([01]\\d|2[0-3]):[0-5]\\d$/;
if(s&&re.test(s.start)&&re.test(s.end)){
var n=new Date(),m=n.getHours()*60+n.getMinutes(),a=+s.start.slice(0,2)*60+ +s.start.slice(3),b=+s.end.slice(0,2)*60+ +s.end.slice(3);
theme=a!==b&&(a<b?(m>=a&&m<b):(m>=a||m<b))?"dark":"light";}}
if(!theme)theme=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
d.setAttribute("data-theme",theme);d.style.colorScheme=theme;
var p=ls.getItem("remitmortgage-palette");if(p==="default"||p==="colorblind")d.setAttribute("data-palette",p);
if(ls.getItem("remitmortgage-high-contrast")==="on")d.setAttribute("data-high-contrast","");
}catch(e){}})();`;
