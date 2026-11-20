const React = require("react");
const { List, ActionPanel, Action, LocalStorage, Icon, Color, Toast, Clipboard, confirmAlert, open, environment, showToast, closeMainWindow, getPreferenceValues } = require("@raycast/api");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const home = require("os").homedir();

const h = React.createElement;
const pageSize = 50;
const cacheKey = "project-index-v2";
const historyKey = "last-opened-by-path";
const favoritesKey = "xcode-project-favorites";
const types = {
  xcodeproj: ["Project", "xcode-project.png"],
  xcworkspace: ["Workspace", "xcode-workspace.png"],
  swift: ["Swift Package", "swift-package.png"],
  playground: ["Playground", "swift-playground.png"],
};
const spotlightQuery = ["*.xcodeproj", "*.xcworkspace", "Package.swift", "*.playground"]
  .map(pattern => 'kMDItemDisplayName == "' + pattern + '"').join(" || ");

const sourceURL = "https://github.com/ritchie7/tinycast-extensions/tree/main/extensions/xcode-projects";
const manifestURL = "https://raw.githubusercontent.com/ritchie7/tinycast-extensions/main/extensions/xcode-projects/package.json";

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid extension version");
  return version.split(".").map(Number);
}

async function checkForUpdates() {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(environment.assetsPath, "..", "package.json"), "utf8"));
    const remote = JSON.parse(await new Promise((resolve, reject) =>
      execFile("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--max-time", "12", manifestURL],
        (error, stdout) => error ? reject(error) : resolve(stdout))));
    if (remote.name !== installed.name) throw new Error("Unexpected extension manifest");
    const local = versionParts(installed.version), latest = versionParts(remote.version);
    const difference = latest.map((part, i) => part - local[i]).find(delta => delta !== 0);
    if (!(difference > 0)) {
      await showToast(Toast.Style.Success, "Up to date", "Installed version " + installed.version);
      return;
    }
    const proceed = await confirmAlert({ title: "Update to " + remote.version + "?",
      message: "Copy the install link and open Extensions settings. Choose Install from GitHub and paste the link.",
      primaryAction: { title: "Copy Link and Open Settings" } });
    if (proceed) {
      await Clipboard.copy(sourceURL);
      await open("tinycast://settings/extensions");
    }
  } catch (error) { await showToast(Toast.Style.Failure, "Could not check for updates", String(error.message || error)); }
}

function directories(value, separator) {
  return [...new Set((value || "").split(separator).map(s => s.trim()).filter(Boolean)
    .map(s => path.resolve(s.replace(/^~(?=\/|$)/, home))))];
}

function readIndex(output, excluded, projects) {
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^([\s\S]+?)\s+kMDItemLastUsedDate\s*=\s*(.*?)\s*$/.exec(record);
    let file = match ? match[1] : record;
    if (/\/(Pods|DerivedData|\.build|node_modules|META-INF)\/|\/Carthage\/Checkouts\/|\/Library\/Autosave Information\//.test(file)) continue;
    if (excluded.some(dir => file === dir || file.startsWith(dir.endsWith("/") ? dir : dir + "/"))) continue;
    if (/\.(xcodeproj|playground)\/[^/]+\.xcworkspace$/.test(file)) file = path.dirname(file);
    const ext = path.extname(file);
    const type = ext.slice(1);
    if (!types[type] || (type === "swift" && path.basename(file) !== "Package.swift")) continue;
    const directory = path.dirname(file);
    const name = type === "swift" ? path.basename(directory) : path.basename(file, ext);
    const [metadataDate, stateSeconds] = (match?.[2] || "").split("\t");
    const iso = metadataDate.replace(/^(\S+) (\S+) ([+-]\d\d)(\d\d)$/, "$1T$2$3:$4");
    const date = Math.max(Date.parse(iso) || 0, (Number(stateSeconds) || 0) * 1000);
    const previous = projects.get(file);
    if (!previous || previous.date < date) projects.set(file, { file, directory, name, type, date });
  }
}

function scan(root, recentOnly = false) {
  return new Promise((resolve, reject) => {
    const args = ["-0", "-attr", "kMDItemLastUsedDate"];
    if (root) args.push("-onlyin", root);
    const query = recentOnly ? "(" + spotlightQuery + ") && kMDItemLastUsedDate >= $time.iso(2001-01-01T00:00:00Z)" : spotlightQuery;
    const child = spawn("/usr/bin/perl", [path.join(environment.assetsPath, "project-dates.pl"), ...args, query], { timeout: 30000 });
    const chunks = [], errors = [];
    child.stdout.on("data", v => chunks.push(v));
    child.stderr.on("data", v => errors.push(v));
    child.once("error", reject);
    child.once("close", status => status === 0 ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(Buffer.concat(errors).toString("utf8").trim() || "Spotlight scan failed")));
  });
}

async function stored(key, fallback) {
  try { return JSON.parse(await LocalStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}
function save(key, value) { return LocalStorage.setItem(key, JSON.stringify(value)); }

function rank(row, text, terms) {
  if (!text || row.nameKey === text) return 0;
  if (row.nameKey.startsWith(text)) return 1;
  if (row.nameKey.includes(text)) return 2;
  if (terms.every(term => row.nameKey.includes(term))) return 3;
  if (terms.every(term => row.nameKey.includes(term) || row.dirKey.includes(term))) return 4;
  return -1;
}

// Within each match group the index is already sorted by most recent use.
function results(rows, query, type, favorites, limit) {
  const text = query.trim().toLowerCase(), terms = text.split(/\s+/);
  const groups = [Array.from({ length: 5 }, () => []), Array.from({ length: 5 }, () => [])];
  let count = 0;
  for (const row of rows) {
    if (type && row.type !== type) continue;
    const score = rank(row, text, terms);
    if (score < 0) continue;
    count++;
    const group = groups[favorites.has(row.file) ? 0 : 1][score];
    if (group.length < limit) group.push(row);
  }
  const pinned = groups[0].flat().slice(0, limit);
  return { pinned, recent: groups[1].flat().slice(0, limit - pinned.length), count };
}

const repoCache = new Map();
function repository(directory) {
  if (repoCache.has(directory)) return repoCache.get(directory);
  const parent = path.dirname(directory);
  const root = fs.existsSync(path.join(directory, ".git")) ? directory : parent === directory ? "" : repository(parent);
  repoCache.set(directory, root);
  return root;
}

function SearchProjects() {
  const prefs = getPreferenceValues();
  const scope = prefs.repoScanPath || prefs.projectFolder || "";
  const includeRecent = prefs.includeRecentOutsideScope !== false;
  const excludes = prefs.excludedXcodeProjectPaths || "";
  const [rows, setRows] = React.useState([]);
  const [history, setHistory] = React.useState({});
  const [favorites, setFavorites] = React.useState([]);
  const [query, setQuery] = React.useState("");
  const [type, setType] = React.useState("");
  const [limit, setLimit] = React.useState(pageSize);
  const [generation, refresh] = React.useReducer(n => n + 1, 0);
  const [loading, setLoading] = React.useState(true);
  const [failure, setFailure] = React.useState("");
  React.useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true); setFailure("");
      try {
        const [cache, past, pins] = await Promise.all([stored(cacheKey, null), stored(historyKey, {}), stored(favoritesKey, [])]);
        if (!active) return;
        setHistory(past); setFavorites(pins);
        const cached = cache && cache.scope === scope && cache.includeRecent === includeRecent && cache.excludes === excludes && Array.isArray(cache.rows);
        if (cached) {
          setRows(cache.rows);
          if (!generation && Date.now() - cache.savedAt < 60000) return;
        }
        const roots = directories(scope, ":"), excluded = directories(excludes, ",");
        const requests = (roots.length ? roots : [""]).map(root => scan(root));
        if (roots.length && includeRecent) requests.push(scan("", true));
        const scans = await Promise.allSettled(requests);
        if (!active) return;
        const projects = new Map();
        for (const item of scans) if (item.status === "fulfilled") readIndex(item.value, excluded, projects);
        const error = scans.find(item => item.status === "rejected");
        if (error) setFailure(String(error.reason?.message || error.reason));
        if (error && !projects.size) return;
        const fresh = [...projects.values()];
        setRows(fresh);
        if (!error) await save(cacheKey, { scope, excludes, includeRecent, rows: fresh, savedAt: Date.now() });
      } catch (error) { if (active) setFailure(String(error.message || error)); }
      finally { if (active) setLoading(false); }
    }
    load();
    return () => { active = false; };
  }, [scope, excludes, includeRecent, generation]);

  const ordered = React.useMemo(() => rows.map(row => ({ ...row, nameKey: row.name.toLowerCase(),
    dirKey: row.directory.toLowerCase(), lastUsed: Math.max(history[row.file] || 0, row.date) }))
    .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name) || a.file.localeCompare(b.file)), [rows, history]);
  const pins = React.useMemo(() => new Set(favorites), [favorites]);
  const visible = React.useMemo(() => results(ordered, query, type, pins, limit), [ordered, query, type, pins, limit]);

  async function openProject(row) {
    try {
      await new Promise((resolve, reject) => execFile("/usr/bin/open", ["-b", "com.apple.dt.Xcode", row.file],
        error => error ? reject(error) : resolve()));
      const updated = { ...await stored(historyKey, {}), [row.file]: Date.now() };
      await save(historyKey, updated);
      setHistory(updated);
      await closeMainWindow();
    } catch (error) { await showToast(Toast.Style.Failure, "Could not open project", String(error.message || error)); }
  }

  async function toggleFavorite(file) {
    const current = await stored(favoritesKey, []);
    const updated = current.includes(file) ? current.filter(p => p !== file) : [...current, file];
    await save(favoritesKey, updated); setFavorites(updated);
  }
  const refreshAction = h(Action, { title: "Refresh Projects", icon: Icon.ArrowClockwise, shortcut: { modifiers: ["cmd"], key: "r" }, onAction: refresh });
  const updateAction = h(Action, { title: "Check for Updates", icon: Icon.Download, onAction: checkForUpdates });
  function item(row) {
    const [label, icon] = types[row.type];
    const subtitle = row.directory === home ? "~" : row.directory.startsWith(home + "/") ? "~" + row.directory.slice(home.length) : row.directory;
    const accessories = [];
    if (prefs.showDirectoryTag) {
      const root = repository(row.directory);
      accessories.push({ tag: {value: path.basename(root || row.directory), color: Color.Blue}, tooltip: subtitle },
        {icon: root ? "git-branch.svg" : Icon.Folder, tooltip: subtitle});
    }
    accessories.push({ text: label });
    const terminal = prefs.terminalApp;
    return h(List.Item, { key: row.file, id: row.file, title: row.name, subtitle: prefs.showDirectoryTag ? undefined : subtitle,
      accessories, icon, actions: h(ActionPanel, null,
        h(Action, { title: "Open with Xcode", icon: Icon.Hammer, onAction: () => openProject(row) }),
        h(Action.ShowInFinder, { path: row.file, shortcut: { modifiers: ["cmd"], key: "return" } }),
        terminal && h(Action.Open, { title: "Open With " + (terminal.name || "Terminal"), icon: Icon.Terminal,
          target: row.directory, application: terminal.bundleId || terminal, shortcut: { modifiers: ["cmd","shift"], key: "o" } }),
        h(Action, { title: pins.has(row.file) ? "Remove from Favorites" : "Add to Favorites", icon: Icon.Star,
          shortcut: { modifiers: ["cmd", "shift"], key: "f" }, onAction: () => toggleFavorite(row.file) }), refreshAction, updateAction) });
  }
  const dropdown = h(List.Dropdown, { tooltip: "Filter projects by type", storeValue: true,
    onChange: v => { setType(v || ""); setLimit(pageSize); } },
    ...[["", ["All"]], ...Object.entries(types)].map(([key, [label]]) => h(List.Dropdown.Item, { key, title: label, value: key })));
  return h(List, { filtering: false, isLoading: loading, searchBarPlaceholder: "Search for Xcode Projects or Swift Packages",
    searchBarAccessory: dropdown, onSearchTextChange: v => { setQuery(v); setLimit(pageSize); }, actions: h(ActionPanel, null, refreshAction, updateAction) },
    failure && h(List.Item, { title: "Could not refresh projects", subtitle: failure, actions: h(ActionPanel, null, refreshAction, updateAction) }),
    visible.pinned.length > 0 && h(List.Section, { title: "Favorites" }, ...visible.pinned.map(item)),
    visible.recent.length > 0 && h(List.Section, { title: visible.pinned.length ? "Recent Projects" : undefined }, ...visible.recent.map(item)),
    visible.count > limit && h(List.Item, { title: "Show More Projects", icon: Icon.Ellipsis, actions: h(ActionPanel, null,
      h(Action, { title: "Show More Projects", onAction: () => setLimit(n => n + pageSize) })) }),
    h(List.EmptyView, { title: loading ? "Loading Projects…" : "No Projects Found" }));
}
module.exports = SearchProjects;
