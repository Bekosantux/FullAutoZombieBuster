// ==UserScript==
// @name         FullAutoZombieBuster
// @namespace    https://com.bekosantux.full-auto-zombie-buster
// @version      1.2.0
// @description  返信欄（会話タイムライン）で、次の条件を満たすアカウントを自動でブロック/ミュートします。 1. 表示名に日本語が含まれていない  2. 認証済みアカウントである  3. プロフィールに特定の文字列が含まれている  4. プロフィールに日本語が含まれていない
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ===== 設定 =====
  const ACTION = 'block'; // 'mute' または 'block'
  const DRY_RUN = false; // trueの場合はログのみ
  const KEYWORDS = ['Web3', 'Crypto', 'AI', 'NFT', 'Trader', 'Wᴇʙ3', 'Business', 'News', 'Marketing']; // 小文字大文字は区別されません

  // 条件1〜4の個別ON/OFF
  const ENABLE_COND1 = true; // 1) 表示名に日本語が含まれていない
  const ENABLE_COND2 = true; // 2) 認証済み
  const ENABLE_COND3 = true; // 3) キーワード（プロフィール/表示名）
  const ENABLE_COND4 = true; // 4) プロフィールに日本語が含まれていない

  // 追加ルール: 認証済み かつ プロフィールに日本語が含まれない場合、他条件によらずブロック
  // 誤爆の可能性があるためデフォルトでは無効
  const ENABLE_COND2A = false;

  const SCAN_INTERVAL_MS = 1000;
  const PROFILE_MAX_RETRIES = 6;

  // ===== 共通 =====
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[imp-zombie]', ...args);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const hasJapanese = (text) => {
    if (!text) return false;
    try {
      return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
    } catch {
      return /[ぁ-んァ-ン一-龥]/.test(text);
    }
  };

  const includesAnyKeyword = (text) => {
    const t = (text || '').toLowerCase();
    return KEYWORDS.some((k) => t.includes(String(k).toLowerCase()));
  };

  function safeJsonParse(text) {
    if (text == null) return null;
    let t = String(text);
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);

    const trimmed = t.trimStart();
    if (trimmed.startsWith(')]}\'')) {
      const idx = trimmed.indexOf('\n');
      t = idx >= 0 ? trimmed.slice(idx + 1) : '';
    } else if (/^for\s*\(\s*;\s*;\s*\)\s*;/.test(trimmed)) {
      t = trimmed.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
    } else {
      t = trimmed;
    }

    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  function buildProfileText({ bio, location, url }) {
    return norm([bio, location, url].filter(Boolean).join('\n'));
  }

  // ===== プロフィールキャッシュ =====
  // lower(handle) -> { bio, profileText, ts }
  const profileCache = new Map();

  function pickFirstString(...candidates) {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c;
    }
    return '';
  }

  function ingestPossibleUserObject(obj) {
    if (!obj || typeof obj !== 'object') return false;

    // XのGraphQLは result.legacy / result.core / legacy などが混在する
    const legacy = (obj.legacy && typeof obj.legacy === 'object') ? obj.legacy : null;
    const result = (obj.result && typeof obj.result === 'object') ? obj.result : null;
    const rLegacy = (result?.legacy && typeof result.legacy === 'object') ? result.legacy : null;
    const rCore = (result?.core && typeof result.core === 'object') ? result.core : null;
    const rUser = (result?.user && typeof result.user === 'object') ? result.user : null;

    const screenName = pickFirstString(
      obj.screen_name,
      obj.username,
      obj.handle,
      legacy?.screen_name,
      rLegacy?.screen_name,
      rCore?.screen_name,
      rCore?.screenName,
      rUser?.screen_name,
      rUser?.username
    );
    if (!screenName) return false;

    const bio = norm(pickFirstString(
      obj.description,
      legacy?.description,
      rLegacy?.description,
      result?.description
    ));
    const location = norm(pickFirstString(
      obj.location,
      legacy?.location,
      rLegacy?.location,
      result?.location
    ));

    const expandedUrl =
      legacy?.entities?.url?.urls?.[0]?.expanded_url ||
      legacy?.entities?.url?.urls?.[0]?.expandedUrl ||
      rLegacy?.entities?.url?.urls?.[0]?.expanded_url ||
      rLegacy?.entities?.url?.urls?.[0]?.expandedUrl ||
      obj?.entities?.url?.urls?.[0]?.expanded_url ||
      obj?.entities?.url?.urls?.[0]?.expandedUrl ||
      '';
    const url = norm(pickFirstString(
      obj.url,
      legacy?.url,
      rLegacy?.url,
      expandedUrl
    ));

    const profileText = buildProfileText({ bio, location, url });
    if (!profileText) return false;

    profileCache.set(String(screenName).toLowerCase(), {
      bio,
      profileText,
      ts: Date.now(),
    });
    return true;
  }

  function ingestJsonPayload(payload) {
    const queue = [payload];
    const seen = new Set();
    while (queue.length) {
      const cur = queue.shift();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      ingestPossibleUserObject(cur);

      if (Array.isArray(cur)) {
        for (const v of cur) queue.push(v);
      } else {
        for (const k of Object.keys(cur)) {
          const v = cur[k];
          if (v && typeof v === 'object') queue.push(v);
        }
      }
    }
  }

  function setupNetworkSniffer() {
    const shouldInspectUrl = (url) => {
      if (!url) return false;
      const u = String(url);
      return u.includes('/i/api/') || u.includes('/graphql') || u.includes('api.x.com') || u.includes('api.twitter.com');
    };

    const tryIngestText = (text) => {
      if (!text) return;
      const t = String(text).trimStart();
      if (!t) return;
      if (t.length > 2_000_000) return;
      const obj = safeJsonParse(t);
      if (!obj) return;
      ingestJsonPayload(obj);
    };

    // fetch
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
          const input = args[0];
          const url = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
          if (!shouldInspectUrl(url)) return res;
          res.clone().text().then(tryIngestText).catch(() => { /* ignore */ });
        } catch {
          // ignore
        }
        return res;
      };
    }

    // XHR
    const OrigXHR = window.XMLHttpRequest;
    if (typeof OrigXHR === 'function') {
      const open = OrigXHR.prototype.open;
      const send = OrigXHR.prototype.send;

      OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__impZombieUrl = url;
        return open.call(this, method, url, ...rest);
      };

      OrigXHR.prototype.send = function (...args) {
        try {
          this.addEventListener('load', function () {
            try {
              const url = this.__impZombieUrl || '';
              if (!shouldInspectUrl(url)) return;

              if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
                ingestJsonPayload(this.response);
                return;
              }
              tryIngestText(this.responseText);
            } catch {
              // ignore
            }
          });
        } catch {
          // ignore
        }
        return send.apply(this, args);
      };
    }
  }

  // ===== DOM抽出（返信欄） =====
  function isStatusPage() {
    return location.pathname.includes('/status/');
  }

  function getConversationRoot() {
    if (!isStatusPage()) return null;
    return document.querySelector('main') || document.body;
  }

  function getTweetArticles(root) {
    return Array.from((root || document).querySelectorAll('article[data-testid="tweet"]'));
  }

  function extractUserNameBlock(article) {
    return article.querySelector('[data-testid="User-Name"]') || null;
  }

  function extractDisplayNameFromNameBlock(userNameBlock) {
    if (!userNameBlock) return '';
    const spans = Array.from(userNameBlock.querySelectorAll('span'));
    const texts = spans
      .map((s) => norm(s.textContent || ''))
      .filter(Boolean)
      .filter((t) => t !== '·')
      .filter((t) => !t.startsWith('@'))
      .filter((t) => t !== '返信先' && t !== '返信先:' && t !== 'Replying to')
      .filter((t) => !/^返信先\s*@/i.test(t))
      .filter((t) => t !== '認証済みアカウント' && t.toLowerCase() !== 'verified account');
    return texts[0] || '';
  }

  function extractHandleFromLinks(container) {
    const links = Array.from(container?.querySelectorAll('a[href^="/"]') || []);
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (!href || href.includes('/status/')) continue;
      if (href.startsWith('/i/')) continue;
      const handle = href.split('?')[0].split('/').filter(Boolean)[0];
      if (handle) return handle;
    }
    return null;
  }

  function extractDisplayNameFromArticle(article, handle) {
    if (!article || !handle) return '';
    const a = article.querySelector(`a[href="/${CSS.escape(handle)}"]`);
    if (a) {
      const spans = Array.from(a.querySelectorAll('span'));
      const texts = spans
        .map((s) => norm(s.textContent || ''))
        .filter(Boolean)
        .filter((t) => !t.startsWith('@'));
      if (texts[0]) return texts[0];
    }
    return '';
  }

  function isVerifiedFrom(container) {
    if (!container) return false;
    if (container.querySelector('[data-testid^="icon-verified"]')) return true;
    if (container.querySelector('[data-testid*="verified"]')) return true;
    const svgs = container.querySelectorAll('svg[aria-label]');
    for (const s of svgs) {
      const label = s.getAttribute('aria-label') || '';
      if (label.includes('認証済み') || label.toLowerCase().includes('verified')) return true;
    }
    const t = norm(container.textContent || '');
    if (t.includes('認証済み') || /\bverified\b/i.test(t)) return true;
    return false;
  }

  // ===== UI操作（必要時のみ） =====
  async function openTweetMenu(article) {
    const btn =
      article.querySelector('button[data-testid="caret"]') ||
      article.querySelector('[aria-label="More"]') ||
      article.querySelector('[aria-label="もっと見る"]') ||
      null;
    if (!btn) return false;
    btn.click();
    const start = Date.now();
    while (Date.now() - start < 1200) {
      if (document.querySelector('div[role="menu"]')) return true;
      await sleep(50);
    }
    return false;
  }

  async function clickMenuItemByText(textCandidates) {
    const start = Date.now();
    while (Date.now() - start < 1200) {
      const items = Array.from(document.querySelectorAll('div[role="menuitem"], a[role="menuitem"], button[role="menuitem"]'));
      for (const it of items) {
        const t = norm(it.textContent || '');
        if (!t) continue;
        if (textCandidates.some((c) => t.includes(c))) {
          it.click();
          return true;
        }
      }
      await sleep(50);
    }
    return false;
  }

  async function confirmBlockIfNeeded() {
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const buttons = Array.from(document.querySelectorAll('div[role="dialog"] button'));
      for (const b of buttons) {
        const t = norm(b.textContent || '');
        if (t === 'ブロック' || t === 'Block') {
          b.click();
          return true;
        }
      }
      await sleep(60);
    }
    return false;
  }

  // ===== スキャン・判定 =====
  const processedHandles = new Set();
  const handleAttempts = new Map();
  const handleSeenCount = new Map();

  setupNetworkSniffer();

  async function evaluateAndActOnArticle(article) {
    const nameBlock = extractUserNameBlock(article);

    const handle = extractHandleFromLinks(nameBlock) || extractHandleFromLinks(article);
    if (!handle) return;
    if (processedHandles.has(handle)) return;

    handleSeenCount.set(handle, (handleSeenCount.get(handle) || 0) + 1);

    const displayName = nameBlock ? extractDisplayNameFromNameBlock(nameBlock) : (extractDisplayNameFromArticle(article, handle) || '');
    // 表示名が取れていない時の条件1ガード
    const rawCond1 = !!displayName && !hasJapanese(displayName);
    const rawCond2 = isVerifiedFrom(nameBlock || article);
    const cond1 = ENABLE_COND1 ? rawCond1 : true;
    const cond2 = ENABLE_COND2 ? rawCond2 : true;

    const needsProfile = ENABLE_COND3 || ENABLE_COND4 || ENABLE_COND2A;
    const handleKey = String(handle).toLowerCase();

    let profileText = '';
    let bio = '';
    if (needsProfile) {
      const attempts = (handleAttempts.get(handleKey) || 0) + 1;
      handleAttempts.set(handleKey, attempts);

      const cached = profileCache.get(handleKey);
      if (!cached || !cached.profileText) {
        if (attempts >= PROFILE_MAX_RETRIES) processedHandles.add(handle);
        return;
      }
      profileText = cached.profileText || '';
      bio = cached.bio || '';
    }

    const rawCond3 = includesAnyKeyword(`${profileText}\n${displayName}`);
    const rawCond4 = !hasJapanese(profileText);
    const cond3 = ENABLE_COND3 ? rawCond3 : true;
    const cond4 = ENABLE_COND4 ? rawCond4 : true;

    const rawCond2A = rawCond2 && rawCond4;
    const cond2A = ENABLE_COND2A && rawCond2A;

    const shouldAct = cond2A || (cond1 && cond2 && cond3 && cond4);

    if (!shouldAct) {
      // 2_a が有効な間は、表示名がまだ取れていない等の揺れで取りこぼさないよう、
      // 早期に processed に入れる判定を控えめにする。
      if (!ENABLE_COND2A && (!cond1 || !cond2)) {
        if ((handleSeenCount.get(handle) || 0) >= 3) processedHandles.add(handle);
        return;
      }
      processedHandles.add(handle);
      return;
    }

    const reason = {
      enabled: {
        cond1: ENABLE_COND1,
        cond2: ENABLE_COND2,
        cond3: ENABLE_COND3,
        cond4: ENABLE_COND4,
        cond2A: ENABLE_COND2A,
      },
      raw: {
        cond1: rawCond1,
        cond2: rawCond2,
        cond3: rawCond3,
        cond4: rawCond4,
        cond2A: rawCond2A,
      },
      cond1, cond2, cond3, cond4,
      cond2A,
      displayName,
      bio: bio.slice(0, 140),
      profileText: profileText.slice(0, 140),
    };

    const actionToRun = cond2A ? 'block' : ACTION;

    if (DRY_RUN) {
      log(`DRY_RUN: ${actionToRun} 対象`, `@${handle}`, reason);
      processedHandles.add(handle);
      return;
    }

    log(`${actionToRun} 実行`, `@${handle}`, reason);
    const opened = await openTweetMenu(article);
    if (!opened) {
      processedHandles.add(handle);
      return;
    }

    if (actionToRun === 'mute') {
      await clickMenuItemByText(['ミュート', 'Mute']);
    } else {
      const ok = await clickMenuItemByText(['ブロック', 'Block']);
      if (ok) await confirmBlockIfNeeded();
    }

    processedHandles.add(handle);
  }

  let lastScanAt = 0;
  let scanRunning = false;

  async function scanLoop() {
    if (scanRunning) return;
    scanRunning = true;
    try {
      const now = Date.now();
      if (now - lastScanAt < SCAN_INTERVAL_MS) return;
      lastScanAt = now;

      const root = getConversationRoot();
      if (!root) return;

      const articles = getTweetArticles(root);
      for (const a of articles) {
        await evaluateAndActOnArticle(a);
      }
    } catch (e) {
      log('scan error', e);
    } finally {
      scanRunning = false;
    }
  }

  const mo = new MutationObserver(() => {
    setTimeout(scanLoop, 200);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(scanLoop, 1200);
  setInterval(() => { scanLoop(); }, Math.max(900, SCAN_INTERVAL_MS));

  log('loaded', { ACTION, DRY_RUN, KEYWORDS, ENABLE_COND1, ENABLE_COND2, ENABLE_COND3, ENABLE_COND4, ENABLE_COND2A });
})();
