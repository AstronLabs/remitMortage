// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import SkipToContent from "@/components/SkipToContent";

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SkipToContent />
      <main id="main-content" role="main" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
    </>
  );
}
