# App identity and native integration

Status: design note, November 2026. Slice 1 (identity levels, saved-login
protection) and slice 2 (per-app cookie partitions for `pane.sh` apps) are
implemented. Everything after them is planned or a prototype.

## Direction

Pane does not give web pages new local powers. A `pane.sh` app's server already
runs as the user with full file access, so sandboxing its page behind a
filesystem bridge would protect nothing and would make the app depend on Pane.
Pane's job is the things only the host can do:

- **Identity**: knowing which program is behind a local origin.
- **Consent**: asking the user and remembering the answer for the right program.
- **Lifecycle**: starting, stopping and restarting servers.
- **Desktop presence**: launchers, file associations, notifications and badges.

Pages use web standards (File System Access, `FileSystemObserver`, Clipboard,
`setAppBadge`, the Web App Manifest), all available in Pane's Chromium.
Pane adds only what the standards leave to the host.

## The problem: a local origin is not an identity

`http://127.0.0.1:8770` is whichever process listens on 8770 at that moment.
Cookies (`persist:app-<port>`), saved logins and site permissions are keyed by
port or origin, so a different program that later takes the port inherits all
of them. Local HTML files have the same problem in a different form: they all
share the `file://` origin and the `persist:files` partition.

## Identity levels

`src/main/identity.js` describes the processes listening on an origin's port as
*evidence* and compares it with a *record* of a process seen earlier. The
result is one of three levels:

| Level | Evidence | May have |
|---|---|---|
| `launched` | The listening process is one Pane started for a `pane:<folder>` app, or a descendant of it. Pane checks the pid together with the process start time, so a reused pid does not count. | Everything below, plus future capabilities that are only for Pane-launched apps (the server channel, saved file grants). |
| `recognized` | The process has the same executable and working folder as the record. | Ordinary saved state: cookies, saved logins, the usual permissions. |
| `unknown` | Anything else, including two processes with different evidence on the same port. | Nothing saved under another identity. |

`recognized` shows that the program is probably the same one as before. It is
not a strong security identity, and it never inherits capabilities that were
granted for `launched`. Plain servers that Pane starts from a pin never reach
`launched`: a pin's start command is copied from whatever server has the
pin's key (`name:port`), so another server could have planted it. A `pane.sh`
cannot be planted that way, because it is the folder's own script.

The API is the same on every platform. Linux provides the evidence from `ss`
and `/proc`. Windows provides none so far (`identity.supported` is false), so
Windows keeps today's behavior: logins are filled by origin alone. Windows can
provide weaker evidence later, such as the executable path from the process
list, without changing callers.

Evidence must be fresh. While only app windows are open, Pane stops scanning
and its server list goes out of date, so every check runs `ss` again for that
one port at the moment of use.

## Invariants

1. A saved secret is only handed to a process that matches one of the
   identities it was saved or used with.
2. Two different processes on one port are `unknown`. Neither one gets
   anything.
3. A recorded identity is never inferred from the port alone. Matching a
   `pane.sh` app by port alone (`paneapps.matchApp` when the working folder is
   not known) is fine for showing a tile, but it is not identity.
4. When nobody listens on the port, nothing is filled or granted.
5. If ownership of existing data cannot be shown from durable records, the
   data stays where it is (legacy key) or the user is asked. Data is never
   given to the first identity Pane happens to see. Nothing is ever copied or
   moved: an existing partition can only get an owner.
6. Privileged requests from a page are honored only from the main frame,
   and only if the page's origin is still the same after the identity check,
   which waits on `ss`. That applies to saved logins, asked-for permissions
   and File System Access writes. An answer from a dialog is used only if,
   once answered, the tab still shows the same origin and the port still has
   the same listening sockets. Dialogs are per tab, so one tab's open prompt
   is never answered for another.

## Slice 1: saved logins (implemented)

- Each saved login keeps `owners`: up to four `{ key, exe, cwd }` records of
  the process it was saved with or that the user later logged in to by typing
  it.
- Autofill on a local origin needs a match (`identity.mayFill`). Network
  origins are filled as before.
- Logins saved before this change have no owners and are not filled on local
  origins. The next time the user types the login into an app and the app
  accepts it, Pane links the login to that process, and from then on it is
  filled there. This costs one manual login per app. It is the price of not
  guessing (invariant 5).
- A process Pane can't read (another user's, usually root, such as
  `docker-proxy`) has no evidence. A login saved while such a process was on
  the port is filled only while the process on the port still can't be read,
  so it never goes to a readable process of the user's own. Processes of
  other users can't be told apart, but on a single-user desktop those are
  root and system services.
- Pane can't recognize an app after its executable changes (for example a
  Python upgrade, because `/proc/<pid>/exe` resolves symlinks) or after it
  moves to another folder. That costs one manual login.
- Pane records which identities have loaded pages in each local partition
  (`partitionUse` in `prefs.json`, at most eight per partition). This is the
  durable evidence the partition migration below depends on. It does not
  change any partition yet.

## Later slices

## Slice 2: per-app partitions (implemented)

A partition name is only a label, so nothing is copied or moved. A `pane.sh`
app, known by its folder, can *own* a partition, recorded in `appPartitions` in
`prefs.json` and never changed after that. The rules are in
`src/main/partitions.js` (`decide`), and the tests are in
`test/partitions.test.js`:

1. The port's old partition `persist:app-<port>` has no data on disk and no
   recorded use: the first `pane.sh` app whose own process is on the port
   (Pane started it, or it works in the app's folder) claims it.
2. It has data: it is claimed only if every durable record names this app.
   Those records are `partitionUse` entries with a known folder inside the
   app's folder, and pins, reopen-list and launcher entries pointing to that
   partition. A record with the app's key but no folder came from a match by
   port alone and counts as somebody else.
3. Anything unclear, or an app matched by port only: nothing is claimed, and
   the app keeps sharing the port's partition as before.
4. Another app already owns the port's partition: the app gets a fresh one,
   `persist:id-<hash of key>`.
5. Plain servers (`python3:8770`) keep the port's partition until a `pane.sh`
   app owns it, and then share `persist:app-<port>-shared`. A process name and
   port is not an identity. Per-identity partitions for plain servers would
   need a key that includes the folder.
6. An app that owns a partition always opens in it, whoever is on the port.
   The partition is *guarded*: a request to any port on this machine goes out
   (with the app's cookies) only after a fresh check shows the app's own
   process listening there, whether Pane started it from the app's `pane.sh` or
   it runs in the app's folder. That means every port, not just the app's own:
   cookies are scoped to a host, not a port, so a cookie set by
   `127.0.0.1:8770` also goes to `127.0.0.1:8771`. The app's own API server on
   a second port passes; any other program is refused. Navigations are always checked. Other requests reuse
   a result for up to 5 s, but only while the port's listening sockets (their
   inodes in `/proc/net/tcp` and `tcp6`) are the same ones. A program that
   takes the port over has to open a new socket, so it is always checked
   anew. When a process Pane started exits, all results are dropped. Otherwise the request is refused and the tab says another
   program is answering on its port. Without this, a tab restored while
   another program held the port would load that program's page, either in the
   app's partition or in the shared one, and leave its cookies there.

`partitionFor()` in `main.js` makes the decision for every tab and thumbnail.
Partitions remembered in pins, the reopen list and launcher entries are only
hints. Links opened from a tab inherit its partition, and with it its guard.

Rollback: an app that claims its port's old partition keeps using the same
name, so Pane 0.4.3 still finds the owner's data there. An app with a fresh
partition goes back to the port's shared one under 0.4.3, which is the old
behavior. 0.4.3 keeps the new `prefs.json` fields without reading them, so
upgrading again finds them intact.

Known limits: an app whose server is not visible to Pane (Docker, another
user's process) never shows its own process, so it never claims a partition
and stays shared. The same goes for a second server of an app that owns a
partition: if Pane can't see it as the app's own, its requests are refused. If an app that owns a partition later runs that way, it is
refused until it runs as its own process again. What remains is the moment
between the check and Chromium's connection, and a listening socket handed
to another program (inherited across `exec` or passed over a Unix socket),
which looks like the same socket.

## Later slices

## Slice 2b: saved permissions (implemented)

A saved "Allow" (camera, microphone, location, screen recording, clipboard
reading, MIDI, idle detection, opening other programs) on a local origin
holds only for the programs it was given to. Pane checks that with
`identity.mayFill`, the same rule logins use. Another program on the port,
or an allow saved before owners were kept, is asked again, and an "Allow"
with "Remember" adds that program. The owners are in `permissionOwners` in
`prefs.json`, next to the plain true/false values that Pane 0.4.3 keeps
reading. A saved "Block" still holds for the whole origin: refusing a new
program is the safe direction, and the Manage dialog undoes it.

## Slice 2c: a partition per local HTML file (implemented)

Every local HTML file has the origin `file://`, so in the one shared
`persist:files` partition any file could read what another stored
(localStorage, IndexedDB). Files now get `persist:file-<hash of URL>`
(`partitions.filePartition`). Files Pane already knew when this was added
(listed, pinned, in the reopen list or detached) were recorded once in
`legacyFiles` in `prefs.json` and keep sharing `persist:files`. Who stored
what there can't be told apart, so nothing is moved (invariant 5). Removing
a file from Pane takes it off that list, so adding it again gives it its own
partition. Pages a file opens by link stay in its partition. Pane 0.4.3 puts
every file back into `persist:files`: the new partitions' data is then out of
reach, but nothing leaks.

### 2d. Rest of the identity work

- High-value or long-lived grants are refused for plain-http network origins
  and for hosts whose certificate Pane accepted despite errors.
- Optionally, ask the user when a partition with data has an unclear history,
  instead of keeping it shared.

### 3. File System Access done right

- Done: write access is asked for, once per tab, page origin and file or
  folder (a folder covers what is inside), and not remembered beyond that.
  Reading what the user picked is not asked again: picking is the consent.
- List grants in Manage and let the user revoke them.
- Prototype only: keep grants across restarts by answering a reloaded
  page's `requestPermission()` from stored grants. Whether Electron routes that
  request through `setPermissionRequestHandler` with the path, without a user
  gesture, needs to be tested first.
- Reveal in folder and open with default app for a granted handle, using the
  path Electron reports in the permission request.

### 4. Web App Manifest

- `file_handlers` → `MimeType=` in a standalone app's `.desktop` entry (with a
  shared-mime-info package for app-specific extensions), and a ProgID per
  extension on Windows, like `register.js` does.
- `shortcuts` → desktop actions and jump lists. `protocol_handlers` → URL
  scheme registration.
- Prototype only: getting the file into the page through `launchQueue`.
  Electron has no API for supplying launch files, and a preload cannot create
  a `FileSystemFileHandle` for a path. The fallback is to open the handler's
  `action` URL with the path, which local apps can use because their server
  can read it.

### 5. Server channel (`PANE_SOCKET`)

For processes Pane starts from a `pane.sh` only:

- A Unix socket in a `0700` runtime directory and a per-instance token in the
  environment, valid for the life of that process. The socket is removed when
  the process exits.
- Versioned JSON lines with a fixed method list: notify, set badge, focus
  window, native folder picker (returns a real path), reveal path, open
  externally.
- Methods are allowlisted with `# pane.allow: notifications, badge, focus,
  picker, reveal` in the `pane.sh` header, shown to the user at first start.
  This states what the app intends; it is not a sandbox.
- No peer-credential check or token rotation in v1. Any process of the same
  user can read the token from `/proc/<pid>/environ`, and nothing protects
  against same-user processes anyway.
- Never exposed or proxied to page JavaScript.
