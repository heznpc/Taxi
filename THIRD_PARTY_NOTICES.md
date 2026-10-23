# Third-Party Notices

Taxi redistributes or installs the components listed below. Each component
remains under its own license. The npm and macOS artifacts retain the license
files shipped inside every production `node_modules` package. The macOS app
also carries the license distributed with its exact embedded Node.js runtime.

This inventory is pinned to Taxi 1.0.0's `package-lock.json` and
`ios/Package.resolved`. It is an inventory and does not replace the license
text included with each component.

## Node.js runtime

- Node.js — its upstream license file and bundled third-party attributions are
  copied verbatim to `Contents/Resources/taxi/runtime/LICENSE` in Taxi.app.

## Production npm dependency inventory

BSD-2-Clause: `json-schema-typed@8.0.2`.

BSD-3-Clause: `fast-uri@3.1.7`, `qs@6.16.0`.

ISC: `inherits@2.0.4`, `isexe@2.0.0`, `once@1.4.0`,
`setprototypeof@1.2.0`, `which@2.0.2`, `wrappy@1.0.2`, `yaml@2.9.0`,
`zod-to-json-schema@3.25.2`.

MIT: `@heznpc/quota-core@0.2.0`, `@hono/node-server@2.0.12`, `@modelcontextprotocol/ext-apps@1.7.5`,
`@modelcontextprotocol/sdk@1.30.0`, `@standard-schema/spec@1.1.0`,
`accepts@2.0.0`, `ajv@8.20.0`, `ajv-formats@3.0.1`,
`body-parser@2.3.0`, `bytes@3.1.2`, `call-bind-apply-helpers@1.0.2`,
`call-bound@1.0.4`, `content-disposition@1.0.1`, `content-type@1.0.5`,
`content-type@2.0.0`, `cookie@0.7.2`, `cookie-signature@1.2.2`,
`cors@2.8.6`, `cross-spawn@7.0.6`, `debug@4.4.3`, `depd@2.0.0`,
`dunder-proto@1.0.1`, `ee-first@1.1.1`, `encodeurl@2.0.0`,
`es-define-property@1.0.1`, `es-errors@1.3.0`, `es-object-atoms@1.1.2`,
`escape-html@1.0.3`, `etag@1.8.1`, `eventsource@3.0.7`,
`eventsource-parser@3.0.6`, `express@5.2.1`, `express-rate-limit@8.5.1`,
`fast-deep-equal@3.1.3`, `finalhandler@2.1.1`, `forwarded@0.2.0`,
`fresh@2.0.0`, `function-bind@1.1.2`, `get-intrinsic@1.3.0`,
`get-proto@1.0.1`, `gopd@1.2.0`, `has-symbols@1.1.0`,
`hasown@2.0.4`, `hono@4.13.1`, `http-errors@2.0.1`,
`iconv-lite@0.7.2`, `ip-address@10.5.0`, `ipaddr.js@1.9.1`,
`is-promise@4.0.0`, `jose@6.2.5`, `json-schema-traverse@1.0.0`,
`math-intrinsics@1.1.0`, `media-typer@1.1.0`, `merge-descriptors@2.0.0`,
`mime-db@1.54.0`, `mime-types@3.0.2`, `ms@2.1.3`,
`negotiator@1.0.0`, `object-assign@4.1.1`, `object-inspect@1.13.4`,
`on-finished@2.4.1`, `parseurl@1.3.3`, `path-key@3.1.1`,
`path-to-regexp@8.4.2`, `pkce-challenge@5.0.1`, `proxy-addr@2.0.7`,
`range-parser@1.2.1`, `raw-body@3.0.2`, `require-from-string@2.0.2`,
`router@2.2.0`, `safer-buffer@2.1.2`, `send@1.2.1`,
`serve-static@2.2.1`, `shebang-command@2.0.0`, `shebang-regex@3.0.0`,
`side-channel@1.1.1`, `side-channel-list@1.0.1`,
`side-channel-map@1.0.1`, `side-channel-weakmap@1.0.2`,
`statuses@2.0.2`, `toidentifier@1.0.1`, `type-is@2.1.0`,
`unpipe@1.0.0`, `vary@1.1.2`, `zod@4.4.3`.

## iOS Swift package inventory

Taxi's iOS preview resolves the following packages. Their upstream
`LICENSE.txt` and, where present, `NOTICE.txt` files must be included in any
public iOS artifact's legal-notice surface:

- `async-http-client@1.32.1`, `hummingbird@2.21.0`
- `swift-algorithms@1.2.1`, `swift-asn1@1.6.0`,
  `swift-async-algorithms@1.1.3`, `swift-atomics@1.3.0`,
  `swift-certificates@1.18.0`, `swift-collections@1.4.1`,
  `swift-configuration@1.2.0`, `swift-crypto@4.3.0`,
  `swift-distributed-tracing@1.4.1`, `swift-http-structured-headers@1.6.0`,
  `swift-http-types@1.5.1`, `swift-log@1.10.1`, `swift-metrics@2.8.0`,
  `swift-nio@2.96.0`, `swift-nio-extras@1.33.0`,
  `swift-nio-http2@1.41.0`, `swift-nio-ssl@2.36.1`,
  `swift-nio-transport-services@1.26.0`, `swift-numerics@1.1.1`,
  `swift-service-context@1.3.0`, `swift-service-lifecycle@2.10.1`,
  `swift-system@1.6.4`.

## Bundled assets

Taxi's product icons and screenshots are project assets. No separately
licensed demo media is required by the npm, MCPB, or macOS app artifacts.
