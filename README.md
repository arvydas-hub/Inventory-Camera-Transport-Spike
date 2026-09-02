# Inventory Camera Transport Spike

Public static staging probe for testing a top-level mobile camera and browser transport to a Google Apps Script staging backend.

- Contains no Apps Script deployment URL.
- Contains no device ID, remember token, inventory record, OAuth credential, or shared secret.
- The staging endpoint is entered in page memory for each test and is not persisted or logged.
- Experiment B2 embeds a read-only staging bridge with one zero-argument `bridgePing`.
- Experiment B3 embeds the existing staging application beneath the top-level scanner. The parent can submit only bounded decoded text to the app's lookup flow; identity, results, and user-clicked inventory controls stay inside Apps Script, and no parent message can request a mutation.
- Authoritative source, tests, and measured results are maintained in the private `Inventory-App-GSheet` repository.

The hosted page is experimental and must not be treated as a production inventory client.
