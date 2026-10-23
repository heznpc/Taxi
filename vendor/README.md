# Shared quota core

`heznpc-quota-core-0.2.0.tgz` is an immutable, compiled dependency from
[QuotaPie](https://github.com/heznpc/QuotaPie), maintained in
`packages/quota-core` at source commit `1b2ab96`. Its adjacent SHA-256 file is checked before every build.
The archive includes its MIT license and public API declarations.

Build updates at the source repository with `bun run pack:quota-core`, verify
the resulting checksum, and update the version, archive, checksum and lockfile
together. Do not edit or fork the implementation here. No registry publication
is needed. The dependency is bundled into Taxi's npm artifact and installed
inside the native app, so running Taxi does not require QuotaPie or its sources.
