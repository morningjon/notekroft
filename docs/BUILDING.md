# Building NoteKroft from source

This guide takes you from a fresh machine to a running copy of NoteKroft, and
then to an installable package.

- [What has been tested](#what-has-been-tested)
- [1. Install the prerequisites](#1-install-the-prerequisites)
- [2. Get the source](#2-get-the-source)
- [3. Run it](#3-run-it)
- [4. Build a release](#4-build-a-release)
- [5. Run the tests](#5-run-the-tests)
- [Useful options](#useful-options)
- [Troubleshooting](#troubleshooting)

## What has been tested

| Platform | Status |
| --- | --- |
| Linux, x86-64 (Ubuntu 24.04) | Built, packaged as `.deb`, launched and saving notes |
| Other Linux distributions | Expected to work; package names below come from Tauri's documentation |
| macOS (universal: Apple silicon and Intel) | Builds and packages on GitHub's runners; not yet run by hand |
| Windows, x86-64 | Builds and packages on GitHub's runners; not yet run by hand |

Every push is built for all three platforms by the workflow in
`.github/workflows/build.yml`, and the resulting apps are attached to each
run under the repository's Actions tab. So the macOS and Windows builds are
known to compile and package, but nobody has yet confirmed how they behave in
use. If you try one, please open an issue with the result either way.

## 1. Install the prerequisites

You need three things: the system libraries Tauri uses to draw a window, a
Rust toolchain, and Node.js.

| Tool | Version |
| --- | --- |
| Rust | 1.90 or newer (stable) |
| Node.js | 20.19 or newer, or 22.12 or newer |
| npm | Comes with Node.js |

### Linux

Install the system libraries for your distribution.

Debian, Ubuntu, Linux Mint, Pop!_OS:

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Arch, CachyOS, EndeavourOS, Manjaro:

```sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

Fedora:

```sh
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
```

openSUSE:

```sh
sudo zypper in webkit2gtk3-devel libopenssl-devel curl wget file \
  libappindicator3-1 librsvg-devel
sudo zypper in -t pattern devel_basis
```

Then install Rust:

```sh
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

Restart your terminal afterwards so `cargo` is on your `PATH`. If you prefer
your distribution's packages, `rustup` from the package manager followed by
`rustup default stable` works equally well.

Install Node.js from your package manager (`nodejs` and `npm`), from
[nodejs.org](https://nodejs.org), or with a version manager such as `fnm` or
`nvm`. Check the version meets the minimum above; older distribution releases
ship a Node.js that is too old.

### macOS

Install the Xcode Command Line Tools:

```sh
xcode-select --install
```

Install Rust:

```sh
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

Install Node.js from [nodejs.org](https://nodejs.org) or with Homebrew
(`brew install node`).

### Windows

1. Install the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   and select the "Desktop development with C++" workload.
2. WebView2 is already present on Windows 10 (version 1803 and later) and
   Windows 11. On anything older, install the Evergreen Bootstrapper from
   Microsoft's [WebView2 download page](https://developer.microsoft.com/microsoft-edge/webview2/).
3. Install Rust with [rustup](https://rustup.rs) and make sure the MSVC
   toolchain is the default: `rustup default stable-msvc`.
4. Install Node.js from [nodejs.org](https://nodejs.org).

The authoritative, up-to-date list for every platform is Tauri's own
[prerequisites page](https://v2.tauri.app/start/prerequisites/).

### Check your setup

```sh
rustc --version
cargo --version
node --version
npm --version
```

All four should print a version, and the Rust and Node.js versions should
meet the minimums above.

## 2. Get the source

```sh
git clone https://github.com/morningjon/notekroft.git
cd notekroft
npm install
```

`npm install` fetches the interface's build tools and the Tauri command line.
Rust dependencies are fetched automatically the first time you build.

## 3. Run it

```sh
npm run tauri dev
```

The first run compiles a few hundred Rust crates and takes several minutes.
Later runs start in seconds. A NoteKroft window opens, and changes you make to
the source reload automatically: interface changes instantly, Rust changes
after a short recompile.

This is a development build. It is larger and slower than a release build but
otherwise behaves the same, and it reads and writes the same notes folder.

### Interface only, in a browser

To try or work on the interface without building any Rust:

```sh
npm run dev
```

Then open http://localhost:1420. In this mode there is no Rust backend, so
notes are kept in that browser's local storage and are not written to disk as
files.

## 4. Build a release

```sh
npm run tauri build
```

This type-checks and bundles the interface, compiles an optimised binary, and
packages it for the platform you are on. Expect it to take five to ten
minutes. Everything lands under `target/release/`:

| Platform | Output |
| --- | --- |
| Any | The bare executable: `target/release/notekroft` (`notekroft.exe` on Windows) |
| Linux | `bundle/deb/*.deb`, `bundle/rpm/*.rpm`, `bundle/appimage/*.AppImage` |
| macOS | `bundle/macos/NoteKroft.app`, `bundle/dmg/*.dmg` |
| Windows | `bundle/msi/*.msi`, `bundle/nsis/*-setup.exe` |

You can only build packages for the operating system you are running.

### Choosing what gets packaged

Pass options to Tauri after a `--`:

```sh
npm run tauri build -- --no-bundle           # just the executable, no packages
npm run tauri build -- --bundles deb         # one package type
npm run tauri build -- --bundles deb,rpm     # several
```

On Arch-based systems the simplest route is `--no-bundle` and running
`target/release/notekroft` directly, or `--bundles appimage`.

### Installing what you built

```sh
# Debian, Ubuntu and relatives
sudo apt install ./target/release/bundle/deb/NoteKroft_*_amd64.deb

# Fedora and relatives
sudo dnf install ./target/release/bundle/rpm/NoteKroft-*.x86_64.rpm

# Any Linux, no install needed
chmod +x target/release/bundle/appimage/NoteKroft_*_amd64.AppImage
./target/release/bundle/appimage/NoteKroft_*_amd64.AppImage
```

On macOS, open the `.dmg` and drag NoteKroft to Applications. On Windows, run
the installer. Builds you make yourself are not code-signed, so macOS and
Windows will warn you the first time you open them.

## 5. Run the tests

```sh
cargo test --workspace --exclude notekroft   # storage, sanitising, search, import rules
npm run build && npm run test:ui           # the interface, in headless Chromium
```

The OneNote importer has a further test that runs it over real `.one` files.
NoteKroft does not ship any, so it borrows the parser project's collection and
is skipped unless you point it at one:

```sh
git clone https://github.com/msiemens/onenote.rs /tmp/onenote.rs
NOTEKROFT_ONE_SAMPLES=/tmp/onenote.rs/crates/parser/tests/samples \
  cargo test -p notekroft-onenote --test samples -- --nocapture
```

The interface test uses [Playwright](https://playwright.dev). If it reports
that no browser is installed, run `npx playwright install chromium` once.
Screenshots from the run are written to `tests/out/`.

Before sending a change, please also run:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets
```

## Useful options

### Keep notes somewhere else

By default notes live in `Documents/NoteKroft`. Set `NOTEKROFT_LIBRARY` to use a
different folder. This is the safe way to experiment without touching your
real notes:

```sh
NOTEKROFT_LIBRARY=/tmp/notekroft-test npm run tauri dev
```

On Windows PowerShell:

```powershell
$env:NOTEKROFT_LIBRARY = "C:\Temp\notekroft-test"; npm run tauri dev
```

### Using the Rust core on its own

`crates/notekroft-core` has no dependency on Tauri or the interface. It builds
and tests on its own with `cargo build -p notekroft-core`, which needs only a
Rust toolchain and none of the system libraries above.

## Troubleshooting

**`Package webkit2gtk-4.1 was not found in the pkg-config search path`**
The Linux system libraries from step 1 are missing or incomplete. Re-run the
install command for your distribution.

**`error: package ... requires rustc 1.90 or newer`**
Your Rust toolchain is too old. Run `rustup update stable`.

**Vite refuses to start, or `npm install` warns about an unsupported engine**
Your Node.js is older than 20.19. Install a current LTS release.

**`Port 1420 is already in use`**
Another copy of the development server is still running. Close it, or find it
with `lsof -i :1420`.

**A blank or flickering window on Linux**
This is a known WebKitGTK rendering problem with some graphics drivers. Try:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev
```

**`failed to run light.exe` on Windows**
Building `.msi` installers needs the VBSCRIPT optional feature. Enable it
under Settings, Apps, Optional features, More Windows features, or skip MSI
with `npm run tauri build -- --bundles nsis`.

**AppImage packaging fails on Linux**
Tauri downloads its AppImage tooling the first time, so this step needs
network access. Build another package type, or use `--no-bundle`.

If you hit something not listed here, please open an issue and include your
operating system, the command you ran, and the full error text.
