// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Inline script that runs before first paint so the chosen text size is applied
// without a visible reflow. It cannot import anything, so it duplicates the
// small resolution logic from textSize.ts; text-size.test.tsx checks the two
// stay in agreement. Only non-default sizes are stored on the root, matching
// applyTextSize(). Storage key must match textSize.ts.
export const TEXT_SIZE_BOOT_SCRIPT = `(function(){try{
var s=localStorage.getItem("remitmortgage-text-size");
if(s==="large"||s==="x-large")document.documentElement.setAttribute("data-text-size",s);
}catch(e){}})();`;
