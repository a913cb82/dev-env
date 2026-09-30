# Native Engines

How to bundle, start, and debug a prebuilt native engine (KataGo, Leela
Zero, an `.so` plus models) inside an app. Each entry cost real debugging
time.

## Vendoring

- Pull the exact binaries and models from the upstream APK or release that
  the reference app uses. Decompiling the reference is faster than guessing
  configs.
- A `.so` is not self-contained. The linker needs every `DT_NEEDED`
  library in the same directory (or on `LD_LIBRARY_PATH`). List them
  explicitly and pin the list in a unit test, so a new native dependency
  cannot ship without staging.
- Some vendor builds refuse to run for other packages. Expect it. Read the
  strings. Then decide: patch, or rebuild from source.

## Start Contract

- Start through the system linker:
  `/system/bin/linker64 <path>/lib.so <args>`. argv reaches the engine.
  PT_INTERP and the executable bit do not matter.
- Vendor binaries may check their cwd or package path. One real gate works
  like this. It reads `readlink(/proc/self/cwd)`. It compares the first 27
  bytes against `/data/data/<package>`. On mismatch it exits 0 with no
  output. Exit 0 plus empty stderr is the signature of a deliberate gate,
  not a crash.
- Neutralize a gate with a byte patch. Then check the patch:
  - Check the file size.
  - Check the count of target bytes.
  - Check the replacement bytes.
  A patch script that cannot check itself is a silent trap.
- cwd: choose a directory the gate accepts. App mount namespaces can
  resolve `/data/user/0/...` and `/data/data/...` to the same place. Check
  with a probe (`run-as <pkg> readlink /proc/self/cwd`). Do not assume.
- Scrub the environment. Inherited ART and vendor variables change native
  init. Set the minimum: `LD_LIBRARY_PATH`, `PATH`, `HOME`.
- Write paths inside the engine config must be ABSOLUTE (log dir, data
  dir). The start cwd is usually not writable.

## Readiness and Death

- Redirect stderr to a FILE, not a pipe. A pipe risks losing the only bytes
  that explain a startup death. Watch the file for a ready banner with a
  timeout.
- Log the exit code when the child dies early. A death-watch thread that
  prints `child died after Nms exit=X` plus the stderr tail turns a silent
  failure into a diagnosis in one run.
- Bound the start timeout (model load is seconds, not minutes). Fail loudly:
  print the last stderr lines.
- Run one throwaway real query at start (warmup). The first query warms
  caches and thread setup. Run it while the UI renders.

## Protocol Conformance

- Match the binary's version, not the project's master docs. Read the
  matching tag. Field sets and command names differ between releases. One
  version printed rich text analysis lines (`scoreLead`, `prior`). Another
  printed rounded integers. One accepted `kata-genmove`. The next removed
  it.
- Streaming commands print their response header once and never end
  it. Drain the queue before the next command. If you do not, that command
  consumes a stale header and succeeds with the wrong payload.
- A blank line frames each multi-line response. While collecting a
  response, ignore a blank line when the buffer is empty. A streaming
  command that ended can leave a stray terminator.
- Anonymous response protocols (`= ...` with no ids) need single-flight
  serialization. Put one mutex around all engine calls. A cancelled caller
  must consume-and-discard, not leave a response for the next caller.
- Text and JSON formats can both exist in one product family. Probe the
  binary with a FIFO harness. Read one real response before writing the
  parser.

## Packaging

- `aapt2` decompresses assets whose name ends in `.gz` and strips the
  suffix. `assets/models/net.bin.gz` lands in the APK as
  `assets/models/net.bin` (uncompressed). Then `assets.open` throws a bare
  FileNotFoundException. The failure surfaces as a red error card on the
  phone. Ship model files under a plain name.
- Check the APK entries, not the source tree. Run
  `unzip -l app.apk | grep asset`.
- Staging needs a revision marker. File size and mtime lie across rebuilds
  and reinstalls. A `.rev` file next to the staged copy forces the recopy.
  Bump the revision string for every engine, config, or asset change.

## Diagnosis Ladder for a Silent Child

Run these in order. Stop at the first failure.

1. Read the exit code and lifetime from the death watch. Instant death
   means gate, linker, or constructor. Death after seconds means load or
   config.
2. Read the stderr file tail. A gate exits 0 with empty stderr. A config
   error names the key. A missing library names the library.
3. Repeat the same argv and cwd from a `run-as` probe. If it works there
   but not in app, the difference is environment, uid, or a path form.
4. Compare the minimal vars against the inherited app environment.
5. Read the strings and the config keys of that exact binary version.
