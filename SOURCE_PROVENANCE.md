# Source provenance

Taxi's initial codebase was derived from AirMCP commit
`6e85de94ee71011c2ac318adeabfa5d43bde50b2`.

- Source repository: https://github.com/heznpc/AirMCP
- Source commit: `6e85de94ee71011c2ac318adeabfa5d43bde50b2`
- Source tree: `8585a74f2ba5ab385d4283dbbe2218f764fd7a5f`
- Source archive SHA-256: `ab395012352f17ed8b259f91c1e08014a0796007c4ca5b1ade7dabdc315ad52c`

AirMCP was distributed under the MIT License. Original development history
and authorship remain available in the AirMCP source repository.

Taxi starts from AirMCP's verified final source base as a separate product. It
does not claim to have been built from scratch or to consist entirely of code
originally written for Taxi.

Separately licensed third-party components retain their respective license and
notice requirements.

## Execution follow-up assets

- Zoint's provider-adapter and process-runner designs informed read-only CLI
  adapter flags and capture/review separation in Taxi's Node implementation.
  No Zoint database or application lifecycle was copied.
- Modore supplies the v1 agent-state snapshot contract consumed by Taxi.
  The synthetic producer example is preserved byte-for-byte in
  `tests/fixtures/modore/agent-state-snapshot-v1.json`.
- newtria-crossflow's Power Automate Desktop URI semantics informed the
  Windows adapter. Taxi adds durable request correlation and authenticated
  completion callbacks; URI dispatch alone does not establish flow success.
