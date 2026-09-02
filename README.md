# Inventory Camera Transport Spike

Public static staging probe for testing a top-level mobile camera and browser transport to a Google Apps Script staging backend.

- Contains no Apps Script deployment URL.
- Contains no device ID, remember token, inventory record, OAuth credential, or shared secret.
- The staging endpoint is entered in page memory for each test and is not persisted or logged.
- Experiment B embeds only the staging bridge route and exposes one zero-argument, read-only `bridgePing`; it does not expose inventory reads or mutations.
- Authoritative source, tests, and measured results are maintained in the private `Inventory-App-GSheet` repository.

The hosted page is experimental and must not be treated as a production inventory client.
