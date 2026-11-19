# Data saver and accessibility behavior

The client reads the browser `navigator.connection.saveData` hint on first load. Users can override it from Settings → Profile → Accessibility & data use; the choice is stored locally under `remitmortgage-data-saver`.

When enabled, analytics requests send `Save-Data: on`, request three months instead of twelve, omit the activity feed, pause interactive charts, and reduce ledger/transaction polling. Core actions (wallet connection, deposits, withdrawals, repayments, and report filtering) remain available.

To measure the impact, open the browser Network panel, enable “Disable cache”, load `/analytics` once with the toggle off and once with it on, and compare the Network panel’s transferred-byte total. The compact requests and the paused chart bundle should produce a lower total; repeat the same comparison on a throttled mobile profile for a representative result.

The shared `DateRangePicker` calculates dates with local `Date` accessors, so presets stay in the user’s timezone and custom ranges reject a start after the end. Native date inputs and buttons provide keyboard operation.

Forced-colors support is in `globals.css`: controls use system colors, focus uses `Highlight`, and chart lines use dash patterns. The optional high-contrast palette strengthens text, borders, and focus outlines for environments that do not enable Windows forced-colors.
