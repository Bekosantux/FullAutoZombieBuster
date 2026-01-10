// ==UserScript==
// @name         Full Auto Zombie Buster
// @namespace    https://com.bekosantux.full-auto-zombie-buster
// @version      1.5.5
// @description  X (Twitter) の返信欄（会話タイムライン）で、条件を満たすアカウントをBotとして自動でブロック/ミュートします。
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://github.com/Bekosantux/FullAutoZombieBuster/raw/main/script.user.js
// @downloadURL  https://github.com/Bekosantux/FullAutoZombieBuster/raw/main/script.user.js
// ==/UserScript==

(() => {
  'use strict';

  // ===== 設定 =====
  const ACTION = 'block'; // 'mute' または 'block'
  const DRY_RUN = false; // trueの場合はログのみ
  const DEBUG_LOG_EVALUATION = false; // trueの場合、判定が確定した全ユーザーの評価結果をログ出力
  const KEYWORDS = ['Web3', 'Crypto', 'AI', 'NFT', 'Trader', 'Wᴇʙ3', 'Business', 'News', 'Marketing', 'BTC', 'Bitcoin', 'ETH', 'MeMeMax']; // 小文字大文字は区別されません

  // 前提: 認証済み（Verified）アカウントのみを処理対象にする
    const REQUIRE_VERIFIED = true;

  // ----- 通常条件-----
  // 以下の条件をすべて満たす場合に処理対象とする

    const COND_1 = true; // 1) 表示名に日本語が含まれていない
    const COND_2 = true; // 2) キーワード（プロフィール+表示名）
    const COND_3 = true; // 3) プロフィールに日本語が含まれていない
    const COND_4 = true; // 4) プロフィールが取得できている（空欄でも可）

  // ----- 優先条件（強制処理）-----
  // 条件を満たす場合、通常条件に関係なく強制的に処理対象とする

    // 優先条件A（強制block）: 認証済み & プロフィール空欄
    // 誤爆の可能性があるためデフォルトでは無効
    const COND_A = false;

    // 優先条件B（強制block）: 認証済み &（プロフィールが日本語なし）&（表示名が日本語なし OR 表示名/プロフィールに簡体字がある）
    // 誤爆の可能性があるためデフォルトでは無効
    const COND_B = false;

  // ----- 除外設定 -----
  // 対象のユーザーは処理対象から除外する（優先条件を含む）

    // 除外: フォロー中のユーザーはあらゆる条件から除外
    const EXCLUDE_FOLLOWED = true;

    // 除外: フォロワー数が一定以上のアカウントは除外する
    const EXCLUDE_HIGH_FOLLOWERS = true;
    const EXCLUDE_HIGH_FOLLOWERS_MIN = 10_000; // ここを変更すると閾値を変えられます

  const SCAN_INTERVAL_MS = 1000;
  const PROFILE_MAX_RETRIES = 6;

  // ===== 共通 =====
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[imp-zombie]', ...args);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function getStatusPermalinkFromArticle(article) {
    try {
      const a = article?.querySelector?.('a[href*="/status/"]');
      const href = a?.getAttribute?.('href') || '';
      if (!href) return '';
      return new URL(href, location.origin).toString();
    } catch {
      return '';
    }
  }

  const shouldDebugWait = (n) => (n === 1 || n === PROFILE_MAX_RETRIES || (n % 2 === 0));

  // デバッグログの重複抑制: 同一ユーザー×同一outcomeは1回だけ（wait系は除外）
  const debugOutcomeLogged = new Set();

  const debugEval = (handle, payload) => {
    if (!DEBUG_LOG_EVALUATION) return;
    const outcome = String(payload?.outcome || '');
    const handleKey = String(payload?.handleKey || (handle ? String(handle).toLowerCase() : '?'));
    const allowRepeat = outcome.startsWith('wait_');
    const dedupeKey = `${handleKey}|${outcome}`;
    if (!allowRepeat) {
      if (debugOutcomeLogged.has(dedupeKey)) return;
      debugOutcomeLogged.add(dedupeKey);
    }
    const base = {
      ts: new Date().toISOString(),
      path: location.pathname,
    };
    log('eval', `@${handle || '?'}`, { ...base, handleKey, ...payload });
  };

  // 簡体字に頻出の漢字
  const SIMPLIFIED_ONLY_RE = /[们门这说吗为对时见关东车发经书买两开网应进动电气简后兴诗记爱资盈币]/;

  const hasSimplified = (text) => SIMPLIFIED_ONLY_RE.test(String(text || ''));

  const hasJapanese = (text) => {
    if (!text) return false;
    try {
      const t = String(text);
      // かながあるなら日本語扱い
      if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)) return true;

      // かな無しの場合は、漢字があるかを確認する
      const hasHan = /[\p{Script=Han}]/u.test(t);
      if (!hasHan) return false;

      // 漢字がある場合、簡体字特有の字があれば日本語扱いしない
      if (SIMPLIFIED_ONLY_RE.test(t)) return false;
      return true;
    } catch {
      const t = String(text);
      if (/[ぁ-んァ-ン]/.test(t)) return true;
      const hasHan = /[一-龥]/.test(t);
      if (!hasHan) return false;
      if (SIMPLIFIED_ONLY_RE.test(t)) return false;
      return true;
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
  // lower(handle) -> { bio, profileText, profileEmpty, ts }
  const profileCache = new Map();

  // lower(handle) -> { followersCount, ts }
  const userMetricsCache = new Map();

  const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

  function pickFirstString(...candidates) {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c;
    }
    return '';
  }

  function pickFirstNumber(...candidates) {
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c)) return c;
      if (typeof c === 'string' && c.trim() && Number.isFinite(Number(c))) return Number(c);
    }
    return null;
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

    const followersCount = pickFirstNumber(
      obj.followers_count,
      obj.followersCount,
      legacy?.followers_count,
      legacy?.followersCount,
      rLegacy?.followers_count,
      rLegacy?.followersCount,
      result?.followers_count,
      result?.followersCount
    );
    if (followersCount != null) {
      userMetricsCache.set(String(screenName).toLowerCase(), { followersCount, ts: Date.now() });
    }

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

    // 重要: GraphQLの一部レスポンスは screen_name だけ等「プロフィール項目が未同梱」なことがある。
    // それを空欄プロフィール扱いにすると、条件Cが暴発する。
    const profileKnown =
      hasOwn(obj, 'description') || hasOwn(obj, 'location') || hasOwn(obj, 'url') || hasOwn(obj, 'entities') ||
      hasOwn(legacy, 'description') || hasOwn(legacy, 'location') || hasOwn(legacy, 'url') || hasOwn(legacy, 'entities') ||
      hasOwn(rLegacy, 'description') || hasOwn(rLegacy, 'location') || hasOwn(rLegacy, 'url') || hasOwn(rLegacy, 'entities') ||
      hasOwn(result, 'description') || hasOwn(result, 'location') || hasOwn(result, 'url') || hasOwn(result, 'entities');

    const profileText = buildProfileText({ bio, location, url });
    const profileEmpty = profileKnown && !bio && !location && !url;

    // プロフィール項目が未同梱のオブジェクトはプロフィールキャッシュしない（後続の完全なpayloadを待つ）
    if (!profileKnown) return followersCount != null;

    profileCache.set(String(screenName).toLowerCase(), { bio, profileText, profileEmpty, ts: Date.now() });
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
  function getOpenMenuElement() {
    const menus = Array.from(document.querySelectorAll('div[role="menu"]'));
    // 最後に出た（＝一番手前になりやすい）かつ表示中のメニューを優先
    for (let i = menus.length - 1; i >= 0; i--) {
      const m = menus[i];
      const rect = m.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (visible) return m;
    }
    return null;
  }

  async function waitMenuClosed(timeoutMs = 600) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!getOpenMenuElement()) return true;
      await sleep(30);
    }
    return !getOpenMenuElement();
  }

  async function openTweetMenu(article) {
    // 既存メニューを先に閉じる
    if (getOpenMenuElement()) {
      await closeMenuIfOpen();
      await waitMenuClosed(800);
    }
    const btn =
      article.querySelector('button[data-testid="caret"]') ||
      article.querySelector('[aria-label="More"]') ||
      article.querySelector('[aria-label="もっと見る"]') ||
      null;
    if (!btn) return false;
    btn.click();
    const start = Date.now();
    while (Date.now() - start < 1200) {
      if (getOpenMenuElement()) return true;
      await sleep(50);
    }
    return false;
  }

  async function clickMenuItemByText(textCandidates) {
    const start = Date.now();
    while (Date.now() - start < 1200) {
      const menu = getOpenMenuElement();
      if (!menu) {
        await sleep(50);
        continue;
      }
      const items = Array.from(menu.querySelectorAll('div[role="menuitem"], a[role="menuitem"], button[role="menuitem"]'));
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

  function menuHasText(textCandidates) {
    const menu = getOpenMenuElement();
    if (!menu) return false;
    const items = Array.from(menu.querySelectorAll('div[role="menuitem"], a[role="menuitem"], button[role="menuitem"]'));
    for (const it of items) {
      const t = norm(it.textContent || '');
      if (!t) continue;
      if (textCandidates.some((c) => t.includes(c))) return true;
    }
    return false;
  }

  function getFollowStatusFromMenu() {
    const followed = menuHasText([
      'フォロー解除',
      'フォローを解除',
      'フォローを解除する',
      'フォローをやめる',
      'フォロー中',
      'Unfollow',
      'Following',
    ]);
    if (followed) return 'followed';

    const notFollowed = menuHasText([
      'フォローする',
      'フォロー',
      'Follow',
    ]);
    if (notFollowed) return 'not_followed';

    return 'unknown';
  }

  async function closeMenuIfOpen() {
    try {
      if (!getOpenMenuElement()) return;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      }));
      await sleep(50);
    } catch {
      // ignore
    }
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
  // lower(handle) を格納（大文字小文字差での重複処理を防ぐ）
  const processedHandles = new Set();
  const handleAttempts = new Map();
  const handleSeenCount = new Map();
  const followCheckAttempts = new Map();

  // 会話タイムライン先頭ツイート（＝スレ主とみなす）の handle（lower）
  let timelineOwnerHandleKey = null;
  let timelineOwnerLastPathname = '';

  function updateTimelineOwnerFromConversationTop(root) {
    if (timelineOwnerHandleKey) return;
    const articles = getTweetArticles(root);
    if (!articles.length) return;
    const first = articles[0];
    const nb = extractUserNameBlock(first);
    const h = extractHandleFromLinks(nb) || extractHandleFromLinks(first);
    if (h) timelineOwnerHandleKey = String(h).toLowerCase();
  }

  setupNetworkSniffer();

  async function evaluateAndActOnArticle(article) {
    const nameBlock = extractUserNameBlock(article);

    const handle = extractHandleFromLinks(nameBlock) || extractHandleFromLinks(article);
    const permalink = getStatusPermalinkFromArticle(article);
    if (!handle) {
      debugEval('?', { outcome: 'skip_no_handle', permalink });
      return;
    }
    const handleKey = String(handle).toLowerCase();
    if (timelineOwnerHandleKey && handleKey === timelineOwnerHandleKey) {
      debugEval(handle, { outcome: 'excluded_timeline_owner', permalink, timelineOwnerHandleKey, handleKey });
      processedHandles.add(handleKey);
      return;
    }
    if (processedHandles.has(handleKey)) return;

    handleSeenCount.set(handleKey, (handleSeenCount.get(handleKey) || 0) + 1);

    const displayName = nameBlock ? extractDisplayNameFromNameBlock(nameBlock) : (extractDisplayNameFromArticle(article, handle) || '');
    const verified = isVerifiedFrom(nameBlock || article);

    // 前提ゲート: 認証済みのみを処理対象にする
    if (REQUIRE_VERIFIED && !verified) {
      debugEval(handle, { outcome: 'skip_not_verified', permalink, handleKey });
      if ((handleSeenCount.get(handleKey) || 0) >= 3) processedHandles.add(handleKey);
      return;
    }

    // 表示名が取れていない時の条件1ガード
    const rawCond1 = !!displayName && !hasJapanese(displayName);
    const cond1 = COND_1 ? rawCond1 : true;

    const needsProfile = COND_2 || COND_3 || COND_4 || COND_A || COND_B;

    // フォロワー数が多いアカウントは除外
    if (EXCLUDE_HIGH_FOLLOWERS) {
      const m = userMetricsCache.get(handleKey);
      const fc = m?.followersCount;
      if (typeof fc === 'number' && Number.isFinite(fc) && fc >= EXCLUDE_HIGH_FOLLOWERS_MIN) {
        debugEval(handle, { outcome: 'excluded_high_followers', permalink, handleKey, verified, followersCount: fc, min: EXCLUDE_HIGH_FOLLOWERS_MIN });
        log('skip (high follower count)', `@${handle}`, { followersCount: fc, min: EXCLUDE_HIGH_FOLLOWERS_MIN });
        processedHandles.add(handleKey);
        return;
      }
    }

    let profileText = '';
    let bio = '';
    let profileEmpty = false;
    if (needsProfile) {
      const attempts = (handleAttempts.get(handleKey) || 0) + 1;
      handleAttempts.set(handleKey, attempts);

      const cached = profileCache.get(handleKey);
      if (!cached) {
        if (shouldDebugWait(attempts)) {
          debugEval(handle, {
            outcome: 'wait_profile_cache',
            permalink,
            handleKey,
            verified,
            attempts,
            max: PROFILE_MAX_RETRIES,
            cache: {
              profile: false,
              followersCount: userMetricsCache.get(handleKey)?.followersCount,
            },
          });
        }
        if (attempts >= PROFILE_MAX_RETRIES) {
          debugEval(handle, { outcome: 'give_up_profile', permalink, handleKey, verified, attempts, max: PROFILE_MAX_RETRIES });
          processedHandles.add(handleKey);
        }
        return;
      }

      profileText = cached.profileText || '';
      bio = cached.bio || '';
      profileEmpty = cached.profileEmpty === true;

      // 条件2/3/B が有効なのにプロフィール文が取れない場合は待つ（ただし優先条件A成立なら待たない）
      const hasProfileTextNow = !!profileText;
      const rawCondANow = verified && profileEmpty;
      const condANow = COND_A && rawCondANow;

      const needsNonEmptyProfileText = COND_2 || COND_3 || COND_B;
      if (!condANow && needsNonEmptyProfileText && !hasProfileTextNow) {
        if (shouldDebugWait(attempts)) {
          debugEval(handle, {
            outcome: 'wait_profile_text',
            permalink,
            handleKey,
            verified,
            attempts,
            max: PROFILE_MAX_RETRIES,
            profileEmpty,
            hasProfileTextNow,
            cache: {
              profile: true,
              followersCount: userMetricsCache.get(handleKey)?.followersCount,
            },
          });
        }
        if (attempts >= PROFILE_MAX_RETRIES) {
          debugEval(handle, { outcome: 'give_up_profile_text', permalink, handleKey, verified, attempts, max: PROFILE_MAX_RETRIES });
          processedHandles.add(handleKey);
        }
        return;
      }
    }

    const hasProfileText = !!profileText;
    const rawCond2 = hasProfileText ? includesAnyKeyword(`${profileText}\n${displayName}`) : false;
    const rawCond3 = hasProfileText ? !hasJapanese(profileText) : false;
    const rawCond4 = (hasProfileText || profileEmpty);
    const cond2 = COND_2 ? rawCond2 : true;
    const cond3 = COND_3 ? rawCond3 : true;
    const cond4 = COND_4 ? rawCond4 : true;

    const simplifiedInName = hasSimplified(displayName);
    const simplifiedInProfile = hasSimplified(profileText);
    // 優先条件A/B（強制block）
    const rawCondA = verified && profileEmpty;
    const rawCondB = verified && rawCond3 && (rawCond1 || simplifiedInName || simplifiedInProfile);
    const trigA = COND_A && rawCondA;
    const trigB = COND_B && rawCondB;

    // 通常条件（Verified前提のためcond2は廃止）
    const trigNormal = (cond1 && cond2 && cond3 && cond4);

    const shouldAct = trigA || trigB || trigNormal;

    const evaluation = {
      verified,
      displayName: displayName.slice(0, 80),
      profileEmpty,
      hasProfileText,
      permalink,
      handleKey,
      cache: {
        profile: profileCache.has(handleKey),
        followersCount: userMetricsCache.get(handleKey)?.followersCount,
      },
      snippets: {
        bio: bio.slice(0, 140),
        profileText: profileText.slice(0, 140),
      },
      raw: {
        cond1: rawCond1,
        cond2: rawCond2,
        cond3: rawCond3,
        cond4: rawCond4,
        condA: rawCondA,
        condB: rawCondB,
      },
      trig: { A: trigA, B: trigB, normal: trigNormal },
      shouldAct,
    };

    if (!shouldAct) {
      debugEval(handle, { ...evaluation, outcome: 'skip_no_match' });
      processedHandles.add(handleKey);
      return;
    }

    const reason = {
      raw: {
        cond1: rawCond1,
        verified,
        cond2: rawCond2,
        cond3: rawCond3,
        cond4: rawCond4,
        followStatus: 'unknown',
        condA: rawCondA,
        condB: rawCondB,
      },
      displayName,
      bio: bio.slice(0, 140),
      profileText: profileText.slice(0, 140),
      profileEmpty,
    };

    const actionToRun = (trigA || trigB) ? 'block' : ACTION;

    const opened = await openTweetMenu(article);
    if (!opened) {
      debugEval(handle, { ...evaluation, outcome: 'skip_menu_open_failed', action: actionToRun });
      processedHandles.add(handleKey);
      return;
    }

    // 除外: フォロー中ユーザーは実行しない
    if (EXCLUDE_FOLLOWED) {
      const followStatus = getFollowStatusFromMenu();
      reason.raw.followStatus = followStatus;

      if (followStatus === 'followed') {
        debugEval(handle, { ...evaluation, outcome: 'excluded_followed', followStatus, action: actionToRun });
        log('skip (followed user)', `@${handle}`);
        await closeMenuIfOpen();
        await waitMenuClosed(800);
        processedHandles.add(handleKey);
        return;
      }

      if (followStatus === 'unknown') {
        // 安全側: フォロー状態を判定できない場合は実行しない
        const k = String(handle).toLowerCase();
        const n = (followCheckAttempts.get(k) || 0) + 1;
        followCheckAttempts.set(k, n);
        if (shouldDebugWait(n)) {
          debugEval(handle, { ...evaluation, outcome: 'wait_follow_unknown', followStatus, tries: n, action: actionToRun });
        }
        log('skip (follow status unknown)', `@${handle}`, { tries: n });
        await closeMenuIfOpen();
        await waitMenuClosed(800);
        // 何度もunknownが続く場合はキャンセル
        if (n >= 3) {
          debugEval(handle, { ...evaluation, outcome: 'give_up_follow_unknown', followStatus, tries: n, action: actionToRun });
          processedHandles.add(handleKey);
        }
        return;
      }
    }

    if (DRY_RUN) {
      debugEval(handle, { ...evaluation, outcome: 'dry_run', action: actionToRun, followStatus: reason.raw.followStatus });
      log(`DRY_RUN: ${actionToRun} 対象`, `@${handle}`, reason);
      await closeMenuIfOpen();
      await waitMenuClosed(800);
      processedHandles.add(handleKey);
      return;
    }

    debugEval(handle, { ...evaluation, outcome: 'execute', action: actionToRun, followStatus: reason.raw.followStatus });
    log(`${actionToRun} 実行`, `@${handle}`, reason);

    if (actionToRun === 'mute') {
      await clickMenuItemByText(['ミュート', 'Mute']);
    } else {
      const ok = await clickMenuItemByText(['ブロック', 'Block']);
      if (ok) await confirmBlockIfNeeded();
    }

    processedHandles.add(handleKey);
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

      if (location.pathname !== timelineOwnerLastPathname) {
        timelineOwnerLastPathname = location.pathname;
        timelineOwnerHandleKey = null;
      }

      updateTimelineOwnerFromConversationTop(root);

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

  log('loaded', { ACTION, DRY_RUN, DEBUG_LOG_EVALUATION, KEYWORDS, REQUIRE_VERIFIED, COND_1, COND_2, COND_3, COND_4, COND_A, COND_B, EXCLUDE_FOLLOWED, EXCLUDE_HIGH_FOLLOWERS, EXCLUDE_HIGH_FOLLOWERS_MIN });
})();
