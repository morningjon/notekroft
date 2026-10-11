# Android pieces

Tauri generates the Android project (`src-tauri/gen/android`) on demand, and
that folder is not kept in the repository. These files are copied over the
generated ones before building; see `docs/BUILDING.md` and the `android` job
in `.github/workflows/build.yml`.

| File | Goes to |
| --- | --- |
| `MainActivity.kt` | `gen/android/app/src/main/java/io/github/morningjon/notekroft/` |
| `res/` | `gen/android/app/src/main/res/` (the launcher icon) |
| `icon-foreground.svg` | Source of the icon's foreground layer, for regenerating `res/` |

## alpha-test.keystore is public on purpose

Android only installs an update over an existing app if both were signed with
the same key. So that alpha builds from this repository can update one
another without wiping the notes on the phone, they are all signed with
`alpha-test.keystore`, whose password (`notekroft-alpha`) is written here for
anyone to read.

That means the signature proves nothing about who built an APK. Anyone can
sign with this key. Only install builds you got from this repository's own
Actions runs, or built yourself. Before NoteKroft is offered to the public
it needs a private key, and moving to one means uninstalling the alpha first.

If the repository has the secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`, the workflow signs with
that private key instead.
