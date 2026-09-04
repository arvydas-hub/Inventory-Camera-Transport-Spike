# Inventory Camera Transport Spike

Public static staging probe for testing a top-level mobile camera and browser transport to a Google Apps Script staging backend.

- Contains no Apps Script deployment URL.
- Contains no device ID, remember token, inventory record, OAuth credential, or shared secret.
- The staging endpoint is entered in page memory for each test and is not persisted or logged.
- Experiment B2 embeds a read-only staging bridge with one zero-argument `bridgePing`.
- Experiment B3 embeds the existing staging application beneath the top-level scanner. The parent can submit only bounded decoded text to the app's lookup flow; identity, results, and user-clicked inventory controls stay inside Apps Script, and no parent message can request a mutation.
- The v0.3.21 B3 controls wait for the verified app handshake, use a bounded two-attempt rear-camera strategy, suppress repeated reads until explicitly re-armed, and provide local photo decoding as a hardware-independent fallback.
- Experiment B4 is a staging-only external camera window opened by the ordinary Apps Script app. Its v0.3.24 flow makes one guarded automatic camera-start attempt after the verified handshake, stops capture before lookup, and best-effort returns/closes after a found or not-found result; manual Start and Return remain fallbacks. The exact two-window/two-nonce, lookup-only protocol remains in place.
- Both camera pages load the reviewed same-origin `html5-qrcode` 2.3.8 bundle with pinned SHA-256/SRI; its Apache-2.0 license and provenance are preserved under `vendor/`.
- Authoritative source, tests, and measured results are maintained in the private `Inventory-App-GSheet` repository.

The hosted page is experimental and must not be treated as a production inventory client.
