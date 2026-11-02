# Reach Dog n8n templates

## Shopify product to keywords (Template 3)

Import `templates/shopify-product-keywords.json` into n8n. The workflow starts inactive. A Shopify product creation triggers one Reach Dog title match for search phrases and volume. Results are upserted into Google Sheets by product ID.

### Setup

1. In an operator-managed PostgreSQL database, run `sql/template3-budget.sql` once. Use durable storage, synchronous commits and the default READ COMMITTED isolation. Connect both Postgres nodes to that same database. The runtime role needs schema usage, execute on the two functions, and select/insert/update on the operations table. Preserve the ledger across n8n restarts and workflow imports.
2. Select credentials on the Shopify trigger, both Reach Dog HTTP nodes (Header Auth, header name `Authorization`, value `Bearer <key>`), and the two Google Sheets nodes.
3. In Configuration set the trusted HTTPS API origin without a trailing slash, spreadsheet ID, stable nonsecret account label and daily cap in Reach Dog billing tokens. Use one ledger, label and cap across all copies for the same account. Leave run_label empty for ordinary operation. A deliberate new run_label creates a new billable identity.
4. Create a Keywords tab with headers `client_product_id,title,search_phrases,search_volume,charge_state,charged_tokens,status` and an Excluded tab with `client_product_id,status` (each name in its own cell). Select the corresponding tabs and matching column if your n8n version asks to refresh the schema.

### Daily admission and recovery

The Postgres reserve node locks the account for the duration of one transaction, checks the UTC admission day's total and commits the estimate before the paid HTTP node runs. Two workers cannot use the same remaining allowance. An unavailable ledger or missing price stops the paid path. The daily limit applies to estimated Reach Dog spending at admission. If the actual settled charge differs, the ledger records the receipt amount on the original admission day.

The workflow sends the same request key on transient retries. It records settlement and the result row before writing to Sheets. A duplicate settled event can repair a failed sheet write from that saved row. A known pre-execution rejection releases the allowance. A lost response, unavailable receipt or interrupted execution leaves the allowance held. Redelivery of that key stops, including after UTC midnight. A cap skip consumes no allowance.

For a held operation, inspect the original execution and reconcile its request key against authoritative payment evidence. A human operator can use `rd_keywords.finish` with the stored account, key and original execution ID, a verified settled amount and output row, or `released` with zero only after confirming no charge and that the original execution has stopped. Redeliver the original event after reconciliation. Never remove holds merely because they are old or use a new run_label to recover uncertain spending. A new UTC day has a new allowance.

### Offline checks

Run `npm ci` and `npm test` with Node 22 or newer. The tests create a disposable PostgreSQL instance, exercise independent database connections, and run the workflow's retry and receipt code. No service credentials are needed.

For the n8n integration test, point `node tests/n8n-smoke.mjs PATH_TO_N8N_BIN` at a local n8n CLI JavaScript entry point (tested with n8n 2.45.7 and Node 24). The test imports the original workflow into a fresh profile, then runs a copy with loopback HTTP substitutes for Shopify, Reach Dog and Sheets. It forces a failed sheet write after payment, replays that product, and attempts a second product at the exhausted cap.
