/**
 * Runs in <head> before the page paints, so a theme picked with ThemeToggle never flashes the
 * other one first.
 */
export const THEME_SCRIPT =
  "try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";
