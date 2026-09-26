module.exports = {
  version: 2,
  snapshot: {
    widths: [375, 1280],
    minHeight: 1024,
    percyCSS: `
      /* Ensure animations are disabled and dynamic elements are hidden for consistent snapshots */
      * {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      .dynamic-date, [data-testid="date-display"], .chart-animation-wrapper {
        visibility: hidden !important;
      }
    `
  },
  discovery: {
    allowedHostnames: [],
    networkIdleTimeout: 150
  },
  // Color-blind palette snapshots: key pages are captured under both palettes so
  // any status-color regression is flagged in CI visual diffs.
  // Usage: percy exec -- <test-runner> with PERCY_PALETTE env var set by the runner.
  // The e2e suite sets document.documentElement.setAttribute('data-palette', palette)
  // before each snapshot group.
  snapshots: [
    // ── Default palette ─────────────────────────────────────────────────────
    {
      name: "Dashboard – default palette",
      url: "/dashboard",
      additionalSnapshots: [{ suffix: " (mobile)", widths: [375] }],
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'default');
        `,
      },
    },
    {
      name: "Settings / Appearance – default palette",
      url: "/settings",
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'default');
        `,
      },
    },
    {
      name: "Loan Status – default palette",
      url: "/repay",
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'default');
        `,
      },
    },
    {
      name: "Investor Pool – default palette",
      url: "/invest",
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'default');
        `,
      },
    },
    // ── Color-blind-friendly palette ─────────────────────────────────────────
    {
      name: "Dashboard – colorblind palette",
      url: "/dashboard",
      additionalSnapshots: [{ suffix: " (mobile)", widths: [375] }],
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'colorblind');
        `,
      },
    },
    {
      name: "Settings / Appearance – colorblind palette",
      url: "/settings",
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'colorblind');
        `,
      },
    },
    {
      name: "Loan Status – colorblind palette",
      url: "/repay",
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'colorblind');
        `,
      },
    },
    {
      name: "Investor Pool – colorblind palette",
      url: "/invest",
      execute: {
        afterNavigation: `
          document.documentElement.setAttribute('data-palette', 'colorblind');
        `,
      },
    },
  ],
};
