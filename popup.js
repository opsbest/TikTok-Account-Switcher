const DOMAIN = "tiktok.com";
const HOME = "https://www.tiktok.com/";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

async function load() {
  const { accounts = {}, active = null } = await chrome.storage.local.get(["accounts", "active"]);
  return { accounts, active };
}
async function save(accounts, active) {
  await chrome.storage.local.set({ accounts, active });
}

function findKey(accounts, uid) {
  if (!uid) return null;
  const l = uid.toLowerCase();
  return Object.keys(accounts).find((k) => k.toLowerCase() === l) || null;
}

function cookieUrl(c) {
  return (c.secure ? "https://" : "http://") + c.domain.replace(/^\./, "") + c.path;
}

function getCookies() {
  return chrome.cookies.getAll({ domain: DOMAIN });
}

async function clearCookies() {
  const cookies = await getCookies();
  await Promise.all(
    cookies.map((c) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId }))
  );
}

async function restoreCookies(cookies) {
  for (const c of cookies) {
    const details = {
      url: cookieUrl(c),
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
    };
    if (!c.hostOnly) details.domain = c.domain;
    if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
    try {
      await chrome.cookies.set(details);
    } catch (e) {
      console.warn("Could not set cookie:", c.name, e);
    }
  }
}

function waitForComplete(tabId, ms = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function reloadTikTok() {
  const tabs = await chrome.tabs.query({ url: "https://*.tiktok.com/*" });
  if (tabs.length === 0) {
    await chrome.tabs.create({ url: HOME });
    return null;
  }
  const tab = tabs.find((t) => t.active) || tabs[0];
  const loaded = waitForComplete(tab.id);
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
  return { tabId: tab.id, loaded };
}

async function pickTikTokTab() {
  const tabs = await chrome.tabs.query({ url: "https://*.tiktok.com/*" });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

async function scrapeTikTok() {
  const out = { uid: null, avatarUrl: null, notifications: null };
  const isUrl = (u) => typeof u === "string" && u.startsWith("http");
  let uid = null;

  try {
    const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (el) {
      const user = JSON.parse(el.textContent)?.__DEFAULT_SCOPE__?.["webapp.app-context"]?.user;
      if (user && user.uniqueId) uid = user.uniqueId;
      const av = user?.avatarUri;
      const first = Array.isArray(av) ? av[0] : av;
      if (isUrl(first)) out.avatarUrl = first;
    }
  } catch (e) {}

  if (!out.avatarUrl || !uid) {
    try {
      const r = await fetch(
        "/passport/web/account/info/?aid=1988&app_name=tiktok_web&device_platform=web_pc",
        { credentials: "include" }
      );
      const d = (await r.json())?.data;
      if (d) {
        if (!uid && d.username) uid = d.username;
        if (!out.avatarUrl && isUrl(d.avatar_url)) out.avatarUrl = d.avatar_url;
      }
    } catch (e) {}
  }

  if (!uid) {
    const el = document.querySelector(
      'a[data-e2e="nav-profile"], [data-e2e="nav-profile"] a, a[data-e2e="profile-icon"]'
    );
    const m = el && /\/@([^/?#]+)/.exec(el.getAttribute("href") || "");
    if (m) {
      try {
        uid = decodeURIComponent(m[1]);
      } catch (e) {
        uid = m[1];
      }
    }
  }
  out.uid = uid;

  if (!out.avatarUrl) {
    const sels = [
      '[data-e2e="nav-profile"] img',
      '[data-e2e="profile-icon"] img',
      '[data-e2e="top-profile-icon"] img',
      'a[href="/profile"] img',
      'header img[src*="avt"]',
      '#app-header img[src*="avt"]',
    ];
    if (uid && /^[\w.]+$/.test(uid)) sels.unshift(`a[href="/@${uid}" i] img`);
    for (const s of sels) {
      const img = document.querySelector(s);
      if (img && img.src) {
        out.avatarUrl = img.src;
        break;
      }
    }
  }

  const items = document.querySelectorAll(
    [
      'a[href*="/messages"]',
      '[data-e2e="nav-messages"]',
      '[data-e2e="nav-activity"]',
      '[data-e2e="nav-inbox"]',
      '[data-e2e="inbox-icon"]',
      '[data-e2e="inbox-notifications"]',
    ].join(",")
  );

  if (items.length) {
    const seen = new Set();
    let total = 0;
    let plus = false;

    const collect = (root) => {
      let found = 0;
      for (const n of root.querySelectorAll("*")) {
        if (n.children.length || seen.has(n)) continue;
        const m = /^(\d{1,3})(\+?)$/.exec((n.textContent || "").trim());
        if (m) {
          seen.add(n);
          total += parseInt(m[1], 10);
          if (m[2]) plus = true;
          found++;
        }
      }
      return found;
    };

    for (const item of items) {
      if (!collect(item) && item.parentElement) collect(item.parentElement);
    }
    out.notifications = String(total) + (plus ? "+" : "");
  }
  return out;
}

async function fetchAvatarInPage(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    c.getContext("2d").drawImage(bmp, 0, 0, 64, 64);
    return c.toDataURL("image/jpeg", 0.85);
  } catch (e) {
    return null;
  }
}

async function scrapeInfo(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeTikTok });
    return res && res.result ? res.result : null;
  } catch (e) {
    return null;
  }
}

async function toAvatarDataUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    c.getContext("2d").drawImage(bmp, 0, 0, 64, 64);
    return c.toDataURL("image/jpeg", 0.85);
  } catch (e) {
    return null;
  }
}

async function downloadInPage(tabId, url) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchAvatarInPage,
      args: [url],
    });
    return res && res.result ? res.result : null;
  } catch (e) {
    return null;
  }
}

async function applyInfo(acc, tabId, info) {
  if (info.notifications !== null) acc.notifications = info.notifications;
  if (!info.avatarUrl) return;

  const key = info.avatarUrl.split("?")[0];
  const hasData = typeof acc.avatar === "string" && acc.avatar.startsWith("data:");
  if (key === acc.avatarKey && hasData) return;

  const data = (await toAvatarDataUrl(info.avatarUrl)) || (await downloadInPage(tabId, info.avatarUrl));
  acc.avatar = data || info.avatarUrl;
  acc.avatarKey = key;
}

async function refreshActive() {
  const { accounts } = await load();
  const tab = await pickTikTokTab();
  if (!tab) return;
  const info = await scrapeInfo(tab.id);
  if (!info || !info.uid) return;

  const key = findKey(accounts, info.uid);
  if (!key) {
    await save(accounts, null);
    setStatus(`@${info.uid} isn't saved. Press "Save current account" to add it.`);
    return;
  }
  await applyInfo(accounts[key], tab.id, info);
  await save(accounts, key);
}

async function persistActive(accounts, active) {
  if (!active || !accounts[active]) return;
  const tab = await pickTikTokTab();
  const info = tab ? await scrapeInfo(tab.id) : null;
  if (info && info.uid && info.uid.toLowerCase() !== active.toLowerCase()) return;

  const cookies = await getCookies();
  if (cookies.length) accounts[active].cookies = cookies;
  if (tab && info) await applyInfo(accounts[active], tab.id, info);
}

async function saveCurrent() {
  const cookies = await getCookies();
  if (!cookies.length) return setStatus("You don't seem to be logged in to TikTok.");
  const tab = await pickTikTokTab();
  if (!tab) return setStatus("Open a TikTok tab and log in first.");

  setStatus("Reading account…");
  const info = await scrapeInfo(tab.id);
  if (!info) return setStatus("Couldn't read the TikTok page.");
  if (!info.uid) return setStatus("Couldn't read the username. Make sure you're logged in to TikTok.");

  const { accounts } = await load();
  const existing = findKey(accounts, info.uid);
  const key = existing || info.uid;
  accounts[key] = { ...accounts[key], name: key, cookies, savedAt: Date.now() };
  await applyInfo(accounts[key], tab.id, info);
  await save(accounts, key);

  setStatus(existing ? `"${key}" is already saved. Updated.` : `"${key}" added.`);
  render();
}

async function switchTo(name) {
  const { accounts, active } = await load();
  if (!accounts[name]) return;
  if (name === active) return setStatus("You're already on this account.");

  setStatus("Switching…");
  await persistActive(accounts, active);
  await clearCookies();
  await restoreCookies(accounts[name].cookies);
  await save(accounts, name);
  const reloaded = await reloadTikTok();
  setStatus(`Switched to "${name}".`);
  render();

  if (reloaded) {
    await reloaded.loaded;
    await sleep(2500);
    await refreshActive();
    render();
  }
}

async function removeAccount(name) {
  const { accounts, active } = await load();
  delete accounts[name];
  await save(accounts, active === name ? null : active);
  render();
}

async function addNew() {
  const { accounts, active } = await load();
  await persistActive(accounts, active);
  await clearCookies();
  await save(accounts, null);
  await reloadTikTok();
  setStatus("Logged out. Log in with the new account, then save it here.");
  render();
}

function makeAvatar(acc, name) {
  const placeholder = () => {
    const d = document.createElement("div");
    d.className = "avatar";
    d.textContent = (name.replace(/^@/, "").charAt(0) || "?").toUpperCase();
    return d;
  };
  if (!acc.avatar) return placeholder();

  const img = document.createElement("img");
  img.className = "avatar";
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.src = acc.avatar;
  img.addEventListener("error", () => img.replaceWith(placeholder()));
  return img;
}

async function render() {
  const { accounts, active } = await load();
  const list = $("list");
  list.textContent = "";
  const names = Object.keys(accounts);
  $("empty").hidden = names.length > 0;

  for (const name of names) {
    const acc = accounts[name];
    const li = document.createElement("li");
    if (name === active) li.className = "active";

    const sw = document.createElement("button");
    sw.className = "switch";

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;

    const n = acc.notifications;
    const countEl = document.createElement("span");
    countEl.className = "count" + (n && n !== "0" ? " has" : "");
    countEl.textContent = `(${n == null ? "–" : n})`;
    countEl.title = "Inbox notifications (last seen)";

    sw.append(makeAvatar(acc, name), nameEl, countEl);
    sw.addEventListener("click", () => switchTo(name));

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", () => removeAccount(name));

    li.append(sw, del);
    list.append(li);
  }
}

$("saveBtn").addEventListener("click", saveCurrent);
$("addBtn").addEventListener("click", addNew);

render();
refreshActive().then(render);
