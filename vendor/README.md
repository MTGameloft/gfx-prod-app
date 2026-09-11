# Third-party code

## xlsx.full.min.js — SheetJS Community Edition 0.18.5

* Source: https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
* Licence: Apache-2.0
* Homepage: https://sheetjs.com/

Vendored rather than loaded from a CDN on purpose. The app runs inside a
Microsoft Teams tab on a managed corporate machine; a request to a third-party
CDN is one more thing that can be proxied, blocked or flagged, and it would
fail at the exact moment the user is trying to import their roster. Serving it
from our own origin makes the import path depend on nothing but the app itself.

It is ~880 KB raw (~315 KB gzipped, which is what GitHub Pages actually sends)
and is **lazy-loaded** by `js/xlsxio.js` on first use, so opening the app does
not pay for it. Nothing else in the app imports it.

This is the only third-party file in the project. Everything else is ours.
