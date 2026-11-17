// Initialises OpenSSL's random generator before any WebAssembly code runs.
// Works around "ERR_OSSL_ENTROPY_SOURCE_STRENGTH_TOO_WEAK" raised by
// esbuild-wasm on Windows machines where Application Control blocks native
// esbuild/rollup binaries (see IMPORTANT DOC/SETUP.md).
require("node:crypto").randomBytes(16);
