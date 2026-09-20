# Native Engines

How to bundle, launch, and debug a prebuilt native engine (KataGo, Leela Zero,
an `.so` plus models) inside an app. Each entry cost real debugging time.

## Vendoring

- Pull the exact binaries and models from the upstream APK or release that the
  reference app uses. Decompiling the reference is faster than guessing configs.
- A `.so` is not self-contained. The linker needs every `DT_NEEDED` library in
  the same directory (or on `LD_LIBRARY_PATH`). List them explicitly and pin the
  list in a unit test, so a new native dependency cannot ship without staging.
- Some vendor builds refuse to run for other packages. Expect it, read the
  strings, then decide: patch, or rebuild from source.

## Launch Contract

- Launch through the system linker: `/system/bin/linker64 <path>/lib.so <args>`.
  argv reaches the engine; PT_INTERP and the executable bit do not matter.
- Vendor binaries may check their cwd or package path. One real gate:
  `readlink(/proc/self/cwd)`, compare the first 27 bytes against
  `/data/data/<package>`, then fail by exit 0 with NO output on mismatch.
  Exit 0 plus empty stderr is the signature of a deliberate gate, not a crash.
- Neutralize a gate with a byte patch, then ASSERT the patch:
  - the file size,
  - the number of occurrences of the target bytes,
  - the replacement bytes.
  A patch script that cannot verify itself is a silent trap.
- cwd: choose a directory the gate accepts. App mount namespaces can resolve
  `/data/user/0/...` and `/data/data/...` to the same place. Verify with a probe
  (`run-as <pkg> readlink /proc/self/cwd`) instead of assuming.
- Scrub the environment. Inherited ART and vendor variables change native init.
  Set the minimum: `LD_LIBRARY_PATH`, `PATH`, `HOME`.
- Write paths inside the engine config must be ABSOLUTE (log dir, data dir).
  The launch cwd is usually not writable.

## Readiness and Death

- Redirect stderr to a FILE, not a pipe. A pipe risks losing the only bytes that
  explain a startup death. Watch the file for a ready banner with a timeout.
- Log the exit code when the child dies early. A death-watch thread printing
  `child died after Nms exit=X` plus the stderr tail turns a silent failure into
  a diagnosis in one run.
- Bound the start timeout (model load is seconds, not minutes). Fail loud with
  the last stderr lines.
- Run one throwaway real query at launch (warmup). The first query pays caches
  and thread setup; hide that cost while the UI renders.

## Protocol Conformance

- Match the binary's version, not the project's master docs. Read the matching
  tag. Field sets and command names differ between releases. One version printed
  rich text analysis lines (`scoreLead`, `prior`), another printed rounded
  integers; one accepted `kata-genmove`, the next removed it.
- Streaming commands print their response header once and never terminate it.
  Drain the queue before the next command, or that command consumes a stale
  header and "succeeds" with the wrong payload.
- Multi-line responses are framed by a blank line. While collecting one, ignore
  a blank line when the buffer is empty: a terminated streaming command can
  leave a stray terminator.
- Anonymous response protocols (`= ...` with no ids) need single-flight
  serialization. One mutex around all engine calls. A cancelled caller must
  consume-and-discard, not leave a response for the next caller.
- Text and JSON formats can both exist in one product family. Probe the binary
  with a FIFO harness and read one real response before writing the parser.

## Packaging

- `aapt2` decompresses assets whose name ends in `.gz` and strips the suffix:
  `assets/models/net.bin.gz` lands in the APK as `assets/models/net.bin`
  (uncompressed). `assets.open("models/net.bin.gz")` then throws a bare
  FileNotFoundException, and the failure surfaces as a red error card on the
  phone. Ship model files under a plain name.
- Verify the APK entries, not the source tree: `unzip -l app.apk | grep asset`.
- Staging needs a revision marker. File size and mtime lie across rebuilds and
  reinstalls; a `.rev` file next to the staged copy forces the recopy. Bump the
  revision string for every engine, config, or asset change.

## Diagnosis Ladder for a Silent Child

Run these in order. Stop at the first failure.

1. Exit code and lifetime from the death watch. Instant death means gate,
   linker, or constructor. Death after seconds means load or config.
2. stderr file tail. A gate exits 0 with empty stderr; a config error names the
   key; a missing library names the library.
3. Same argv and cwd from a `run-as` probe. If it works there but not in app,
   the difference is environment, uid, or a path form.
4. Diff the environment: minimal vars vs inherited app environment.
5. Read the strings and the config keys of that exact binary version.
